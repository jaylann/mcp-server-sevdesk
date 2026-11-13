/**
 * Credit notes (Gutschriften): lenient parsing of sevDesk's `CreditNote` records, the compact DTOs
 * the credit note tools return, and the read operations behind them.
 *
 * Shape: a recorded `GET /CreditNote/{id}` row published by the sevdesk-rs project
 * (https://github.com/jernoxit/sevdesk-rs, `tests/fixtures/credit_note.json`, measured on an
 * Update 2.0 account in 2026), which carries fields the spec's `Model_creditNoteResponse` lacks:
 * `bookingCategory`, `refSrcInvoice` (`{id, objectName}`), `origin` (set only by
 * `createFromInvoice`), `payDate`, `enshrined`, `creditNoteType`. Credit notes have no
 * `paidAmount`. Filters: the spec's `getCreditNotes` parameters.
 */
import { z } from "zod";

import { expectSingle } from "../sevdesk/envelope.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zId } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { documentDateFilter } from "./common.js";
import {
  countryCodeSchema,
  type CountryReadOptions,
  withDocumentCountry,
} from "./country-codes.js";
import {
  addressDto,
  berlinDate,
  cleanText,
  compact,
  contactRef,
  contactRefSchema,
  type DocumentListResult,
  documentTotals,
  documentTotalsSchema,
  listDocumentPositions,
  listDocuments,
  loadUnitNames,
  matchesNumber,
  type PositionDto,
  priceModeOf,
  refId,
  salesDocumentFields,
  sentDto,
  sentDtoSchema,
  statusDto,
  statusDtoSchema,
  taxDto,
  taxDtoSchema,
  TEXT_MAX,
  toPositionDto,
  zDateValue,
  zOptionalRef,
  zText,
} from "./document-positions.js";
import { BOOKING_CATEGORY_NAMES, CREDIT_NOTE_STATUS_FILTERS, keyForCode } from "./filter-keys.js";
import { creditNoteLink } from "./links.js";

export { CREDIT_NOTE_STATUS_FILTERS } from "./filter-keys.js";

/** Credit note statuses (spec tag `CreditNote` → "Status of credit notes"). */
export type CreditNoteStatusFilter = keyof typeof CREDIT_NOTE_STATUS_FILTERS;

/** Booking categories (spec tag `CreditNote` → "Credit note booking categories"). */
const BOOKING_CATEGORIES: Readonly<Record<string, string>> = {
  PROVISION: "Provision",
  ROYALTY_ASSIGNED: "Assigned royalty",
  ROYALTY_UNASSIGNED: "Unassigned royalty",
  UNDERACHIEVEMENT: "Underachievement of an invoice or voucher (Minderleistung)",
  ACCOUNTING_TYPE: "Booked on a special account (Update 1.0 only)",
};

// ---------------------------------------------------------------------------------------------
// Upstream schema (lenient)
// ---------------------------------------------------------------------------------------------

/**
 * A reference sevDesk may send as `{id, objectName}` or, as the tag text types `refSrcInvoice`
 * ("Integer"), as a bare id; `null`/"" become `undefined`.
 */
const zLooseRef = z
  .union([z.object({ id: zId }), zId, z.null(), z.literal("")])
  .optional()
  .transform((value) =>
    value === null || value === "" || value === undefined
      ? undefined
      : typeof value === "number"
        ? value
        : value.id,
  );

const creditNoteRecordSchema = z.object({
  ...salesDocumentFields,
  creditNoteNumber: zText,
  creditNoteDate: zDateValue,
  bookingCategory: zText,
  refSrcInvoice: zLooseRef,
  refSrcVoucher: zLooseRef,
  origin: zOptionalRef,
  payDate: zDateValue,
  enshrined: zDateValue,
});

type CreditNoteRecord = z.output<typeof creditNoteRecordSchema>;

function parseCreditNoteRecord(raw: unknown): CreditNoteRecord {
  return parseUpstream(creditNoteRecordSchema, raw, "a credit note");
}

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

const bookingCategorySchema = z.object({
  key: z
    .string()
    .optional()
    .describe("Accepted bookingCategory input key; absent for unsupported categories."),
  code: z.string().describe("PROVISION, ROYALTY_ASSIGNED, ROYALTY_UNASSIGNED, UNDERACHIEVEMENT…"),
  label: z.string(),
});

/** Compact credit note for lists. */
export const creditNoteRowSchema = z.object({
  id: z.number().int(),
  number: z.string().optional().describe("Gutschriftsnummer."),
  status: statusDtoSchema,
  contact: contactRefSchema.optional(),
  date: z.string().optional().describe("Credit note date, YYYY-MM-DD."),
  ...documentTotalsSchema.shape,
  bookingCategory: bookingCategorySchema.optional(),
  sourceInvoiceId: z
    .number()
    .int()
    .optional()
    .describe("Invoice this credit note refers to (refSrcInvoice); see sevdesk_invoice_get."),
  sourceVoucherId: z.number().int().optional().describe("Voucher it refers to (refSrcVoucher)."),
  header: z.string().optional(),
  sent: sentDtoSchema.optional().describe("Left out when the credit note was not sent."),
  enshrined: z.boolean().optional().describe("Festgeschrieben (locked); only shown when true."),
  link: z.string().optional().describe("Opens the credit note in the sevDesk web app."),
});

export type CreditNoteRow = z.output<typeof creditNoteRowSchema>;

export const creditNoteDetailSchema = creditNoteRowSchema.extend({
  deliveryDate: z.string().optional().describe("Lieferdatum, YYYY-MM-DD."),
  deliveryDateUntil: z.string().optional(),
  payDate: z.string().optional(),
  priceMode: z.enum(["net", "gross"]).optional(),
  tax: taxDtoSchema,
  address: z
    .object({
      text: z.string().optional().describe("Recipient address as printed."),
      countryId: z.number().int().optional().describe("StaticCountry id."),
      country: countryCodeSchema,
    })
    .optional(),
  contactPersonId: z.number().int().optional(),
  internalNote: z.string().optional(),
  headText: z.string().optional(),
  footText: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type CreditNoteDetail = z.output<typeof creditNoteDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

function toCreditNoteRow(record: CreditNoteRecord): CreditNoteRow {
  const category = cleanText(record.bookingCategory, 50)?.toUpperCase();
  const originInvoice = record.origin?.objectName === "Invoice" ? record.origin.id : undefined;
  return compact({
    id: record.id,
    number: cleanText(record.creditNoteNumber, TEXT_MAX.short),
    status: statusDto("creditNote", record.status),
    contact: contactRef(record.contact),
    date: berlinDate(record.creditNoteDate),
    ...documentTotals(record),
    bookingCategory:
      category === undefined
        ? undefined
        : compact({
            code: category,
            label: BOOKING_CATEGORIES[category] ?? "unknown",
            key: keyForCode(BOOKING_CATEGORY_NAMES, category),
          }),
    sourceInvoiceId: record.refSrcInvoice ?? originInvoice,
    sourceVoucherId: record.refSrcVoucher,
    header: cleanText(record.header, TEXT_MAX.short),
    sent: sentDto(record),
    enshrined: berlinDate(record.enshrined) === undefined ? undefined : true,
    link: creditNoteLink(record.id, record.status),
  });
}

function toCreditNoteDetail(record: CreditNoteRecord): CreditNoteDetail {
  return compact({
    ...toCreditNoteRow(record),
    deliveryDate: berlinDate(record.deliveryDate),
    deliveryDateUntil: berlinDate(record.deliveryDateUntil),
    payDate: berlinDate(record.payDate),
    priceMode: priceModeOf(record.showNet),
    tax: taxDto(record),
    address: addressDto(record),
    contactPersonId: refId(record.contactPerson, "a credit note's contact person"),
    internalNote: cleanText(record.customerInternalNote, TEXT_MAX.long),
    headText: cleanText(record.headText, TEXT_MAX.long),
    footText: cleanText(record.footText, TEXT_MAX.long),
    createdAt: berlinDate(record.create),
    updatedAt: berlinDate(record.update),
  });
}

/**
 * Maps one raw `CreditNote` record (one object of `GET /CreditNote/{id}`, contact embedded or not)
 * to the detail DTO, without positions: for write tools that read a record back. Throws
 * `unexpected_response` for a record that does not fit.
 */
export function mapCreditNoteDetail(raw: unknown): CreditNoteDetail {
  return toCreditNoteDetail(parseCreditNoteRecord(raw));
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const EMBED_CONTACT = "contact";

export interface CreditNoteListParams {
  readonly status?: CreditNoteStatusFilter | undefined;
  readonly contactId?: number | undefined;
  /** Exact credit note number (`creditNoteNumber`). */
  readonly number?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Lists credit notes (`GET /CreditNote`) with sevDesk's filters `status`, `contact[id]`,
 * `creditNoteNumber` and `startDate`/`endDate` (Unix seconds, Berlin days). The number is
 * re-checked on every row (`matchesNumber`).
 */
export async function listCreditNotes(
  client: SevdeskClient,
  params: CreditNoteListParams,
  signal?: AbortSignal,
): Promise<DocumentListResult<CreditNoteRow>> {
  const dates = documentDateFilter(params);
  const query: Record<string, QueryValue> = { embed: EMBED_CONTACT, ...dates.query };
  if (params.status !== undefined) query["status"] = CREDIT_NOTE_STATUS_FILTERS[params.status];
  if (params.contactId !== undefined) {
    query["contact[id]"] = toSevdeskId(params.contactId);
    query["contact[objectName]"] = "Contact";
  }
  if (params.number !== undefined) query["creditNoteNumber"] = params.number;
  return listDocuments({
    client,
    path: "/CreditNote",
    query,
    limit: params.limit,
    offset: params.offset,
    map: (raw) => toCreditNoteRow(parseCreditNoteRecord(raw)),
    keep: matchesNumber(params.number),
    recheck: (row) => dates.contains(row.date),
    signal,
  });
}

export interface CreditNoteDetails {
  readonly creditNote: CreditNoteDetail;
  readonly positions: readonly PositionDto[];
  readonly positionsComplete: boolean;
}

/**
 * One credit note (`GET /CreditNote/{id}`, contact embedded) with its positions
 * (`GET /CreditNotePos?creditNote[id]=…&creditNote[objectName]=CreditNote`) and unit names.
 */
export async function getCreditNote(
  client: SevdeskClient,
  creditNoteId: number,
  options: CountryReadOptions,
): Promise<CreditNoteDetails> {
  const { signal, cacheOwner } = options;
  const id = toSevdeskId(creditNoteId);
  const withSignal = signal === undefined ? {} : { signal };
  const [payload, positions, unitNames] = await Promise.all([
    client.request({
      method: "GET",
      path: sevdeskPath("CreditNote", id),
      query: { embed: EMBED_CONTACT },
      ...withSignal,
    }),
    listDocumentPositions(
      client,
      {
        path: "/CreditNotePos",
        parentKey: "creditNote",
        objectName: "CreditNote",
        what: "credit note positions",
      },
      id,
      signal,
    ),
    loadUnitNames(client, signal),
  ]);
  const record = parseCreditNoteRecord(expectSingle(payload, `credit note ${id}`));
  const creditNote = await withDocumentCountry(toCreditNoteDetail(record), client, {
    signal,
    cacheOwner,
  });
  const context = { currency: creditNote.currency, showNet: record.showNet, unitNames };
  return {
    creditNote,
    positions: positions.rows.map((row) => toPositionDto(row, context)),
    positionsComplete: positions.complete,
  };
}
