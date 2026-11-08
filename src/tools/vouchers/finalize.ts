import { z } from "zod";

import { executeVoucherSave } from "../../domain/drafts/voucher.js";
import { prepareVoucherFinalize } from "../../domain/drafts/voucher-finalize.js";
import { defineWriteTool } from "../define-tool.js";
import { COMMIT_ANNOTATIONS, idInput } from "../lifecycle/shared.js";
import { dryRunInputShape } from "../write-input.js";
import { voucherDraftOutput, voucherDraftToolOutput } from "./draft-output.js";

/**
 * `sevdesk_voucher_finalize`: book a draft voucher (draft 50 → open 100) with `saveVoucher`
 * (mechanism and its assumption: `src/domain/drafts/voucher.ts`, `finalizeBody`).
 */
export const voucherFinalizeTool = defineWriteTool({
  name: "sevdesk_voucher_finalize",
  title: "Finalize a draft voucher",
  description:
    "Finalize a draft voucher (Beleg verbuchen): status draft 50 → open 100, so it is " +
    "booked and counts in the books (EÜR, Umsatzsteuer-Voranmeldung/UStVA) from now on. Before " +
    "sending it checks what sevDesk would refuse late: an Update 2.0 tax rule (Steuerregel) " +
    "that fits the account's VAT regulation, at least one position, and every booking account " +
    "(Buchungskonto) × rule × rate against the ReceiptGuidance. Commit tier: asks a human to " +
    "confirm the preview; dryRun only previews. Undo while not enshrined: sevdesk_voucher_reset " +
    "(to draft). Before: sevdesk_voucher_get. After: sevdesk_voucher_book_payment (Zahlung " +
    "buchen), sevdesk_voucher_enshrine.",
  toolset: "vouchers",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({ id: idInput("voucher"), ...dryRunInputShape }),
  output: voucherDraftOutput,
  prepare: (args, ctx) =>
    prepareVoucherFinalize(ctx.client, args.id, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
      fileDirs: ctx.config.fileDirs,
    }),
  execute: async (_args, plan, ctx) =>
    voucherDraftToolOutput(
      await executeVoucherSave(ctx.client, plan.state, ctx.signal),
      "Finalized",
    ),
});
