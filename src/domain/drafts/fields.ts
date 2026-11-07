/**
 * Input fields shared by the draft tools and the rules behind them: ids, dates (default today in
 * Berlin), delivery periods, currency, price mode, tax rule and texts.
 *
 * Wire formats (spec/deviations.md D-018): document dates (`invoiceDate`, `creditNoteDate`,
 * `orderDate`) are sent as `dd.mm.yyyy`; `deliveryDate` and `deliveryDateUntil` as Unix seconds
 * of 00:00 Berlin time, as the spec types them ("Timestamp", integer) and as jernoxit/sevdesk-rs
 * sends them (`deliveryDate: 1790805600` for 2026-10-01; its recorded response echoes that date).
 *
 * Fields carry no zod defaults: update tools reuse them as "unchanged unless given", and create
 * tools apply the defaults in code.
 */
import { z } from "zod";

import { berlinDateOf, toSevdeskDate, toUnixSeconds } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { isoDateInput } from "../common.js";
import { DEFAULT_CURRENCY, isCurrencyCode } from "../money.js";
import { PRICE_MODES } from "./positions.js";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const contactIdInput = positiveId.describe(
  "Customer contact id (Kontakt), from sevdesk_contacts_search.",
);

export const contactPersonIdInput = positiveId
  .optional()
  .describe(
    "sevDesk user (SevUser) shown as contact person (Ansprechpartner). Required only when the " +
      "account has several users: sevdesk_reference_lookup kind=users lists them.",
  );

export const priceModeInput = z
  .enum(PRICE_MODES)
  .optional()
  .describe(
    "Whether position unit prices are net (netto, the default for new drafts) or gross " +
      "(brutto). Sets sevDesk's showNet.",
  );

export const taxRuleInput = positiveId
  .optional()
  .describe(
    "Tax rule (Steuerregel) id: 1 taxable domestic revenue (default), 2 exports, 3 intra-EU " +
      "supplies, 4 tax-exempt §4, 5 reverse charge §13b, 11 Kleinunternehmer §19, 17 not " +
      "taxable in Germany, 18–20 One-Stop-Shop, 21 reverse charge for EU services. Details: " +
      "sevdesk_reference_lookup kind=tax_rules.",
  );

export const taxTextInput = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .optional()
  .describe("Tax note printed on the document; default: the tax rule's German name.");

export const currencyInput = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "expected a three-letter ISO 4217 code such as EUR")
  .optional()
  .describe("ISO 4217 currency code (Währung); default EUR.");

export const headerInput = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .optional()
  .describe("Document title (Betreff).");

export const headTextInput = z
  .string()
  .max(10_000)
  .optional()
  .describe("Intro text above the positions (Kopftext); simple HTML allowed.");

export const footTextInput = z
  .string()
  .max(10_000)
  .optional()
  .describe("Closing text below the positions (Fußtext); simple HTML allowed.");

export const documentDateInput = isoDateInput
  .optional()
  .describe("Document date, YYYY-MM-DD; default today (Europe/Berlin).");

export const deliveryDateInput = isoDateInput
  .optional()
  .describe(
    "Delivery or service date (Liefer-/Leistungsdatum), YYYY-MM-DD; default the document date.",
  );

export const deliveryDateUntilInput = isoDateInput
  .optional()
  .describe("End of the delivery period (Leistungszeitraum bis), YYYY-MM-DD.");

/** Today's calendar date in Berlin; changes only at midnight, so previews stay deterministic. */
export function todayInBerlin(): string {
  return berlinDateOf(Date.now());
}

/** Upper-case ISO 4217 code; EUR when not given. Throws a `validation` error for unknown codes. */
export function resolveCurrency(code: string | undefined): string {
  if (code === undefined) return DEFAULT_CURRENCY;
  const upper = code.toUpperCase();
  if (!isCurrencyCode(upper)) {
    throw new SevdeskError({
      kind: "validation",
      message: `${upper} is not an ISO 4217 currency code; use e.g. EUR, CHF or USD.`,
    });
  }
  return upper;
}

/** A delivery date or period (Leistungszeitraum), `YYYY-MM-DD`. */
export interface DeliveryPeriod {
  readonly from: string;
  readonly until?: string | undefined;
}

/**
 * The delivery period of a document dated `date`. `notAfterDocumentDate`: regular invoices may not
 * have a delivery date later than the invoice date (spec, `saveInvoice`: "You can not create a
 * regular invoice with the deliveryDate being later than the invoiceDate"). Throws `validation`.
 */
export function resolveDeliveryPeriod(
  date: string,
  deliveryDate: string | undefined,
  deliveryDateUntil: string | undefined,
  notAfterDocumentDate: boolean,
): DeliveryPeriod {
  const from = deliveryDate ?? date;
  if (notAfterDocumentDate && from > date) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `The delivery date ${from} is after the invoice date ${date}, which sevDesk does not ` +
        "allow for a regular invoice. Use a delivery date on or before the invoice date, or " +
        "create an advance invoice (Abschlagsrechnung) in sevDesk.",
    });
  }
  if (deliveryDateUntil !== undefined && deliveryDateUntil < from) {
    throw new SevdeskError({
      kind: "validation",
      message: `deliveryDateUntil ${deliveryDateUntil} is before the delivery date ${from}.`,
    });
  }
  return deliveryDateUntil === undefined ? { from } : { from, until: deliveryDateUntil };
}

/** A document date for the wire: `dd.mm.yyyy`. */
export function wireDocumentDate(date: string): string {
  return toSevdeskDate(date);
}

/** A delivery date for the wire: Unix seconds of 00:00 Berlin time. */
export function wireTimestamp(date: string): number {
  return toUnixSeconds(date, "start");
}

/** A delivery period for previews, e.g. "2026-10-01" or "2026-10-01 – 2026-10-31". */
export function formatPeriod(period: DeliveryPeriod): string {
  return period.until === undefined ? period.from : `${period.from} – ${period.until}`;
}
