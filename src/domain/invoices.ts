/**
 * Invoices (Rechnungen): lenient parsing of sevDesk's `Invoice` records, the compact DTOs the
 * invoice tools return, and the read operations behind them.
 *
 * Shapes: recorded `GET /Invoice` (with an embedded contact) and `GET /InvoicePos` published by
 * sevDesk.NET (https://github.com/emuuu/sevDesk.NET/blob/main/docs/sevdesk-api-responses.txt,
 * 2026-02-19, Update 2.0), plus `Model_InvoiceResponse` in the spec for fields the recording left
 * out (sevDesk omits unset references such as `origin`, `paymentMethod`, `addressCountry`).
 * Filters: the spec's `getInvoices` parameters and the Invoice tag's "How to filter for certain
 * invoices" list.
 */
import { z } from "zod";

import { berlinDateOf } from "../sevdesk/dates.js";
import { expectSingle } from "../sevdesk/envelope.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { documentDateFilter, moneyFromUpstream, moneySchema } from "./common.js";
import {
  addDays,
  addressDto,
  allOf,
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
  positionDtoSchema,
  pricesEnteredAs,
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
  typeDtoSchema,
  zDateValue,
  zOptionalBool,
  zOptionalDecimal,
  zOptionalInt,
  zOptionalRef,
  zText,
} from "./document-positions.js";
import { invoiceLink } from "./links.js";
import { DEFAULT_CURRENCY } from "./money.js";
import { documentTypeByCode } from "./reference-data.js";

// ---------------------------------------------------------------------------------------------
// Filter vocabularies (readable names → sevDesk codes from reference data)
// ---------------------------------------------------------------------------------------------

/**
 * Invoice statuses a list can be filtered by. Codes: spec tag `Invoice` → "Types and status of
 * invoices". Cancelled (storniert) invoices have no documented status code, so they cannot be
 * selected by status.
 */
export const INVOICE_STATUS_FILTERS = {
  draft: 100,
  open: 200,
  partially_paid: 750,
  paid: 1000,
} as const;
export type InvoiceStatusFilter = keyof typeof INVOICE_STATUS_FILTERS;

/** Invoice types (Rechnungsarten) by readable name → sevDesk's `invoiceType`. */
export const INVOICE_TYPE_FILTERS = {
  invoice: "RE",
  advance: "AR",
  partial: "TR",
  final: "ER",
  cancellation: "SR",
  reminder: "MA",
  recurring: "WKR",
} as const;
export type InvoiceTypeFilter = keyof typeof INVOICE_TYPE_FILTERS;

/** Statuses that still expect money: open (200) and partially paid (750). */
const UNPAID_STATUSES: ReadonlySet<number> = new Set([200, 750]);

// ---------------------------------------------------------------------------------------------
// Upstream schema (lenient)
// ---------------------------------------------------------------------------------------------

const invoiceRecordSchema = z.object({
  ...salesDocumentFields,
  invoiceNumber: zText,
  invoiceDate: zDateValue,
  invoiceType: zText,
  timeToPay: zOptionalInt,
  discount: zOptionalDecimal,
  discountTime: zOptionalInt,
  payDate: zDateValue,
  paidAmount: zOptionalDecimal,
  paymentMethod: zOptionalRef,
  costCentre: zOptionalRef,
  origin: zOptionalRef,
  enshrined: zDateValue,
  propertyIsEInvoice: zOptionalBool,
  dunningLevel: zOptionalInt,
  reminderDeadline: zDateValue,
  reminderTotal: zOptionalDecimal,
  reminderCharge: zOptionalDecimal,
  accountIntervall: zText,
  accountNextInvoice: zDateValue,
});

type InvoiceRecord = z.output<typeof invoiceRecordSchema>;

function parseInvoiceRecord(raw: unknown): InvoiceRecord {
  return parseUpstream(invoiceRecordSchema, raw, "an invoice");
}

// ---------------------------------------------------------------------------------------------
// DTOs (also the tools' output schemas)
// ---------------------------------------------------------------------------------------------

/** Compact invoice for lists. */
export const invoiceRowSchema = z.object({
  id: z.number().int(),
  number: z.string().optional().describe("Rechnungsnummer."),
  type: typeDtoSchema.describe("RE invoice, AR advance, TR partial, ER final, SR, MA, WKR."),
  status: statusDtoSchema,
  contact: contactRefSchema.optional(),
  date: z.string().optional().describe("Invoice date (Rechnungsdatum), YYYY-MM-DD."),
  dueDate: z
    .string()
    .optional()
    .describe("Invoice date plus payment term (Zahlungsziel), YYYY-MM-DD."),
  overdue: z
    .boolean()
    .optional()
    .describe("Open or partially paid and the due date is before today (Berlin)."),
  ...documentTotalsSchema.shape,
  paid: moneySchema
    .optional()
    .describe(
      "Amount paid so far (bezahlt). Left out for foreign-currency invoices: its currency is " +
        "not documented.",
    ),
  cancelsInvoiceId: z
    .number()
    .int()
    .optional()
    .describe(
      "Cancellation invoices (SR, Stornorechnung): the invoice they cancel. The cancelled " +
        "invoice itself keeps status 1000 (paid) in sevDesk's API.",
    ),
  header: z.string().optional().describe("Document title (Betreff)."),
  eInvoice: z
    .boolean()
    .optional()
    .describe(
      "E-Rechnung (XRechnung/ZUGFeRD), when sevDesk says; reads usually do not (absent = unknown).",
    ),
  sent: sentDtoSchema.optional().describe("Left out when the invoice was not sent."),
  enshrined: z
    .boolean()
    .optional()
    .describe("Festgeschrieben: locked for changes (GoBD); only shown when true."),
  link: z.string().optional().describe("Opens the invoice in the sevDesk web app."),
});

export type InvoiceRow = z.output<typeof invoiceRowSchema>;

/** One invoice with everything the detail tool shows. */
export const invoiceDetailSchema = invoiceRowSchema.extend({
  deliveryDate: z.string().optional().describe("Lieferdatum / Leistungsdatum, YYYY-MM-DD."),
  deliveryDateUntil: z.string().optional().describe("End of the delivery period, YYYY-MM-DD."),
  payDate: z.string().optional().describe("Date the invoice was paid, YYYY-MM-DD."),
  pricesEnteredAs: z
    .enum(["net", "gross"])
    .optional()
    .describe("Whether position prices were entered net or gross (showNet)."),
  tax: taxDtoSchema,
  paymentTerms: z
    .object({
      daysToPay: z.number().int().optional().describe("Zahlungsziel in days."),
      cashDiscountPercent: z.string().optional().describe("Skonto in percent."),
      cashDiscountDays: z.number().int().optional().describe("Days the Skonto applies."),
      paymentMethodId: z.number().int().optional(),
    })
    .optional(),
  address: z
    .object({
      text: z.string().optional().describe("Recipient address as printed, one line per part."),
      countryId: z.number().int().optional().describe("StaticCountry id."),
    })
    .optional(),
  origin: z
    .object({ objectName: z.string(), id: z.number().int() })
    .optional()
    .describe("Object the invoice was created from, e.g. an Order (Angebot/Auftrag)."),
  reminder: z
    .object({
      dunningLevel: z.number().int().optional().describe("Mahnstufe."),
      deadline: z.string().optional(),
      total: moneySchema.optional(),
      charge: moneySchema.optional().describe("Mahngebühr."),
    })
    .optional()
    .describe("Dunning data (Mahnung), when set."),
  recurring: z
    .object({
      interval: z.string().optional().describe("ISO-8601 duration as sevDesk sent it."),
      nextInvoice: z.string().optional(),
    })
    .optional()
    .describe("Recurring invoice (Abo-Rechnung) schedule, when set."),
  contactPersonId: z.number().int().optional().describe("SevUser responsible for the invoice."),
  costCentreId: z.number().int().optional().describe("Kostenstelle."),
  internalNote: z.string().optional().describe("Internal note (not printed)."),
  headText: z.string().optional().describe("Intro text (may contain HTML)."),
  footText: z.string().optional().describe("Closing text (may contain HTML)."),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

type InvoiceDetail = z.output<typeof invoiceDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

/** Maps a parsed invoice to the list row. `today` is a Berlin `YYYY-MM-DD` for `overdue`. */
function toInvoiceRow(record: InvoiceRecord, today: string): InvoiceRow {
  const typeCode = cleanText(record.invoiceType, 10)?.toUpperCase() ?? "RE";
  const type = documentTypeByCode("invoice", typeCode);
  const date = berlinDate(record.invoiceDate);
  const dueDate =
    date === undefined || record.timeToPay === undefined
      ? undefined
      : addDays(date, record.timeToPay);
  const unpaid = UNPAID_STATUSES.has(record.status);
  const totals = documentTotals(record);
  return compact({
    id: record.id,
    number: cleanText(record.invoiceNumber, TEXT_MAX.short),
    type:
      type === undefined
        ? { code: typeCode, label: "unknown" }
        : { code: type.code, label: type.label, labelDe: type.labelDe },
    status: statusDto("invoice", record.status),
    contact: contactRef(record.contact),
    date,
    dueDate,
    overdue: unpaid && dueDate !== undefined ? dueDate < today : undefined,
    ...totals,
    paid:
      totals.currency === DEFAULT_CURRENCY
        ? moneyFromUpstream(record.paidAmount, totals.currency)
        : undefined,
    cancelsInvoiceId:
      typeCode === "SR" && record.origin?.objectName === "Invoice" ? record.origin.id : undefined,
    header: cleanText(record.header, TEXT_MAX.short),
    eInvoice: record.propertyIsEInvoice,
    sent: sentDto(record),
    enshrined: berlinDate(record.enshrined) === undefined ? undefined : true,
    link: invoiceLink(record.id, typeCode, record.status),
  });
}

function toInvoiceDetail(record: InvoiceRecord, today: string): InvoiceDetail {
  const row = toInvoiceRow(record, today);
  const currency = row.currency;
  const paymentTerms = compact({
    daysToPay: record.timeToPay,
    cashDiscountPercent: nonZero(record.discount),
    cashDiscountDays: record.discountTime === 0 ? undefined : record.discountTime,
    paymentMethodId: record.paymentMethod?.id,
  });
  const reminder = compact({
    dunningLevel: record.dunningLevel,
    deadline: berlinDate(record.reminderDeadline),
    total: moneyFromUpstream(nonZero(record.reminderTotal), currency),
    charge: moneyFromUpstream(nonZero(record.reminderCharge), currency),
  });
  const recurring = compact({
    interval: cleanText(record.accountIntervall, TEXT_MAX.short),
    nextInvoice: berlinDate(record.accountNextInvoice),
  });
  return compact({
    ...row,
    deliveryDate: berlinDate(record.deliveryDate),
    deliveryDateUntil: berlinDate(record.deliveryDateUntil),
    payDate: berlinDate(record.payDate),
    pricesEnteredAs: pricesEnteredAs(record.showNet),
    tax: taxDto(record),
    paymentTerms: Object.keys(paymentTerms).length === 0 ? undefined : paymentTerms,
    address: addressDto(record),
    origin:
      record.origin === undefined
        ? undefined
        : { objectName: cleanText(record.origin.objectName, 50) ?? "", id: record.origin.id },
    reminder: Object.keys(reminder).length === 0 ? undefined : reminder,
    recurring: Object.keys(recurring).length === 0 ? undefined : recurring,
    contactPersonId: refId(record.contactPerson, "an invoice's contact person"),
    costCentreId: record.costCentre?.id,
    internalNote: cleanText(record.customerInternalNote, TEXT_MAX.long),
    headText: cleanText(record.headText, TEXT_MAX.long),
    footText: cleanText(record.footText, TEXT_MAX.long),
    createdAt: berlinDate(record.create),
    updatedAt: berlinDate(record.update),
  });
}

/** The value unless it is a zero decimal (sevDesk sends "0" for "no Skonto", "no fee"). */
function nonZero(value: string | undefined): string | undefined {
  return value === undefined || /^-?0+(\.0+)?$/.test(value) ? undefined : value;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/** `embed` value that makes sevDesk send the whole contact instead of `{id, objectName}`. */
const EMBED_CONTACT = "contact";

export interface InvoiceListParams {
  readonly status?: InvoiceStatusFilter | undefined;
  readonly type?: InvoiceTypeFilter | undefined;
  readonly contactId?: number | undefined;
  /** Exact invoice number (sevDesk's `invoiceNumber` filter). */
  readonly number?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Open/partially paid with a due date before today; filtered here (see the tool). */
  readonly overdueOnly?: boolean | undefined;
  readonly limit: number;
  readonly offset: number;
  /** Berlin `YYYY-MM-DD` used for "today" (tests); defaults to the current date. */
  readonly today?: string | undefined;
}

/**
 * Lists invoices (`GET /Invoice`) with sevDesk's own filters: `status`, `invoiceType`,
 * `contact[id]`, `invoiceNumber` and `startDate`/`endDate` (Unix seconds, Berlin days). Applied
 * here (see `listDocuments`): the overdue filter, whose server-side form (`delinquent`) the web
 * app only uses together with `status=200` and `notPartiallyPaid`, and exact re-checks of the
 * number (see {@link matchesNumber}) and the type, which sevDesk would ignore silently if it did
 * not understand them (spec/deviations.md D-015, D-035). The date range is re-checked without a
 * scan (see `documentDateFilter`).
 */
export async function listInvoices(
  client: SevdeskClient,
  params: InvoiceListParams,
  signal?: AbortSignal,
): Promise<DocumentListResult<InvoiceRow>> {
  const dates = documentDateFilter(params);
  const query: Record<string, QueryValue> = { embed: EMBED_CONTACT, ...dates.query };
  if (params.status !== undefined) query["status"] = INVOICE_STATUS_FILTERS[params.status];
  const type = params.type === undefined ? undefined : INVOICE_TYPE_FILTERS[params.type];
  if (type !== undefined) query["invoiceType"] = type;
  // The Invoice tag's filter table lists `showWkr=all` ("Retrieve all recurring invoices") and
  // `showMa=all` ("… payment reminders"), which suggests sevDesk hides recurring templates and
  // reminders unless asked. Unverified (no recording): sent only when that type is requested; the
  // local type re-check below keeps the result exact either way.
  if (type === "WKR") query["showWkr"] = "all";
  if (type === "MA") query["showMa"] = "all";
  if (params.contactId !== undefined) {
    query["contact[id]"] = toSevdeskId(params.contactId);
    query["contact[objectName]"] = "Contact";
  }
  if (params.number !== undefined) query["invoiceNumber"] = params.number;

  const today = params.today ?? berlinDateOf(Date.now());
  return listDocuments({
    client,
    path: "/Invoice",
    query,
    limit: params.limit,
    offset: params.offset,
    map: (raw) => toInvoiceRow(parseInvoiceRecord(raw), today),
    keep: allOf(
      params.overdueOnly === true ? (row: InvoiceRow) => row.overdue === true : undefined,
      matchesNumber(params.number),
      type === undefined ? undefined : (row: InvoiceRow) => row.type.code === type,
    ),
    recheck: (row) => dates.contains(row.date),
    signal,
  });
}

export interface InvoiceDetails {
  readonly invoice: InvoiceDetail;
  readonly positions: readonly z.output<typeof positionDtoSchema>[];
  /** False when sevDesk had more position rows than could be read. */
  readonly positionsComplete: boolean;
}

/**
 * One invoice (`GET /Invoice/{id}`, contact embedded) with its positions
 * (`GET /InvoicePos?invoice[id]=…&invoice[objectName]=Invoice`) and unit names (`GET /Unity`).
 */
export async function getInvoice(
  client: SevdeskClient,
  invoiceId: number,
  signal?: AbortSignal,
  today: string = berlinDateOf(Date.now()),
): Promise<InvoiceDetails> {
  const id = toSevdeskId(invoiceId);
  const withSignal = signal === undefined ? {} : { signal };
  const [payload, positions, unitNames] = await Promise.all([
    client.request({
      method: "GET",
      path: sevdeskPath("Invoice", id),
      query: { embed: EMBED_CONTACT },
      ...withSignal,
    }),
    listDocumentPositions(
      client,
      {
        path: "/InvoicePos",
        parentKey: "invoice",
        objectName: "Invoice",
        what: "invoice positions",
      },
      id,
      signal,
    ),
    loadUnitNames(client, signal),
  ]);
  const record = parseInvoiceRecord(expectSingle(payload, `invoice ${id}`));
  const invoice = toInvoiceDetail(record, today);
  const context = { currency: invoice.currency, showNet: record.showNet, unitNames };
  return {
    invoice,
    positions: positions.rows.map((row) => toPositionDto(row, context)),
    positionsComplete: positions.complete,
  };
}
