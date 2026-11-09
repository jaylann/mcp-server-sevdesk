import { z } from "zod";

import { executeVoucherSave, prepareVoucherCreate } from "../../domain/drafts/voucher.js";
import { voucherCreateInputShape } from "../../domain/drafts/voucher-inputs.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { voucherDraftOutput, voucherDraftToolOutput } from "./draft-output.js";

/** `sevdesk_voucher_create_draft`: a new draft voucher (Beleg, status 50), optionally with its receipt. */
export const voucherCreateDraftTool = defineWriteTool({
  name: "sevdesk_voucher_create_draft",
  title: "Create a draft voucher",
  description:
    "Create a draft voucher (Beleg, Belegentwurf) for a receipt or supplier invoice " +
    "(Lieferantenrechnung): kind expense (default) or revenue, supplier (Lieferant: contact or " +
    "name), Belegnummer, Belegdatum and positions (Belegpositionen) of booking account " +
    "(Buchungskonto, accountDatevId), amount and tax rate. Optionally attaches the receipt " +
    "file (PDF/PNG/JPEG from SEVDESK_FILE_DIRS, or on a remote server an upload from " +
    "sevdesk_upload_request; refused with a hint when neither is available). " +
    "Tier write: only a draft, nothing is booked. Every account × Steuerregel × rate is checked " +
    "against sevDesk's ReceiptGuidance first; the tax rule defaults to 9 (or 10 for " +
    "Kleinunternehmer) for expenses, 1 (or 11) for revenue. Needs sevDesk Update 2.0, EUR. A " +
    "possible duplicate (same supplier, Belegnummer, date, gross) is refused unless " +
    "allowDuplicate. dryRun previews. Before: sevdesk_reference_lookup kind=receipt_guidance. " +
    "After: sevdesk_voucher_finalize.",
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
  prepare: (args, ctx) =>
    prepareVoucherCreate(ctx.client, args, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
      files: ctx.files,
    }),
  execute: async (_args, plan, ctx) =>
    voucherDraftToolOutput(
      await executeVoucherSave(ctx.client, plan.state, ctx.signal),
      "Created draft",
    ),
});
