/**
 * The requests that create a bank transaction or change its own state, sent from `execute` of
 * `sevdesk_transaction_mark_private`, `sevdesk_transaction_reset`, `sevdesk_transaction_create`,
 * `sevdesk_transaction_delete` and `sevdesk_transaction_enshrine` with the client scoped to the
 * tool's tier. Checks, plans and payloads are in `transaction-status.ts` and
 * `manual-transactions.ts`; the paths are built only here, so the tool layer never talks to the
 * client itself (review 2026-11, round 3). Every request changes data: sent once, never retried.
 */
import { SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { resetDocument } from "../lifecycle/actions.js";
import type { PaymentKind } from "../lifecycle/documents.js";
import { type ChangedRecord, documentObject, transactionObject } from "./allocate.js";
import type { TransactionCreatePayload } from "./manual-transactions.js";
import type { TransactionStatusPayload } from "./transaction-status.js";

/**
 * Creates a transaction: `POST /CheckAccountTransaction` with a body from
 * `transactionCreatePayload` (accepted on file-import accounts only, D-071, D-095). Returns
 * sevDesk's answer, unread: `createdTransactionId` reads the new id from it.
 */
export async function createTransaction(
  client: SevdeskClient,
  payload: TransactionCreatePayload,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "POST",
    path: "/CheckAccountTransaction",
    body: payload,
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Deletes a transaction: `DELETE /CheckAccountTransaction/{id}`, no body. A soft delete: the row
 * stays readable by id with `deletedAt` set (D-096), so the caller confirms it by reading back.
 */
export async function deleteTransaction(
  client: SevdeskClient,
  transactionId: number,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "DELETE",
    path: sevdeskPath("CheckAccountTransaction", transactionId),
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Enshrines (festschreiben) a transaction for good: `PUT /CheckAccountTransaction/{id}/enshrine`,
 * no body; sevDesk answers `{objects: null}` (D-098), so the caller reads back `enshrined`.
 */
export async function enshrineTransaction(
  client: SevdeskClient,
  transactionId: number,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: "PUT",
    path: sevdeskPath("CheckAccountTransaction", transactionId, "enshrine"),
    ...(signal === undefined ? {} : { signal }),
  });
}

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
