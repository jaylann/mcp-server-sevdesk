import { z } from "zod";

import {
  executeVoucherDelete,
  prepareVoucherDelete,
} from "../../domain/drafts/voucher-finalize.js";
import { voucherDetailDtoSchema } from "../../domain/vouchers.js";
import { defineWriteTool } from "../define-tool.js";
import { idInput } from "../lifecycle/shared.js";
import { dryRunInputShape } from "../write-input.js";

/**
 * `sevdesk_voucher_delete_draft`: delete a draft voucher (`DELETE /Voucher/{id}`). Commit tier
 * although the endpoint needs only `write`: a deletion cannot be undone and can take the captured
 * receipt with it, so a human confirms it (lead decision after review).
 */
export const voucherDeleteDraftTool = defineWriteTool({
  name: "sevdesk_voucher_delete_draft",
  title: "Delete a draft voucher",
  description:
    "Delete a draft voucher (Belegentwurf löschen) with its positions, e.g. a duplicate or a " +
    "wrongly captured receipt. Only drafts (status 50) that are not enshrined " +
    "(festgeschrieben); booked vouchers stay in the books (reset to draft first with " +
    "sevdesk_voucher_reset only if that is really intended). Cannot be undone, and an attached " +
    "receipt may go with it. Commit tier: asks a human to confirm the preview, which names the " +
    "voucher; dryRun only previews. Before: sevdesk_voucher_get.",
  toolset: "vouchers",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({ id: idInput("voucher"), ...dryRunInputShape }),
  output: z.object({
    voucher: voucherDetailDtoSchema.describe("The voucher as it was before the deletion."),
    deleted: z.boolean().describe("True when a read afterwards confirmed it is gone."),
    notes: z.array(z.string()).optional(),
  }),
  prepare: (args, ctx) => prepareVoucherDelete(ctx.client, args.id, ctx.signal),
  execute: async (args, plan, ctx) => {
    const result = await executeVoucherDelete(ctx.client, args.id, ctx.signal);
    return {
      data: {
        voucher: plan.state.voucher,
        deleted: result.deleted,
        ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
      },
      summary: result.deleted
        ? `Deleted draft voucher ${String(args.id)}.`
        : `Asked sevDesk to delete voucher ${String(args.id)}; it is still there. See notes.`,
      affected: [{ objectName: "Voucher", id: String(args.id) }],
    };
  },
});
