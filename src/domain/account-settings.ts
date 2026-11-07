/**
 * Account-wide settings of the connected sevDesk account that decide how documents must be
 * written: the VAT regulation (regular VAT or Kleinunternehmer, §19 UStG) and the chart of
 * accounts (SKR03/SKR04).
 *
 * Source: `GET /SevClient` (undocumented). Recorded on the trial account on 2026-11-07: it answers
 * one object with 92 fields, among them `smallSettlement` ("1" Kleinunternehmer, "0" regular VAT)
 * and `chartOfAccounts` ("skr04"); the same fields appear on the `sevClient` object sevDesk.NET
 * recorded inside other responses. Parsing is lenient (an array or a single object, the first row
 * wins; only these two fields are read). Why it matters: on a Kleinunternehmer account sevDesk
 * refuses to finalize a document with tax rule 1 (422 "Tax rule 'USTPFL_UMS_EINN' is not valid
 * for account '4400' with taxation scope 'SMALL_BUSINESS'", recorded), so the draft tools pick
 * the tax rule from the regime.
 *
 * Caching: the settings change rarely (the user switches the regime in sevDesk's settings), so
 * {@link loadAccountSettings} keeps a successful read per cache owner for
 * {@link ACCOUNT_SETTINGS_TTL_MS}. Tools pass `ctx.config` as the owner: it identifies the account
 * (token) and lives as long as the server, whereas `ctx.client` is a per-call wrapper inside write
 * tools. Failures are not cached.
 */
import { z } from "zod";

import { SevdeskError, type SevdeskErrorKind } from "../sevdesk/errors.js";
import { parseUpstream, zBool01, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import type { TaxRule } from "./reference-data.js";

/** The VAT regulation of an account, as `TaxRule.regimes` names it. */
export type TaxRegime = TaxRule["regimes"][number];

export interface AccountSettings {
  /** True for the Kleinunternehmer regulation (§19 UStG): documents show no VAT. */
  readonly smallBusiness: boolean;
  /** Lower-case chart of accounts code, e.g. "skr04"; absent when sevDesk sent none. */
  readonly chartOfAccounts?: string | undefined;
}

/** How long cached settings are reused: 5 minutes (a regime switch shows up within that time). */
export const ACCOUNT_SETTINGS_TTL_MS = 5 * 60_000;

/** A chart of accounts code: short letters and digits ("skr03", "skr04"); anything else is dropped. */
const CHART_OF_ACCOUNTS = /^[a-z0-9]{2,16}$/;

const sevClientSchema = z.object({
  smallSettlement: zBool01.optional(),
  chartOfAccounts: zText,
});

/**
 * Reads the account settings from `GET /SevClient`. Throws `unexpected_response` when the answer
 * has no object or no readable `smallSettlement` (the regime would be a guess).
 */
export async function fetchAccountSettings(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<AccountSettings> {
  const payload = await client.request({
    method: "GET",
    path: "/SevClient",
    ...(signal === undefined ? {} : { signal }),
  });
  const row: unknown = Array.isArray(payload) ? (payload as unknown[])[0] : payload;
  if (typeof row !== "object" || row === null) throw unreadable();
  const record = parseUpstream(sevClientSchema, row, "the account settings");
  if (record.smallSettlement === undefined) throw unreadable();
  const chart = record.chartOfAccounts?.trim().toLowerCase();
  return {
    smallBusiness: record.smallSettlement,
    ...(chart !== undefined && CHART_OF_ACCOUNTS.test(chart) ? { chartOfAccounts: chart } : {}),
  };
}

/** Options of {@link loadAccountSettings}. */
export interface AccountSettingsCacheOptions {
  /** Object the cache belongs to (a `WeakMap` key); tools pass `ctx.config`. */
  readonly cacheOwner: object;
  readonly signal?: AbortSignal | undefined;
  /** Skip a cached value (the fresh one is still cached), e.g. for `sevdesk_account_info`. */
  readonly fresh?: boolean;
  /** Defaults to {@link ACCOUNT_SETTINGS_TTL_MS}. */
  readonly ttlMs?: number;
  /** Clock in epoch milliseconds (tests). */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly expires: number;
  readonly value: AccountSettings;
}

const cache = new WeakMap<object, CacheEntry>();

/**
 * Failure kinds that mean "this account's settings cannot be read here" (the endpoint is gone,
 * answers differently or breaks): {@link loadAccountSettings} then returns `undefined` so callers
 * can fall back. A 403 counts too (see {@link isUnreadable}). Everything else (401, rate limit,
 * network, timeout, cancellation) would break any other read as well and is rethrown.
 */
const UNREADABLE_KINDS: ReadonlySet<SevdeskErrorKind> = new Set([
  "not_found",
  "validation",
  "server",
  "unexpected_response",
]);

/**
 * Whether `error` means the settings are unreadable for this token rather than a broken call:
 * one of {@link UNREADABLE_KINDS}, or a 403 (a restricted sevDesk user may be refused the account
 * settings yet still work with documents). A 401 (token wrong or revoked) is not.
 */
function isUnreadable(error: SevdeskError): boolean {
  return UNREADABLE_KINDS.has(error.kind) || (error.kind === "auth" && error.status === 403);
}

/**
 * {@link fetchAccountSettings} with a per-owner cache. Returns `undefined` when sevDesk does not
 * provide readable settings (see {@link isUnreadable}); only successful reads are cached.
 */
export async function loadAccountSettings(
  client: SevdeskClient,
  options: AccountSettingsCacheOptions,
): Promise<AccountSettings | undefined> {
  const now = options.now ?? Date.now;
  const hit = cache.get(options.cacheOwner);
  if (options.fresh !== true && hit !== undefined && hit.expires > now()) return hit.value;
  let value: AccountSettings;
  try {
    value = await fetchAccountSettings(client, options.signal);
  } catch (error) {
    if (error instanceof SevdeskError && isUnreadable(error)) return undefined;
    throw error;
  }
  cache.set(options.cacheOwner, {
    expires: now() + (options.ttlMs ?? ACCOUNT_SETTINGS_TTL_MS),
    value,
  });
  return value;
}

/** Drops the cached settings of `owner`. */
export function clearAccountSettingsCache(owner: object): void {
  cache.delete(owner);
}

/** The regime of readable settings; `undefined` when they could not be read. */
export function taxRegimeOf(settings: AccountSettings | undefined): TaxRegime | undefined {
  if (settings === undefined) return undefined;
  return settings.smallBusiness ? "small_business" : "regular";
}

function unreadable(): SevdeskError {
  return new SevdeskError({
    kind: "unexpected_response",
    message: "sevDesk returned the account settings without the VAT regulation (smallSettlement).",
  });
}
