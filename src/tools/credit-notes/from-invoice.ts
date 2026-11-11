import { z } from "zod";

import { creditNoteDetailSchema } from "../../domain/credit-notes.js";
import {
  executeCreditNoteFromInvoice,
  planCreditNoteFromInvoice,
} from "../../domain/derived-documents.js";
import { positionDtoSchema } from "../../domain/document-positions.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_CREDIT_NOTE_NUMBERS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

const output = z.object({
  creditNote: creditNoteDetailSchema.describe("The new credit note draft, read back."),
  positions: z.array(positionDtoSchema).describe("Its positions (Positionen)."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more position rows than could be read."),
  invoiceId: z.number().int().describe("The invoice the credit note was created from."),
  notes: z
    .array(z.string())
    .optional()
    .describe("Things to check, e.g. whether sevDesk's credit note counter was moved on."),
});

/** `sevdesk_credit_note_create_from_invoice`: a credit note draft from a finalized invoice. */
export const creditNoteFromInvoiceTool = defineWriteTool({
  name: "sevdesk_credit_note_create_from_invoice",
  title: "Create a credit note from a sevDesk invoice",
  description:
    "Create a credit note draft (Gutschrift / Rechnungskorrektur) from a finalized invoice " +
    "(open, partially paid or paid; not a draft, Storno, Mahnung or Abo template, and not " +
    "cancelled) with all its positions: the way to correct or refund a paid invoice. For an " +
    "unpaid invoice that should " +
    "be voided completely, cancel it instead (sevdesk_invoice_cancel). Refuses when a credit " +
    "note for the invoice exists (allowDuplicate overrides, e.g. a second partial refund). " +
    "Tier write. Afterwards sevDesk's credit note counter is moved past the new draft's " +
    "number (sevDesk does not do that itself). Then check it with sevdesk_credit_note_get and " +
    "finalize it with sevdesk_credit_note_finalize.",
  toolset: "credit-notes",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    invoiceId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Invoice id (not its number), e.g. from sevdesk_invoices_list."),
    allowDuplicate: z
      .boolean()
      .default(false)
      .describe("Create it even though a credit note from this invoice exists."),
    ...dryRunInputShape,
  }),
  output,
  // The number range: sevDesk hands out the counter's current number without advancing it, so
  // two creations at once (different invoices too) got the same one. The invoice: the "no credit
  // note for it yet" check, and it serializes with the lifecycle tools on that invoice (review
  // 2026-11, round 3).
  locks: (args) => [
    ACCOUNT_CREDIT_NOTE_NUMBERS,
    { objectName: "Invoice", id: String(args.invoiceId) },
  ],
  prepare: (args, ctx) => planCreditNoteFromInvoice(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) => {
    const { details, affected, notes } = await executeCreditNoteFromInvoice(
      ctx.client,
      plan.state,
      ctx.signal,
    );
    return {
      data: {
        creditNote: details.creditNote,
        positions: [...details.positions],
        positionsComplete: details.positionsComplete,
        invoiceId: plan.state.invoiceId,
        ...(notes.length === 0 ? {} : { notes }),
      },
      summary:
        `Created credit note draft ${details.creditNote.id} from invoice ` +
        `${plan.state.invoiceId}; finalize it with sevdesk_credit_note_finalize.` +
        (notes.length === 0 ? "" : " See notes."),
      affected,
    };
  },
});
