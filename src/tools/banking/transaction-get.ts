/**
 * `sevdesk_transaction_get`: one bank transaction with its assignments (Zuordnungen) from
 * sevDesk's booking log (`GET /CheckAccountTransactionLog`, undocumented, D-057) and the amount
 * still unassigned, exactly. The documents it was booked to are read for their number, status and
 * contact (at most {@link MAX_DOCUMENT_LOOKUPS}).
 */
import { z } from "zod";

import { getTransactionDetails, maskIban, transactionDtoSchema } from "../../domain/banking.js";
import { moneySchema } from "../../domain/common.js";
import {
  type LifecycleDocument,
  type PaymentKind,
  readLifecycleDocument,
} from "../../domain/lifecycle/documents.js";
import { money } from "../../domain/money.js";
import {
  entryShare,
  readTransactionLog,
  remainingAmount,
} from "../../domain/reconciliation/transaction-log.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { defineTool } from "../define-tool.js";
import {
  argOfKind,
  DOCUMENT_KINDS,
  type DocumentSummary,
  documentSummary,
  documentSummarySchema,
  READ_ANNOTATIONS,
  transactionIdInput,
} from "./reconcile-shared.js";

/** Most documents read for the assignments of one transaction. */
const MAX_DOCUMENT_LOOKUPS = 10;

const assignmentSchema = z.object({
  logEntryId: z.number().int(),
  document: documentSummarySchema
    .extend({
      kind: z.enum([...DOCUMENT_KINDS, "other"]),
      objectName: z.string().optional().describe("sevDesk's object name, for kind other."),
      unreadable: z
        .boolean()
        .optional()
        .describe("True when the document could not be read (deleted, or the lookup cap)."),
    })
    .optional()
    .describe("The document the share was booked to."),
  amount: moneySchema
    .optional()
    .describe("Share of the transaction booked to it (positive, transaction currency)."),
  bookingDate: z.string().optional().describe("Booking date of the assignment, YYYY-MM-DD."),
});

const output = z.object({
  transaction: transactionDtoSchema,
  counterpartyIbanMasked: z
    .string()
    .optional()
    .describe("Last four characters of the counterparty's IBAN; the rest is withheld."),
  assignments: z
    .array(assignmentSchema)
    .describe("Bookings to documents (booking log), oldest first."),
  assigned: moneySchema.optional().describe("Sum of the assignments (positive)."),
  remaining: moneySchema
    .optional()
    .describe("Still unassigned (positive); what sevdesk_transaction_book can still book."),
  remainingUnknown: z
    .string()
    .optional()
    .describe("Why the remaining amount cannot be told, when it cannot."),
});

type Assignment = z.output<typeof assignmentSchema>;

export const transactionGetTool = defineTool({
  name: "sevdesk_transaction_get",
  title: "Get a sevDesk bank transaction with its assignments",
  description:
    "Show one bank transaction (Kontoumsatz) with its assignments (Zuordnungen): which " +
    "invoices (Rechnungen), credit notes (Gutschriften) or vouchers (Belege) it was booked to, " +
    "with how much, and the amount still unassigned (exact; from sevDesk's booking log). Use it " +
    "before sevdesk_transaction_book (partly linked transactions, status 200, can be booked up " +
    "to the remaining amount) and before sevdesk_transaction_reset (to see what would be " +
    "undone). Find ids with sevdesk_transactions_list. Offline and cash accounts get their " +
    "transactions from payment bookings, so they are booked already. Read-only.",
  toolset: "banking",
  tier: "read",
  annotations: READ_ANNOTATIONS,
  input: z.strictObject({ id: transactionIdInput }),
  output,
  handler: async (args, ctx) => {
    const details = await getTransactionDetails(ctx.client, args.id, ctx.signal);
    const { transaction } = details;
    const log = await readTransactionLog(ctx.client, transaction.id, ctx.signal);
    const remaining = remainingAmount(transaction, log);
    const currency = transaction.amount.currency;

    const summaries = new Map<string, DocumentSummary | "unreadable">();
    const assignments: Assignment[] = [];
    for (const entry of log.entries) {
      const share = entryShare(entry, transaction.amount.amount);
      const document = entry.document;
      let documentOut: Assignment["document"];
      const documentKind = document?.kind;
      if (document !== undefined && documentKind === "other") {
        documentOut = { kind: "other", id: document.id, objectName: document.objectName };
      } else if (document !== undefined && documentKind !== undefined && documentKind !== "other") {
        const kind: PaymentKind = documentKind;
        const { id } = document;
        const key = `${kind}:${String(id)}`;
        let summary = summaries.get(key);
        if (summary === undefined) {
          summary =
            summaries.size >= MAX_DOCUMENT_LOOKUPS
              ? "unreadable"
              : await readSummary(() =>
                  readLifecycleDocument(ctx.client, kind, id, ctx.signal, undefined, ctx.config),
                );
          summaries.set(key, summary);
        }
        documentOut =
          summary === "unreadable" ? { kind: argOfKind(kind), id, unreadable: true } : summary;
      }
      assignments.push({
        logEntryId: entry.id,
        ...(documentOut === undefined ? {} : { document: documentOut }),
        ...("share" in share ? { amount: money(share.share, currency) } : {}),
        ...(entry.bookingDate === undefined ? {} : { bookingDate: entry.bookingDate }),
      });
    }

    const counterpartyIbanMasked = maskIban(details.counterpartyAccount);
    return {
      data: {
        transaction,
        ...(counterpartyIbanMasked === undefined ? {} : { counterpartyIbanMasked }),
        assignments,
        ...(remaining.known
          ? {
              assigned: money(remaining.assigned, currency),
              remaining: money(remaining.remaining, currency),
            }
          : { remainingUnknown: remaining.reason }),
      },
      summary:
        `Bank transaction ${String(transaction.id)}: ${String(assignments.length)} ` +
        (assignments.length === 1 ? "assignment" : "assignments") +
        (remaining.known
          ? `, ${money(remaining.remaining, currency).amount} ${currency} unassigned.`
          : `; the unassigned amount is unknown (${remaining.reason}).`),
    };
  },
});

/** A document's summary, or `unreadable` when sevDesk no longer has it or sends it oddly. */
async function readSummary(
  read: () => Promise<LifecycleDocument<PaymentKind>>,
): Promise<DocumentSummary | "unreadable"> {
  try {
    return documentSummary(await read());
  } catch (error) {
    if (
      error instanceof SevdeskError &&
      (error.kind === "not_found" || error.kind === "unexpected_response")
    ) {
      return "unreadable";
    }
    throw error;
  }
}
