/**
 * Field-level reading shared by the CII and UBL readers: every value from the XML goes through
 * one of these methods, which normalize it to the contract of `model.ts` (cleaned, capped text;
 * exact decimal strings; ISO dates; upper-case codes) and record a finding instead of guessing
 * when a value is malformed. Findings carry trusted messages that name the business term, never
 * the offending value.
 */
import { findHiddenCharacters } from "../../safety/fence.js";
import { isIsoDate } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { cleanText } from "../common.js";
import { isCurrencyCode } from "../money.js";
import { isVatCategoryCode } from "./codes.js";
import type { EInvoiceFinding, EInvoiceParty, VatCategoryCode } from "./model.js";

/** Caps for untrusted text, in characters. */
export const TEXT_CAPS = {
  /** Party names, trading names, item names. */
  name: 200,
  /** Identifiers, references, codes. */
  identifier: 100,
  /** Street lines (two lines joined). */
  street: 300,
  postcode: 20,
  city: 100,
  /** Electronic address, e-mail. */
  address: 200,
  /** Item descriptions, payment terms. */
  description: 500,
  /** Notes (BT-22), each. */
  note: 1_000,
  /** Allowance/charge reasons, exemption reasons, remittance information. */
  reason: 300,
  /** Specification identifier (BT-24). */
  specification: 300,
} as const;

/** At most this many notes (BT-22) are kept. */
export const MAX_NOTES = 20;
/** At most this many lines are read; an invoice with more is refused. */
export const MAX_LINES = 10_000;
/** At most this many allowance/charge or VAT breakdown rows are read. */
export const MAX_ROWS = 1_000;

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;
const MAX_DECIMAL_DIGITS = 30;

/** Collects findings while reading one document. */
export class FieldReader {
  private readonly collected: EInvoiceFinding[] = [];
  private hiddenText = false;
  private readonly seenCodes = new Set<string>();

  /** Findings recorded so far, plus a note when hidden characters were removed. */
  findings(): EInvoiceFinding[] {
    const notes: EInvoiceFinding[] = this.hiddenText
      ? [
          {
            code: "SD-HIDDEN-TEXT",
            severity: "warning",
            message:
              "Some text fields contained invisible or text-direction control characters; they " +
              "were removed. Check names and amounts against the visual invoice (PDF) before " +
              "booking.",
          },
        ]
      : [];
    return [...this.collected, ...notes];
  }

  /** Records a finding once per code and message. */
  add(finding: EInvoiceFinding): void {
    const key = `${finding.code}\u0000${finding.message}`;
    if (this.seenCodes.has(key)) return;
    this.seenCodes.add(key);
    this.collected.push(finding);
  }

  /** Untrusted text: cleaned and capped; `undefined` when nothing visible is left. */
  text(value: string | undefined, max: number): string | undefined {
    if (value === undefined) return undefined;
    if (!this.hiddenText && hasHiddenCharacters(value)) this.hiddenText = true;
    return cleanText(value, max);
  }

  /** Several text values joined by a line break (e.g. two street lines). */
  joined(values: readonly (string | undefined)[], max: number): string | undefined {
    const parts = values
      .map((value) => this.text(value, max))
      .filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : cleanText(parts.join("\n"), max);
  }

  /**
   * An amount (BT-xxx) as an exact decimal string without a plus sign; `undefined` when absent.
   * A malformed value is recorded as an error and treated as absent.
   */
  amount(value: string | undefined, term: string): string | undefined {
    if (value === undefined) return undefined;
    const normalized = normalizeDecimal(value);
    if (normalized === undefined) {
      this.add({
        code: "SD-NUMBER",
        severity: "error",
        message: `${term} is not a decimal number; it was ignored.`,
      });
    }
    return normalized;
  }

  /** A date (BT-xxx) as `YYYY-MM-DD`; a malformed value is recorded and treated as absent. */
  date(value: string | undefined, term: string, format?: string): string | undefined {
    if (value === undefined) return undefined;
    const iso = toIsoDate(value, format);
    if (iso === undefined) {
      this.add({
        code: "SD-DATE",
        severity: "error",
        message: `${term} is not a calendar date in a supported format; it was ignored.`,
      });
    }
    return iso;
  }

  /** ISO 3166-1 alpha-2 country code, upper case; anything else is recorded and dropped. */
  country(value: string | undefined, term: string): string | undefined {
    if (value === undefined) return undefined;
    const code = value.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) return code;
    this.add({
      code: "SD-COUNTRY",
      severity: "error",
      message: `${term} is not a two-letter ISO 3166-1 country code; it was ignored.`,
    });
    return undefined;
  }

  /** A code (type codes, unit codes, payment means): trimmed, at most 20 safe characters. */
  code(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const code = value.trim();
    return /^[A-Za-z0-9._:-]{1,20}$/.test(code) ? code : undefined;
  }
}

/** Line breaks, carriage returns and tabs are layout, not hidden text. */
const LAYOUT_CHARACTERS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

/** Whether `value` holds characters a human would not see (see `findHiddenCharacters`). */
function hasHiddenCharacters(value: string): boolean {
  return findHiddenCharacters(value).some((codePoint) => !LAYOUT_CHARACTERS.has(codePoint));
}

/** `" +12.50 "` → `"12.50"`, `".5"` → `"0.5"`, `"7."` → `"7"`; `undefined` for non-decimals. */
export function normalizeDecimal(value: string): string | undefined {
  const match = DECIMAL.exec(value.trim());
  if (match === null) return undefined;
  const [, sign = "", whole = "", fraction = ""] = match;
  if (whole === "" && fraction === "") return undefined;
  if (whole.length + fraction.length > MAX_DECIMAL_DIGITS) return undefined;
  const body = `${whole === "" ? "0" : whole}${fraction === "" ? "" : `.${fraction}`}`;
  return sign === "-" ? `-${body}` : body;
}

/**
 * A date in one of the forms e-invoices use: CII `udt:DateTimeString` format 102 (`20260131`),
 * or an `xs:date` (`2026-01-31`, optionally with a time zone such as `Z` or `+01:00`).
 */
export function toIsoDate(value: string, format?: string): string | undefined {
  const text = value.trim();
  let iso: string | undefined;
  if (format === undefined || format === "102") {
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    if (compact !== null) iso = `${compact[1] ?? ""}-${compact[2] ?? ""}-${compact[3] ?? ""}`;
  }
  if (iso === undefined && format === undefined) {
    const dashed = /^(\d{4}-\d{2}-\d{2})(?:Z|[+-]\d{2}:\d{2})?$/.exec(text);
    if (dashed !== null) iso = dashed[1];
  }
  return iso !== undefined && isIsoDate(iso) ? iso : undefined;
}

/** A VAT identifier without spaces, dots or dashes, upper case; `undefined` when empty. */
export function normalizeVatId(value: string | undefined): string | undefined {
  const id = value?.replace(/[\s.-]+/g, "").toUpperCase();
  return id === undefined || id === "" ? undefined : id;
}

/** An IBAN without spaces, upper case, only letters and digits (at most 34). */
export function normalizeIban(value: string | undefined): string | undefined {
  const iban = value?.replace(/\s+/g, "").toUpperCase();
  return iban !== undefined && /^[A-Z0-9]{5,34}$/.test(iban) ? iban : undefined;
}

/**
 * The VAT category of a line, allowance/charge or breakdown row. EN 16931 requires one on each
 * (BR-CO-04, BR-32, BR-37, BR-47); without a valid one the document cannot be summed up per
 * VAT rate, so it is refused rather than guessed.
 */
export function requireVatCategory(value: string | undefined, where: string): VatCategoryCode {
  const code = value?.trim().toUpperCase();
  if (code !== undefined && isVatCategoryCode(code)) return code;
  throw unreadable(
    `${where} has no VAT category code or one EN 16931 does not define (S, Z, E, AE, K, G, O, ` +
      "L, M)",
  );
}

/** The ISO 4217 currency (BT-5); refused when missing or unknown. */
export function requireCurrency(value: string | undefined): string {
  const code = value?.trim().toUpperCase();
  if (code !== undefined && isCurrencyCode(code)) return code;
  throw unreadable("The e-invoice has no invoice currency (BT-5) or not an ISO 4217 code");
}

/** A refusal of a document that cannot be read as an invoice (trusted text). */
export function unreadable(reason: string): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message: `${reason}. The e-invoice cannot be read; nothing was sent to sevDesk.`,
  });
}

/** A party with absent fields left out (the model omits absent optional terms). */
export function partyOf(fields: {
  readonly name: string | undefined;
  readonly tradingName?: string | undefined;
  readonly vatId?: string | undefined;
  readonly taxNumber?: string | undefined;
  readonly identifier?: string | undefined;
  readonly electronicAddress?: string | undefined;
  readonly email?: string | undefined;
  readonly street?: string | undefined;
  readonly postcode?: string | undefined;
  readonly city?: string | undefined;
  readonly countryCode?: string | undefined;
}): EInvoiceParty {
  const party: Record<string, unknown> = {
    name: fields.name ?? fields.tradingName ?? "",
    tradingName: fields.tradingName,
    vatId: fields.vatId,
    taxNumber: fields.taxNumber,
    identifier: fields.identifier,
    electronicAddress: fields.electronicAddress,
    email: fields.email,
    address: withoutUndefined({
      street: fields.street,
      postcode: fields.postcode,
      city: fields.city,
      countryCode: fields.countryCode,
    }),
  };
  return withoutUndefined(party) as unknown as EInvoiceParty;
}

/** A copy without `undefined` members. */
export function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}
