/**
 * Orders (Aufträge): estimates/offers (Angebote, AN), order confirmations (Auftragsbestätigungen,
 * AB) and delivery notes (Lieferscheine, LI). Lenient parsing of sevDesk's `Order` records, the
 * compact DTOs the order tools return, and the read operations behind them.
 *
 * Shape: a real `GET /Order?embed=positions` response pasted into the OrderManager2 project
 * (https://github.com/TomDixon63/OrderManager2, `front/src/app/model/order.ts`, 2023), checked
 * against the spec's `Model_OrderResponse`/`Model_OrderPosResponse` and the Order tag's attribute
 * table (`origin`, `typeOrigin`, `version`, `paymentTerms`, `deliveryTerms`). Filters: the spec's
 * `getOrders` parameters and the Order tag's "How to filter for certain orders" list.
 *
 * Related documents come from `GET /Order/{id}/getRelatedObjects`. The spec declares order
 * positions as its items, which is wrong: a real Update 1.0 account returned the linked invoices
 * and orders, as a list or as an object with numeric keys (https://github.com/firsttris/haben,
 * issue #346 and `packages/import/src/sevdesk/client.test.ts`). Both forms are read here.
 */
import { z } from "zod";

import { expectSingle } from "../sevdesk/envelope.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zId } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { documentDateFilter } from "./common.js";
import { countryCodeSchema, withDocumentCountry } from "./country-codes.js";
import {
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
  typeDtoSchema,
  zDateValue,
  zOptionalInt,
  zOptionalRef,
  zText,
} from "./document-positions.js";
import { keyForCode, ORDER_STATUS_FILTERS, ORDER_TYPE_FILTERS } from "./filter-keys.js";
import { creditNoteLink, invoiceLink, orderLink } from "./links.js";
import { documentTypeByCode } from "./reference-data.js";

export { ORDER_STATUS_FILTERS, ORDER_TYPE_FILTERS } from "./filter-keys.js";

/** Order statuses (spec tag `Order` → "Types and status of orders"). */
export type OrderStatusFilter = keyof typeof ORDER_STATUS_FILTERS;

/** Order types by readable name → sevDesk's `orderType`. */
export type OrderTypeFilter = keyof typeof ORDER_TYPE_FILTERS;

// ---------------------------------------------------------------------------------------------
// Upstream schemas (lenient)
// ---------------------------------------------------------------------------------------------

const orderRecordSchema = z.object({
  ...salesDocumentFields,
  orderNumber: zText,
  orderDate: zDateValue,
  orderType: zText,
  origin: zOptionalRef,
  typeOrigin: zText,
  version: zOptionalInt,
  paymentTerms: zText,
  deliveryTerms: zText,
});

type OrderRecord = z.output<typeof orderRecordSchema>;

function parseOrderRecord(raw: unknown): OrderRecord {
  return parseUpstream(orderRecordSchema, raw, "an order");
}

/** One object of `getRelatedObjects` (fields seen in the haben regression fixture). */
const relatedRecordSchema = z.object({
  id: zId,
  objectName: zText,
  invoiceNumber: zText,
  orderNumber: zText,
  creditNoteNumber: zText,
  invoiceType: zText,
  orderType: zText,
  status: zOptionalInt,
});

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

/** Compact order for lists. */
export const orderRowSchema = z.object({
  id: z.number().int(),
  number: z.string().optional().describe("Angebots-/Auftragsnummer."),
  type: typeDtoSchema.describe("AN offer (Angebot), AB order confirmation, LI delivery note."),
  status: statusDtoSchema,
  contact: contactRefSchema.optional(),
  date: z.string().optional().describe("Order date, YYYY-MM-DD."),
  ...documentTotalsSchema.shape,
  header: z.string().optional(),
  sent: sentDtoSchema.optional().describe("Left out when the order was not sent."),
  link: z.string().optional().describe("Opens the order in the sevDesk web app."),
});

export type OrderRow = z.output<typeof orderRowSchema>;

export const relatedDocumentSchema = z.object({
  objectName: z.string().describe("Invoice, Order or CreditNote."),
  id: z.number().int().describe("Open with sevdesk_invoice_get / _order_get / _credit_note_get."),
  number: z.string().optional(),
  typeCode: z.string().optional().describe("invoiceType or orderType, e.g. RE, AB, LI."),
  status: statusDtoSchema.optional(),
  link: z.string().optional(),
});

type RelatedDocument = z.output<typeof relatedDocumentSchema>;

export const orderDetailSchema = orderRowSchema.extend({
  priceMode: z.enum(["net", "gross"]).optional(),
  tax: taxDtoSchema,
  version: z.number().int().optional().describe("Draft version, starting at 0."),
  origin: z
    .object({ objectName: z.string(), id: z.number().int() })
    .optional()
    .describe("Object this order was created from, e.g. the offer (Order) of a confirmation."),
  paymentTerms: z.string().optional().describe("Zahlungsbedingungen as sevDesk stores them."),
  deliveryTerms: z.string().optional().describe("Lieferbedingungen."),
  deliveryDate: z.string().optional(),
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

export type OrderDetail = z.output<typeof orderDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

function toOrderRow(record: OrderRecord): OrderRow {
  const typeCode = cleanText(record.orderType, 10)?.toUpperCase() ?? "AN";
  const type = documentTypeByCode("order", typeCode);
  return compact({
    id: record.id,
    number: cleanText(record.orderNumber, TEXT_MAX.short),
    type:
      type === undefined
        ? { code: typeCode, label: "unknown" }
        : compact({
            code: type.code,
            label: type.label,
            labelDe: type.labelDe,
            key: keyForCode(ORDER_TYPE_FILTERS, type.code),
          }),
    status: statusDto("order", record.status),
    contact: contactRef(record.contact),
    date: berlinDate(record.orderDate),
    ...documentTotals(record),
    header: cleanText(record.header, TEXT_MAX.short),
    sent: sentDto(record),
    link: orderLink(record.id, typeCode, record.status),
  });
}

function toOrderDetail(record: OrderRecord): OrderDetail {
  const originName =
    record.origin === undefined
      ? undefined
      : (cleanText(record.origin.objectName, 50) ?? cleanText(record.typeOrigin, 50) ?? "");
  return compact({
    ...toOrderRow(record),
    priceMode: priceModeOf(record.showNet),
    tax: taxDto(record),
    version: record.version,
    origin:
      record.origin === undefined || originName === undefined
        ? undefined
        : { objectName: originName, id: record.origin.id },
    paymentTerms: cleanText(record.paymentTerms, TEXT_MAX.long),
    deliveryTerms: cleanText(record.deliveryTerms, TEXT_MAX.long),
    deliveryDate: berlinDate(record.deliveryDate),
    address: addressDto(record),
    contactPersonId: refId(record.contactPerson, "an order's contact person"),
    internalNote: cleanText(record.customerInternalNote, TEXT_MAX.long),
    headText: cleanText(record.headText, TEXT_MAX.long),
    footText: cleanText(record.footText, TEXT_MAX.long),
    createdAt: berlinDate(record.create),
    updatedAt: berlinDate(record.update),
  });
}

/**
 * Maps one raw `Order` record (one object of `GET /Order/{id}`, contact embedded or not) to the
 * detail DTO, without positions or related documents: for write tools that read a record back.
 * Throws `unexpected_response` for a record that does not fit.
 */
export function mapOrderDetail(raw: unknown): OrderDetail {
  return toOrderDetail(parseOrderRecord(raw));
}

function toRelatedDocument(record: z.output<typeof relatedRecordSchema>): RelatedDocument {
  const objectName = cleanText(record.objectName, 50) ?? "unknown";
  const typeCode = cleanText(record.invoiceType ?? record.orderType, 10)?.toUpperCase();
  const status = record.status;
  let statusEntry: RelatedDocument["status"];
  let link: string | undefined;
  if (objectName === "Invoice") {
    statusEntry = status === undefined ? undefined : statusDto("invoice", status);
    link =
      status === undefined || typeCode === undefined
        ? undefined
        : invoiceLink(record.id, typeCode, status);
  } else if (objectName === "Order") {
    statusEntry = status === undefined ? undefined : statusDto("order", status);
    link =
      status === undefined || typeCode === undefined
        ? undefined
        : orderLink(record.id, typeCode, status);
  } else if (objectName === "CreditNote") {
    statusEntry = status === undefined ? undefined : statusDto("creditNote", status);
    link = status === undefined ? undefined : creditNoteLink(record.id, status);
  } else {
    statusEntry = status === undefined ? undefined : { code: status, label: "unknown" };
  }
  return compact({
    objectName,
    id: record.id,
    number: cleanText(
      record.invoiceNumber ?? record.orderNumber ?? record.creditNoteNumber,
      TEXT_MAX.short,
    ),
    typeCode,
    status: statusEntry,
    link,
  });
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const EMBED_CONTACT = "contact";

export interface OrderListParams {
  readonly status?: OrderStatusFilter | undefined;
  readonly type?: OrderTypeFilter | undefined;
  readonly contactId?: number | undefined;
  /** Exact order number (`orderNumber`). */
  readonly number?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Lists orders (`GET /Order`) with sevDesk's filters `status`, `orderType`, `contact[id]`,
 * `orderNumber` and `startDate`/`endDate` (Unix seconds, Berlin days). The number and the type are
 * re-checked on every row (`matchesNumber`), since sevDesk ignores filters it does not understand
 * (spec/deviations.md D-035); the date range is re-checked without a scan (`documentDateFilter`).
 */
export async function listOrders(
  client: SevdeskClient,
  params: OrderListParams,
  signal?: AbortSignal,
): Promise<DocumentListResult<OrderRow>> {
  const dates = documentDateFilter(params);
  const query: Record<string, QueryValue> = { embed: EMBED_CONTACT, ...dates.query };
  if (params.status !== undefined) query["status"] = ORDER_STATUS_FILTERS[params.status];
  const type = params.type === undefined ? undefined : ORDER_TYPE_FILTERS[params.type];
  if (type !== undefined) query["orderType"] = type;
  if (params.contactId !== undefined) {
    query["contact[id]"] = toSevdeskId(params.contactId);
    query["contact[objectName]"] = "Contact";
  }
  if (params.number !== undefined) query["orderNumber"] = params.number;
  return listDocuments({
    client,
    path: "/Order",
    query,
    limit: params.limit,
    offset: params.offset,
    map: (raw) => toOrderRow(parseOrderRecord(raw)),
    keep: allOf(
      matchesNumber(params.number),
      type === undefined ? undefined : (row: OrderRow) => row.type.code === type,
    ),
    recheck: (row) => dates.contains(row.date),
    signal,
  });
}

export interface OrderDetails {
  readonly order: OrderDetail;
  readonly positions: readonly PositionDto[];
  readonly positionsComplete: boolean;
  /** `undefined` when sevDesk could not provide them (request failed or unknown shape). */
  readonly related: readonly RelatedDocument[] | undefined;
}

/**
 * One order (`GET /Order/{id}`, contact embedded) with its positions
 * (`GET /OrderPos?order[id]=…&order[objectName]=Order`), unit names and related documents.
 */
export async function getOrder(
  client: SevdeskClient,
  orderId: number,
  signal?: AbortSignal,
  cacheOwner: object = client,
): Promise<OrderDetails> {
  const id = toSevdeskId(orderId);
  const withSignal = signal === undefined ? {} : { signal };
  const [payload, positions, unitNames, related] = await Promise.all([
    client.request({
      method: "GET",
      path: sevdeskPath("Order", id),
      query: { embed: EMBED_CONTACT },
      ...withSignal,
    }),
    listDocumentPositions(
      client,
      { path: "/OrderPos", parentKey: "order", objectName: "Order", what: "order positions" },
      id,
      signal,
    ),
    loadUnitNames(client, signal),
    loadRelatedDocuments(client, id, signal),
  ]);
  const record = parseOrderRecord(expectSingle(payload, `order ${id}`));
  const order = await withDocumentCountry(toOrderDetail(record), client, signal, cacheOwner);
  const context = { currency: order.currency, showNet: record.showNet, unitNames };
  return {
    order,
    positions: positions.rows.map((row) => toPositionDto(row, context)),
    positionsComplete: positions.complete,
    related,
  };
}

/**
 * Documents linked to an order (`GET /Order/{id}/getRelatedObjects?includeItself=0`), e.g. the
 * invoices created from it, without the order itself. Their shape is only known from one community
 * observation, so they are an extra: a failed request or an unreadable answer gives `undefined`
 * (the tool says so) instead of failing the whole order. Cancellation is still passed on.
 */
async function loadRelatedDocuments(
  client: SevdeskClient,
  orderId: number,
  signal: AbortSignal | undefined,
): Promise<readonly RelatedDocument[] | undefined> {
  try {
    const payload = await client.request({
      method: "GET",
      path: sevdeskPath("Order", orderId, "getRelatedObjects"),
      query: { includeItself: false },
      ...(signal === undefined ? {} : { signal }),
    });
    return relatedItems(payload)
      .map((raw) => toRelatedDocument(parseUpstream(relatedRecordSchema, raw, "related documents")))
      .filter((item) => !(item.objectName === "Order" && item.id === orderId));
  } catch (error) {
    if (!(error instanceof SevdeskError) || error.kind === "aborted") throw error;
    return undefined;
  }
}

/** The items of a list, or of an object with numeric keys (`{"0": …, "3": …}`). */
function relatedItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload as unknown[];
  if (typeof payload === "object" && payload !== null) {
    const entries = Object.entries(payload as Record<string, unknown>);
    if (entries.every(([key]) => /^\d+$/.test(key))) {
      return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => value);
    }
  }
  throw new SevdeskError({
    kind: "unexpected_response",
    message: "sevDesk returned related documents in an unexpected format.",
  });
}
