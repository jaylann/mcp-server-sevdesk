import { z } from "zod";

import { executeVoucherSave, prepareVoucherUpdate } from "../../domain/drafts/voucher.js";
import { voucherUpdateInputShape } from "../../domain/drafts/voucher-inputs.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { voucherDraftOutput, voucherDraftToolOutput } from "./draft-output.js";

/** `sevdesk_voucher_update_draft`: change a draft voucher (header, all positions, receipt file). */
export const voucherUpdateDraftTool = defineWriteTool({
  name: "sevdesk_voucher_update_draft",
  title: "Update a draft voucher",
  description:
    "Update an unlocked draft voucher (Beleg, status 50): supplier, dates, tax rule, positions or receipt file. EUR drafts keep omitted fields. Every non-EUR update needs a fresh exchangeRate or foreignCurrencyDeadline and ALL positions in the voucher currency: retaining stored EUR amounts can convert them again. Any currency change also needs all positions. Use currency EUR with EUR amounts to convert back, without a rate. Update 2.0 only; ReceiptGuidance is checked. Tier write; dryRun previews. Foreign-currency drafts cannot be finalized here.",
  toolset: "vouchers",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  localEffects: "reads-files",
  input: z.strictObject({ ...voucherUpdateInputShape, ...dryRunInputShape }),
  output: voucherDraftOutput,
  // Serialized with other calls on the same record (see WriteToolDefinition.locks).
  locks: (args) => [{ objectName: "Voucher", id: String(args.id) }],
  prepare: (args, ctx) =>
    prepareVoucherUpdate(ctx.client, args, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
      files: ctx.files,
    }),
  execute: async (args, plan, ctx) => {
    const result = await executeVoucherSave(ctx.client, plan.state, ctx.signal);
    if (
      args.file !== undefined &&
      plan.state.file !== undefined &&
      result.previousDocumentId !== undefined &&
      result.details.documentId !== undefined &&
      result.details.documentId !== result.previousDocumentId
    ) {
      ctx.files.release(args.file);
    }
    return voucherDraftToolOutput(result, "Updated draft");
  },
});
