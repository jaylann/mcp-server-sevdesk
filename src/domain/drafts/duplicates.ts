/**
 * Duplicate warning for new drafts: an existing document of the same type for the same contact,
 * on the same date and with the same gross total is probably the same document created twice
 * (a repeated call, a retry by the client). The check only warns in the preview; it never blocks,
 * since two identical documents can be legitimate.
 *
 * It uses the list operations of the M2 domain with sevDesk's own filters (contact, date range,
 * type) and compares totals exactly ({@link sameGross}, which the `duplicates` audit check uses as
 * well). Only ids go into the warning; numbers are upstream text.
 */
import type { SevdeskClient } from "../../sevdesk/types.js";
import { listCreditNotes } from "../credit-notes.js";
import { listInvoices } from "../invoices.js";
import { compare, type DecimalLike } from "../money.js";
import { listOrders, type OrderTypeFilter } from "../orders.js";

/** A gross total in a document's own currency; `undefined` when the document has none. */
export interface GrossAmount {
  readonly currency: string;
  readonly gross: DecimalLike | undefined;
}

/**
 * Whether two documents have the same gross total: the same currency and exactly the same amount
 * (decimal comparison, so `"10.5"` equals `"10.50"`). A missing total never matches; `0` is an
 * amount like any other.
 */
export function sameGross(a: GrossAmount, b: GrossAmount): boolean {
  return (
    a.currency === b.currency &&
    a.gross !== undefined &&
    b.gross !== undefined &&
    compare(a.gross, b.gross) === 0
  );
}

/** Rows checked per document type; a contact rarely has more documents on one day. */
const DUPLICATE_SCAN_LIMIT = 25;

export type DuplicateTarget =
  | { readonly kind: "invoice" }
  | { readonly kind: "creditNote" }
  | { readonly kind: "order"; readonly orderType: OrderTypeFilter };

export interface DuplicateQuery {
  readonly contactId: number;
  /** Document date, `YYYY-MM-DD`. */
  readonly date: string;
  /** Expected gross total with two decimals. */
  readonly gross: string;
  readonly currency: string;
}

/** Ids of existing documents that match `query` (same type, contact, date, currency and gross). */
export async function findDuplicates(
  client: SevdeskClient,
  target: DuplicateTarget,
  query: DuplicateQuery,
  signal?: AbortSignal,
): Promise<number[]> {
  const common = {
    contactId: query.contactId,
    from: query.date,
    to: query.date,
    limit: DUPLICATE_SCAN_LIMIT,
    offset: 0,
  };
  let rows: readonly {
    readonly id: number;
    readonly currency: string;
    readonly totals: { readonly gross?: { readonly amount: string } | undefined };
  }[];
  if (target.kind === "invoice") {
    rows = (await listInvoices(client, { ...common, type: "invoice" }, signal)).items;
  } else if (target.kind === "creditNote") {
    rows = (await listCreditNotes(client, common, signal)).items;
  } else {
    rows = (await listOrders(client, { ...common, type: target.orderType }, signal)).items;
  }
  return rows
    .filter((row) =>
      sameGross(
        { currency: row.currency, gross: row.totals.gross?.amount },
        { currency: query.currency, gross: query.gross },
      ),
    )
    .map((row) => row.id)
    .sort((a, b) => a - b);
}

/** The preview warning for found duplicates, or `undefined` when there are none. */
export function duplicateWarning(
  noun: string,
  ids: readonly number[],
  query: DuplicateQuery,
): string | undefined {
  if (ids.length === 0) return undefined;
  const which = ids.length === 1 ? `${noun} ${ids[0] ?? ""}` : `${noun}s ${ids.join(", ")}`;
  return (
    `Possible duplicate: ${which} for the same contact, date (${query.date}) and gross total ` +
    `(${query.gross} ${query.currency}) already exist${ids.length === 1 ? "s" : ""}. ` +
    "Check it before creating another one."
  );
}
