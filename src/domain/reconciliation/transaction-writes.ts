/**
 * The requests that change a bank transaction's own state, sent from `execute` of
 * `sevdesk_transaction_mark_private` and `sevdesk_transaction_reset` with the client scoped to
 * the tool's tier. Checks, plans and the payload are in `transaction-status.ts`; the paths are
 * built only here, so the tool layer never talks to the client itself (review 2026-11, round 3).
 * Every request changes data: sent once, never retried.
 */
import { SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { resetDocument } from "../lifecycle/actions.js";
import type { PaymentKind } from "../lifecycle/documents.js";
import { type ChangedRecord, documentObject, transactionObject } from "./allocate.js";
import type { TransactionStatusPayload } from "./transaction-status.js";

/**
 * Sets a transaction's status: `PUT /CheckAccountTransaction/{id}` with a body from
 * `statusPayload` (`{status: 300}` private, `{status: 100}` unbooked again).
 */
export async function updateTransactionStatus(
  client: SevdeskClient,
  transactionId: number,
  payload: TransactionStatusPayload,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "PUT",
    path: sevdeskPath("CheckAccountTransaction", transactionId),
    body: payload,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** One document a transaction reset takes back to open. */
export interface DocumentToReset {
  readonly kind: PaymentKind;
  readonly id: number;
  /** Other bank transactions booked on it, which its reset unlinks too. */
  readonly otherTransactionIds: readonly number[];
}

/**
 * Undoes a linked transaction's bookings: resets each document to open, in order
 * (`resetDocument`: `PUT /{Invoice|CreditNote|Voucher}/{id}/resetToOpen`). Returns the records
 * changed: the documents, this transaction, then the other transactions those resets unlinked, by
 * id. A failure after at least one reset is rethrown with the records changed so far as completed
 * writes.
 */
export async function executeTransactionReset(
  client: SevdeskClient,
  transactionId: number,
  documents: readonly DocumentToReset[],
  signal?: AbortSignal,
): Promise<ChangedRecord[]> {
  const done: ChangedRecord[] = [];
  const unlinked = new Set<number>();
  /** The documents reset so far, this transaction, and the other transactions they unlinked. */
  const changedSoFar = (): ChangedRecord[] => [
    ...done,
    transactionObject(transactionId),
    ...[...unlinked].sort((a, b) => a - b).map((id) => transactionObject(id)),
  ];
  for (const { kind, id, otherTransactionIds } of documents) {
    try {
      await resetDocument(client, kind, id, "open", signal);
    } catch (error) {
      if (done.length > 0 && error instanceof SevdeskError) {
        throw withCompletedWrites(error, changedSoFar());
      }
      throw error;
    }
    done.push(documentObject(kind, id));
    for (const other of otherTransactionIds) unlinked.add(other);
  }
  return changedSoFar();
}
