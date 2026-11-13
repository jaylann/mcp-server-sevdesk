import { z } from "zod";

import { executeVoucherSave, prepareVoucherCreate } from "../../domain/drafts/voucher.js";
import { voucherCreateInputShape } from "../../domain/drafts/voucher-inputs.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_VOUCHER_DRAFTS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { voucherDraftOutput, voucherDraftToolOutput } from "./draft-output.js";

/** `sevdesk_voucher_create_draft`: a new draft voucher (Beleg, status 50), optionally with its receipt. */
export const voucherCreateDraftTool = defineWriteTool({
  name: "sevdesk_voucher_create_draft",
  title: "Create a draft voucher",
  description:
    "Create a draft voucher (Beleg) for a receipt or supplier invoice: expense or revenue, supplier, dates and booking-account positions. EUR by default; non-EUR requires exchangeRate (EUR per currency unit) or foreignCurrencyDeadline. Amounts are in the voucher currency. Update 2.0 only; accounts and tax rules are checked against ReceiptGuidance. Optionally attach a PDF/PNG/JPEG from SEVDESK_FILE_DIRS or an upload. Possible duplicates need allowDuplicate. Tier write: nothing is booked; dryRun previews. Foreign-currency drafts cannot be finalized here.",
  toolset: "vouchers",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  localEffects: "reads-files",
  input: z.strictObject({ ...voucherCreateInputShape, ...dryRunInputShape }),
  output: voucherDraftOutput,
  // The duplicate refusal reads the existing vouchers, then the draft is created: two identical
  // creations at once both passed it (review 2026-11, round 3).
  locks: () => [ACCOUNT_VOUCHER_DRAFTS],
  prepare: (args, ctx) =>
    prepareVoucherCreate(ctx.client, args, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
      files: ctx.files,
    }),
  execute: async (args, plan, ctx) => {
    const result = await executeVoucherSave(ctx.client, plan.state, ctx.signal);
    if (
      args.file !== undefined &&
      plan.state.file !== undefined &&
      result.details.voucher.hasDocument === true
    ) {
      ctx.files.release(args.file);
    }
    return voucherDraftToolOutput(result, "Created draft");
  },
});
