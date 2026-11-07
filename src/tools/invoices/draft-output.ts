import { z } from "zod";

import { positionDtoSchema } from "../../domain/document-positions.js";
import type { InvoiceDraftResult } from "../../domain/drafts/invoice.js";
import { invoiceDetailSchema } from "../../domain/invoices.js";
import type { ToolOutput } from "../types.js";

/** Output of the invoice draft tools: the invoice as read back after the save. */
export const invoiceDraftOutput = z.object({
  invoice: invoiceDetailSchema,
  positions: z.array(positionDtoSchema).describe("Positionen as sevDesk stored them."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more position rows than could be read back."),
  notes: z
    .array(z.string())
    .optional()
    .describe("Things to check, e.g. a total that differs from the preview or a missing number."),
});

type InvoiceDraftOutput = z.output<typeof invoiceDraftOutput>;

/** The tool output of a saved invoice draft; `verb` is "Created" or "Updated". */
export function invoiceDraftToolOutput(
  result: InvoiceDraftResult,
  verb: "Created" | "Updated",
): ToolOutput<InvoiceDraftOutput> {
  const { invoice, positions, positionsComplete } = result.details;
  const gross = invoice.totals.gross;
  const total = gross === undefined ? "" : `, gross ${gross.amount} ${gross.currency}`;
  const count = `${positions.length} position${positions.length === 1 ? "" : "s"}`;
  return {
    data: {
      invoice,
      positions: [...positions],
      positionsComplete,
      ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
    },
    summary:
      `${verb} draft invoice ${result.id} (${count}${total}).` +
      (result.notes.length === 0 ? "" : " See notes."),
    affected: [{ objectName: "Invoice", id: String(result.id) }],
  };
}
