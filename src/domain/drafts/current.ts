/**
 * The stored state of a draft that an update tool changes: the raw writable fields of the
 * invoice or order (`GET /Invoice/{id}`, `GET /Order/{id}`) and its position rows.
 *
 * Updates go through the save factories with the document's id (spec tag `InvoicePos`: "you must
 * use the same endpoint as when creating an invoice, then passing in the ID along with the
 * objectName of the invoice and mapAll"). Whether sevDesk then clears fields the body leaves out
 * is not recorded, so update bodies carry every writable field this server knows over unchanged.
 * That is why these schemas keep raw values (texts untrimmed and unsanitized, decimals as sent)
 * instead of the display DTOs, which cap and clean text. Nothing here is shown to the model.
 */
import { z } from "zod";

import { toBerlinDate } from "../../sevdesk/dates.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import {
  parseUpstream,
  zBool01,
  zId,
  zIntish,
  zOptionalDecimal,
  zOptionalInt,
  zOptionalRef,
  zText,
} from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { listDocumentPositions, type PositionRecord } from "../document-positions.js";

const zOptionalBool = zBool01.optional();
/** Dates arrive as ISO date-times (or Unix seconds); kept raw and converted with {@link berlinDay}. */
const zDate = z.unknown().optional();

/** Fields shared by invoices and orders that an update carries over. */
const documentShape = {
  id: zId,
  status: zIntish,
  contact: zOptionalRef,
  contactPerson: zOptionalRef,
  header: zText,
  headText: zText,
  footText: zText,
  currency: zText,
  showNet: zOptionalBool,
  smallSettlement: zOptionalBool,
  taxRule: zOptionalRef,
  taxType: zText,
  taxSet: zOptionalRef,
  taxText: zText,
  address: zText,
  addressCountry: zOptionalRef,
  customerInternalNote: zText,
  origin: zOptionalRef,
  sumNet: zOptionalDecimal,
  sumTax: zOptionalDecimal,
  sumGross: zOptionalDecimal,
  sumNetForeignCurrency: zOptionalDecimal,
  sumTaxForeignCurrency: zOptionalDecimal,
  sumGrossForeignCurrency: zOptionalDecimal,
};

const currentInvoiceSchema = z.object({
  ...documentShape,
  invoiceNumber: zText,
  invoiceType: zText,
  invoiceDate: zDate,
  deliveryDate: zDate,
  deliveryDateUntil: zDate,
  timeToPay: zOptionalInt,
  discount: zOptionalDecimal,
  discountTime: zOptionalInt,
  addressName: zText,
  addressStreet: zText,
  addressZip: zText,
  addressCity: zText,
  paymentMethod: zOptionalRef,
  costCentre: zOptionalRef,
  propertyIsEInvoice: zOptionalBool,
  enshrined: zDate,
});

export type CurrentInvoice = z.output<typeof currentInvoiceSchema>;

const currentOrderSchema = z.object({
  ...documentShape,
  orderNumber: zText,
  orderType: zText,
  orderDate: zDate,
  version: zOptionalInt,
  deliveryTerms: zText,
  paymentTerms: zText,
});

export type CurrentOrder = z.output<typeof currentOrderSchema>;

/** A stored draft with its position rows (sorted by position number). */
export interface CurrentDraft<D> {
  readonly document: D;
  readonly positions: readonly PositionRecord[];
}

/** The stored invoice and its positions. A missing invoice is a `validation` error. */
export async function loadCurrentInvoice(
  client: SevdeskClient,
  invoiceId: number,
  signal?: AbortSignal,
): Promise<CurrentDraft<CurrentInvoice>> {
  const id = toSevdeskId(invoiceId);
  const [payload, positions] = await Promise.all([
    readOrExplain(
      client,
      sevdeskPath("Invoice", id),
      `Invoice ${id}`,
      "sevdesk_invoices_list",
      signal,
    ),
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
  ]);
  const document = parseUpstream(
    currentInvoiceSchema,
    expectSingle(payload, `invoice ${id}`),
    "an invoice",
  );
  return { document, positions: completePositions(positions, `invoice ${id}`) };
}

/** The stored order and its positions. A missing order is a `validation` error. */
export async function loadCurrentOrder(
  client: SevdeskClient,
  orderId: number,
  signal?: AbortSignal,
): Promise<CurrentDraft<CurrentOrder>> {
  const id = toSevdeskId(orderId);
  const [payload, positions] = await Promise.all([
    readOrExplain(client, sevdeskPath("Order", id), `Order ${id}`, "sevdesk_orders_list", signal),
    listDocumentPositions(
      client,
      { path: "/OrderPos", parentKey: "order", objectName: "Order", what: "order positions" },
      id,
      signal,
    ),
  ]);
  const document = parseUpstream(
    currentOrderSchema,
    expectSingle(payload, `order ${id}`),
    "an order",
  );
  return { document, positions: completePositions(positions, `order ${id}`) };
}

/** The Berlin calendar day of a stored date, or `undefined` when unset. */
export function berlinDay(value: unknown): string | undefined {
  return toBerlinDate(value);
}

async function readOrExplain(
  client: SevdeskClient,
  path: string,
  label: string,
  listTool: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return await client.request({
      method: "GET",
      path,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      throw new SevdeskError({
        kind: "validation",
        message: `${label} does not exist in sevDesk. Find the right id with ${listTool}.`,
      });
    }
    throw error;
  }
}

/**
 * Positions must be complete: replacing them deletes every stored row, and a row that could not
 * be read would survive next to the new ones.
 */
function completePositions(
  rows: { readonly rows: readonly PositionRecord[]; readonly complete: boolean },
  label: string,
): readonly PositionRecord[] {
  if (!rows.complete) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `The ${label} has more positions than this server reads at once, so it cannot be ` +
        "updated safely here. Edit it in sevDesk.",
    });
  }
  return rows.rows;
}
