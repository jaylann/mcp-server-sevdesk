/**
 * Bank transactions entered by hand (Umsatz von Hand erfassen), deleted again, and locked
 * (festschreiben): the checks, plans and read-back checks behind `sevdesk_transaction_create`,
 * `sevdesk_transaction_delete` and `sevdesk_transaction_enshrine`. The requests are in
 * `transaction-writes.ts`; booking a new row on documents reuses `allocate.ts`.
 *
 * What sevDesk does (recorded on the trial account, Update 2.0, spec/deviations.md):
 * - `POST /CheckAccountTransaction` creates a row at status 100 only on a file-import account
 *   (type `online`, `importType` CSV) and answers with the new row as one object under `objects`
 *   (value date at noon Berlin as sent). The cash register, offline (clearing) accounts and the
 *   base account refuse it with 422 "Use document bookAmount to create transactions on other
 *   types" (D-071, D-095, D-097). A bank-connected account could not be tested (a trial has
 *   none): its rows come from the bank, so it is refused here too. A cash sale or expense is a
 *   payment booked on its document against the register (`bookAmount` without a transaction),
 *   which creates the register row itself (D-095).
 * - `DELETE /CheckAccountTransaction/{id}` is a soft delete, only at status 100 (409 otherwise):
 *   the row stays readable by id with `deletedAt` set, and lists and balances leave it out
 *   (D-096). So a delete is confirmed by `deletedAt` on the read-back, never by a 404. It works
 *   the same on a row of an archived file-import account (recorded 2026-11-18, D-096).
 * - `PUT /CheckAccountTransaction/{id}/enshrine` needs status 200 or higher (422 at 100), is
 *   idempotent and irreversible: afterwards no status change, no delete, no further booking, and
 *   `resetToOpen` on the document it pays is refused (400 "Already enshrined by transaction",
 *   D-098). Recorded at 400 and, on 2026-11-18, at 200, 300 and 350. The document itself is not
 *   enshrined by it.
 *
 * Nothing here retries a write; every refusal is a trusted `validation` error raised before
 * anything is sent.
 */
import { z } from "zod";

import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import { zId } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import {
  type BankAccountDto,
  getBankAccount,
  getTransaction,
  listTransactions,
  MAX_SCAN_ROWS,
  type TransactionDto,
} from "../banking.js";
import { cleanText } from "../common.js";
import { documentRef, type PaymentKind } from "../lifecycle/documents.js";
import { bookingTimestamp, exactNumber, linkTransaction } from "../lifecycle/payments.js";
import { formatMoney } from "../lifecycle/preview.js";
import { refuse } from "../lifecycle/transitions.js";
import { compare, type Money, money, negate, toDecimalString } from "../money.js";
import { dateText, type Phrase, phrase, type PreviewLanguage } from "../preview-text.js";
import {
  type BookingToSend,
  type ChangedRecord,
  executeAllocation,
  lookup,
  transactionObject,
} from "./allocate.js";
import { readTransactionLog, TRANSACTION_STATUS } from "./transaction-log.js";
import { createTransaction, deleteTransaction, enshrineTransaction } from "./transaction-writes.js";

/** Longest counterparty accepted (the length the transaction DTO shows). */
export const COUNTERPARTY_MAX = 200;
/** Longest purpose (Verwendungszweck) accepted (the length the transaction DTO shows). */
export const PURPOSE_MAX = 500;
/** Matching rows of one day the duplicate check reads at most. */
const DUPLICATE_SCAN_MATCHES = 100;

// ---------------------------------------------------------------------------------------------
// Which accounts take hand-made transactions
// ---------------------------------------------------------------------------------------------

/** The tools that book a payment on a document; without a transaction they create the row. */
const PAYMENT_TOOLS =
  "sevdesk_voucher_book_payment, sevdesk_invoice_book_payment or " +
  "sevdesk_credit_note_book_payment";

/**
 * Refuses every account but an active file-import account, before anything is sent, with what to
 * do instead: on a cash register or a clearing account the payment is booked on its document
 * (sevDesk then creates the row itself); a bank-connected account gets its rows from the bank.
 */
export function assertManualEntryAccount(account: BankAccountDto): void {
  const ref = `Check account ${String(account.id)}`;
  if (account.status?.code === 0) {
    refuse(`${ref} is archived; enter the transaction on an active file-import account.`);
  }
  if (account.fileImport) return;
  switch (account.type) {
    case "cash":
      refuse(
        `${ref} is a cash register (Kasse), and sevDesk takes no hand-made transactions on it. ` +
          "Record a cash sale or cash expense by booking the payment on its document against " +
          `this register without transactionId (${PAYMENT_TOOLS}); sevDesk then adds the entry ` +
          "to the cash book itself.",
      );
      break;
    case "clearing":
      refuse(
        `${ref} is a clearing account (Verrechnungskonto, offline), and sevDesk takes no ` +
          "hand-made transactions on it. Book the payment on its document against this account " +
          `without transactionId (${PAYMENT_TOOLS}); sevDesk then creates the transaction itself.`,
      );
      break;
    case "bank":
      refuse(
        `${ref} is connected to a bank (or PayPal): its transactions come from the bank, so ` +
          "none are entered by hand. Book the imported row with sevdesk_transaction_book once it " +
          "is there; for transactions entered by hand use a file-import account " +
          "(sevdesk_bank_account_create, kind file_import).",
      );
      break;
    case "unknown":
      refuse(
        `${ref} is of an account type sevDesk does not document; transactions are entered by ` +
          "hand only on file-import accounts (fileImport in sevdesk_bank_accounts_list).",
      );
  }
}

/**
 * Refuses deleting a row of any account but a file-import account (the only one deleting was
 * recorded on), naming what undoes such a row instead.
 */
function assertDeletableOn(account: BankAccountDto, ref: string): void {
  if (account.fileImport) return;
  switch (account.type) {
    case "cash":
      refuse(
        `${ref} is on a cash register (Kasse), whose entries come from payments booked there; ` +
          "this tool does not delete them. Undo the payment by resetting its document to open " +
          "(sevdesk_voucher_reset, sevdesk_invoice_reset or sevdesk_credit_note_reset): sevDesk " +
          "then books a counter-entry dated that day.",
      );
      break;
    case "clearing":
      refuse(
        `${ref} is on a clearing account (Verrechnungskonto), whose transactions sevDesk ` +
          "creates for payments booked there; this tool does not delete them. Undo the payment " +
          "by resetting its document to open (sevdesk_voucher_reset, sevdesk_invoice_reset or " +
          "sevdesk_credit_note_reset), which deletes the transaction.",
      );
      break;
    case "bank":
      refuse(
        `${ref} is on a bank-connected account: its rows come from the bank, and deleting them ` +
          "through the API has not been tried. Delete a duplicate import in the sevDesk web app.",
      );
      break;
    case "unknown":
      refuse(
        `${ref} is on an account of a type sevDesk does not document; this tool deletes rows of ` +
          "file-import accounts only.",
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** An ISO date-time in UTC, as `Date.toISOString` writes it (the recorded request format). */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Outgoing `POST /CheckAccountTransaction` body (strict: sevDesk ignores unknown fields, D-003):
 * the body the probes recorded (`write-transaction-create`, `write-transaction-delete`), with
 * both dates at 12:00 Berlin as ISO date-times in UTC, so either reading keeps the day; both
 * dates read back as sent (D-016). Status 100 is the only one the spec allows on creation.
 */
const createPayloadSchema = z.strictObject({
  objectName: z.literal("CheckAccountTransaction"),
  mapAll: z.literal(true),
  valueDate: z.string().regex(UTC_DATE_TIME),
  entryDate: z.string().regex(UTC_DATE_TIME),
  amount: z.number(),
  paymtPurpose: z.string().min(1).max(PURPOSE_MAX).optional(),
  payeePayerName: z.string().min(1).max(COUNTERPARTY_MAX),
  checkAccount: z.strictObject({
    id: z.number().int().positive(),
    objectName: z.literal("CheckAccount"),
  }),
  status: z.literal(TRANSACTION_STATUS.created),
});

export type TransactionCreatePayload = z.output<typeof createPayloadSchema>;

/** What `sevdesk_transaction_create` is asked for (amount positive, `direction` gives the sign). */
export interface TransactionCreateInput {
  readonly checkAccountId: number;
  /** Value date, `YYYY-MM-DD` (Berlin). */
  readonly date: string;
  /** Positive exact decimal. */
  readonly amount: string;
  readonly direction: "in" | "out";
  /** Trimmed, not empty. */
  readonly counterparty: string;
  /** Trimmed and not empty, or absent. */
  readonly purpose?: string | undefined;
}

/** Everything the preview and the request of a new transaction need; built from reads only. */
export interface TransactionCreatePlan {
  readonly account: BankAccountDto;
  /** Signed as the money moves (positive = in), in the account's currency. */
  readonly amount: Money;
  readonly payload: TransactionCreatePayload;
  /** The counterparty and purpose as the preview shows them. */
  readonly counterparty: string;
  readonly purpose: string | undefined;
  /** Rows of the account on that day with the same amount and purpose (the duplicate check). */
  readonly duplicates: readonly number[];
  /** Consequences for the preview, in both languages. */
  readonly warnings: readonly Phrase[];
}

/**
 * Checks a transaction to enter by hand and builds its request. Reads only: the account
 * (`GET /CheckAccount/{id}`) and its rows of that day (the duplicate check). Refuses unknown and
 * unsuitable accounts ({@link assertManualEntryAccount}) and amounts that cannot be sent exactly.
 *
 * The duplicate check guards against a doubled row when a call is repeated (the POST is never
 * retried, but a model may call the tool twice): rows of the same account and value date with
 * the same signed amount and purpose (compared without case and extra spaces) are named in a
 * warning, so the human who confirms sees them. It warns rather than refuses, because two equal
 * payments on one day happen. sevDesk's lists leave deleted rows out (D-096). sevDesk filters
 * dates only by entry date (D-047), so the value date is filtered here: the check reads the
 * account's rows, newest first by value date as sevDesk lists them (D-145), until it passes that
 * day, holds {@link DUPLICATE_SCAN_MATCHES} of that day or has searched `MAX_SCAN_ROWS`, and a
 * warning says when one of the last two stopped it.
 */
export async function planTransactionCreate(
  client: SevdeskClient,
  input: TransactionCreateInput,
  signal?: AbortSignal,
): Promise<TransactionCreatePlan> {
  const account = await lookup(
    () => getBankAccount(client, input.checkAccountId, signal),
    `Check account ${String(input.checkAccountId)} does not exist; list the accounts with ` +
      "sevdesk_bank_accounts_list.",
  );
  assertManualEntryAccount(account);
  const signed = input.direction === "out" ? toDecimalString(negate(input.amount)) : input.amount;
  const amount = money(signed, account.currency);
  const noon = new Date(bookingTimestamp(input.date) * 1000).toISOString();
  const payload = createPayloadSchema.parse({
    objectName: "CheckAccountTransaction",
    mapAll: true,
    valueDate: noon,
    entryDate: noon,
    amount: exactNumber(toDecimalString(signed)),
    ...(input.purpose === undefined ? {} : { paymtPurpose: input.purpose }),
    payeePayerName: input.counterparty,
    checkAccount: { id: account.id, objectName: "CheckAccount" },
    status: TRANSACTION_STATUS.created,
  });

  const scan = await listTransactions(
    client,
    {
      checkAccountId: account.id,
      from: input.date,
      to: input.date,
      dateField: "value",
      limit: DUPLICATE_SCAN_MATCHES,
      offset: 0,
    },
    { signal },
  );
  const wanted = purposeKey(input.purpose);
  const duplicates = scan.items
    .filter(
      (row) =>
        row.deleted !== true &&
        compare(row.amount.amount, signed) === 0 &&
        purposeKey(row.purpose) === wanted,
    )
    .map((row) => row.id);

  const show = (lang: PreviewLanguage) => formatMoney(amount, lang);
  const warnings: Phrase[] = [
    phrase(
      `The new row changes the balance of account ${String(account.id)} by ${show("en")} and ` +
        "counts as unbooked (status 100) until it is booked to documents. It can be deleted " +
        "again only while it is unbooked (sevdesk_transaction_delete).",
      `Der neue Umsatz ändert den Saldo des Kontos ${String(account.id)} um ${show("de")} und ` +
        "gilt als ungebucht (Status 100), bis er Dokumenten zugeordnet ist. Löschen lässt er " +
        "sich nur, solange er ungebucht ist (sevdesk_transaction_delete).",
    ),
  ];
  const day = (lang: PreviewLanguage) => dateText(input.date, lang);
  if (duplicates.length > 0) {
    const ids = duplicates.slice(0, 10).map(String).join(", ");
    warnings.push(
      phrase(
        `Account ${String(account.id)} already has ${duplicates.length === 1 ? "a row" : `${String(duplicates.length)} rows`} ` +
          `on ${day("en")} with the same amount and purpose (bank transaction ${ids}). If this ` +
          "is the same payment, do not create it again.",
        `Das Konto ${String(account.id)} hat am ${day("de")} bereits ` +
          `${duplicates.length === 1 ? "einen Umsatz" : `${String(duplicates.length)} Umsätze`} ` +
          `mit demselben Betrag und Verwendungszweck (Kontoumsatz ${ids}). Ist es dieselbe ` +
          "Zahlung, lege sie nicht noch einmal an.",
      ),
    );
  }
  if (scan.scanCapped) {
    // sevDesk lists the rows newest first by value date (D-145), and the scan ends at the first
    // row before that day; it stopped at its cap instead, so the newest rows, all dated that day
    // or later, filled it, and rows of that day may lie beyond.
    warnings.push(
      phrase(
        `Account ${String(account.id)} has more than ${String(MAX_SCAN_ROWS)} rows dated ` +
          `${day("en")} or later, more than the duplicate check searches, so rows dated ` +
          `${day("en")} may not all have been checked; check it with sevdesk_transactions_list ` +
          "before confirming.",
        `Das Konto ${String(account.id)} hat mehr als ${String(MAX_SCAN_ROWS)} Umsätze vom ` +
          `${day("de")} oder später, mehr als die Prüfung auf Doppelte durchsucht; Umsätze vom ` +
          `${day("de")} wurden daher womöglich nicht alle geprüft. Prüfe es vor der Bestätigung ` +
          "mit sevdesk_transactions_list.",
      ),
    );
  } else if (scan.hasMore) {
    // Below the cap, the scan stops early only once it holds DUPLICATE_SCAN_MATCHES rows of
    // that day.
    warnings.push(
      phrase(
        "The account has more rows on that day than were checked for duplicates; check it " +
          "with sevdesk_transactions_list before confirming.",
        "Das Konto hat an diesem Tag mehr Umsätze, als auf Doppelte geprüft wurden; prüfe es " +
          "vor der Bestätigung mit sevdesk_transactions_list.",
      ),
    );
  }
  return {
    account,
    amount,
    payload,
    counterparty: cleanText(input.counterparty, COUNTERPARTY_MAX) ?? "",
    purpose: cleanText(input.purpose, PURPOSE_MAX),
    duplicates,
    warnings,
  };
}

/** A purpose for comparisons: Unicode-normalized, spaces collapsed, case ignored; none is "". */
function purposeKey(purpose: string | undefined): string {
  return (purpose ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

const createdSchema = z.object({ id: zId });
const nestedCreatedSchema = z.object({ checkAccountTransaction: createdSchema });

/**
 * The id of the transaction sevDesk created, from its answer. As recorded (D-071), `objects`
 * (unwrapped by the client) is one object: the new row itself, with the keys of a GET row. An
 * array of one or the row under a `checkAccountTransaction` key were never seen here and are only
 * tolerated. `undefined` when the answer names none.
 */
function createdTransactionId(answer: unknown): number | undefined {
  let single: unknown;
  try {
    single = expectSingle(answer, "created bank transaction");
  } catch (error) {
    if (error instanceof SevdeskError) return undefined;
    throw error;
  }
  const direct = createdSchema.safeParse(single);
  if (direct.success) return direct.data.id;
  const nested = nestedCreatedSchema.safeParse(single);
  return nested.success ? nested.data.checkAccountTransaction.id : undefined;
}

/** What {@link executeTransactionCreate} sends: the new row, then its bookings (unlinked). */
export interface TransactionCreateState {
  readonly payload: TransactionCreatePayload;
  /** Planned against the row before it existed: their payloads carry no transaction yet. */
  readonly bookings: readonly BookingToSend[];
}

/**
 * Creates the transaction (one POST, never retried) and, when bookings were planned, links each
 * to the new row and books it (`executeAllocation`). Returns the new id and the records changed.
 * An answer without an id fails with a message that says the row was probably created; a booking
 * that fails is rethrown with the new transaction (and the documents booked before it) as
 * completed writes, so the result says exactly what exists.
 */
export async function executeTransactionCreate(
  client: SevdeskClient,
  state: TransactionCreateState,
  signal?: AbortSignal,
): Promise<{ readonly id: number; readonly changed: readonly ChangedRecord[] }> {
  const answer = await createTransaction(client, state.payload, signal);
  const id = createdTransactionId(answer);
  if (id === undefined) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        "sevDesk accepted the new bank transaction, but its answer did not name it, so its id " +
        "is unknown and nothing was booked. Do not repeat the call: look for the row with " +
        `sevdesk_transactions_list (account ${String(state.payload.checkAccount.id)}) first.`,
    });
  }
  const created = transactionObject(id);
  if (state.bookings.length === 0) return { id, changed: [created] };
  try {
    const changed = await executeAllocation(
      client,
      id,
      state.bookings.map((booking) => ({
        ...booking,
        payload: linkTransaction(booking.payload, id),
      })),
      signal,
    );
    return { id, changed };
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    const listed = error.completedWrites.some(
      (record) => record.objectName === created.objectName && record.id === created.id,
    );
    throw listed ? error : withCompletedWrites(error, [created]);
  }
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

/**
 * Checks that a transaction can be deleted: it exists and is not deleted yet, is not enshrined,
 * belongs to a file-import account ({@link assertDeletableOn}) and is unbooked (status 100, the
 * only status sevDesk deletes, D-096). Reads the transaction and its account.
 */
export async function planTransactionDelete(
  client: SevdeskClient,
  transactionId: number,
  signal?: AbortSignal,
): Promise<{ readonly transaction: TransactionDto; readonly account: BankAccountDto }> {
  const transaction = await readTransaction(client, transactionId, signal);
  const ref = `Bank transaction ${String(transaction.id)}`;
  if (transaction.deleted === true) {
    const on = transaction.deletedOn === undefined ? "" : ` on ${transaction.deletedOn}`;
    refuse(`${ref} was deleted already${on}; there is nothing to do.`);
  }
  if (transaction.enshrined) {
    refuse(`${ref} is enshrined (festgeschrieben); sevDesk never deletes it.`);
  }
  if (transaction.account === undefined) refuse(`${ref} belongs to no check account.`);
  const accountId = transaction.account.id;
  const account = await lookup(
    () => getBankAccount(client, accountId, signal),
    `${ref} belongs to check account ${String(accountId)}, which sevDesk does not know.`,
  );
  assertDeletableOn(account, ref);
  const status = transaction.status?.code;
  if (status === TRANSACTION_STATUS.private) {
    refuse(
      `${ref} is marked as private; sevDesk deletes only unbooked rows (status 100). Set it ` +
        "back to unbooked with sevdesk_transaction_reset first.",
    );
  }
  if (status !== TRANSACTION_STATUS.created) {
    refuse(
      `${ref} is booked or linked to documents (status ${status === undefined ? "unknown" : String(status)}); ` +
        "sevDesk deletes only unbooked rows (status 100). Undo its bookings with " +
        "sevdesk_transaction_reset first (it resets the documents it pays to open), then " +
        "delete it.",
    );
  }
  return { transaction, account };
}

/**
 * Deletes the transaction (one DELETE, never retried) and confirms it by reading it back: sevDesk
 * keeps a deleted row readable by id with `deletedAt` (D-096), so success is that mark, never a
 * missing row. A row that reads back live, or not at all, fails with the transaction as a
 * completed write: sevDesk accepted the request, and the user must look before trying again.
 */
export async function executeTransactionDelete(
  client: SevdeskClient,
  transactionId: number,
  signal?: AbortSignal,
): Promise<TransactionDto> {
  await deleteTransaction(client, transactionId, signal);
  const changed = [transactionObject(transactionId)];
  const ref = `bank transaction ${String(transactionId)}`;
  const after = await readBack(client, transactionId, changed, signal, () =>
    unexpected(
      `sevDesk accepted the delete of ${ref}, but the row could not be read back afterwards, ` +
        "although sevDesk keeps deleted rows readable by id. Check the account's rows with " +
        "sevdesk_transactions_list before trying again.",
      changed,
    ),
  );
  if (after.deleted !== true) {
    throw unexpected(
      `sevDesk accepted the delete of ${ref}, but the row still reads back as not deleted. ` +
        "Check it with sevdesk_transaction_get before trying again.",
      changed,
    );
  }
  return after;
}

// ---------------------------------------------------------------------------------------------
// Enshrine
// ---------------------------------------------------------------------------------------------

/** A document an enshrined transaction pays, as the preview names it. */
export interface PaidDocument {
  readonly kind: PaymentKind | "other";
  readonly id: number;
  /** sevDesk's objectName (letters only) for kind `other`. */
  readonly objectName: string;
}

/** What locking a transaction changes, for the preview. */
export interface TransactionEnshrinePlan {
  readonly transaction: TransactionDto;
  /** The documents its booking log links it to, first entry first. */
  readonly documents: readonly PaidDocument[];
  /** False when the booking log could not be read completely. */
  readonly logComplete: boolean;
}

/**
 * Checks that a transaction can be locked: it exists, is not deleted and not enshrined yet, and
 * has status 200 (linked) or higher, the spec's rule and sevDesk's (422 at 100, recorded, D-098;
 * locking was recorded at 200, 300, 350 and 400). Reads its booking log for the documents it
 * pays.
 */
export async function planTransactionEnshrine(
  client: SevdeskClient,
  transactionId: number,
  signal?: AbortSignal,
): Promise<TransactionEnshrinePlan> {
  const transaction = await readTransaction(client, transactionId, signal);
  const ref = `Bank transaction ${String(transaction.id)}`;
  if (transaction.deleted === true) {
    refuse(`${ref} was deleted; a deleted row cannot be locked.`);
  }
  if (transaction.enshrined) {
    refuse(`${ref} is already enshrined (festgeschrieben); there is nothing to do.`);
  }
  const status = transaction.status?.code;
  if (status === undefined || status < TRANSACTION_STATUS.linked) {
    refuse(
      `${ref} is ${status === TRANSACTION_STATUS.created ? "unbooked (status 100)" : `at status ${String(status ?? "unknown")}`}; ` +
        "sevDesk locks only transactions that are linked or booked (status 200 or higher). " +
        "Book it first (sevdesk_transaction_book).",
    );
  }
  const log = await readTransactionLog(client, transaction.id, signal);
  const documents: PaidDocument[] = [];
  for (const entry of log.entries) {
    const document = entry.document;
    if (document === undefined) continue;
    if (documents.some((known) => known.kind === document.kind && known.id === document.id)) {
      continue;
    }
    documents.push({ kind: document.kind, id: document.id, objectName: document.objectName });
  }
  return { transaction, documents, logComplete: log.complete };
}

/** A document of {@link TransactionEnshrinePlan} as trusted preview text ("invoice 1001"). */
export function paidDocumentText(document: PaidDocument, lang: PreviewLanguage): string {
  if (document.kind === "other") {
    // sevDesk's objectName, reduced to letters by the log parser; a generic noun without one.
    const name =
      document.objectName === "" ? (lang === "de" ? "Datensatz" : "record") : document.objectName;
    return `${name} ${String(document.id)}`;
  }
  return documentRef({ kind: document.kind, id: document.id }, false, lang);
}

/**
 * Locks the transaction (one PUT, never retried; sevDesk answers `{objects: null}`) and confirms
 * it by reading back `enshrined`. A row that does not read back as enshrined fails with the
 * transaction as a completed write.
 */
export async function executeTransactionEnshrine(
  client: SevdeskClient,
  transactionId: number,
  signal?: AbortSignal,
): Promise<TransactionDto> {
  await enshrineTransaction(client, transactionId, signal);
  const changed = [transactionObject(transactionId)];
  const ref = `bank transaction ${String(transactionId)}`;
  const after = await readBack(client, transactionId, changed, signal);
  if (!after.enshrined) {
    throw unexpected(
      `sevDesk accepted locking ${ref}, but it does not read back as enshrined. Check it with ` +
        "sevdesk_transaction_get before trying again.",
      changed,
    );
  }
  return after;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A transaction by id; an unknown id becomes a trusted validation error. */
function readTransaction(
  client: SevdeskClient,
  transactionId: number,
  signal: AbortSignal | undefined,
): Promise<TransactionDto> {
  return lookup(
    () => getTransaction(client, transactionId, signal),
    `Bank transaction ${String(transactionId)} does not exist; find it with ` +
      "sevdesk_transactions_list.",
  );
}

/**
 * Reads the transaction back after a write. A failed read is rethrown with `changed` as completed
 * writes; `whenMissing` replaces a not-found error (sevDesk keeps deleted rows readable).
 */
async function readBack(
  client: SevdeskClient,
  transactionId: number,
  changed: readonly ChangedRecord[],
  signal: AbortSignal | undefined,
  whenMissing?: () => SevdeskError,
): Promise<TransactionDto> {
  try {
    return await getTransaction(client, transactionId, signal);
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    if (error.kind === "not_found" && whenMissing !== undefined) throw whenMissing();
    throw withCompletedWrites(error, changed);
  }
}

/** An `unexpected_response` after a write sevDesk accepted, with what it changed. */
function unexpected(message: string, changed: readonly ChangedRecord[]): SevdeskError {
  return new SevdeskError({ kind: "unexpected_response", message, completedWrites: changed });
}
