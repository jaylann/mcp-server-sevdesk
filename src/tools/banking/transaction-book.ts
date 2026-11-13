/**
 * `sevdesk_transaction_book`: book one bank transaction to one or more documents (Zuordnung, also
 * split): one `PUT /{Invoice|CreditNote|Voucher}/{id}/bookAmount` per document, each linked to
 * the transaction. Guards and execution: `src/domain/reconciliation/allocate.ts`.
 */
import { z } from "zod";

import { type TransactionDto, transactionDtoSchema } from "../../domain/banking.js";
import { amountInput, moneySchema } from "../../domain/common.js";
import {
  KINDS,
  type PaymentKind,
  readLifecycleDocument,
} from "../../domain/lifecycle/documents.js";
import {
  type BookingType,
  PAYMENT_TYPES,
  type PaymentPlan,
  paymentTypeOf,
} from "../../domain/lifecycle/payments.js";
import {
  documentTitle,
  type Fact,
  formatMoney,
  statusText,
} from "../../domain/lifecycle/preview.js";
import { compare, type Money, money } from "../../domain/money.js";
import {
  bothPreviews,
  dateText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../../domain/preview-text.js";
import {
  type AllocationPlan,
  documentBookingType,
  executeAllocation,
  MAX_ALLOCATIONS,
  planAllocation,
  type PlannedAllocation,
} from "../../domain/reconciliation/allocate.js";
import {
  readTransactionLog,
  remainingAmount,
} from "../../domain/reconciliation/transaction-log.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS, type ToolContext } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import {
  COMMIT_ANNOTATIONS,
  DOCUMENT_KINDS,
  documentFactParts,
  documentSummary,
  documentSummarySchema,
  kindOfArg,
  readBackOrReport,
  readBackTransaction,
  transactionFacts,
  transactionIdInput,
} from "./reconcile-shared.js";

const BOOKING_TYPE_TEXT: Readonly<Record<BookingType, Phrase>> = {
  FULL_PAYMENT: phrase("full payment", "vollständige Zahlung"),
  N: phrase("partial payment", "Teilzahlung"),
  CB: phrase("payment less Skonto", "Zahlung abzüglich Skonto"),
  MTC: phrase("payment less bank fees", "Zahlung abzüglich Kosten des Geldverkehrs"),
  O: phrase(
    "payment with a difference for other reasons",
    "Zahlung mit Differenz aus sonstigen Gründen",
  ),
  OF: phrase("payment plus reminder charges", "Zahlung zuzüglich Mahngebühren"),
};

/** How to undo the booking: the consequence every allocation shares. */
const UNDO_WARNING = phrase(
  "Each document's status changes (shown per allocation). To undo, use " +
    "sevdesk_transaction_reset, which resets these documents to open and so removes all their " +
    "payments.",
  "Der Status jedes Dokuments ändert sich (siehe die einzelnen Zuordnungen). Rückgängig machen " +
    "lässt sich das mit sevdesk_transaction_reset: Das setzt diese Dokumente auf offen zurück " +
    "und entfernt damit alle ihre Zahlungen.",
);

/** The fact labels and fixed wording of a booking, per language. */
const BOOK_TEXT = {
  en: {
    before: "Unassigned before",
    date: "Booking date",
    allocation: "Allocation",
    sentAs: (type: string) => `, sent as type ${type} as it uses part of the transaction`,
    defaulted: ", amount defaulted",
    open: "open",
    status: "status",
    contact: "contact",
    after: "Unassigned after",
    booked: "transaction fully booked, status 400",
    partly: "status 200, partly linked",
    paid: "paid",
    partlyPaid: "partially paid",
    staysOpen: "stays open",
  },
  de: {
    before: "Vorher nicht zugeordnet",
    date: "Buchungsdatum",
    allocation: "Zuordnung",
    sentAs: (type: string) =>
      `, gesendet als Typ ${type}, da nur ein Teil des Umsatzes genutzt wird`,
    defaulted: ", Betrag automatisch gewählt",
    open: "offen",
    status: "Status",
    contact: "Kontakt",
    after: "Danach nicht zugeordnet",
    booked: "Umsatz vollständig gebucht, Status 400",
    partly: "Status 200, teilweise verknüpft",
    paid: "bezahlt",
    partlyPaid: "teilweise bezahlt",
    staysOpen: "bleiben offen",
  },
} as const;

const bookingSchema = z.object({
  document: documentSummarySchema.describe("The document as read back after the booking."),
  amount: moneySchema.describe("Share of the transaction booked to it (positive)."),
  paymentType: z
    .enum(PAYMENT_TYPES)
    .describe(
      "How it was booked, as the paymentType input names it: payment (full or partial), " +
        "cash_discount, bank_fees, other_difference, reminder_charges.",
    ),
});

const output = z.object({
  transaction: transactionDtoSchema.describe("The transaction as read back after the bookings."),
  bookings: z.array(bookingSchema),
  remaining: moneySchema.describe(
    "Left unassigned on the transaction after these bookings, from its booking log read afterwards.",
  ),
  remainingNote: z
    .string()
    .optional()
    .describe(
      "Set when the log could not be read afterwards: remaining is then the planned value.",
    ),
});

interface BookState {
  readonly allocations: readonly {
    readonly kind: PaymentKind;
    readonly id: number;
    readonly payload: PaymentPlan["payload"];
    readonly amount: PaymentPlan["amount"];
    readonly bookingType: BookingType;
  }[];
  readonly remainingAfter: string;
}

export const transactionBookTool = defineWriteTool({
  name: "sevdesk_transaction_book",
  title: "Book a sevDesk bank transaction to documents",
  description:
    "Book (zuordnen) a bank transaction (Kontoumsatz) to documents: invoices (Rechnungen, money " +
    "in), credit notes (Gutschriften, money out) or vouchers (Belege, by direction). Each " +
    "allocation books a payment linked to the transaction; amount defaults to the smaller of the " +
    "open amount and what is left. Up to 10 documents per call (split, e.g. one transfer for " +
    "several invoices); a partly linked transaction (status 200) is bookable up to its rest. " +
    "Guards: at most the unassigned amount in total, each at most the document's open amount " +
    "unless paymentType says otherwise (cash_discount/Skonto, bank_fees, other_difference, " +
    "reminder_charges: only when one document takes the whole transaction), same direction and " +
    "currency. Candidates: sevdesk_reconcile_suggest. " +
    "Commit tier: asks a human to confirm the preview; dryRun only previews. Undo: " +
    "sevdesk_transaction_reset.",
  toolset: "banking",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({
    id: transactionIdInput,
    allocations: z
      .array(
        z.strictObject({
          kind: z.enum(DOCUMENT_KINDS).describe("invoice, credit_note or voucher."),
          id: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .describe("Document id (not its number)."),
          amount: amountInput({ allowZero: false })
            .optional()
            .describe(
              'Share of the transaction for this document, positive, e.g. "119.00"; defaults ' +
                "to the smaller of its open amount and what is left of the transaction.",
            ),
          paymentType: z
            .enum(PAYMENT_TYPES)
            .optional()
            .describe(
              "payment (default: full or partial). cash_discount (Skonto) / bank_fees: less than " +
                "open, the rest is written off. other_difference: settles with more or less. " +
                "reminder_charges (invoices): more than open.",
            ),
        }),
      )
      .min(1)
      .max(MAX_ALLOCATIONS)
      .describe("Documents to book the transaction to, in this order."),
    ...dryRunInputShape,
  }),
  output,
  // The transaction's unassigned amount and each document's open amount are checked, then booked.
  locks: (args) => [
    ACCOUNT_BOOKINGS,
    { objectName: "CheckAccountTransaction", id: String(args.id) },
    ...args.allocations.map((allocation) => ({
      objectName: KINDS[kindOfArg(allocation.kind)].objectName,
      id: String(allocation.id),
    })),
  ],
  prepare: async (args, ctx) => {
    const plan = await planAllocation(
      ctx.client,
      args.id,
      args.allocations.map((allocation) => ({
        kind: kindOfArg(allocation.kind),
        id: allocation.id,
        amount: allocation.amount,
        paymentType: allocation.paymentType,
      })),
      ctx.signal,
      ctx.config,
    );
    const state: BookState = {
      allocations: plan.allocations.map(({ doc, plan: payment }) => ({
        kind: doc.kind,
        id: doc.id,
        payload: payment.payload,
        amount: payment.amount,
        bookingType: payment.bookingType,
      })),
      remainingAfter: plan.remainingAfter,
    };
    const warnings = [...plan.warnings, UNDO_WARNING];
    return {
      ...bothPreviews((lang) => ({
        action: actionText(plan, lang),
        facts: bookFacts(plan, lang),
        warnings: warnings.map((warning) => warning[lang]),
        irreversible: false,
      })),
      state,
    };
  },
  execute: async (args, plan, ctx) => {
    const { state } = plan;
    const changed = await executeAllocation(ctx.client, args.id, state.allocations, ctx.signal);
    const transaction = await readBackTransaction(ctx, args.id, changed);
    const bookings = [];
    for (const allocation of state.allocations) {
      const doc = await readBackOrReport(
        () =>
          readLifecycleDocument(
            ctx.client,
            allocation.kind,
            allocation.id,
            ctx.signal,
            undefined,
            ctx.config,
          ),
        changed,
      );
      bookings.push({
        document: documentSummary(doc),
        amount: allocation.amount,
        paymentType: paymentTypeOf(allocation.bookingType),
      });
    }
    const after = await remainingAfterBooking(ctx, transaction, state.remainingAfter);
    return {
      data: {
        transaction,
        bookings,
        remaining: after.remaining,
        ...(after.note === undefined ? {} : { remainingNote: after.note }),
      },
      summary:
        `Bank transaction ${String(args.id)} booked to ${String(bookings.length)} ` +
        `${bookings.length === 1 ? "document" : "documents"}; ` +
        `${after.remaining.amount} ${after.remaining.currency} left unassigned` +
        (after.note === undefined ? "." : " (planned; the booking log could not be read)."),
      affected: changed,
    };
  },
});

/**
 * What is left of the transaction after the bookings, from a fresh read of its booking log; the
 * planned value with a trusted note when the log cannot be read or does not tell (the bookings
 * are done, so a failing read must not fail the call).
 */
async function remainingAfterBooking(
  ctx: ToolContext,
  transaction: TransactionDto,
  planned: string,
): Promise<{ readonly remaining: Money; readonly note: string | undefined }> {
  const currency = transaction.amount.currency;
  const fallback = (reason: string) => ({
    remaining: money(planned, currency),
    note: `This is the planned value: ${reason}.`,
  });
  try {
    const log = await readTransactionLog(ctx.client, transaction.id, ctx.signal);
    const fresh = remainingAmount(transaction, log);
    return fresh.known
      ? { remaining: money(fresh.remaining, currency), note: undefined }
      : fallback(`after the booking, ${fresh.reason}`);
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted") {
      return fallback("the booking log could not be read after the booking");
    }
    throw error;
  }
}

function actionText(plan: AllocationPlan, lang: PreviewLanguage): string {
  const { transaction } = plan;
  const docs = plan.allocations.map(({ doc }) => documentTitle(doc, lang));
  const and = lang === "de" ? "und" : "and";
  const list =
    docs.length === 1 ? docs[0] : `${docs.slice(0, -1).join(", ")} ${and} ${docs.at(-1) ?? ""}`;
  const total = formatMoney(money(plan.allocated, transaction.amount.currency), lang);
  return lang === "de"
    ? `Kontoumsatz ${String(transaction.id)} (${formatMoney(transaction.amount, lang)}) ` +
        `zuordnen zu ${String(list)}: insgesamt ${total}.`
    : `Book bank transaction ${String(transaction.id)} (${formatMoney(transaction.amount)}) to ` +
        `${String(list)}: ${total} in total.`;
}

/** From the document side: N with the whole open amount also settles the document (measured). */
function statusAfter(allocation: PlannedAllocation, lang: PreviewLanguage): string {
  const { doc, plan } = allocation;
  const t = BOOK_TEXT[lang];
  const codes = KINDS[doc.kind].status;
  if (documentBookingType(plan) !== "N") return `${t.paid} (${String(codes.paid)})`;
  const open = plan.remaining ?? money(0, doc.currency);
  return (
    `${t.partlyPaid} (${String(codes.partiallyPaid)}), ${formatMoney(open, lang)} ` + t.staysOpen
  );
}

function bookFacts(plan: AllocationPlan, lang: PreviewLanguage): Fact[] {
  const t = BOOK_TEXT[lang];
  const currency = plan.transaction.amount.currency;
  const facts: Fact[] = [
    ...transactionFacts(plan.transaction, lang),
    { label: t.before, value: formatMoney(money(plan.remainingBefore, currency), lang) },
    { label: t.date, value: dateText(plan.bookingDate, lang) },
  ];
  plan.allocations.forEach((allocation, index) => {
    const { doc, plan: payment } = allocation;
    const documentType = documentBookingType(payment);
    const party =
      doc.contact?.name ??
      doc.partyName ??
      (doc.contact === undefined ? undefined : `${t.contact} ${String(doc.contact.id)}`);
    // The label is trusted text: the document by id; its stored number opens the value.
    const named = documentFactParts(doc, lang);
    facts.push({
      label: `${t.allocation} ${String(index + 1)}: ${named.label}`,
      value:
        named.number +
        `${formatMoney(payment.amount, lang)} (${BOOKING_TYPE_TEXT[documentType][lang]}` +
        (documentType === payment.bookingType ? "" : t.sentAs(payment.bookingType)) +
        `${allocation.amountDefaulted ? t.defaulted : ""}); ${t.open} ` +
        `${formatMoney(money(payment.open.open, doc.currency), lang)}; ${t.status} ` +
        `${statusText(doc, lang)} → ${statusAfter(allocation, lang)}` +
        (party === undefined ? "" : `; ${party}`),
    });
  });
  facts.push({
    label: t.after,
    value:
      `${formatMoney(money(plan.remainingAfter, currency), lang)} ` +
      `(${compare(plan.remainingAfter, 0) === 0 ? t.booked : t.partly})`,
  });
  return facts;
}
