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
 * The same answer also carries the account's own company as printed on outgoing invoices (name,
 * address, VAT id, tax number, bank account, contact): {@link loadAccountCompany} reads those
 * fields (recorded keys `name`, `addressStreet`, `addressZip`, `addressCity`, `addressCountry`,
 * `vatNumber`, `taxNumber`, `bankIban`, `bankBic`, `contactEmail`, `contactPhone`; sevDesk.NET
 * recording 2026-02-19, the same object our trial answered). The e-invoice tools use them to tell
 * whether the account is the buyer or the seller of an e-invoice and to check the seller data of
 * outgoing e-invoices. Every company field is optional and parsed leniently: an unreadable value
 * is dropped, never fatal. The company IBAN may be compared, but anything shown to a model or a
 * human masks it (`maskIban`).
 *
 * Caching: the settings change rarely (the user switches the regime in sevDesk's settings), so
 * {@link loadAccountSettings} and {@link loadAccountCompany} share one successful read per cache
 * owner for {@link ACCOUNT_SETTINGS_TTL_MS}. Tools pass `ctx.config` as the owner: it identifies
 * the account (token) and lives as long as the server, whereas `ctx.client` is a per-call wrapper
 * inside write tools. Failures are not cached.
 */
import { z } from "zod";

import { SevdeskError, type SevdeskErrorKind } from "../sevdesk/errors.js";
import { parseUpstream, zBool01, zOptionalRef, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { cleanText } from "./common.js";
import type { TaxRule } from "./reference-data.js";

/** The VAT regulation of an account, as `TaxRule.regimes` names it. */
export type TaxRegime = TaxRule["regimes"][number];

export interface AccountSettings {
  /** True for the Kleinunternehmer regulation (§19 UStG): documents show no VAT. */
  readonly smallBusiness: boolean;
  /** Lower-case chart of accounts code, e.g. "skr04"; absent when sevDesk sent none. */
  readonly chartOfAccounts?: string | undefined;
}

/**
 * The account's own company from `GET /SevClient`. Every field is optional (absent when sevDesk
 * sent nothing readable). Text is user-entered sevDesk data, cleaned with `cleanText`; still
 * untrusted. `iban` is unmasked for comparisons only: show it through `maskIban`.
 */
export interface AccountCompany {
  /** `name`. */
  readonly name?: string;
  /** `vatNumber`: USt-IdNr. */
  readonly vatNumber?: string;
  /** `taxNumber`: Steuernummer. */
  readonly taxNumber?: string;
  /** `addressStreet`. */
  readonly street?: string;
  /** `addressZip`. */
  readonly zip?: string;
  /** `addressCity`. */
  readonly city?: string;
  /** `addressCountry.id` (StaticCountry). */
  readonly countryId?: number;
  /** `bankIban`, spaces removed, upper case. */
  readonly iban?: string;
  /** `bankBic`. */
  readonly bic?: string;
  /** `contactEmail`. */
  readonly email?: string;
  /** `contactPhone`. */
  readonly phone?: string;
}

/** Settings and company from one `GET /SevClient` answer (what the cache keeps). */
interface AccountProfile {
  readonly settings: AccountSettings;
  readonly company: AccountCompany;
}

/** How long cached settings are reused: 5 minutes (a regime switch shows up within that time). */
export const ACCOUNT_SETTINGS_TTL_MS = 5 * 60_000;

/** A chart of accounts code: short letters and digits ("skr03", "skr04"); anything else is dropped. */
const CHART_OF_ACCOUNTS = /^[a-z0-9]{2,16}$/;

const sevClientSchema = z.object({
  smallSettlement: zBool01.optional(),
  chartOfAccounts: zText,
});

/** Company text: anything that is not text, a number or null is dropped instead of failing. */
const companyText = zText.catch(undefined);

/** The company fields of `GET /SevClient`; every field falls back to absent (never fatal). */
const companySchema = z.object({
  name: companyText,
  vatNumber: companyText,
  taxNumber: companyText,
  addressStreet: companyText,
  addressZip: companyText,
  addressCity: companyText,
  addressCountry: zOptionalRef.catch(undefined),
  bankIban: companyText,
  bankBic: companyText,
  contactEmail: companyText,
  contactPhone: companyText,
});

/** Longest company text kept (names, streets, e-mail addresses). */
const COMPANY_TEXT_MAX = 200;

/**
 * Reads the account settings from `GET /SevClient`. Throws `unexpected_response` when the answer
 * has no object or no readable `smallSettlement` (the regime would be a guess).
 */
export async function fetchAccountSettings(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<AccountSettings> {
  return (await fetchAccountProfile(client, signal)).settings;
}

async function fetchAccountProfile(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
): Promise<AccountProfile> {
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
    settings: {
      smallBusiness: record.smallSettlement,
      ...(chart !== undefined && CHART_OF_ACCOUNTS.test(chart) ? { chartOfAccounts: chart } : {}),
    },
    company: companyOf(row),
  };
}

function companyOf(row: object): AccountCompany {
  const parsed = companySchema.safeParse(row);
  if (!parsed.success) return {};
  const record = parsed.data;
  const text = (value: string | undefined): string | undefined =>
    cleanText(value, COMPANY_TEXT_MAX);
  const iban = text(record.bankIban)?.replace(/\s+/g, "").toUpperCase();
  const company: Record<string, string | number | undefined> = {
    name: text(record.name),
    vatNumber: text(record.vatNumber),
    taxNumber: text(record.taxNumber),
    street: text(record.addressStreet),
    zip: text(record.addressZip),
    city: text(record.addressCity),
    countryId: record.addressCountry?.id,
    iban: iban === "" ? undefined : iban,
    bic: text(record.bankBic),
    email: text(record.contactEmail),
    phone: text(record.contactPhone),
  };
  return Object.fromEntries(Object.entries(company).filter(([, value]) => value !== undefined));
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
  readonly value: AccountProfile;
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
  return (await loadAccountProfile(client, options))?.settings;
}

/**
 * The account's own company (see {@link AccountCompany}), from the same cached `GET /SevClient`
 * read as {@link loadAccountSettings} (one request serves both). `undefined` when sevDesk does
 * not provide readable settings, exactly when {@link loadAccountSettings} returns `undefined`.
 */
export async function loadAccountCompany(
  client: SevdeskClient,
  options: AccountSettingsCacheOptions,
): Promise<AccountCompany | undefined> {
  return (await loadAccountProfile(client, options))?.company;
}

async function loadAccountProfile(
  client: SevdeskClient,
  options: AccountSettingsCacheOptions,
): Promise<AccountProfile | undefined> {
  const now = options.now ?? Date.now;
  const hit = cache.get(options.cacheOwner);
  if (options.fresh !== true && hit !== undefined && hit.expires > now()) return hit.value;
  let value: AccountProfile;
  try {
    value = await fetchAccountProfile(client, options.signal);
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
