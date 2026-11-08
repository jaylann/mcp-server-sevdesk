import { z } from "zod";

import type { VoucherSaveResult } from "../../domain/drafts/voucher.js";
import { voucherDetailDtoSchema, voucherPositionDtoSchema } from "../../domain/vouchers.js";
import type { ToolOutput } from "../types.js";

/** Output of the voucher save tools: the voucher as read back after the save. */
export const voucherDraftOutput = z.object({
  voucher: voucherDetailDtoSchema,
  positions: z.array(voucherPositionDtoSchema).describe("Belegpositionen as sevDesk stored them."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more position rows than could be read back."),
  receipt: z
    .object({
      name: z.string().describe("Local file name of the attached receipt (Belegbild)."),
      kind: z.string().describe("pdf, png, jpeg or xml (recognized by content)."),
      bytes: z.number().int(),
      pages: z.number().optional().describe("Pages sevDesk counted, when it said."),
    })
    .optional()
    .describe("The receipt file uploaded and attached by this call."),
  notes: z
    .array(z.string())
    .optional()
    .describe("Things to check, e.g. a total that differs from the preview."),
});

type VoucherDraftOutput = z.output<typeof voucherDraftOutput>;

/** The tool output of a saved voucher; `verb` says what happened ("Created draft", …). */
export function voucherDraftToolOutput(
  result: VoucherSaveResult,
  verb: string,
): ToolOutput<VoucherDraftOutput> {
  const { voucher, positions, positionsComplete } = result.details;
  const gross = voucher.gross;
  const total = gross === undefined ? "" : `, gross ${gross.amount} ${gross.currency}`;
  const count = `${String(positions.length)} position${positions.length === 1 ? "" : "s"}`;
  const file = result.receipt === undefined ? "" : ", receipt attached";
  return {
    data: {
      voucher,
      positions: [...positions],
      positionsComplete,
      ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
      ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
    },
    summary:
      `${verb} voucher ${String(result.id)} (${count}${total}${file}).` +
      (result.notes.length === 0 ? "" : " See notes."),
    affected: [{ objectName: "Voucher", id: String(result.id) }],
  };
}
