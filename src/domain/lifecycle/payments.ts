/**
 * Payment booking (Zahlung buchen) for invoices and credit notes: the open-amount maths, the
 * over-booking guard, the checks on the check account (Zahlungskonto) and on a bank transaction to
 * link, and the strict `bookAmount` payload. All amounts are exact decimals (`money.ts`).
 *
 * Wire format of `PUT /{Invoice|CreditNote}/{id}/bookAmount` (spec `bookInvoice`/`bookCreditNote`):
 * - `amount`: a JSON number (spec `type: number`), checked to round-trip exactly. Signed as the
 *   money moves on the check account: positive for an invoice (money in), negative for a credit
 *   note (money out), via `bookingAmountSign` (spec/deviations.md D-041 for vouchers; for credit
 *   notes measured by jernoxit/sevdesk-rs: "−58.31 pays a credit note of 58.31").
 * - `date`: Unix seconds (spec `type: integer`), at 12:00 Europe/Berlin of the booking day, so the
 *   day is the same whether sevDesk reads the instant in Berlin time or UTC. sevdesk-rs sends the
 *   same (`1787652000` = 2026-08-25 12:00 CEST in its request test).
 * - `type`: FULL_PAYMENT settles the document, N books a part (status 750); CB, MTC and O settle
 *   it with less money (Skonto, bank fees, other reason), O and OF with more (OF: reminder
 *   charges). CF is deprecated and not offered.
 * - `checkAccount` / `checkAccountTransaction`: `{id, objectName}` references (the spec warns of a
 *   "logic error" without `objectName`). Without a transaction sevDesk creates one on offline and
 *   cash accounts; an online account needs one (spec). Booking with only the account when the
 *   payment is already imported creates a second payment instead of linking it (joosthel/sevdesk-mcp
 *   PR #7), so the tool asks for the transaction id when there is one (B7).
 *
 * A transaction is only linked while it is free: status 100 (created). 200 means it is partly
 * assigned already and sevDesk reports no remaining amount for it (firsttris/haben transaction log
 * fixture), 300 private, 350 auto-booked, 400 booked.
 */
import { z } from "zod";

import { toUnixSeconds } from "../../sevdesk/dates.js";
import type { BankAccountDto, TransactionDto } from "../banking.js";
import {
  compare,
  type DecimalLike,
  DEFAULT_CURRENCY,
  type Money,
  money,
  negate,
  subtract,
  toDecimalString,
} from "../money.js";
import { bookingAmountSign } from "../vouchers.js";
import { documentRef, type LifecycleDocument, type PaymentKind, STATUS } from "./documents.js";
import { formatMoney } from "./preview.js";
import { hasPayments, refuse } from "./transitions.js";

/** Readable payment types and the sevDesk booking types behind them. */
export const PAYMENT_TYPES = [
  "payment",
  "cash_discount",
  "bank_fees",
  "other_difference",
  "reminder_charges",
] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

/** Payment types offered for credit notes: reminder charges belong to invoices only. */
export const CREDIT_NOTE_PAYMENT_TYPES = [
  "payment",
  "cash_discount",
  "bank_fees",
  "other_difference",
] as const satisfies readonly PaymentType[];

/** sevDesk booking types this server sends (spec `bookInvoice.type` without deprecated CF). */
export const BOOKING_TYPES = ["FULL_PAYMENT", "N", "CB", "O", "OF", "MTC"] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

/** What a settling payment with a difference does with it, for warnings. */
const DIFFERENCE_WORDING: Readonly<Record<Exclude<PaymentType, "payment">, string>> = {
  cash_discount: "as cash discount (Skonto)",
  bank_fees: "as bank fees (Geldverkehrskosten)",
  other_difference: "as a difference for other reasons",
  reminder_charges: "as reminder charges (Mahngebühren)",
};

const ACCOUNT_ARCHIVED = 0;
const TRANSACTION_FREE = 100;
const TRANSACTION_BUSY: Readonly<Record<number, string>> = {
  200: "is already partly assigned to another document, and sevDesk does not report how much of it is left",
  300: "is marked as private (Privatentnahme/-einlage)",
  350: "was booked automatically by sevDesk already",
  400: "is already booked",
};

const NOON_SECONDS = 12 * 60 * 60;

// ---------------------------------------------------------------------------------------------
// Open amount
// ---------------------------------------------------------------------------------------------

/** Exact amounts of a document in its currency (decimal strings). */
export interface OpenAmount {
  readonly currency: string;
  readonly gross: string;
  readonly paid: string;
  readonly open: string;
}

/**
 * Gross minus paid, exactly, in the document's currency. Refuses (validation) when it cannot be
 * known for sure: no gross total, a gross of zero or less, a negative paid amount (the trace of a
 * wrongly signed booking, D-041), a partially paid credit note (sevDesk reports no paid amount for
 * credit notes), a foreign-currency document with payments (the currency of `paidAmount` is
 * undocumented, D-043), or nothing left to pay.
 */
export function openAmount(doc: LifecycleDocument<PaymentKind>): OpenAmount {
  const ref = documentRef(doc, true);
  const gross = doc.totals.gross?.amount;
  if (gross === undefined) refuse(`${ref} has no gross total in sevDesk's answer.`);
  if (compare(gross, 0) <= 0) {
    refuse(`${ref} has a gross total of zero or less; there is nothing to pay.`);
  }
  if (doc.paidAmount !== undefined && compare(doc.paidAmount, 0) < 0) {
    refuse(
      `${ref} shows a negative paid amount, which a wrongly signed booking leaves behind. ` +
        `Check its payments in sevDesk before booking more.`,
    );
  }
  if (doc.paidAmount === undefined && doc.status === STATUS.partiallyPaid) {
    refuse(
      `${ref} is partially paid, and sevDesk does not report how much, so the open amount cannot ` +
        `be checked. Book the rest in the sevDesk web app.`,
    );
  }
  if (doc.currency !== DEFAULT_CURRENCY && (hasPayments(doc) || doc.status !== STATUS.open)) {
    refuse(
      `${ref} is in ${doc.currency} and already has payments; sevDesk does not document the ` +
        `currency of the paid amount of foreign-currency documents, so the open amount cannot be ` +
        `checked. Book the rest in the sevDesk web app.`,
    );
  }
  const paid = toDecimalString(doc.paidAmount ?? 0);
  const open = toDecimalString(subtract(gross, paid));
  if (compare(open, 0) <= 0) {
    refuse(`${ref} has nothing left to pay (gross ${gross}, paid ${paid}).`);
  }
  return { currency: doc.currency, gross: toDecimalString(gross), paid, open };
}

// ---------------------------------------------------------------------------------------------
// Account and transaction checks
// ---------------------------------------------------------------------------------------------

/** The direction a payment of this kind moves money on the check account. */
export function paymentDirection(kind: PaymentKind): "in" | "out" {
  return paymentSign(kind) > 0 ? "in" : "out";
}

/** Sign of the booked amount: invoices bring money in (+1), credit notes pay it out (-1). */
export function paymentSign(kind: PaymentKind): -1 | 1 {
  return bookingAmountSign(kind === "creditNote" ? "expense" : "revenue");
}

/**
 * Checks the check account for a payment and returns warnings for the preview. Refuses archived
 * accounts, accounts in another currency than the document, and online (bank) accounts without a
 * transaction to link (spec: "When the check account is type online, you must provide a
 * transaction").
 */
export function checkPaymentAccount(
  doc: LifecycleDocument<PaymentKind>,
  account: BankAccountDto,
  hasTransaction: boolean,
): string[] {
  const accountRef = `Check account ${String(account.id)}`;
  if (account.status?.code === ACCOUNT_ARCHIVED) {
    refuse(`${accountRef} is archived; book on an active account (sevdesk_bank_accounts_list).`);
  }
  if (account.currency !== doc.currency) {
    refuse(
      `${accountRef} is in ${account.currency}, ${documentRef(doc)} in ${doc.currency}; ` +
        `payments are only booked in the document's currency.`,
    );
  }
  if (hasTransaction) return [];
  if (account.type === "bank") {
    refuse(
      `${accountRef} is a bank account fed by imports (online); sevDesk needs the imported ` +
        `transaction to link. Find it with sevdesk_transactions_list (status created) and pass ` +
        `transactionId.`,
    );
  }
  if (account.type === "unknown") {
    return [
      "sevDesk creates a new transaction for this payment on offline and cash accounts; it may " +
        "refuse an account of another type.",
    ];
  }
  return [
    `sevDesk creates a new bank transaction for this payment on account ${String(account.id)}. ` +
      `If the payment is already in sevDesk as an imported transaction, pass its transactionId ` +
      `instead, or it is counted twice.`,
  ];
}

/**
 * Checks a bank transaction to link and returns warnings for the preview. It must belong to the
 * check account, be free (status 100) and not enshrined, move money in the payment's direction and
 * cover the amount.
 */
export function checkPaymentTransaction(
  doc: LifecycleDocument<PaymentKind>,
  accountId: number,
  transaction: TransactionDto,
  amount: string,
): string[] {
  const ref = `Bank transaction ${String(transaction.id)}`;
  if (transaction.account?.id !== accountId) {
    const owner =
      transaction.account === undefined
        ? "no check account"
        : `check account ${String(transaction.account.id)}`;
    refuse(`${ref} belongs to ${owner}, not to check account ${String(accountId)}.`);
  }
  if (transaction.enshrined) {
    refuse(`${ref} is enshrined (festgeschrieben) and cannot be linked to a payment anymore.`);
  }
  const status = transaction.status?.code;
  if (status !== TRANSACTION_FREE) {
    const reason =
      status === undefined
        ? "has no status"
        : (TRANSACTION_BUSY[status] ?? `has status ${String(status)}`);
    refuse(`${ref} ${reason}; only unbooked transactions (status 100, created) can be linked.`);
  }
  if (transaction.amount.currency !== doc.currency) {
    refuse(`${ref} is in ${transaction.amount.currency}, ${documentRef(doc)} in ${doc.currency}.`);
  }
  const expected = paymentDirection(doc.kind);
  if (transaction.direction !== expected) {
    const wanted = expected === "in" ? "an incoming payment" : "an outgoing payment";
    refuse(`${ref} is not ${wanted}, which a payment of ${documentRef(doc)} needs.`);
  }
  const available = absolute(transaction.amount.amount);
  if (compare(available, amount) < 0) {
    refuse(
      `${ref} is ${formatMoney(money(available, doc.currency))}, less than the payment of ` +
        `${formatMoney(money(amount, doc.currency))}. Book at most the transaction amount.`,
    );
  }
  if (compare(available, amount) > 0) {
    const rest = formatMoney(money(subtract(available, amount), doc.currency));
    return [
      `${ref} is ${formatMoney(money(available, doc.currency))}; ${rest} of it stays unassigned, ` +
        `and this tool cannot book more on a partly assigned transaction later.`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Payment plan and payload
// ---------------------------------------------------------------------------------------------

const refSchema = <N extends string>(objectName: N) =>
  z.strictObject({ id: z.number().int().positive(), objectName: z.literal(objectName) });

/** Outgoing `bookAmount` body (strict: sevDesk ignores unknown fields silently, D-003). */
const bookAmountPayloadSchema = z.strictObject({
  amount: z.number(),
  date: z.number().int().positive(),
  type: z.enum(BOOKING_TYPES),
  checkAccount: refSchema("CheckAccount"),
  checkAccountTransaction: refSchema("CheckAccountTransaction").optional(),
});

export type BookAmountPayload = z.output<typeof bookAmountPayloadSchema>;

export interface PaymentRequest {
  /** Exact positive decimal in the document's currency (from `amountInput`). */
  readonly amount: string;
  readonly paymentType: PaymentType;
  /** Booking day, `YYYY-MM-DD` (Berlin). */
  readonly date: string;
  readonly checkAccountId: number;
  readonly transactionId?: number | undefined;
}

export interface PaymentPlan {
  readonly bookingType: BookingType;
  readonly open: OpenAmount;
  /** The amount paid, positive, in the document's currency. */
  readonly amount: Money;
  /** What stays open after a partial payment (`N`). */
  readonly remaining: Money | undefined;
  /** Amount minus open amount for settling bookings with a difference (negative = less). */
  readonly difference: Money | undefined;
  readonly payload: BookAmountPayload;
  readonly warnings: readonly string[];
}

/**
 * Decides the sevDesk booking type for `request` against the open amount and builds the payload.
 * The guard: a plain payment books at most the open amount (all of it: FULL_PAYMENT, less: N);
 * cash discount and bank fees need less than the open amount; reminder charges need more; other
 * difference anything but the open amount. Over-booking is refused unless one of the two types
 * that allow it (reminder_charges, other_difference) was chosen explicitly.
 */
export function planPayment(
  doc: LifecycleDocument<PaymentKind>,
  request: PaymentRequest,
): PaymentPlan {
  const open = openAmount(doc);
  const ref = documentRef(doc);
  const amount = request.amount;
  const versus = compare(amount, open.open);
  const show = (value: string): string => formatMoney(money(value, doc.currency));
  const overBooking = (): never =>
    refuse(
      `The payment of ${show(amount)} is more than the open amount of ${show(open.open)} of ` +
        `${ref}. Book at most the open amount` +
        (doc.kind === "invoice"
          ? `, or choose paymentType "reminder_charges" (the customer paid reminder charges on ` +
            `top) or "other_difference" if the extra is intended.`
          : `, or choose paymentType "other_difference" if the extra is intended.`),
    );

  let bookingType: BookingType;
  switch (request.paymentType) {
    case "payment":
      if (versus > 0) overBooking();
      bookingType = versus === 0 ? "FULL_PAYMENT" : "N";
      break;
    case "cash_discount":
    case "bank_fees":
      if (versus > 0) overBooking();
      if (versus === 0) {
        refuse(
          `The payment equals the open amount of ${ref}, so there is no difference to write off; ` +
            `use paymentType "payment".`,
        );
      }
      bookingType = request.paymentType === "cash_discount" ? "CB" : "MTC";
      break;
    case "reminder_charges":
      if (doc.kind !== "invoice") refuse("Reminder charges can only be booked on invoices.");
      if (versus <= 0) {
        refuse(
          `paymentType "reminder_charges" books more than the open amount of ${show(open.open)}; ` +
            `for the open amount or less use "payment".`,
        );
      }
      bookingType = "OF";
      break;
    case "other_difference":
      if (versus === 0) {
        refuse(
          `The payment equals the open amount of ${ref}; there is no difference, so use ` +
            `paymentType "payment".`,
        );
      }
      bookingType = "O";
      break;
  }

  const sign = paymentSign(doc.kind);
  const signed = sign < 0 ? negate(amount) : amount;
  const payload = bookAmountPayloadSchema.parse({
    amount: exactNumber(toDecimalString(signed)),
    date: bookingTimestamp(request.date),
    type: bookingType,
    checkAccount: { id: request.checkAccountId, objectName: "CheckAccount" },
    ...(request.transactionId === undefined
      ? {}
      : {
          checkAccountTransaction: {
            id: request.transactionId,
            objectName: "CheckAccountTransaction",
          },
        }),
  });

  const differenceValue = subtract(amount, open.open);
  const warnings: string[] = [];
  let remaining: Money | undefined;
  let difference: Money | undefined;
  if (bookingType === "N") {
    remaining = money(negate(differenceValue), doc.currency);
    warnings.push(
      `This is a partial payment: ${formatMoney(remaining)} stays open and the ${
        doc.kind === "invoice" ? "invoice" : "credit note"
      } becomes partially paid (750).`,
    );
  } else if (bookingType !== "FULL_PAYMENT") {
    difference = money(differenceValue, doc.currency);
    const wording = DIFFERENCE_WORDING[request.paymentType as Exclude<PaymentType, "payment">];
    const size = formatMoney(money(absolute(differenceValue), doc.currency));
    warnings.push(
      compare(differenceValue, 0) < 0
        ? `The document is marked as fully paid; the missing ${size} is written off ${wording}.`
        : `The document is marked as fully paid; the extra ${size} is booked ${wording}.`,
    );
  }
  return {
    bookingType,
    open,
    amount: money(amount, doc.currency),
    remaining,
    difference,
    payload,
    warnings,
  };
}

/**
 * Unix seconds of 12:00 Europe/Berlin on `date`: the calendar day survives a reading in Berlin time
 * and in UTC alike (see the module doc).
 */
export function bookingTimestamp(date: string): number {
  return toUnixSeconds(date, "start") + NOON_SECONDS;
}

/** `value` as a JSON number, refused when the number would not be exactly that decimal. */
export function exactNumber(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || compare(String(number), value) !== 0) {
    refuse("The amount has too many digits to be sent to sevDesk exactly.");
  }
  return number;
}

function absolute(value: DecimalLike): string {
  return toDecimalString(compare(value, 0) < 0 ? negate(value) : value);
}
