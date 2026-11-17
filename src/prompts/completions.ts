/**
 * Suggestions for prompt arguments (MCP `completion/complete`).
 *
 * The catalog names a {@link CompletionKind} per argument (`PromptSpec.completions`);
 * `registerPrompts` attaches the completer of that kind for one server instance. Months and
 * periods come from the clock and never touch sevDesk. Contact and payment account names come from
 * the account:
 *
 * - only when the read tool behind them is registered for the configuration
 *   ({@link COMPLETION_TOOLS}), so never without the read tier or the toolset;
 * - through a client that refuses every request that changes data, always with an explicit
 *   `limit`: one list request per kind, plus a name search (limit 100) per typed name when the
 *   account has more contacts than one read returns;
 * - cached for {@link COMPLETION_CACHE_TTL_MS} per account. Over HTTP each request builds a new
 *   server instance (ADR 0004), so the cache lives here, keyed by the account's `Config` object:
 *   the owner the domain caches use, one per OAuth context (`src/accounts/resolver.ts`). One
 *   account's names never reach another account. The full lists are kept apart from the
 *   searches, of which the {@link MAX_CACHED_SEARCHES} most recently used are kept, so a burst of
 *   typed names never pushes the full contact list out.
 *
 * A failed read suggests nothing and is kept for {@link COMPLETION_FAILURE_TTL_MS}. A failure that
 * concerns the account rather than the typed name ({@link ACCOUNT_FAILURES}: sevDesk refused the
 * token, asked to slow down or did not answer) also holds back every new read of the account for
 * that long, so a lasting failure (a revoked token, say) is not sent again on every keystroke. A
 * suggestion is optional, and the prompt works without one. A search is stopped when every
 * request waiting for it has ended early ({@link AccountCompleterOptions.signal}), so it gives up
 * its place in the account's request pacing; the full lists are always read to the end, because
 * the next keystroke needs them.
 *
 * Suggestions are data for the client, not text of a prompt. A chosen value comes back as an
 * ordinary argument: the SDK checks it against the argument's pattern and the prompt shows it only
 * fenced. `registerPrompts` also drops every suggestion the argument would refuse.
 */
import type { Config } from "../config.js";
import { listBankAccountNames } from "../domain/banking.js";
import { listContactNames } from "../domain/contacts.js";
import { berlinDateOf } from "../sevdesk/dates.js";
import { SevdeskError, type SevdeskErrorKind } from "../sevdesk/errors.js";
import { readOnlyClient } from "../sevdesk/scoped-client.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { monthPeriod, type Period, quarterPeriod } from "./periods.js";
import type { CompletionKind } from "./types.js";

/** @public Suggestions for what the user typed so far, best first. */
export type Completer = (value: string) => Promise<readonly string[]>;

/** The completers of one server instance, by kind; a kind without one is not completed. */
export type Completers = Readonly<Partial<Record<CompletionKind, Completer>>>;

/** How long names read from an account are reused. */
export const COMPLETION_CACHE_TTL_MS = 60_000;

/** How long a failed read is reused (suggesting nothing) before the next keystroke tries again. */
export const COMPLETION_FAILURE_TTL_MS = 5_000;

/** The read tool whose registration a kind needs; months and periods need none. */
export const COMPLETION_TOOLS = {
  contact: "sevdesk_contacts_search",
  checkAccount: "sevdesk_bank_accounts_list",
} as const satisfies Partial<Record<CompletionKind, string>>;

/** What each kind suggests, for `docs/tools.md`. Trusted text. */
export const COMPLETION_HINTS: Readonly<Record<CompletionKind, string>> = {
  month: "recent months",
  period: "recent months and quarters",
  contact: "contact names",
  checkAccount: "payment account names",
};

/** Months offered before the user narrows them down by typing a year. */
const RECENT_MONTHS = 24;
/** Quarters offered before the user narrows them down by typing a year. */
const RECENT_QUARTERS = 8;
/** Contacts read in one request; sevDesk's maximum page size. */
const CONTACT_LIMIT = 1000;
/** Contacts read per typed name when the account has more than {@link CONTACT_LIMIT}. */
const CONTACT_SEARCH_LIMIT = 100;
/** Longest typed name sent to sevDesk as a search: the longest reference an argument accepts. */
const MAX_SEARCH_LENGTH = 200;
/** Searches by typed name cached per account; the full lists do not count. */
export const MAX_CACHED_SEARCHES = 32;
/**
 * Failures that any other read of the account would meet too, so new reads wait
 * {@link COMPLETION_FAILURE_TTL_MS}; the others (a refused search, say) concern one read only.
 */
const ACCOUNT_FAILURES: ReadonlySet<SevdeskErrorKind> = new Set([
  "auth",
  "rate_limited",
  "server",
  "network",
  "timeout",
]);

// ---------------------------------------------------------------------------------------------
// Months and periods
// ---------------------------------------------------------------------------------------------

/** The `count` months up to the one `today` lies in, newest first. */
function monthsBack(today: string, count: number): Period[] {
  const current = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, back) => {
    const index = current - back;
    return monthPeriod(Math.floor(index / 12), (index % 12) + 1);
  });
}

/** The `count` quarters up to the one `today` lies in, newest first. */
function quartersBack(today: string, count: number): Period[] {
  const current = Number(today.slice(0, 4)) * 4 + Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  return Array.from({ length: count }, (_, back) => {
    const index = current - back;
    return quarterPeriod(Math.floor(index / 4), (index % 4) + 1);
  });
}

/** The year at the start of `value` (`2023`, `2023-…`), when it names one of 2000–2099. */
function typedYear(value: string): number | undefined {
  const match = /^(20\d\d)/.exec(value);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Periods whose key starts with `value` (case-insensitive), without duplicates, in order. */
function matching(periods: readonly Period[], value: string): string[] {
  const prefix = value.toUpperCase();
  const keys = periods.map((period) => period.key).filter((key) => key.startsWith(prefix));
  return [...new Set(keys)];
}

/**
 * Months (`YYYY-MM`) for what the user typed, newest first: the last {@link RECENT_MONTHS} up to
 * the current one, and every month of a year the user typed. Never a month after `today`.
 */
export function monthSuggestions(value: string, today: string): string[] {
  const year = typedYear(value);
  const ofYear =
    year === undefined
      ? []
      : monthsBack(lastMonthOf(year), 12).filter((month) => month.from <= today);
  return matching([...monthsBack(today, RECENT_MONTHS), ...ofYear], value);
}

/** A day in December of `year`, to count months and quarters back from. */
function lastMonthOf(year: number): string {
  return `${String(year)}-12-01`;
}

/**
 * Months and quarters (`YYYY-Qn`) for what the user typed, newest first by their last day (a
 * month before the quarter it ends): the last {@link RECENT_MONTHS} months and
 * {@link RECENT_QUARTERS} quarters, and those of a year the user typed. Never a period that starts
 * after `today`.
 */
export function periodSuggestions(value: string, today: string): string[] {
  const year = typedYear(value);
  const ofYear =
    year === undefined
      ? []
      : [...monthsBack(lastMonthOf(year), 12), ...quartersBack(lastMonthOf(year), 4)].filter(
          (period) => period.from <= today,
        );
  const periods = [
    ...monthsBack(today, RECENT_MONTHS),
    ...quartersBack(today, RECENT_QUARTERS),
    ...ofYear,
  ].sort(
    (a, b) =>
      b.to.localeCompare(a.to) ||
      (a.quarter === undefined ? 0 : 1) - (b.quarter === undefined ? 0 : 1),
  );
  return matching(periods, value);
}

/** Completers for months and periods; `now` gives today in Europe/Berlin. */
export function periodCompleters(now: () => number): Completers {
  return {
    month: (value) => Promise.resolve(monthSuggestions(value, berlinDateOf(now()))),
    period: (value) => Promise.resolve(periodSuggestions(value, berlinDateOf(now()))),
  };
}

// ---------------------------------------------------------------------------------------------
// Names from the account
// ---------------------------------------------------------------------------------------------

interface NameList {
  readonly names: readonly string[];
  /** False when the account may hold more than were read. */
  readonly complete: boolean;
}

/** One read of names, shared by every caller of the account while it is reused. */
interface CachedRead {
  /**
   * Reused until then: {@link COMPLETION_CACHE_TTL_MS} after it started, or at most
   * {@link COMPLETION_FAILURE_TTL_MS} after it failed.
   */
  expires: number;
  readonly names: Promise<NameList>;
  /** Callers waiting that may still give up on the read; infinite once one never will. */
  waiting: number;
  /** Drops the read from the cache and stops it, unless it has settled. */
  readonly stop: () => void;
}

/** One account's reads: the full lists by kind, and the searches by typed name. */
interface AccountReads {
  readonly lists: Map<string, CachedRead>;
  /** Least recently used first; at most {@link MAX_CACHED_SEARCHES}. */
  readonly searches: Map<string, CachedRead>;
  /** Set after a failure of {@link ACCOUNT_FAILURES}: new reads fail with it until then. */
  held?: { readonly until: number; readonly error: SevdeskError };
}

/** By account (`Config` object); see the module comment. */
const caches = new WeakMap<object, AccountReads>();

function readsOf(owner: object): AccountReads {
  let reads = caches.get(owner);
  if (reads === undefined) {
    reads = { lists: new Map(), searches: new Map() };
    caches.set(owner, reads);
  }
  return reads;
}

/**
 * The read `key` of `reads` (one of `account`'s maps): the cached one while it is reused (a hit
 * moves it last, as the most recently used), or a new one that `load` starts. Before a new read,
 * expired reads are dropped, then the least recently used until fewer than `limit` remain; an
 * evicted read still answers the callers waiting for it. A failed read is kept for
 * {@link COMPLETION_FAILURE_TTL_MS}; while the account is held back, a new read fails at once
 * without calling `load`.
 */
function cachedRead(
  account: AccountReads,
  reads: Map<string, CachedRead>,
  key: string,
  now: () => number,
  load: (signal: AbortSignal) => Promise<NameList>,
  limit = Number.POSITIVE_INFINITY,
): CachedRead {
  const at = now();
  const hit = reads.get(key);
  if (hit !== undefined && hit.expires > at) {
    reads.delete(key);
    reads.set(key, hit);
    return hit;
  }
  for (const [cachedKey, entry] of reads) {
    if (entry.expires <= at) reads.delete(cachedKey);
  }
  while (reads.size >= limit) {
    const oldest = reads.keys().next().value;
    if (oldest === undefined) break;
    reads.delete(oldest);
  }
  const held = account.held !== undefined && account.held.until > at ? account.held : undefined;
  const controller = new AbortController();
  let settled = false;
  const read: CachedRead = {
    expires: held?.until ?? at + COMPLETION_CACHE_TTL_MS,
    names: held === undefined ? load(controller.signal) : Promise.reject(held.error),
    waiting: 0,
    stop: () => {
      if (settled) return;
      if (reads.get(key) === read) reads.delete(key);
      controller.abort();
    },
  };
  reads.set(key, read);
  void read.names.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      // A stopped read is no longer cached and holds nothing back; other failures are reused.
      if (controller.signal.aborted) return;
      const until = now() + COMPLETION_FAILURE_TTL_MS;
      if (reads.get(key) === read) read.expires = Math.min(read.expires, until);
      if (error !== held?.error && error instanceof SevdeskError) {
        if (ACCOUNT_FAILURES.has(error.kind)) account.held = { until, error };
      }
    },
  );
  return read;
}

/** Waits for `read` without ever giving up on it, so it is never stopped. */
function awaitRead(read: CachedRead): Promise<NameList> {
  read.waiting = Number.POSITIVE_INFINITY;
  return read.names;
}

/**
 * Waits for `read` until `signal` aborts, and gives `undefined` then. When the last caller still
 * waiting gives up, the read is stopped; a caller without a signal never gives up.
 */
function awaitReadUnless(
  read: CachedRead,
  signal: AbortSignal | undefined,
): Promise<NameList | undefined> {
  if (signal === undefined) return awaitRead(read);
  read.waiting += 1;
  let giveUp = (): void => undefined;
  const gaveUp = new Promise<undefined>((resolve) => {
    giveUp = () => {
      read.waiting -= 1;
      if (read.waiting === 0) read.stop();
      resolve(undefined);
    };
  });
  if (signal.aborted) giveUp();
  else signal.addEventListener("abort", giveUp, { once: true });
  return Promise.race([read.names, gaveUp]).finally(() => {
    signal.removeEventListener("abort", giveUp);
  });
}

/**
 * `names` that contain `value` (case-insensitive, trimmed), those starting with it first, then
 * alphabetically; all of them for an empty value.
 */
export function rankNames(names: readonly string[], value: string): string[] {
  const needle = value.trim().toLocaleLowerCase("de");
  const found = [...new Set(names)]
    .map((name) => ({ name, at: name.toLocaleLowerCase("de").indexOf(needle) }))
    .filter(({ at }) => at >= 0);
  found.sort(
    (a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.name.localeCompare(b.name, "de"),
  );
  return found.map(({ name }) => name);
}

/** @public What {@link accountCompleters} needs of one server instance. */
export interface AccountCompleterOptions {
  /** The account's configuration; also the owner of its cache entries. */
  readonly config: Config;
  readonly client: SevdeskClient;
  /** Names of the tools registered for this configuration (see {@link COMPLETION_TOOLS}). */
  readonly tools: ReadonlySet<string>;
  /**
   * Aborts when the request this instance serves ends early. The SDK hands a completer no signal
   * of its own; over HTTP every request is a new instance, so the request's signal (the client
   * left, the deadline passed, the server shuts down) stands in. Undefined over stdio, where one
   * instance serves the whole connection. Only searches by typed name are stopped with it.
   */
  readonly signal?: AbortSignal | undefined;
  /** Epoch milliseconds, for the cache (tests). Default `Date.now`. */
  readonly now?: () => number;
}

/** Runs `complete`; a failed sevDesk read suggests nothing (see the module comment). */
async function quietly(complete: () => Promise<readonly string[]>): Promise<readonly string[]> {
  try {
    return await complete();
  } catch (error) {
    if (error instanceof SevdeskError) return [];
    throw error;
  }
}

/**
 * Completers for contact and payment account names of one account: only those whose read tool is
 * registered (an empty object otherwise).
 */
export function accountCompleters(options: AccountCompleterOptions): Completers {
  const { tools, signal } = options;
  const now = options.now ?? Date.now;
  const client = readOnlyClient(options.client, "suggesting prompt arguments");
  const reads = readsOf(options.config);
  const completers: Partial<Record<CompletionKind, Completer>> = {};

  if (tools.has(COMPLETION_TOOLS.contact)) {
    completers.contact = (value) =>
      quietly(async () => {
        const all = await awaitRead(
          cachedRead(reads, reads.lists, "contact", now, (stop) =>
            listContactNames(client, { limit: CONTACT_LIMIT }, stop),
          ),
        );
        const needle = value.trim();
        if (all.complete || needle === "" || needle.length > MAX_SEARCH_LENGTH) {
          return rankNames(all.names, value);
        }
        const search = cachedRead(
          reads,
          reads.searches,
          needle.toLocaleLowerCase("de"),
          now,
          (stop) => listContactNames(client, { query: needle, limit: CONTACT_SEARCH_LIMIT }, stop),
          MAX_CACHED_SEARCHES,
        );
        const found = await awaitReadUnless(search, signal);
        // Undefined: the request ended early, and nothing is sent back for it.
        return found === undefined ? [] : rankNames([...all.names, ...found.names], value);
      });
  }

  if (tools.has(COMPLETION_TOOLS.checkAccount)) {
    completers.checkAccount = (value) =>
      quietly(async () => {
        const accounts = await awaitRead(
          cachedRead(reads, reads.lists, "checkAccount", now, async (stop) => ({
            names: await listBankAccountNames(client, stop),
            complete: true,
          })),
        );
        return rankNames(accounts.names, value);
      });
  }

  return completers;
}
