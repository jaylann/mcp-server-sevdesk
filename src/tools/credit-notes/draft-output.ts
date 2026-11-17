import { z } from "zod";

import { creditNoteDetailSchema } from "../../domain/credit-notes.js";
import { positionDtoSchema } from "../../domain/document-positions.js";
import type { CreditNoteDraftResult } from "../../domain/drafts/credit-note.js";
import type { ToolOutput } from "../types.js";

/** Output of the credit note draft tools: the credit note as read back after the save. */
export const creditNoteDraftOutput = z.object({
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

type CreditNoteDraftOutput = z.output<typeof creditNoteDraftOutput>;

/** The tool output of a saved credit note draft; `verb` is "Created" or "Updated". */
export function creditNoteDraftToolOutput(
  result: CreditNoteDraftResult,
  verb: "Created" | "Updated",
): ToolOutput<CreditNoteDraftOutput> {
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
      `${verb} draft credit note ${result.id} (${count}${total}).` +
      (result.notes.length === 0 ? "" : " See notes."),
    affected: [{ objectName: "CreditNote", id: String(result.id) }],
  };
}
