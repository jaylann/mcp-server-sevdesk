/**
 * Booking one bank transaction (Kontoumsatz) to one or more documents (Zuordnung, also split over
 * several invoices, credit notes or vouchers): the plan with every guard, and its execution.
 *
 * Each allocation is one `PUT /{Invoice|CreditNote|Voucher}/{id}/bookAmount` with the transaction
 * as `checkAccountTransaction` (B7), planned by `planPayment` (`lifecycle/payments.ts`), which
 * guards each document against over-booking and gives the sign, booking type and payload. On top
 * of that this module checks what `checkPaymentTransaction` cannot: a transaction that is already
 * partly assigned (status 200) is bookable up to its remaining amount from the booking log
 * (`transaction-log.ts`), and the allocations together never exceed what is left. Every
 * allocation must move money in the transaction's direction and currency, on its check account;
 * the transaction must not be enshrined.
 *
 * Execution sends the bookings in the order given, never retries, and when booking k + 1 fails
 * after k succeeded, rethrows the failure with the k documents and the transaction as completed
 * writes, so the user can finish the rest or undo with `sevdesk_transaction_reset`.
 */
import { SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import {
  type BankAccountDto,
  getBankAccount,
  getTransaction,
  type TransactionDto,
} from "../banking.js";
import {
  documentRef,
  KINDS,
  type LifecycleDocument,
  type PaymentKind,
  readLifecycleDocument,
} from "../lifecycle/documents.js";
import {
  type BookingType,
  checkPaymentAccount,
  openAmount,
  paymentDirection,
  type PaymentPlan,
  type PaymentType,
  planPayment,
} from "../lifecycle/payments.js";
import { formatMoney } from "../lifecycle/preview.js";
import { assertBookable, refuse } from "../lifecycle/transitions.js";
import { add, compare, money, subtract, toDecimalString } from "../money.js";
import { type Phrase, phrase, type PreviewLanguage } from "../preview-text.js";
import { readTransactionLog, remainingAmount, TRANSACTION_STATUS } from "./transaction-log.js";

/** Most documents one booking call may allocate a transaction to. */
export const MAX_ALLOCATIONS = 10;

/** One requested allocation. */
export interface AllocationRequest {
  readonly kind: PaymentKind;
  readonly id: number;
  /** Positive exact decimal; defaults to the smaller of the open amount and what is left. */
  readonly amount?: string | undefined;
  /** Defaults to `payment` (full or partial). */
  readonly paymentType?: PaymentType | undefined;
}

/**
 * One planned booking. `plan.bookingType` and `plan.payload` are what is sent: `planPayment` gets
 * the transaction's whole amount (`transactionAmount`), so a booking that uses only part of the
 * transaction (a split, the rest of a partly linked one, less than the transaction) goes out as
 * N, and a Skonto, bank-fee or other difference on part of a transaction is refused
 * (`transactionBookingType` in `lifecycle/payments.ts`, the one place of that rule). Measured on
 * the trial (2026-11-08): FULL_PAYMENT of 119 linked to +238 → 422 "Payment difference amount
 * must be 0.0 when using type 'NONE'"; N 119 + N 119 of +238 → both invoices paid (1000), the
 * transaction 200 then 400; N 119 of +119 on an invoice of 238 → 750; FULL_PAYMENT 1:1 → 1000.
 */
export interface PlannedAllocation {
  readonly doc: LifecycleDocument<PaymentKind>;
  readonly plan: PaymentPlan;
  /** True when the amount was not given and defaulted. */
  readonly amountDefaulted: boolean;
}

/**
 * The document-side booking type of a plan: what the payment does to the document. N sent for
 * part of a transaction with no amount left open on the document is a full payment (it settles
 * the document, measured).
 */
export function documentBookingType(plan: PaymentPlan): BookingType {
  return plan.bookingType === "N" && plan.remaining === undefined
    ? "FULL_PAYMENT"
    : plan.bookingType;
}

/** Everything a booking needs; built from reads only (deterministic for unchanged data). */
export interface AllocationPlan {
  readonly transaction: TransactionDto;
  readonly account: BankAccountDto;
  /** Booking day: the transaction's value date (else entry date), `YYYY-MM-DD`. */
  readonly bookingDate: string;
  /** Positive decimals in the transaction's currency. */
  readonly remainingBefore: string;
  readonly allocated: string;
  readonly remainingAfter: string;
  readonly allocations: readonly PlannedAllocation[];
  /** Consequences for the preview, in both languages. */
  readonly warnings: readonly Phrase[];
}

/** Reads a record; an unknown id becomes a trusted validation error. */
export async function lookup<T>(read: () => Promise<T>, missing: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") refuse(missing);
    throw error;
  }
}

const STATUS_REFUSALS: Readonly<Record<number, string>> = {
  [TRANSACTION_STATUS.private]:
    "is marked as private (Privatentnahme/-einlage); undo that with sevdesk_transaction_reset first",
  [TRANSACTION_STATUS.autoBooked]: "was booked automatically by sevDesk already",
  [TRANSACTION_STATUS.booked]: "is already fully booked",
};

/**
 * Checks that a transaction can take bookings at all: refuses an enshrined transaction, one
 * without a check account or with amount zero, and any status but free (100) and partly linked
 * (200).
 */
function assertTransactionBookable(transaction: TransactionDto): void {
  const ref = `Bank transaction ${String(transaction.id)}`;
  if (transaction.enshrined) {
    refuse(`${ref} is enshrined (festgeschrieben) and cannot be booked anymore.`);
  }
  if (transaction.account === undefined) refuse(`${ref} belongs to no check account.`);
  if (transaction.direction === "none") refuse(`${ref} has the amount zero; nothing to book.`);
  const status = transaction.status?.code;
  if (status !== TRANSACTION_STATUS.created && status !== TRANSACTION_STATUS.linked) {
    const reason =
      status === undefined
        ? "has no status"
        : (STATUS_REFUSALS[status] ?? `has status ${String(status)}`);
    refuse(
      `${ref} ${reason}; only unbooked (100) and partly linked (200) transactions can be booked. ` +
        "See it with sevdesk_transaction_get.",
    );
  }
}

/**
 * {@link assertTransactionBookable}, then what is left of the transaction (positive decimal);
 * refuses an unknown or zero remaining amount.
 */
function bookableRemaining(
  transaction: TransactionDto,
  remaining: ReturnType<typeof remainingAmount>,
): string {
  assertTransactionBookable(transaction);
  const ref = `Bank transaction ${String(transaction.id)}`;
  if (!remaining.known) {
    refuse(
      `${ref}: how much of it is still unassigned cannot be told (${remaining.reason}), so ` +
        "nothing is booked. Check it in the sevDesk web app.",
    );
  }
  if (compare(remaining.remaining, 0) <= 0) {
    refuse(`${ref} has nothing left to assign; it is fully booked.`);
  }
  return remaining.remaining;
}

/**
 * Plans booking `transactionId` to `requests` (in that order). Reads the transaction, its log,
 * its check account and every document; throws a trusted `validation` error before anything is
 * sent when a guard fails.
 */
export async function planAllocation(
  client: SevdeskClient,
  transactionId: number,
  requests: readonly AllocationRequest[],
  signal?: AbortSignal,
  cacheOwner: object = client,
): Promise<AllocationPlan> {
  if (requests.length === 0) refuse("Name at least one document to book the transaction to.");
  if (requests.length > MAX_ALLOCATIONS) {
    refuse(`At most ${MAX_ALLOCATIONS} documents can be booked in one call.`);
  }
  const seen = new Set<string>();
  for (const request of requests) {
    const key = `${request.kind}:${String(request.id)}`;
    if (seen.has(key)) {
      refuse(
        `${documentRef(request, true)} is named twice; give each document once with its total ` +
          "amount.",
      );
    }
    seen.add(key);
  }

  const transaction = await lookup(
    () => getTransaction(client, transactionId, signal),
    `Bank transaction ${String(transactionId)} does not exist; find it with ` +
      "sevdesk_transactions_list.",
  );
  assertTransactionBookable(transaction);
  const log = await readTransactionLog(client, transaction.id, signal);
  const remainingBefore = bookableRemaining(transaction, remainingAmount(transaction, log));
  const currency = transaction.amount.currency;
  const accountId = transaction.account?.id ?? 0;
  const account = await getBankAccount(client, accountId, signal);
  const bookingDate = transaction.valueDate ?? transaction.entryDate;
  if (bookingDate === undefined) {
    refuse(`Bank transaction ${String(transaction.id)} has no date to book the payments on.`);
  }

  const ref = `bank transaction ${String(transaction.id)}`;
  const show = (value: string, lang: PreviewLanguage = "en"): string =>
    formatMoney(money(value, currency), lang);
  const allocations: PlannedAllocation[] = [];
  const warnings: Phrase[] = [];
  const signed = transaction.amount.amount;
  const transactionTotal = toDecimalString(compare(signed, 0) < 0 ? subtract(0, signed) : signed);
  let allocated = "0";
  for (const request of requests) {
    const doc = await lookup(
      () => readLifecycleDocument(client, request.kind, request.id, signal, undefined, cacheOwner),
      `${documentRef(request, true)} does not exist; look it up with ` +
        `${KINDS[request.kind].toolPrefix}s_list.`,
    );
    assertBookable(doc);
    const docRef = documentRef(doc, true);
    const expected = paymentDirection(doc);
    if (expected !== transaction.direction) {
      const moves = transaction.direction === "in" ? "incoming" : "outgoing";
      const needs = expected === "in" ? "incoming money" : "outgoing money";
      refuse(
        `${docRef} needs ${needs}, but ${ref} is ${moves}. Invoices and revenue vouchers take ` +
          "incoming payments; credit notes and expense vouchers outgoing ones.",
      );
    }
    if (doc.currency !== currency) {
      refuse(
        `${docRef} is in ${doc.currency}, ${ref} in ${currency}; sevDesk books a transaction ` +
          "only to documents in its own currency.",
      );
    }
    checkPaymentAccount(doc, account, true);
    const left = toDecimalString(subtract(remainingBefore, allocated));
    let amount = request.amount;
    if (amount === undefined) {
      if (compare(left, 0) <= 0) {
        refuse(
          `Nothing of ${ref} is left for ${documentRef(doc)}: the documents before it take all ` +
            `${show(remainingBefore)}.`,
        );
      }
      const open = openAmount(doc).open;
      amount = compare(open, left) <= 0 ? open : left;
    }
    const total = toDecimalString(add(allocated, amount));
    if (compare(total, remainingBefore) > 0) {
      refuse(
        `The allocations add up to ${show(total)} or more, more than the ` +
          `${show(remainingBefore)} still unassigned on ${ref}. Lower the amounts.`,
      );
    }
    const plan = planPayment(doc, {
      amount,
      paymentType: request.paymentType ?? "payment",
      date: bookingDate,
      checkAccountId: account.id,
      transactionId: transaction.id,
      transactionAmount: transactionTotal,
    });
    allocated = total;
    allocations.push({ doc, plan, amountDefaulted: request.amount === undefined });
    const docRefDe = documentRef(doc, true, "de");
    warnings.push(
      ...plan.warnings.map((warning) =>
        phrase(`${docRef}: ${warning.en}`, `${docRefDe}: ${warning.de}`),
      ),
    );
  }

  const remainingAfter = toDecimalString(subtract(remainingBefore, allocated));
  if (compare(remainingAfter, 0) > 0) {
    warnings.push(
      phrase(
        `${show(remainingAfter)} of ${ref} stays unassigned: it becomes partly linked (status ` +
          "200) and can be booked further with sevdesk_transaction_book.",
        `${show(remainingAfter, "de")} von Kontoumsatz ${String(transaction.id)} bleiben ohne ` +
          "Zuordnung: Der Umsatz gilt dann als teilweise verknüpft (Status 200) und kann mit " +
          "sevdesk_transaction_book weiter gebucht werden.",
      ),
    );
  }
  return {
    transaction,
    account,
    bookingDate,
    remainingBefore,
    allocated,
    remainingAfter,
    allocations,
    warnings,
  };
}

/** A record a write changed: `{objectName, id}`, for `affected` and completed writes. */
export interface ChangedRecord {
  readonly objectName: string;
  readonly id: string;
}

/** `{objectName, id}` of a document. */
export function documentObject(kind: PaymentKind, id: number): ChangedRecord {
  return { objectName: KINDS[kind].objectName, id: String(id) };
}

/** `{objectName: "CheckAccountTransaction", id}`. */
export function transactionObject(id: number): ChangedRecord {
  return { objectName: "CheckAccountTransaction", id: String(id) };
}

/** One booking to send: the document and its `bookAmount` body from the plan. */
export interface BookingToSend {
  readonly kind: PaymentKind;
  readonly id: number;
  readonly payload: PaymentPlan["payload"];
}

/**
 * Sends the planned bookings in order (one `bookAmount` each, never retried). A failure after at
 * least one booking is rethrown with the booked documents and the transaction as completed
 * writes. Returns the records changed: the documents, then the transaction.
 */
export async function executeAllocation(
  client: SevdeskClient,
  transactionId: number,
  bookings: readonly BookingToSend[],
  signal?: AbortSignal,
): Promise<ChangedRecord[]> {
  const completed: ChangedRecord[] = [];
  for (const allocation of bookings) {
    try {
      await client.request({
        method: "PUT",
        path: sevdeskPath(KINDS[allocation.kind].objectName, allocation.id, "bookAmount"),
        body: allocation.payload,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (completed.length > 0 && error instanceof SevdeskError) {
        throw withCompletedWrites(error, [...completed, transactionObject(transactionId)]);
      }
      throw error;
    }
    completed.push(documentObject(allocation.kind, allocation.id));
  }
  return [...completed, transactionObject(transactionId)];
}
