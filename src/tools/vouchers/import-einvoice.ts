import { z } from "zod";

import { executeVoucherSave } from "../../domain/drafts/voucher.js";
import {
  prepareVoucherImport,
  type VoucherSuggestionPlanner,
} from "../../domain/drafts/voucher-import.js";
import { voucherImportInputShape } from "../../domain/drafts/voucher-inputs.js";
import { canReadFiles } from "../../safety/file-access.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { voucherDraftOutput, voucherDraftToolOutput } from "./draft-output.js";

/**
 * `sevdesk_voucher_import_einvoice`: an incoming e-invoice (XRechnung, ZUGFeRD / Factur-X) as a
 * draft voucher with the original file attached. `planner` is the e-invoice module's
 * `planVoucherFromEInvoice` (passed in, see `voucher-import.ts`).
 */
export function voucherImportEInvoiceTool(planner: VoucherSuggestionPlanner) {
  return defineWriteTool({
    name: "sevdesk_voucher_import_einvoice",
    title: "Import an e-invoice as a voucher",
    description:
      "Import a received e-invoice (E-Rechnung: XRechnung XML or ZUGFeRD/Factur-X PDF from " +
      "SEVDESK_FILE_DIRS or, on a remote server, an upload from sevdesk_upload_request) as a " +
      "draft voucher (Beleg) and attach the original file. Supplier " +
      "(Lieferant: contact matched by VAT id/IBAN, else the issuer's name), Belegnummer, dates " +
      "and one position per VAT rate (net amounts) come from the invoice; you give the " +
      "Buchungskonto (accountDatevId, or accounts per rate). Refused when the invoice's sums or " +
      "VAT breakdown are unreliable, when the voucher totals would differ from the invoice " +
      "totals, or when an account × Steuerregel × rate is not allowed (ReceiptGuidance). EUR, " +
      "Update 2.0. Tier write: only a draft; dryRun previews. Before: sevdesk_einvoice_parse. " +
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
    available: canReadFiles,
    input: z.strictObject({ ...voucherImportInputShape, ...dryRunInputShape }),
    output: voucherDraftOutput,
    prepare: (args, ctx) =>
      prepareVoucherImport(
        ctx.client,
        args,
        { signal: ctx.signal, cacheOwner: ctx.config, files: ctx.files },
        planner,
      ),
    execute: async (_args, plan, ctx) =>
      voucherDraftToolOutput(
        await executeVoucherSave(ctx.client, plan.state, ctx.signal),
        "Imported e-invoice as draft",
      ),
  });
}
