/**
 * ReceiptGuidance (Kontierungshilfe): which booking accounts (`AccountDatev`) a receipt may use,
 * and which tax rules and tax rates each account allows. Voucher writes check their
 * account × tax rule × tax rate combination against it before anything is sent, because sevDesk
 * rejects wrong combinations late and with unhelpful messages (spec/deviations.md D-006).
 *
 * Endpoints (spec tag `Voucher`, schema `ReceiptGuideDto`): `GET /ReceiptGuidance/forAllAccounts`,
 * `/forRevenue`, `/forExpense`, `/forAccountNumber?accountNumber=…` and `/forTaxRule?taxRule=…`
 * (tax rule code, e.g. `USTPFL_UMS_EINN`); the last two answer 422 when nothing matches.
 *
 * Shape: a real `forAllAccounts` response published by sevdesk-rs
 * (https://github.com/jernoxit/sevdesk-rs, `tests/fixtures/receipt_guidance.json`, Update 2.0,
 * 2026). Unlike most sevDesk responses its ids are JSON numbers; tax rates are words (`ZERO`,
 * `SEVEN`, `NINETEEN`) and receipt types `EXPENSE`/`REVENUE`. Parsing is lenient (string or
 * number ids, numeric rate strings), and unknown rate words or receipt types are kept apart
 * instead of failing the list. Account names and descriptions are typed by sevDesk staff but
 * still treated as untrusted text: sanitized in output and never used in messages.
 *
 * Caching: the guidance changes only when the account's chart of accounts or tax settings change,
 * so {@link loadReceiptGuidance} keeps it per cache owner for {@link RECEIPT_GUIDANCE_TTL_MS}.
 * Tools pass `ctx.config` as the owner: it identifies the account (token) and lives as long as
 * the server, whereas `ctx.client` is a per-call wrapper inside write tools.
 */
import { z } from "zod";

import { SevdeskError } from "../sevdesk/errors.js";
import { parseUpstream, zId, zText } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { cleanText, compact } from "./common.js";
import { type Phrase, phrase, type PreviewLanguage } from "./preview-text.js";
import { taxRuleById } from "./reference-data.js";

const NAME_MAX = 200;
const DESCRIPTION_MAX = 500;
const CODE_MAX = 100;
/** sevDesk's maximum page size; one page is read (see {@link fetchReceiptGuidance}). */
const PAGE_LIMIT = 1000;

/** How long cached guidance is reused: 15 minutes. */
export const RECEIPT_GUIDANCE_TTL_MS = 15 * 60_000;

export const RECEIPT_TYPES = ["expense", "revenue"] as const;
type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** Rate words sevDesk uses in `taxRates` (seen: ZERO, SEVEN, NINETEEN; the others by analogy). */
const RATE_WORDS: Readonly<Record<string, number>> = {
  ZERO: 0,
  FIVE: 5,
  SEVEN: 7,
  SIXTEEN: 16,
  NINETEEN: 19,
};

// ---------------------------------------------------------------------------------------------
// Upstream schema (lenient)
// ---------------------------------------------------------------------------------------------

const ruleRecordSchema = z.object({
  id: zId,
  name: zText,
  description: zText,
  taxRates: z
    .array(z.union([z.string(), z.number()]))
    .nullish()
    .transform((value) => value ?? []),
});

const guideRecordSchema = z.object({
  accountDatevId: zId,
  accountNumber: zText,
  accountName: zText,
  description: zText,
  allowedTaxRules: z
    .array(ruleRecordSchema)
    .nullish()
    .transform((value) => value ?? []),
  allowedReceiptTypes: z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []),
});

type GuideRecord = z.output<typeof guideRecordSchema>;

// ---------------------------------------------------------------------------------------------
// Parsed guidance
// ---------------------------------------------------------------------------------------------

/** A tax rule an account allows, with the tax rates allowed for it. */
interface GuideTaxRule {
  readonly id: number;
  /** sevDesk's code (`name` upstream), e.g. `USTPFL_UMS_EINN`; sanitized. */
  readonly code?: string | undefined;
  /** Allowed tax rates in percent, ascending. */
  readonly taxRates: readonly number[];
  /** Rate words this module does not know (kept so validation can say it could not decide). */
  readonly unknownTaxRates: readonly string[];
}

/** One account a receipt may be booked on. */
export interface ReceiptGuide {
  readonly accountDatevId: number;
  /** Account number in the account's chart (SKR03/SKR04), e.g. "4400"; sanitized. */
  readonly accountNumber?: string | undefined;
  /** Untrusted (sanitized) account name, e.g. "Erlöse 19 % USt". */
  readonly accountName?: string | undefined;
  /** Untrusted (sanitized) explanation of what the account is for. */
  readonly description?: string | undefined;
  readonly receiptTypes: readonly ReceiptType[];
  readonly taxRules: readonly GuideTaxRule[];
}

/** A fetched guidance list. */
export interface ReceiptGuidanceList {
  readonly guides: readonly ReceiptGuide[];
  /** True when sevDesk had more entries than one page of {@link PAGE_LIMIT} could hold. */
  readonly truncated: boolean;
}

function toGuide(record: GuideRecord): ReceiptGuide {
  const receiptTypes = RECEIPT_TYPES.filter((type) =>
    record.allowedReceiptTypes.some((value) => value.trim().toLowerCase() === type),
  );
  return compact({
    accountDatevId: record.accountDatevId,
    accountNumber: cleanText(record.accountNumber, CODE_MAX),
    accountName: cleanText(record.accountName, NAME_MAX),
    description: cleanText(record.description, DESCRIPTION_MAX),
    receiptTypes,
    taxRules: record.allowedTaxRules.map((rule) => {
      const known: number[] = [];
      const unknown: string[] = [];
      for (const token of rule.taxRates) {
        const rate = taxRateOf(token);
        if (rate === undefined) {
          unknown.push(cleanText(String(token), CODE_MAX) ?? "");
        } else if (!known.includes(rate)) {
          known.push(rate);
        }
      }
      return compact({
        id: rule.id,
        code: cleanText(rule.name, CODE_MAX),
        taxRates: known.sort((a, b) => a - b),
        unknownTaxRates: unknown.filter((token) => token !== ""),
      });
    }),
  });
}

/** A rate word (`NINETEEN`), a numeric string ("19", "7.0") or a number, in percent. */
function taxRateOf(token: string | number): number | undefined {
  if (typeof token === "number") return Number.isFinite(token) ? token : undefined;
  const text = token.trim().toUpperCase();
  if (Object.hasOwn(RATE_WORDS, text)) return RATE_WORDS[text];
  return /^\d{1,3}(\.\d+)?$/.test(text) ? Number(text) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Fetching and caching
// ---------------------------------------------------------------------------------------------

/** Which ReceiptGuidance endpoint to ask. */
export type ReceiptGuidanceScope =
  | { readonly kind: "all" }
  | { readonly kind: "revenue" }
  | { readonly kind: "expense" }
  /** One account by its number in the chart of accounts, e.g. "4400". */
  | { readonly kind: "account_number"; readonly accountNumber: string }
  /** Accounts that allow a tax rule, by its code, e.g. `USTPFL_UMS_EINN`. */
  | { readonly kind: "tax_rule"; readonly code: string };

function endpointOf(scope: ReceiptGuidanceScope): {
  path: string;
  query: Record<string, QueryValue>;
} {
  switch (scope.kind) {
    case "all":
      return { path: "/ReceiptGuidance/forAllAccounts", query: {} };
    case "revenue":
      return { path: "/ReceiptGuidance/forRevenue", query: {} };
    case "expense":
      return { path: "/ReceiptGuidance/forExpense", query: {} };
    case "account_number":
      return {
        path: "/ReceiptGuidance/forAccountNumber",
        query: { accountNumber: scope.accountNumber },
      };
    case "tax_rule":
      return { path: "/ReceiptGuidance/forTaxRule", query: { taxRule: scope.code } };
  }
}

function cacheKey(scope: ReceiptGuidanceScope): string {
  switch (scope.kind) {
    case "account_number":
      return `account_number:${scope.accountNumber}`;
    case "tax_rule":
      return `tax_rule:${scope.code}`;
    default:
      return scope.kind;
  }
}

/**
 * Reads one ReceiptGuidance endpoint, uncached. It is not documented as paged, so one page of
 * {@link PAGE_LIMIT} is requested with an explicit `limit` (an omitted limit truncates other
 * collections at 100, D-019) and `truncated` reports a full page. The 422 that
 * `forAccountNumber`/`forTaxRule` answer when nothing matches becomes an empty list. Every row
 * must parse; one that does not is an `unexpected_response` error.
 */
export async function fetchReceiptGuidance(
  client: SevdeskClient,
  scope: ReceiptGuidanceScope,
  signal?: AbortSignal,
): Promise<ReceiptGuidanceList> {
  const { path, query } = endpointOf(scope);
  let page;
  try {
    page = await client.list(path, query, {
      limit: PAGE_LIMIT,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    const lookup = scope.kind === "account_number" || scope.kind === "tax_rule";
    if (
      lookup &&
      error instanceof SevdeskError &&
      error.kind === "validation" &&
      error.status === 422
    ) {
      return { guides: [], truncated: false };
    }
    throw error;
  }
  const guides = page.items.map((raw) =>
    toGuide(parseUpstream(guideRecordSchema, raw, "receipt guidance")),
  );
  const truncated =
    page.total === undefined ? page.items.length >= PAGE_LIMIT : page.total > page.items.length;
  return { guides, truncated };
}

/** Options of {@link loadReceiptGuidance}. */
export interface ReceiptGuidanceCacheOptions {
  /**
   * Object the cache belongs to; entries live as long as it does (a `WeakMap` key). Tools pass
   * `ctx.config` (see the module comment).
   */
  readonly cacheOwner: object;
  readonly signal?: AbortSignal | undefined;
  /** Defaults to {@link RECEIPT_GUIDANCE_TTL_MS}. */
  readonly ttlMs?: number;
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly expires: number;
  readonly value: ReceiptGuidanceList;
}

const caches = new WeakMap<object, Map<string, CacheEntry>>();

/**
 * {@link fetchReceiptGuidance} with a per-owner cache. Only successful reads are cached, so a
 * failed or cancelled read is retried by the next call; concurrent misses each fetch once.
 */
export async function loadReceiptGuidance(
  client: SevdeskClient,
  scope: ReceiptGuidanceScope,
  options: ReceiptGuidanceCacheOptions,
): Promise<ReceiptGuidanceList> {
  const now = options.now ?? Date.now;
  const key = cacheKey(scope);
  let cache = caches.get(options.cacheOwner);
  const hit = cache?.get(key);
  if (hit !== undefined && hit.expires > now()) return hit.value;

  const value = await fetchReceiptGuidance(client, scope, options.signal);
  if (cache === undefined) {
    cache = new Map();
    caches.set(options.cacheOwner, cache);
  }
  cache.set(key, { expires: now() + (options.ttlMs ?? RECEIPT_GUIDANCE_TTL_MS), value });
  return value;
}

/** Drops every cached guidance list of `owner`. */
export function clearReceiptGuidanceCache(owner: object): void {
  caches.delete(owner);
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** What a receipt (voucher) position wants to book. */
export interface AccountTaxRuleInput {
  readonly accountDatevId: number;
  readonly taxRuleId: number;
  /** Tax rate in percent, e.g. 19. */
  readonly taxRate: number;
  readonly direction: ReceiptType;
}

type AccountTaxRuleProblemCode =
  "unknown_account" | "wrong_direction" | "tax_rule_not_allowed" | "tax_rate_not_allowed";

/** A combination sevDesk would reject; `message` is trusted and says what to use instead. */
interface AccountTaxRuleProblem {
  readonly code: AccountTaxRuleProblemCode;
  readonly message: string;
}

export interface AccountTaxRuleCheck {
  /** True when no problem was found. */
  readonly ok: boolean;
  readonly problems: readonly AccountTaxRuleProblem[];
  /**
   * Trusted notes about what could not be checked (e.g. a rate word this server does not know),
   * in both preview languages.
   */
  readonly warnings: readonly Phrase[];
}

const LOOKUP_HINT = "sevdesk_reference_lookup kind=receipt_guidance";

/**
 * Checks an account × tax rule × tax rate × direction combination against guidance rows (pure).
 * Messages are trusted: they name accounts by id and (digits-only) number and tax rules by id and
 * this server's reference code, never by sevDesk's free text.
 */
export function checkAccountTaxRule(
  guides: readonly ReceiptGuide[],
  input: AccountTaxRuleInput,
): AccountTaxRuleCheck {
  const guide = guides.find((entry) => entry.accountDatevId === input.accountDatevId);
  if (guide === undefined) {
    return result(
      [
        {
          code: "unknown_account",
          message:
            `Account ${input.accountDatevId} (accountDatev) is not an account receipts can be ` +
            `booked on in this sevDesk account. Look up valid accounts with ${LOOKUP_HINT}.`,
        },
      ],
      [],
    );
  }

  const account = accountLabel(guide);
  const problems: AccountTaxRuleProblem[] = [];
  const warnings: Phrase[] = [];

  if (!guide.receiptTypes.includes(input.direction)) {
    const allowed = guide.receiptTypes.length === 0 ? "none" : guide.receiptTypes.join(", ");
    problems.push({
      code: "wrong_direction",
      message:
        `${account} cannot be used for ${input.direction} receipts (allowed receipt types: ` +
        `${allowed}). Pick an account for ${input.direction} receipts with ${LOOKUP_HINT} ` +
        `receiptType=${input.direction}.`,
    });
  }

  const rule = guide.taxRules.find((entry) => entry.id === input.taxRuleId);
  if (rule === undefined) {
    const allowed = guide.taxRules.map((entry) => ruleLabel(entry.id)).join(", ");
    problems.push({
      code: "tax_rule_not_allowed",
      message:
        `Tax rule ${ruleLabel(input.taxRuleId)} is not allowed with ${account}. Allowed tax ` +
        `rules: ${allowed === "" ? "none" : allowed}.`,
    });
  } else if (!rule.taxRates.includes(input.taxRate)) {
    if (rule.unknownTaxRates.length > 0) {
      warnings.push(
        phrase(
          `The tax rates sevDesk allows for tax rule ${ruleLabel(rule.id)} with ${account} ` +
            "include values this server does not know, so the tax rate could not be checked.",
          `Die Steuersätze, die sevDesk für die Steuerregel ${ruleLabel(rule.id)} mit ` +
            `${accountLabel(guide, "de")} zulässt, enthalten Werte, die dieser Server nicht ` +
            "kennt; der Steuersatz konnte daher nicht geprüft werden.",
        ),
      );
    } else {
      const allowed = rule.taxRates.map((rate) => `${rate}%`).join(", ");
      problems.push({
        code: "tax_rate_not_allowed",
        message:
          `Tax rate ${input.taxRate}% is not allowed for tax rule ${ruleLabel(rule.id)} with ` +
          `${account}. Allowed tax rates: ${allowed === "" ? "none" : allowed}.`,
      });
    }
  }
  return result(problems, warnings);
}

/**
 * {@link checkAccountTaxRule} against the account's cached `forAllAccounts` guidance. When that
 * list was truncated and the account is missing from it, the account cannot be checked (sevDesk
 * has no guidance lookup by account id), so the result says so as a warning instead of reporting
 * an unknown account.
 */
export async function validateAccountTaxRule(
  client: SevdeskClient,
  input: AccountTaxRuleInput,
  options: ReceiptGuidanceCacheOptions,
): Promise<AccountTaxRuleCheck> {
  const list = await loadReceiptGuidance(client, { kind: "all" }, options);
  const check = checkAccountTaxRule(list.guides, input);
  const unknown = check.problems.some((problem) => problem.code === "unknown_account");
  if (unknown && list.truncated) {
    return result(
      [],
      [
        phrase(
          `sevDesk's receipt guidance has more accounts than could be read, and account ` +
            `${input.accountDatevId} is not among those read, so it could not be checked.`,
          `Die Buchungshilfe von sevDesk (ReceiptGuidance) enthält mehr Konten, als gelesen ` +
            `werden konnten, und das Konto ${input.accountDatevId} ist nicht darunter; es ` +
            `konnte daher nicht geprüft werden.`,
        ),
      ],
    );
  }
  return check;
}

function result(
  problems: readonly AccountTaxRuleProblem[],
  warnings: readonly Phrase[],
): AccountTaxRuleCheck {
  return { ok: problems.length === 0, problems, warnings };
}

/** "account 4285 (no. 4970)": the number only when it is plain digits (it is sevDesk data). */
function accountLabel(guide: ReceiptGuide, lang: PreviewLanguage = "en"): string {
  const number = guide.accountNumber;
  const [word, no] = lang === "de" ? ["Konto", "Nr."] : ["account", "no."];
  return number !== undefined && /^\d{1,12}$/.test(number)
    ? `${word} ${guide.accountDatevId} (${no} ${number})`
    : `${word} ${guide.accountDatevId}`;
}

/** "9 (VORST_ABZUGSF_AUFW)" with this server's reference code, or the bare id if unknown. */
function ruleLabel(id: number): string {
  const rule = taxRuleById(id);
  return rule === undefined ? String(id) : `${id} (${rule.code})`;
}
