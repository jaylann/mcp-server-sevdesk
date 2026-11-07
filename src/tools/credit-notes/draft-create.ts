import { z } from "zod";

import { creditNoteDetailSchema } from "../../domain/credit-notes.js";
import { positionDtoSchema } from "../../domain/document-positions.js";
import {
  creditNoteCreateInputShape,
  executeCreditNoteDraft,
  prepareCreditNoteCreate,
} from "../../domain/drafts/credit-note.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";

const output = z.object({
  creditNote: creditNoteDetailSchema,
  positions: z.array(positionDtoSchema).describe("Positionen as sevDesk stored them."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more position rows than could be read back."),
  notes: z
    .array(z.string())
    .optional()
    .describe("Things to check, e.g. a total that differs from the preview or a missing number."),
});

/** `sevdesk_credit_note_create_draft`: a new draft credit note (Gutschrift) with positions. */
export const creditNoteCreateDraftTool = defineWriteTool({
  name: "sevdesk_credit_note_create_draft",
  title: "Create a draft credit note",
  description:
    "Create a draft credit note (Gutschrift) for a contact with its positions. Tier write: it " +
    "only creates a draft; nothing is sent or booked and no number is assigned yet. " +
    "bookingCategory is required: underachievement (Minderleistung) reduces a finalized invoice " +
    "of the same contact given as sourceInvoiceId (not cancelled; refused when a credit note " +
    "for it exists unless allowDuplicate), and every rate must be one of that invoice's " +
    "rates; provision (Provisionsgutschrift) uses tax rule 9; royalty_assigned/_unassigned " +
    "(Lizenzen) are not verified live yet. To credit a whole invoice use " +
    "sevdesk_credit_note_create_from_invoice instead. Defaults: today, net prices, EUR (or the " +
    "invoice's currency), the contact's invoice address, the account's only user as contact " +
    "person. dryRun previews without saving. After: sevdesk_credit_note_pdf, " +
    "sevdesk_credit_note_finalize.",
  toolset: "credit-notes",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({ ...creditNoteCreateInputShape, ...dryRunInputShape }),
  output,
  prepare: (args, ctx) => prepareCreditNoteCreate(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) => {
    const result = await executeCreditNoteDraft(ctx.client, plan.state, ctx.signal);
    const { creditNote, positions, positionsComplete } = result.details;
    const gross = creditNote.totals.gross;
    const total = gross === undefined ? "" : `, gross ${gross.amount} ${gross.currency}`;
    const count = `${positions.length} position${positions.length === 1 ? "" : "s"}`;
    return {
      data: {
        creditNote,
        positions: [...positions],
        positionsComplete,
        ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
      },
      summary:
        `Created draft credit note ${result.id} (${count}${total}).` +
        (result.notes.length === 0 ? "" : " See notes."),
      affected: [{ objectName: "CreditNote", id: String(result.id) }],
    };
  },
});
