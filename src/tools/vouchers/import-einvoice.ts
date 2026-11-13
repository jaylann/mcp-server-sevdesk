import { z } from "zod";

import { executeVoucherSave } from "../../domain/drafts/voucher.js";
import {
  prepareVoucherImport,
  type VoucherSuggestionPlanner,
} from "../../domain/drafts/voucher-import.js";
import { voucherImportInputShape } from "../../domain/drafts/voucher-inputs.js";
import { canReadFiles } from "../../safety/file-access.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_VOUCHER_DRAFTS } from "../types.js";
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
      "Import an XRechnung XML or ZUGFeRD/Factur-X PDF as a draft voucher (Beleg) with its receipt attached. File from SEVDESK_FILE_DIRS or an upload. Supplier, currency, dates and net positions per VAT rate come from the invoice; supply accountDatevId or accounts per rate. A non-EUR invoice requires exchangeRate (EUR per currency unit) or foreignCurrencyDeadline. Refuses unreliable sums, VAT breakdowns or invalid booking-account/tax-rule combinations. Update 2.0 only. Tier write; dryRun previews. Foreign-currency drafts cannot be finalized here.",
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
    // Shares the duplicate refusal of sevdesk_voucher_create_draft, so it shares its lock.
    locks: () => [ACCOUNT_VOUCHER_DRAFTS],
    prepare: (args, ctx) =>
      prepareVoucherImport(
        ctx.client,
        args,
        { signal: ctx.signal, cacheOwner: ctx.config, files: ctx.files },
        planner,
      ),
    execute: async (args, plan, ctx) => {
      const result = await executeVoucherSave(ctx.client, plan.state, ctx.signal);
      if (plan.state.file !== undefined && result.details.voucher.hasDocument === true) {
        ctx.files.release(args.file);
      }
      return voucherDraftToolOutput(result, "Imported e-invoice as draft");
    },
  });
}
