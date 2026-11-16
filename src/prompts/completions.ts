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
 * - through a client that refuses every request that changes data, one list request with an
 *   explicit `limit`;
 * - cached for {@link COMPLETION_CACHE_TTL_MS} per account. Over HTTP each request builds a new
 *   server instance (ADR 0004), so the cache lives here, keyed by the account's `Config` object:
 *   the owner the domain caches use, one per OAuth context (`src/accounts/resolver.ts`). One
 *   account's names never reach another account.
 *
 * A failed read suggests nothing and is not cached, so the next keystroke tries again; a
 * suggestion is optional, and the prompt works without one.
 *
 * Suggestions are data for the client, not text of a prompt. A chosen value comes back as an
 * ordinary argument: the SDK checks it against the argument's pattern and the prompt shows it only
 * fenced. `registerPrompts` also drops every suggestion the argument would refuse.
 */
import type { Config } from "../config.js";
import { listBankAccountNames } from "../domain/banking.js";
import { listContactNames } from "../domain/contacts.js";
import { berlinDateOf } from "../sevdesk/dates.js";
import { SevdeskError } from "../sevdesk/errors.js";
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
/** Cached reads per account (the full lists and typed names). */
const MAX_CACHED_READS = 32;

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

interface CachedRead {
  readonly expires: number;
  readonly names: Promise<NameList>;
}

interface NameList {
  readonly names: readonly string[];
  /** False when the account may hold more than were read. */
  readonly complete: boolean;
}

/** By account (`Config` object), then by read; see the module comment. */
const caches = new WeakMap<object, Map<string, CachedRead>>();

/**
 * The names `load` reads, shared by every caller for {@link COMPLETION_CACHE_TTL_MS}, including
 * one still in flight. A failed read is dropped, so it is not reused.
 */
function cachedRead(
  owner: object,
  key: string,
  now: () => number,
  load: () => Promise<NameList>,
): Promise<NameList> {
  let cache = caches.get(owner);
  if (cache === undefined) {
    cache = new Map();
    caches.set(owner, cache);
  }
  const at = now();
  const hit = cache.get(key);
  if (hit !== undefined && hit.expires > at) return hit.names;
  for (const [cachedKey, entry] of cache) {
    if (entry.expires <= at) cache.delete(cachedKey);
  }
  while (cache.size >= MAX_CACHED_READS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const reads = cache;
  const names: Promise<NameList> = load().catch((error: unknown) => {
    if (reads.get(key)?.names === names) reads.delete(key);
    throw error;
  });
  reads.set(key, { expires: at + COMPLETION_CACHE_TTL_MS, names });
  return names;
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
  const { config, tools } = options;
  const now = options.now ?? Date.now;
  const client = readOnlyClient(options.client, "suggesting prompt arguments");
  const completers: Partial<Record<CompletionKind, Completer>> = {};

  if (tools.has(COMPLETION_TOOLS.contact)) {
    completers.contact = (value) =>
      quietly(async () => {
        const all = await cachedRead(config, "contact", now, () =>
          listContactNames(client, { limit: CONTACT_LIMIT }),
        );
        const needle = value.trim();
        if (all.complete || needle === "" || needle.length > MAX_SEARCH_LENGTH) {
          return rankNames(all.names, value);
        }
        const key = `contact:${needle.toLocaleLowerCase("de")}`;
        const found = await cachedRead(config, key, now, () =>
          listContactNames(client, { query: needle, limit: CONTACT_SEARCH_LIMIT }),
        );
        return rankNames([...all.names, ...found.names], value);
      });
  }

  if (tools.has(COMPLETION_TOOLS.checkAccount)) {
    completers.checkAccount = (value) =>
      quietly(async () => {
        const accounts = await cachedRead(config, "checkAccount", now, async () => ({
          names: await listBankAccountNames(client),
          complete: true,
        }));
        return rankNames(accounts.names, value);
      });
  }

  return completers;
}
