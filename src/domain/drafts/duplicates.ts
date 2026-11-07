/**
 * Duplicate warning for new drafts: an existing document of the same type for the same contact,
 * on the same date and with the same gross total is probably the same document created twice
 * (a repeated call, a retry by the client). The check only warns in the preview; it never blocks,
 * since two identical documents can be legitimate.
 *
 * It uses the list operations of the M2 domain with sevDesk's own filters (contact, date range,
 * type) and compares totals exactly. Only ids go into the warning; numbers are upstream text.
 */
import type { SevdeskClient } from "../../sevdesk/types.js";
import { listCreditNotes } from "../credit-notes.js";
import { listInvoices } from "../invoices.js";
import { compare } from "../money.js";
import { listOrders, type OrderTypeFilter } from "../orders.js";

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
    .filter(
      (row) =>
        row.currency === query.currency &&
        row.totals.gross !== undefined &&
        compare(row.totals.gross.amount, query.gross) === 0,
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
