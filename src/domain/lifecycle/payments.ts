/**
 * Payment booking (Zahlung buchen) for invoices, credit notes and vouchers: the open-amount maths, the
 * over-booking guard, the checks on the check account (Zahlungskonto) and on a bank transaction to
 * link, and the strict `bookAmount` payload. All amounts are exact decimals (`money.ts`).
 *
 * Wire format of `PUT /{Invoice|CreditNote|Voucher}/{id}/bookAmount` (spec `bookInvoice`,
 * `bookCreditNote`, `bookVoucher`: "exactly the same as the process for invoices"):
 * - `amount`: a JSON number (spec `type: number`), checked to round-trip exactly. Signed as the
 *   money moves on the check account: positive for an invoice (money in), negative for a credit
 *   note (money out), and for a voucher by its own direction (expense out, revenue in), via
 *   `bookingAmountSign` (spec/deviations.md D-041; for credit notes measured by
 *   jernoxit/sevdesk-rs: "−58.31 pays a credit note of 58.31", and recorded).
 * - `date`: Unix seconds (spec `type: integer` for invoices), at 12:00 Europe/Berlin of the
 *   booking day, so the day is the same whether sevDesk reads the instant in Berlin time or UTC.
 *   sevdesk-rs sends the same (`1787652000` = 2026-08-25 12:00 CEST in its request test). The
 *   voucher spec types it `date-time`; vouchers take the Unix noon too (M4 probe,
 *   {@link BOOKING_DATE_FORMATS}).
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
import {
  documentRef,
  KINDS,
  type LifecycleDocument,
  type PaymentDirection,
  type PaymentKind,
  statusOf,
} from "./documents.js";
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

/** Payment types offered for credit notes and vouchers: reminder charges belong to invoices only. */
export const CREDIT_NOTE_PAYMENT_TYPES = [
  "payment",
  "cash_discount",
  "bank_fees",
  "other_difference",
] as const satisfies readonly PaymentType[];

/** sevDesk booking types this server sends (spec `bookInvoice.type` without deprecated CF). */
const BOOKING_TYPES = ["FULL_PAYMENT", "N", "CB", "O", "OF", "MTC"] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

const PAYMENT_TYPE_BY_BOOKING_TYPE: Readonly<Record<BookingType, PaymentType>> = {
  FULL_PAYMENT: "payment",
  N: "payment",
  CB: "cash_discount",
  MTC: "bank_fees",
  O: "other_difference",
  OF: "reminder_charges",
};

/**
 * The readable payment type (the tools' `paymentType` input value) of a sevDesk booking type, for
 * outputs: full and partial payments (FULL_PAYMENT, N) are both `payment`.
 */
export function paymentTypeOf(bookingType: BookingType): PaymentType {
  return PAYMENT_TYPE_BY_BOOKING_TYPE[bookingType];
}

/** What a settling payment with a difference does with it, for warnings. */
const DIFFERENCE_WORDING: Readonly<Record<Exclude<PaymentType, "payment">, string>> = {
  cash_discount: "as cash discount (Skonto)",
  bank_fees: "as bank fees (Geldverkehrskosten)",
  other_difference: "as a difference for other reasons",
  reminder_charges: "as reminder charges (Mahngebühren)",
};

const ACCOUNT_ARCHIVED = 0;
const TRANSACTION_FREE = 100;
/** Partly assigned: bookable for the rest its booking log leaves (the caller passes `assigned`). */
const TRANSACTION_PARTLY = 200;
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
  const codes = statusOf(doc);
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
  if (doc.paidAmount === undefined && doc.status === codes.partiallyPaid) {
    refuse(
      `${ref} is partially paid, and sevDesk does not report how much, so the open amount cannot ` +
        `be checked. Book the rest in the sevDesk web app.`,
    );
  }
  if (doc.currency !== DEFAULT_CURRENCY && (hasPayments(doc) || doc.status !== codes.open)) {
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

/**
 * What a payment's direction is decided by: a kind whose direction is fixed (invoices in, credit
 * notes out), or a document (vouchers carry theirs, from `creditDebit`).
 */
export type PaymentSubject =
  | Exclude<PaymentKind, "voucher">
  | Pick<LifecycleDocument<PaymentKind>, "kind" | "id" | "direction">;

/** The direction a payment moves money on the check account (see {@link paymentSign}). */
export function paymentDirection(subject: PaymentSubject): PaymentDirection {
  return paymentSign(subject) > 0 ? "in" : "out";
}

/**
 * Sign of the booked amount: invoices bring money in (+1), credit notes pay it out (-1), vouchers
 * by their own direction (expense −1, revenue +1; `bookingAmountSign`). Refuses a voucher whose
 * direction sevDesk did not report (no readable `creditDebit`): the sign would be a guess, and a
 * wrong sign is accepted silently and leaves the voucher partially paid (D-041).
 */
export function paymentSign(subject: PaymentSubject): -1 | 1 {
  if (typeof subject === "string") {
    return bookingAmountSign(subject === "creditNote" ? "expense" : "revenue");
  }
  if (subject.direction === undefined) {
    refuse(
      `${documentRef(subject, true)} does not say whether it is an expense or revenue ` +
        "(creditDebit), so the sign of the payment is unknown. Check it in sevDesk.",
    );
  }
  return bookingAmountSign(subject.direction === "out" ? "expense" : "revenue");
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
 *
 * `assigned` (positive, default 0) is what the transaction's booking log already assigns to other
 * documents, read by the caller from the log. A partly assigned transaction (status 200; also
 * what resetting one document of a split leaves, M4 probe run 4) is bookable for the rest the log
 * leaves; at status 100 entries are subtracted as well, defensively. Only the rest counts as free,
 * and the payment then always goes out as a partial booking (N). Without log shares, status 200
 * stays refused.
 */
export function checkPaymentTransaction(
  doc: LifecycleDocument<PaymentKind>,
  accountId: number,
  transaction: TransactionDto,
  amount: string,
  assigned = "0",
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
  const partlyKnown = status === TRANSACTION_PARTLY && compare(assigned, 0) > 0;
  if (status !== TRANSACTION_FREE && !partlyKnown) {
    const reason =
      status === undefined
        ? "has no status"
        : (TRANSACTION_BUSY[status] ?? `has status ${String(status)}`);
    refuse(`${ref} ${reason}; only unbooked transactions (status 100, created) can be linked.`);
  }
  if (transaction.amount.currency !== doc.currency) {
    refuse(`${ref} is in ${transaction.amount.currency}, ${documentRef(doc)} in ${doc.currency}.`);
  }
  const expected = paymentDirection(doc);
  if (transaction.direction !== expected) {
    const wanted = expected === "in" ? "an incoming payment" : "an outgoing payment";
    refuse(`${ref} is not ${wanted}, which a payment of ${documentRef(doc)} needs.`);
  }
  const total = absolute(transaction.amount.amount);
  const show = (value: DecimalLike): string => formatMoney(money(value, doc.currency));
  if (compare(assigned, 0) > 0) {
    const free = toDecimalString(subtract(total, assigned));
    const marked =
      status === TRANSACTION_PARTLY
        ? `${ref} is partly assigned (status 200): its booking log assigns`
        : `${ref} is marked unbooked (status 100), but its booking log already assigns`;
    if (compare(free, amount) < 0) {
      refuse(
        `${marked} ` +
          `${show(assigned)} of its ${show(total)} to other documents, so only ${show(free)} is ` +
          `free, less than the payment of ${show(amount)}. Book at most ${show(free)}.`,
      );
    }
    const rest = toDecimalString(subtract(free, amount));
    return [
      `${marked} ` +
        `${show(assigned)} of its ${show(total)} to other documents; only ${show(free)} is ` +
        "treated as free. The payment is sent as a partial booking (N)" +
        (compare(rest, 0) > 0
          ? `, and ${show(rest)} of the transaction stays assignable to other documents.`
          : "."),
    ];
  }
  const available = total;
  if (compare(available, amount) < 0) {
    refuse(
      `${ref} is ${formatMoney(money(available, doc.currency))}, less than the payment of ` +
        `${formatMoney(money(amount, doc.currency))}. Book at most the transaction amount.`,
    );
  }
  if (compare(available, amount) > 0) {
    const rest = formatMoney(money(subtract(available, amount), doc.currency));
    return [
      `${ref} is ${formatMoney(money(available, doc.currency))}; the payment uses part of it, so ` +
        `it is sent as a partial booking (N), and ${rest} of the transaction stays assignable ` +
        `to other documents (sevDesk marks it partly assigned, status 200).`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Payment plan and payload
// ---------------------------------------------------------------------------------------------

const refSchema = <N extends string>(objectName: N) =>
  z.strictObject({ id: z.number().int().positive(), objectName: z.literal(objectName) });

/**
 * How each kind's `bookAmount` takes its `date`: Unix seconds at noon Berlin (recorded, D-056).
 * Vouchers (spec: `date-time`) take Unix seconds, ISO date-times and `dd.mm.yyyy` alike (M4 probe,
 * 2026-11-08; `dd.mm.yyyy` lands at 00:00), so they get the same Unix noon. Kept per kind so a
 * kind can switch to `"iso"` in one place.
 */
export const BOOKING_DATE_FORMATS: Readonly<Record<PaymentKind, "unix" | "iso">> = {
  invoice: "unix",
  creditNote: "unix",
  voucher: "unix",
};

/** Outgoing `bookAmount` body (strict: sevDesk ignores unknown fields silently, D-003). */
const bookAmountPayloadSchema = z.strictObject({
  amount: z.number(),
  date: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d{4}-\d{2}-\d{2}T12:00:00[+-]\d{2}:\d{2}$/),
  ]),
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
  /**
   * The linked transaction's amount, positive (absolute). When the payment uses only part of it,
   * a full payment goes out as a partial booking (N) and difference types are refused (see
   * {@link transactionBookingType}). Leave it out to plan without that rule.
   */
  readonly transactionAmount?: string | undefined;
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

  let documentType: BookingType;
  switch (request.paymentType) {
    case "payment":
      if (versus > 0) overBooking();
      documentType = versus === 0 ? "FULL_PAYMENT" : "N";
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
      documentType = request.paymentType === "cash_discount" ? "CB" : "MTC";
      break;
    case "reminder_charges":
      if (doc.kind !== "invoice") refuse("Reminder charges can only be booked on invoices.");
      if (versus <= 0) {
        refuse(
          `paymentType "reminder_charges" books more than the open amount of ${show(open.open)}; ` +
            `for the open amount or less use "payment".`,
        );
      }
      documentType = "OF";
      break;
    case "other_difference":
      if (versus === 0) {
        refuse(
          `The payment equals the open amount of ${ref}; there is no difference, so use ` +
            `paymentType "payment".`,
        );
      }
      documentType = "O";
      break;
  }
  const partOfTransaction =
    request.transactionAmount !== undefined && compare(amount, request.transactionAmount) < 0;
  const bookingType = transactionBookingType(documentType, partOfTransaction);

  const sign = paymentSign(doc);
  const signed = sign < 0 ? negate(amount) : amount;
  const payload = bookAmountPayloadSchema.parse({
    amount: exactNumber(toDecimalString(signed)),
    date: wireBookingDate(doc.kind, request.date),
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
  if (documentType === "N") {
    remaining = money(negate(differenceValue), doc.currency);
    warnings.push(
      `This is a partial payment: ${formatMoney(remaining)} stays open and the ${
        KINDS[doc.kind].noun
      } becomes partially paid (750).`,
    );
  } else if (documentType !== "FULL_PAYMENT") {
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
 * The booking type sent when the payment uses only part of the linked bank transaction
 * (`partOfTransaction`). sevDesk refuses a FULL_PAYMENT whose amount differs from the linked
 * transaction's with 422 "Payment difference amount must be 0.0 when using type 'NONE'"; a partial
 * booking (N) works and settles the document when it covers the open amount, leaving the
 * transaction partly assigned (status 200; live check by the lead on the trial, 2026-11-08). How
 * sevDesk treats a Skonto, bank-fee or other difference on part of a transaction is not verified,
 * so those are refused (the same rule as the bank reconciliation's `bookingTypeForTransactionUse`).
 */
function transactionBookingType(planned: BookingType, partOfTransaction: boolean): BookingType {
  if (!partOfTransaction) return planned;
  if (planned === "FULL_PAYMENT" || planned === "N") return "N";
  return refuse(
    "Skonto, bank fees and other differences (paymentType cash_discount, bank_fees, " +
      "other_difference, reminder_charges) can only be booked when the payment takes the whole " +
      'bank transaction. Book the transaction\'s full amount, use paymentType "payment" here, ' +
      "or book the difference in the sevDesk web app.",
  );
}

/**
 * Unix seconds of 12:00 Europe/Berlin on `date`: the calendar day survives a reading in Berlin time
 * and in UTC alike (see the module doc).
 */
export function bookingTimestamp(date: string): number {
  return toUnixSeconds(date, "start") + NOON_SECONDS;
}

/**
 * The booking day `date` (`YYYY-MM-DD`) as `kind`'s `bookAmount` takes it (see
 * {@link BOOKING_DATE_FORMATS}): Unix seconds of noon Berlin, or the same instant as an ISO 8601
 * date-time with the Berlin offset of that day (`2026-11-02T12:00:00+01:00`).
 */
export function wireBookingDate(kind: PaymentKind, date: string): number | string {
  const seconds = bookingTimestamp(date);
  if (BOOKING_DATE_FORMATS[kind] === "unix") return seconds;
  const offsetMinutes = (seconds - Date.parse(`${date}T12:00:00Z`) / 1000) / -60;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  return `${date}T12:00:00${sign}${hours}:${minutes}`;
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
