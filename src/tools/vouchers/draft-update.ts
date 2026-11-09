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
    "Change a draft voucher (Beleg, status draft 50): supplier (Lieferant), Belegnummer, " +
    "dates, Steuerregel, or replace ALL positions (Belegpositionen) at once, and/or attach a " +
    "receipt file (PDF/PNG/JPEG from SEVDESK_FILE_DIRS or an upload). Fields left out keep " +
    "their stored values. A new tax rule must fit every position; accounts × rule × rate are " +
    "checked against sevDesk's ReceiptGuidance before anything is sent. Only drafts that are not " +
    "enshrined (EUR, Update 2.0); a booked voucher must be reset to draft first " +
    "(sevdesk_voucher_reset). Tier write; dryRun previews. Before: sevdesk_voucher_get. After: " +
    "sevdesk_voucher_finalize.",
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
  prepare: (args, ctx) =>
    prepareVoucherUpdate(ctx.client, args, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
      files: ctx.files,
    }),
  execute: async (_args, plan, ctx) =>
    voucherDraftToolOutput(
      await executeVoucherSave(ctx.client, plan.state, ctx.signal),
      "Updated draft",
    ),
});
