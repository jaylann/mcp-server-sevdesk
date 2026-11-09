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
import { documentTitle, type Fact, formatMoney } from "../../domain/lifecycle/preview.js";
import { compare, type Money, money } from "../../domain/money.js";
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
import type { ToolContext } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import {
  COMMIT_ANNOTATIONS,
  DOCUMENT_KINDS,
  documentSummary,
  documentSummarySchema,
  kindOfArg,
  readBackOrReport,
  readBackTransaction,
  transactionFacts,
  transactionIdInput,
} from "./reconcile-shared.js";

const BOOKING_TYPE_TEXT: Readonly<Record<BookingType, string>> = {
  FULL_PAYMENT: "full payment",
  N: "partial payment",
  CB: "payment less Skonto",
  MTC: "payment less bank fees",
  O: "payment with a difference for other reasons",
  OF: "payment plus reminder charges",
};

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
    return {
      preview: {
        action: actionText(plan),
        facts: bookFacts(plan),
        warnings: [
          ...plan.warnings,
          "Each document's status changes (shown per allocation). To undo, use " +
            "sevdesk_transaction_reset, which resets these documents to open and so removes all " +
            "their payments.",
        ],
        irreversible: false,
      },
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
        () => readLifecycleDocument(ctx.client, allocation.kind, allocation.id, ctx.signal),
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

function actionText(plan: AllocationPlan): string {
  const { transaction } = plan;
  const docs = plan.allocations.map(({ doc }) => documentTitle(doc));
  const list =
    docs.length === 1 ? docs[0] : `${docs.slice(0, -1).join(", ")} and ${docs.at(-1) ?? ""}`;
  return (
    `Book bank transaction ${String(transaction.id)} (${formatMoney(transaction.amount)}) to ` +
    `${String(list)}: ${formatMoney(money(plan.allocated, transaction.amount.currency))} in total.`
  );
}

/** From the document side: N with the whole open amount also settles the document (measured). */
function statusAfter(allocation: PlannedAllocation): string {
  const { doc, plan } = allocation;
  const codes = KINDS[doc.kind].status;
  if (documentBookingType(plan) !== "N") return `paid (${String(codes.paid)})`;
  const open = plan.remaining ?? money(0, doc.currency);
  return `partially paid (${String(codes.partiallyPaid)}), ${formatMoney(open)} stays open`;
}

function bookFacts(plan: AllocationPlan): Fact[] {
  const currency = plan.transaction.amount.currency;
  const facts: Fact[] = [
    ...transactionFacts(plan.transaction),
    { label: "Unassigned before", value: formatMoney(money(plan.remainingBefore, currency)) },
    { label: "Booking date", value: plan.bookingDate },
  ];
  plan.allocations.forEach((allocation, index) => {
    const { doc, plan: payment } = allocation;
    const documentType = documentBookingType(payment);
    const party =
      doc.contact?.name ??
      doc.partyName ??
      (doc.contact === undefined ? undefined : `contact ${String(doc.contact.id)}`);
    facts.push({
      label: `Allocation ${String(index + 1)}: ${documentTitle(doc)}`,
      value:
        `${formatMoney(payment.amount)} (${BOOKING_TYPE_TEXT[documentType]}` +
        (documentType === payment.bookingType
          ? ""
          : `, sent as type ${payment.bookingType} as it uses part of the transaction`) +
        `${allocation.amountDefaulted ? ", amount defaulted" : ""}); open ` +
        `${formatMoney(money(payment.open.open, doc.currency))}; status ${doc.statusLabel} ` +
        `(${String(doc.status)}) → ${statusAfter(allocation)}` +
        (party === undefined ? "" : `; ${party}`),
    });
  });
  facts.push({
    label: "Unassigned after",
    value:
      formatMoney(money(plan.remainingAfter, currency)) +
      (compare(plan.remainingAfter, 0) === 0
        ? " (transaction fully booked, status 400)"
        : " (status 200, partly linked)"),
  });
  return facts;
}
