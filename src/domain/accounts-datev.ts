/**
 * Booking accounts (Buchungskonten, `AccountDatev`) of the connected sevDesk account: the accounts
 * Update 2.0 voucher positions are booked on (`voucherPos.accountDatev`). Used to name accounts in
 * previews ("6815 Bürobedarf") and to tell expense, revenue and asset accounts apart; which tax
 * rules and rates an account allows comes from ReceiptGuidance (`receipt-guidance.ts`).
 *
 * Source: the undocumented `GET /AccountDatev` (spec/deviations.md D-024), recorded on the trial
 * account on 2026-11-07 (`test/fixtures/recorded/2026-11-07/meta/account-datev.json`, SKR04): rows
 * of 28 keys with scalars as strings, among them `number` / `translatedNumber` (the number in the
 * account's chart; `number03` is the SKR03 number), `name` / `translatedName`, the flags
 * `expenseAccount`, `revenueAccount`, `assetAccount`, `deactivated`, `deprecated` ("0"/"1", or
 * `null`) and `hidden` ("0" or `false`), and `validFrom` / `validUntil` (ISO date-times; the same
 * account number can appear in several rows with different validity, e.g. "4400 Erlöse 19 %" for
 * the 2020 VAT cut). The M4 probe (2026-11-08, same account) found 100 rows in all, `total` a
 * number, `limit`/`offset` paging, and every filter (`expenseAccount`, `number`, …) ignored, so
 * nothing is filtered upstream. The endpoint lists fewer accounts than ReceiptGuidance names (652,
 * 569 of their ids not among the 100), so a preview falls back to the guidance's number and name.
 * {@link fetchAccountsDatev} pages until `total` is reached or an empty page, and stops at a page
 * without new ids (an ignored `offset`) or at {@link MAX_ACCOUNTS}.
 *
 * Names are typed by sevDesk staff but still treated as untrusted text: sanitized here and never
 * put into error messages.
 *
 * Caching: the chart changes only when the user edits it, so {@link loadAccountsDatev} keeps it
 * per cache owner (tools pass `ctx.config`, as for ReceiptGuidance) for
 * {@link ACCOUNTS_DATEV_TTL_MS}. Failures are not cached.
 */
import { z } from "zod";

import { parseUpstream, zBerlinDate, zBool01, zId, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { cleanText, compact } from "./common.js";

const NAME_MAX = 200;
const NUMBER_MAX = 20;
const PAGE_LIMIT = 1000;
/** Most accounts read (a full SKR chart has a few thousand); more is reported as truncated. */
export const MAX_ACCOUNTS = 10_000;

/** How long a cached account list is reused: 15 minutes. */
const ACCOUNTS_DATEV_TTL_MS = 15 * 60_000;

/** What an account books: expense (Aufwand), revenue (Erlös), asset or other (balance accounts). */
type AccountDatevKind = "expense" | "revenue" | "asset" | "other";

/** One booking account. */
export interface AccountDatev {
  readonly id: number;
  /** Number in the account's chart (SKR03/SKR04), e.g. "6815"; sanitized. */
  readonly number?: string | undefined;
  /** Untrusted (sanitized) name, e.g. "Bürobedarf". */
  readonly name?: string | undefined;
  /** expense (Aufwand), revenue (Erlös), asset (Anlagevermögen) or other (balance accounts). */
  readonly kind: AccountDatevKind;
  /** False when sevDesk marks it deactivated, deprecated or hidden. */
  readonly active: boolean;
  /** First valid day, `YYYY-MM-DD` (Berlin); absent: always. */
  readonly validFrom?: string | undefined;
  /** Last valid day, `YYYY-MM-DD` (Berlin); absent: open-ended. */
  readonly validUntil?: string | undefined;
}

/** A fetched account list. */
export interface AccountDatevList {
  readonly accounts: readonly AccountDatev[];
  /** True when not every account could be read (cap hit, or sevDesk ignored `offset`). */
  readonly truncated: boolean;
}

const accountRecordSchema = z.object({
  id: zId,
  number: zText,
  translatedNumber: zText,
  name: zText,
  translatedName: zText,
  expenseAccount: zBool01.optional(),
  revenueAccount: zBool01.optional(),
  assetAccount: zBool01.optional(),
  deactivated: zBool01.optional(),
  deprecated: zBool01.optional(),
  hidden: zBool01.optional(),
  validFrom: zBerlinDate,
  validUntil: zBerlinDate,
});

type AccountRecord = z.output<typeof accountRecordSchema>;

/** Maps one raw `AccountDatev` row (lenient; a row that does not fit is `unexpected_response`). */
export function toAccountDatev(raw: unknown): AccountDatev {
  const record = parseUpstream(accountRecordSchema, raw, "a booking account (AccountDatev)");
  return compact({
    id: record.id,
    number: cleanText(record.translatedNumber ?? record.number, NUMBER_MAX),
    name: cleanText(record.translatedName ?? record.name, NAME_MAX),
    kind: kindOf(record),
    active: record.deactivated !== true && record.deprecated !== true && record.hidden !== true,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  });
}

function kindOf(record: AccountRecord): AccountDatevKind {
  const expense = record.expenseAccount === true;
  const revenue = record.revenueAccount === true;
  if (expense && !revenue) return "expense";
  if (revenue && !expense) return "revenue";
  if (record.assetAccount === true) return "asset";
  return "other";
}

/**
 * Reads every booking account (`GET /AccountDatev`, uncached), page by page with an explicit
 * `limit` (D-019), until sevDesk's `total` is reached or a page is empty. A page that adds no new
 * id means sevDesk ignored `offset`, which ends the read as `truncated`, as does reaching
 * {@link MAX_ACCOUNTS}.
 */
export async function fetchAccountsDatev(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<AccountDatevList> {
  const byId = new Map<number, AccountDatev>();
  let offset = 0;
  for (;;) {
    const page = await client.list(
      "/AccountDatev",
      {},
      { limit: PAGE_LIMIT, offset, ...(signal === undefined ? {} : { signal }) },
    );
    if (page.items.length === 0) return { accounts: [...byId.values()], truncated: false };
    let added = 0;
    for (const raw of page.items) {
      const account = toAccountDatev(raw);
      if (!byId.has(account.id)) {
        byId.set(account.id, account);
        added += 1;
      }
    }
    offset += page.items.length;
    if (page.total !== undefined && offset >= page.total) {
      return { accounts: [...byId.values()], truncated: false };
    }
    if (added === 0 || byId.size >= MAX_ACCOUNTS) {
      return { accounts: [...byId.values()], truncated: true };
    }
  }
}

/** Options of {@link loadAccountsDatev}. */
export interface AccountsDatevCacheOptions {
  /** Object the cache belongs to (a `WeakMap` key); tools pass `ctx.config`. */
  readonly cacheOwner: object;
  readonly signal?: AbortSignal | undefined;
  /** Defaults to {@link ACCOUNTS_DATEV_TTL_MS}. */
  readonly ttlMs?: number;
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly expires: number;
  readonly value: AccountDatevList;
}

const cache = new WeakMap<object, CacheEntry>();

/** {@link fetchAccountsDatev} with a per-owner cache; only successful reads are cached. */
export async function loadAccountsDatev(
  client: SevdeskClient,
  options: AccountsDatevCacheOptions,
): Promise<AccountDatevList> {
  const now = options.now ?? Date.now;
  const hit = cache.get(options.cacheOwner);
  if (hit !== undefined && hit.expires > now()) return hit.value;
  const value = await fetchAccountsDatev(client, options.signal);
  cache.set(options.cacheOwner, {
    expires: now() + (options.ttlMs ?? ACCOUNTS_DATEV_TTL_MS),
    value,
  });
  return value;
}

/** Drops the cached accounts of `owner`. */
export function clearAccountsDatevCache(owner: object): void {
  cache.delete(owner);
}

/** The account with `id`, if the list has it. */
export function findAccountDatev(
  list: AccountDatevList | readonly AccountDatev[],
  id: number,
): AccountDatev | undefined {
  const accounts = "accounts" in list ? list.accounts : list;
  return accounts.find((account) => account.id === id);
}

/** Whether `account` is valid on `date` (`YYYY-MM-DD`, both bounds inclusive). */
export function isValidOn(account: AccountDatev, date: string): boolean {
  return (
    (account.validFrom === undefined || account.validFrom <= date) &&
    (account.validUntil === undefined || date <= account.validUntil)
  );
}

/**
 * The account for previews: "6815 Bürobedarf" (number only when plain digits, then the sanitized
 * name), "account 4266" when the account or its number and name are unknown. The result contains
 * sevDesk text: for previews (facts), never for error messages.
 */
export function accountLabel(list: AccountDatevList | readonly AccountDatev[], id: number): string {
  const account = findAccountDatev(list, id);
  const number =
    account?.number !== undefined && /^\d{1,12}$/.test(account.number) ? account.number : undefined;
  const parts = [number, account?.name].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? `account ${String(id)}` : parts.join(" ");
}
