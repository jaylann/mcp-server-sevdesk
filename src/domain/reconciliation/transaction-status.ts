/**
 * Changing a bank transaction's own status: marking it private (Privatentnahme/-einlage) and
 * undoing a transaction's bookings (private → unbooked, linked → its documents reset to open).
 *
 * Private: `PUT /CheckAccountTransaction/{id}` with `{status: 300}` and back with `{status: 100}`.
 * The spec's update model (`Model_CheckAccountTransactionUpdate`) declares `status` as an integer
 * 100/200/300/400 ("300 <-> Private"); sevdesk-rs sends a partial update with only the fields to
 * change. Recorded 2026-11-08 (probe `write-transaction-private-status`, D-076): `{status: 300}`
 * changes only the status, without a log entry, and `{status: 100}` restores it; both bodies are
 * built in {@link statusPayload} only.
 *
 * Reset of a linked transaction: sevDesk has no documented way to unlink one transaction; the
 * documents it paid are reset to open (`PUT /{Invoice|CreditNote|Voucher}/{id}/resetToOpen`),
 * which removes ALL payments of each document, not only this transaction's (D-060): other linked
 * transactions return to unbooked, transactions sevDesk created for bookings without one are
 * deleted (D-071). {@link planTransactionReset} lists that collateral from each document's paid
 * amount against this transaction's log entries, and refuses enshrined documents and
 * transactions.
 */
import { z } from "zod";

import type { SevdeskClient } from "../../sevdesk/types.js";
import { getBankAccount, getTransaction, type TransactionDto } from "../banking.js";
import type { CountryReadOptions } from "../country-codes.js";
import {
  documentRef,
  KINDS,
  type LifecycleDocument,
  type PaymentKind,
  readLifecycleDocument,
} from "../lifecycle/documents.js";
import { formatMoney } from "../lifecycle/preview.js";
import { assertResettable, refuse } from "../lifecycle/transitions.js";
import {
  add,
  compare,
  DEFAULT_CURRENCY,
  money,
  negate,
  subtract,
  toDecimalString,
} from "../money.js";
import { type Phrase, phrase } from "../preview-text.js";
import { lookup } from "./allocate.js";
import {
  entryShare,
  readTransactionLog,
  readWholeLog,
  TRANSACTION_STATUS,
} from "./transaction-log.js";

// ---------------------------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------------------------

/** Outgoing `PUT /CheckAccountTransaction/{id}` body (strict: unknown fields are ignored, D-003). */
const statusPayloadSchema = z.strictObject({
  status: z.union([z.literal(TRANSACTION_STATUS.created), z.literal(TRANSACTION_STATUS.private)]),
});

export type TransactionStatusPayload = z.output<typeof statusPayloadSchema>;

/** The body that marks a transaction private (`300`) or sets it back to unbooked (`100`). */
export function statusPayload(target: "private" | "created"): TransactionStatusPayload {
  return statusPayloadSchema.parse({
    status: target === "private" ? TRANSACTION_STATUS.private : TRANSACTION_STATUS.created,
  });
}

// ---------------------------------------------------------------------------------------------
// Mark private
// ---------------------------------------------------------------------------------------------

/**
 * Checks that a transaction can be marked private: unbooked (status 100), not enshrined, with an
 * amount. Returns the German term for what it becomes: Privatentnahme (money out, the owner took
 * it) or Privateinlage (money in, the owner put it in).
 */
export function assertMarkablePrivate(
  transaction: TransactionDto,
): "Privatentnahme" | "Privateinlage" {
  const ref = `Bank transaction ${String(transaction.id)}`;
  if (transaction.enshrined) {
    refuse(`${ref} is enshrined (festgeschrieben) and cannot be changed anymore.`);
  }
  const status = transaction.status?.code;
  if (status === TRANSACTION_STATUS.private) {
    refuse(`${ref} is already marked as private; there is nothing to do.`);
  }
  if (status !== TRANSACTION_STATUS.created) {
    refuse(
      `${ref} is booked or linked to documents (status ${status === undefined ? "unknown" : String(status)}); ` +
        "only unbooked transactions (status 100) can be marked private. Undo its bookings with " +
        "sevdesk_transaction_reset first.",
    );
  }
  if (transaction.direction === "none") refuse(`${ref} has the amount zero; nothing to mark.`);
  return transaction.direction === "out" ? "Privatentnahme" : "Privateinlage";
}

// ---------------------------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------------------------

/** Another bank transaction booked on a document the reset takes back. */
interface OtherTransaction {
  readonly id: number;
  /** Its share on the document, positive; `undefined` when the log entry has no amount. */
  readonly amount: string | undefined;
  /**
   * Its status after the reset, from the whole log: 200 (partly linked) while it still pays a
   * document the reset leaves alone, else 100 (unbooked). Measured (probe, 2026-11-08):
   * `resetToOpen` removes only the reset document's entries; a transaction keeping others goes
   * back to 200, one without any to 100.
   */
  readonly statusAfter: 100 | 200;
}

/** One document a reset takes back to open. */
interface ResetDocument {
  readonly doc: LifecycleDocument<PaymentKind>;
  /** What this transaction paid on it (positive, transaction currency). */
  readonly share: string;
  /**
   * Other payments on the document that the reset removes as well (paid amount minus `share`),
   * positive; `"0"` for none; `undefined` when sevDesk reports no paid amount (credit notes) or
   * its currency is undocumented (D-043).
   */
  readonly otherPayments: string | undefined;
  /**
   * The other bank transactions booked on the document (from the whole booking log), which lose
   * that booking too; `amount` is positive, `undefined` when the entry has none. Empty when the
   * paid amount shows no other payments (the log is then not scanned).
   */
  readonly otherTransactions: readonly OtherTransaction[];
}

export type ResetPlan =
  | { readonly mode: "private"; readonly transaction: TransactionDto; readonly warnings: Phrase[] }
  | {
      readonly mode: "linked";
      readonly transaction: TransactionDto;
      readonly documents: readonly ResetDocument[];
      /** Consequences for the preview, in both languages. */
      readonly warnings: Phrase[];
    };

/** Most documents one reset may take back. */
export const MAX_RESET_DOCUMENTS = 10;

/**
 * Plans undoing a transaction's bookings. Private (300) → back to unbooked. Linked (200), booked
 * (400) or auto-booked (350) with log entries → every document in the log reset to open, in the
 * order of the first entry for it. Refuses enshrined transactions, unbooked ones (nothing to do),
 * logs that are incomplete or name anything but invoices, credit notes and vouchers, documents
 * that are enshrined or cannot be reset to open, and more than {@link MAX_RESET_DOCUMENTS}.
 */
export async function planTransactionReset(
  client: SevdeskClient,
  transactionId: number,
  options: CountryReadOptions,
): Promise<ResetPlan> {
  const { signal, cacheOwner } = options;
  const transaction = await lookup(
    () => getTransaction(client, transactionId, signal),
    `Bank transaction ${String(transactionId)} does not exist; find it with ` +
      "sevdesk_transactions_list.",
  );
  const ref = `Bank transaction ${String(transaction.id)}`;
  if (transaction.enshrined) {
    refuse(
      `${ref} is enshrined (festgeschrieben); sevDesk keeps its bookings (resetToOpen answers ` +
        '422 "Already enshrined by payment"), so nothing can be undone.',
    );
  }
  const status = transaction.status?.code;
  if (status === TRANSACTION_STATUS.private) {
    return {
      mode: "private",
      transaction,
      warnings: [
        phrase(
          "The transaction is no longer private: it counts as unbooked again and can be booked " +
            "to documents (sevdesk_reconcile_suggest, sevdesk_transaction_book).",
          "Der Umsatz ist dann nicht mehr privat: Er gilt wieder als ungebucht und kann " +
            "Dokumenten zugeordnet werden (sevdesk_reconcile_suggest, sevdesk_transaction_book).",
        ),
      ],
    };
  }
  if (status === TRANSACTION_STATUS.created || status === undefined) {
    refuse(
      `${ref} is not booked (status ${String(status ?? "unknown")}); there is nothing to reset.`,
    );
  }

  const log = await readTransactionLog(client, transaction.id, signal);
  if (!log.complete) {
    refuse(`${ref}: its booking log could not be read completely, so nothing is reset.`);
  }
  if (log.entries.length === 0) {
    refuse(
      `${ref} is booked, but sevDesk's booking log links it to no document (it was booked ` +
        "another way, e.g. directly to an account). Undo it in the sevDesk web app.",
    );
  }
  const shares = new Map<string, { kind: PaymentKind; id: number; share: string }>();
  for (const entry of log.entries) {
    const document = entry.document;
    if (document === undefined || document.kind === "other") {
      refuse(
        `${ref} is linked to a record other than an invoice, credit note or voucher; reset it ` +
          "in the sevDesk web app.",
      );
    }
    const share = entryShare(entry, transaction.amount.amount);
    if ("problem" in share) refuse(`${ref}: ${share.problem}; nothing is reset.`);
    const key = `${document.kind}:${String(document.id)}`;
    const known = shares.get(key);
    shares.set(key, {
      kind: document.kind,
      id: document.id,
      share: toDecimalString(add(known?.share ?? "0", share.share)),
    });
  }
  if (shares.size > MAX_RESET_DOCUMENTS) {
    refuse(
      `${ref} is linked to ${shares.size} documents; this tool resets at most ` +
        `${MAX_RESET_DOCUMENTS}. Reset the documents one by one with their reset tools.`,
    );
  }

  const resettable: Omit<ResetDocument, "otherTransactions">[] = [];
  for (const { kind, id, share } of shares.values()) {
    const doc = await lookup(
      () => readLifecycleDocument(client, kind, id, { signal, cacheOwner }),
      `${documentRef({ kind, id }, true)}, which ${ref.toLowerCase()} is linked to, no longer ` +
        "exists; undo the booking in the sevDesk web app.",
    );
    if (doc.enshrined) {
      refuse(
        `${documentRef(doc, true)} is enshrined (festgeschrieben); this tool does not reset ` +
          `enshrined documents. Use ${KINDS[doc.kind].toolPrefix}_reset if it must be done.`,
      );
    }
    assertResettable(doc, "open");
    resettable.push({ doc, share, otherPayments: otherPayments(doc, share, transaction) });
  }
  const documents = await withOtherTransactions(client, transaction, resettable, signal);

  const account =
    transaction.account === undefined
      ? undefined
      : await getBankAccount(client, transaction.account.id, signal);
  return {
    mode: "linked",
    transaction,
    documents,
    warnings: resetWarnings(documents, account?.type),
  };
}

/**
 * Finds the other bank transactions booked on the documents, which a reset to open unlinks too.
 * When every document's paid amount equals this transaction's share there are none and nothing is
 * read. Otherwise (other payments, or a paid amount sevDesk does not report) the whole booking
 * log is scanned (its document filters are ignored, D-057) and the entries on these documents
 * from other transactions are collected. Refuses when that scan hits its cap or an entry on them
 * names no transaction: the preview could not name everything the reset changes.
 */
async function withOtherTransactions(
  client: SevdeskClient,
  transaction: TransactionDto,
  documents: readonly Omit<ResetDocument, "otherTransactions">[],
  signal: AbortSignal | undefined,
): Promise<ResetDocument[]> {
  const needsScan = documents.some(
    ({ otherPayments: other }) => other === undefined || compare(other, 0) > 0,
  );
  if (!needsScan) return documents.map((document) => ({ ...document, otherTransactions: [] }));
  const cannotName = (reason: string): never =>
    refuse(
      `Bank transaction ${String(transaction.id)}: the documents it paid have other payments, ` +
        `and ${reason}, so the reset cannot list every bank transaction it would unlink; nothing ` +
        "is reset. Reset the documents in the sevDesk web app or one by one with their reset " +
        "tools (sevdesk_invoice_reset, sevdesk_credit_note_reset, sevdesk_voucher_reset).",
    );
  const log = await readWholeLog(client, { signal });
  if (!log.complete) cannotName("sevDesk's booking log is too large to read completely");
  const others = new Map<string, Map<number, string | undefined>>();
  for (const entry of log.entries) {
    const document = entry.document;
    if (document === undefined || entry.transactionId === transaction.id) continue;
    const key = `${document.kind}:${String(document.id)}`;
    if (!documents.some(({ doc }) => `${doc.kind}:${String(doc.id)}` === key)) continue;
    const otherId = entry.transactionId;
    if (otherId === undefined) {
      return cannotName("its booking log has an entry on them that names no transaction");
    }
    const perDocument = others.get(key) ?? new Map<number, string | undefined>();
    const previous = perDocument.has(otherId) ? perDocument.get(otherId) : "0";
    const paid = entry.amountPaid;
    const amount = paid === undefined ? undefined : compare(paid, 0) < 0 ? negate(paid) : paid;
    perDocument.set(
      otherId,
      previous === undefined || amount === undefined
        ? undefined
        : toDecimalString(add(previous, amount)),
    );
    others.set(key, perDocument);
  }
  const resetKeys = new Set(documents.map(({ doc }) => `${doc.kind}:${String(doc.id)}`));
  const keepsBookings = (id: number): boolean =>
    log.entries.some(
      (entry) =>
        entry.transactionId === id &&
        entry.document !== undefined &&
        !resetKeys.has(`${entry.document.kind}:${String(entry.document.id)}`),
    );
  return documents.map((document) => {
    const found = others.get(`${document.doc.kind}:${String(document.doc.id)}`);
    const otherTransactions = [...(found ?? new Map<number, string | undefined>()).entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, amount]): OtherTransaction => ({
        id,
        amount,
        statusAfter: keepsBookings(id) ? 200 : 100,
      }));
    return { ...document, otherTransactions };
  });
}

/** Paid amount minus this transaction's share, when the paid amount can be compared. */
function otherPayments(
  doc: LifecycleDocument<PaymentKind>,
  share: string,
  transaction: TransactionDto,
): string | undefined {
  if (doc.paidAmount === undefined) return undefined;
  if (doc.currency !== DEFAULT_CURRENCY && doc.currency !== transaction.amount.currency) {
    return undefined;
  }
  const paid = compare(doc.paidAmount, 0) < 0 ? negate(doc.paidAmount) : doc.paidAmount;
  const other = subtract(paid, share);
  return compare(other, 0) <= 0 ? "0" : toDecimalString(other);
}

function resetWarnings(
  documents: readonly ResetDocument[],
  accountType: string | undefined,
): Phrase[] {
  const warnings = [
    phrase(
      "sevDesk cannot unlink a single transaction: each document is reset to open, which " +
        "removes ALL payments booked on it, not only this transaction's. This transaction " +
        "loses all its bookings and goes back to unbooked (status 100). Other bank " +
        "transactions booked on these documents (listed per document) lose only those " +
        "bookings: one that still pays other documents goes back to partly linked (200), one " +
        "without any left to unbooked (100). Transactions sevDesk created for payments booked " +
        "without one are deleted instead.",
      "sevDesk kann einen einzelnen Umsatz nicht lösen: Jedes Dokument wird auf offen " +
        "zurückgesetzt, und das entfernt ALLE darauf gebuchten Zahlungen, nicht nur die dieses " +
        "Umsatzes. Dieser Umsatz verliert alle seine Buchungen und gilt wieder als ungebucht " +
        "(Status 100). Andere Kontoumsätze, die auf diese Dokumente gebucht sind (je Dokument " +
        "aufgeführt), verlieren nur diese Buchungen: Bezahlt ein solcher Umsatz noch andere " +
        "Dokumente, gilt er danach als teilweise verknüpft (200), sonst als ungebucht (100). " +
        "Umsätze, die sevDesk für Zahlungen ohne Umsatz selbst angelegt hat, werden stattdessen " +
        "gelöscht.",
    ),
  ];
  for (const { doc, otherPayments: other, otherTransactions } of documents) {
    const ref = documentRef(doc, true);
    const refDe = documentRef(doc, true, "de");
    const found = otherTransactions.map(({ id, amount, statusAfter }) => {
      const share = amount === undefined ? undefined : money(amount, doc.currency);
      return phrase(
        `bank transaction ${String(id)} (${share === undefined ? "" : `${formatMoney(share)}, `}` +
          `${statusAfter === 200 ? "then partly linked (200)" : "then unbooked (100)"})`,
        `Kontoumsatz ${String(id)} (` +
          (share === undefined ? "" : `${formatMoney(share, "de")}, `) +
          `${statusAfter === 200 ? "danach teilweise verknüpft (200)" : "danach ungebucht (100)"})`,
      );
    });
    if (found.length > 0) {
      warnings.push(
        phrase(
          `${ref} also loses its payments from ${found.map((item) => item.en).join(", ")}; ` +
            "book them again afterwards if they stand.",
          `${refDe} verliert auch die Zahlungen aus ` +
            `${found.map((item) => item.de).join(", ")}; buchen Sie diese danach erneut, wenn ` +
            "sie weiterhin gelten.",
        ),
      );
    }
    const logged = otherTransactions.reduce(
      (sum, { amount }) => toDecimalString(add(sum, amount ?? "0")),
      "0",
    );
    if (other !== undefined && compare(other, logged) > 0) {
      const unexplained = money(subtract(other, logged), doc.currency);
      warnings.push(
        phrase(
          `${ref} shows ${formatMoney(unexplained)} more paid than its bank transactions ` +
            "explain; that payment is removed too.",
          `${refDe} weist ${formatMoney(unexplained, "de")} mehr als bezahlt aus, als die ` +
            "Kontoumsätze erklären; auch diese Zahlung wird entfernt.",
        ),
      );
    }
  }
  if (accountType === "clearing" || accountType === "cash") {
    warnings.push(
      phrase(
        "This transaction is on an offline or cash account, where sevDesk creates " +
          "transactions when a payment is booked without one; such a transaction is deleted by " +
          "the reset, not set back to unbooked.",
        "Dieser Umsatz liegt auf einem Offline- oder Kassenkonto, auf dem sevDesk Umsätze " +
          "selbst anlegt, wenn eine Zahlung ohne Umsatz gebucht wird; ein solcher Umsatz wird " +
          "beim Zurücksetzen gelöscht und nicht auf ungebucht gesetzt.",
      ),
    );
  }
  return warnings;
}
