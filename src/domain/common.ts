/**
 * Shared building blocks for DTOs and list filters: one money shape for every amount the model
 * sees, ISO date ranges converted to sevDesk's Unix-second filters (Europe/Berlin days), and the
 * text and object helpers every mapper uses (untrusted text cleaning, dropping absent fields).
 */
import { z } from "zod";

import { sanitizeUntrusted } from "../safety/fence.js";
import { isIsoDate, toUnixSeconds } from "../sevdesk/dates.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  compare,
  decimal,
  DEFAULT_CURRENCY,
  isCurrencyCode,
  isDecimal,
  type Money,
  money,
  toDecimalString,
} from "./money.js";
import { statusByCode, type StatusObjectType } from "./reference-data.js";

/**
 * Every amount in tool output: an exact decimal string (never a float) plus its ISO-4217 currency.
 * Totals keep sevDesk's precision; nothing is rounded silently.
 */
export const moneySchema = z.object({
  amount: z.string().describe("Exact decimal amount, e.g. '119.00'."),
  currency: z.string().length(3).describe("ISO 4217 currency code, e.g. 'EUR'."),
});

/**
 * Builds a `Money` from an upstream decimal string (as produced by `zDecimalString`). `undefined`
 * stays `undefined`; an unset or empty currency falls back to EUR (sevDesk's default currency).
 * Amounts that are not decimals and currencies that are not ISO 4217 codes (see
 * {@link currencyCode}) raise `unexpected_response` instead of becoming NaN or a `MoneyError`.
 */
export function moneyFromUpstream(
  amount: string | undefined,
  currency: string | undefined,
): Money | undefined {
  if (amount === undefined) return undefined;
  if (!isDecimal(amount)) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message: "sevDesk returned an amount that is not a decimal number.",
    });
  }
  return money(amount, currencyCode(currency));
}

/**
 * An upstream currency code, trimmed and upper case; EUR (sevDesk's default) when unset or "".
 * Anything that is not an ISO 4217 code the runtime knows (e.g. "€", "EURO") is an
 * `unexpected_response` error: amounts in it cannot be represented, and the error says so instead
 * of failing later as an internal `MoneyError`. The value itself stays out of the message.
 */
export function currencyCode(currency: string | undefined): string {
  const code = currency?.trim().toUpperCase();
  if (code === undefined || code === "") return DEFAULT_CURRENCY;
  if (!isCurrencyCode(code)) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message: "sevDesk returned a currency that is not an ISO 4217 code.",
    });
  }
  return code;
}

/** The sum fields every sevDesk document and position has (decimal strings, see `zDecimalString`). */
export interface SumFields {
  readonly sumNet?: string | undefined;
  readonly sumTax?: string | undefined;
  readonly sumGross?: string | undefined;
  readonly sumNetForeignCurrency?: string | undefined;
  readonly sumTaxForeignCurrency?: string | undefined;
  readonly sumGrossForeignCurrency?: string | undefined;
}

/** Net, tax and gross in one currency; absent sums are left out. */
export interface Amounts {
  readonly net?: Money | undefined;
  readonly tax?: Money | undefined;
  readonly gross?: Money | undefined;
}

/**
 * The amounts of a document or position (invoice, credit note, order, voucher) in its own
 * `currency`, plus the EUR amounts sevDesk books when the two differ. sevDesk keeps the EUR value
 * in `sumNet`/`sumTax`/`sumGross` and the document's own amounts in `sum…ForeignCurrency`, which
 * are "0" for EUR documents (see the sales-document and voucher modules for the evidence). So:
 * EUR → the plain sums; another currency with non-zero foreign sums → those in `currency` plus the
 * plain sums as `eur`; another currency without foreign sums (zero or missing) → sevDesk did not
 * convert it, the plain sums are taken as `currency` and no EUR figure is claimed.
 */
export function splitTotals(
  record: SumFields,
  currency: string,
): { totals: Amounts; eur: Amounts | undefined } {
  const plain = { net: record.sumNet, tax: record.sumTax, gross: record.sumGross };
  if (currency === DEFAULT_CURRENCY) return { totals: toAmounts(plain, currency), eur: undefined };
  const foreign = {
    net: record.sumNetForeignCurrency,
    tax: record.sumTaxForeignCurrency,
    gross: record.sumGrossForeignCurrency,
  };
  const converted = [foreign.net, foreign.tax, foreign.gross].some(
    (value) => value !== undefined && compare(value, 0) !== 0,
  );
  if (!converted) return { totals: toAmounts(plain, currency), eur: undefined };
  return { totals: toAmounts(foreign, currency), eur: toAmounts(plain, DEFAULT_CURRENCY) };
}

function toAmounts(
  amounts: {
    readonly net: string | undefined;
    readonly tax: string | undefined;
    readonly gross: string | undefined;
  },
  currency: string,
): Amounts {
  return compact({
    net: moneyFromUpstream(amounts.net, currency),
    tax: moneyFromUpstream(amounts.tax, currency),
    gross: moneyFromUpstream(amounts.gross, currency),
  });
}

/** A status: the code sevDesk sends and its meaning from reference data. */
export const statusDtoSchema = z.object({
  code: z.number().int(),
  label: z.string().describe("Meaning from sevDesk's docs; 'unknown' for undocumented codes."),
});

export type StatusDto = z.output<typeof statusDtoSchema>;

/** `{code, label}`; an undocumented code is kept with the label "unknown", never dropped. */
export function statusDto(objectType: StatusObjectType, code: number): StatusDto {
  return { code, label: statusByCode(objectType, code)?.label ?? "unknown" };
}

/** Drops `undefined` members, so absent fields are left out of the JSON instead of set to null. */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}

/** The trimmed text, or `undefined` when nothing but whitespace is left. Does not sanitize. */
export function trimmedText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}

/**
 * Untrusted text from sevDesk for a DTO: trimmed, sanitized (see `sanitizeUntrusted`, capped at
 * `maxLength`) and trimmed again; `undefined` when nothing visible is left. Trimming first keeps
 * surrounding whitespace from counting toward the cap; trimming again removes whitespace that
 * invisible characters hid, so a value made only of them is left out instead of shown as "".
 */
export function cleanText(value: string | undefined, maxLength: number): string | undefined {
  const text = trimmedText(value);
  return text === undefined ? undefined : trimmedText(sanitizeUntrusted(text, maxLength));
}

const isoDate = z.string().refine(isIsoDate, { message: "expected a calendar date as YYYY-MM-DD" });

/** A calendar-date argument, `YYYY-MM-DD` (Europe/Berlin). Add `.describe(...)` per field. */
export const isoDateInput = isoDate;

/** Options of {@link amountInput}. */
export interface AmountInputOptions {
  /** Maximum fraction digits accepted (default 2). Excess digits are rejected, never rounded. */
  readonly places?: number;
  /** Accept amounts below zero (default false). */
  readonly allowNegative?: boolean;
  /** Accept zero (default true). */
  readonly allowZero?: boolean;
}

/**
 * An amount argument for write tools: a decimal string (`"1190.50"`) or a JSON number (`19.99`,
 * read through its shortest `String()` form, so no float arithmetic happens), parsed to an exact
 * decimal string without exponent, e.g. `"1190.5"`. Comma decimals ("1.190,50") are rejected
 * rather than guessed. Add `.describe(...)` per field (say the currency and net/gross).
 */
export function amountInput(options: AmountInputOptions = {}) {
  const places = options.places ?? 2;
  return z.union([z.string(), z.number()]).transform((value, ctx): string => {
    const text = typeof value === "number" ? String(value) : value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !isDecimal(text)) {
      ctx.addIssue({ code: "custom", message: "expected a decimal amount such as 119.00" });
      return z.NEVER;
    }
    const exact = decimal(text);
    if (exact.scale > places) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${places} decimal places are allowed (got ${toDecimalString(exact)})`,
      });
      return z.NEVER;
    }
    const sign = compare(exact, 0);
    if (sign < 0 && options.allowNegative !== true) {
      ctx.addIssue({ code: "custom", message: "the amount must not be negative" });
      return z.NEVER;
    }
    if (sign === 0 && options.allowZero === false) {
      ctx.addIssue({ code: "custom", message: "the amount must not be zero" });
      return z.NEVER;
    }
    return toDecimalString(exact);
  });
}

/** `from`/`to` input fields (inclusive calendar days, Europe/Berlin); spread into a tool input. */
export const dateRangeInputShape = {
  from: isoDate.optional().describe("First day to include, YYYY-MM-DD (Berlin time)."),
  to: isoDate.optional().describe("Last day to include, YYYY-MM-DD (Berlin time)."),
};

export interface UnixRange {
  /** Start of `from` in Berlin, Unix seconds. */
  readonly start: number | undefined;
  /** Last second of `to` in Berlin, Unix seconds. */
  readonly end: number | undefined;
}

/**
 * Converts an inclusive ISO day range to Unix-second bounds. Throws a local `validation` error if
 * `from` is after `to` (nothing is sent to sevDesk).
 */
export function toUnixRange(range: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): UnixRange {
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    throw new SevdeskError({
      kind: "validation",
      message: "The date range is empty: 'from' is after 'to'.",
    });
  }
  return {
    start: range.from === undefined ? undefined : toUnixSeconds(range.from, "start"),
    end: range.to === undefined ? undefined : toUnixSeconds(range.to, "end"),
  };
}

/** sevDesk's date filters for a document list and the matching local re-check. */
export interface DocumentDateFilter {
  /** `startDate`/`endDate` in Unix seconds, to spread into the list query; empty without a range. */
  readonly query: Readonly<{ startDate?: number; endDate?: number }>;
  /** Whether a document date (`YYYY-MM-DD`, Berlin) lies in the range; always true without one. */
  readonly contains: (date: string | undefined) => boolean;
}

/**
 * The `startDate`/`endDate` filters of `GET /Invoice`, `/CreditNote`, `/Order` and `/Voucher` for
 * an inclusive Berlin day range, and the local re-check that makes the result exact. The spec
 * describes `startDate` both as "equal or higher" and as "bigger than" (spec/deviations.md D-046)
 * and documents are dated at 00:00 Berlin time, so `startDate` is sent one second before the first
 * day (the first day counts under either reading) and every returned document's date is checked
 * against the range again, which drops anything the earlier bound let in. A document without a
 * date never matches a range. Throws a local `validation` error when `from` is after `to`.
 */
export function documentDateFilter(range: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): DocumentDateFilter {
  const { start, end } = toUnixRange(range);
  const { from, to } = range;
  return {
    query: {
      ...(start === undefined ? {} : { startDate: start - 1 }),
      ...(end === undefined ? {} : { endDate: end }),
    },
    contains: (date) =>
      (from === undefined && to === undefined) ||
      (date !== undefined &&
        (from === undefined || date >= from) &&
        (to === undefined || date <= to)),
  };
}
