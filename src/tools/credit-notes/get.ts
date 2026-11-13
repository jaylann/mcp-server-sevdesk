import { z } from "zod";

import { creditNoteDetailSchema, getCreditNote } from "../../domain/credit-notes.js";
import { positionDtoSchema } from "../../domain/document-positions.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  creditNote: creditNoteDetailSchema,
  positions: z.array(positionDtoSchema).describe("Positionen, in position-number order."),
  positionsComplete: z
    .boolean()
    .describe(
      "False when sevDesk had more position rows than could be read: positions is partial.",
    ),
});

/** `sevdesk_credit_note_get`: one credit note with positions, totals and tax rule. */
export const creditNoteGetTool = defineTool({
  name: "sevdesk_credit_note_get",
  title: "Get a sevDesk credit note",
  description:
    "Get one credit note (Gutschrift) by its sevDesk id with its positions (name, quantity, " +
    "unit, unit price net/gross, tax rate, sums), totals (net, Umsatzsteuer, gross), tax rule " +
    "(Steuerregel), booking category, the invoice or voucher it refers to (sourceInvoiceId, " +
    "sourceVoucherId), recipient address and delivery date. Use it after " +
    "sevdesk_credit_notes_list; open the source invoice with sevdesk_invoice_get.",
  toolset: "credit-notes",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Credit note id (not its number), e.g. from sevdesk_credit_notes_list."),
  }),
  output,
  handler: async (args, ctx) => {
    const details = await getCreditNote(ctx.client, args.id, ctx.signal, ctx.config);
    const { creditNote, positions } = details;
    const count = `${positions.length} position${positions.length === 1 ? "" : "s"}`;
    const partial = details.positionsComplete
      ? ""
      : " Partial: sevDesk had more positions than could be read.";
    return {
      data: {
        creditNote,
        positions: [...positions],
        positionsComplete: details.positionsComplete,
      },
      summary:
        `Credit note ${creditNote.id} (status ${creditNote.status.label}) with ${count}.` + partial,
    };
  },
});
