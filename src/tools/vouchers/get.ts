import { z } from "zod";

import {
  getVoucherDetails,
  voucherDetailDtoSchema,
  voucherPositionDtoSchema,
} from "../../domain/vouchers.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  voucher: voucherDetailDtoSchema,
  positions: z.array(voucherPositionDtoSchema).describe("Belegpositionen."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more rows than could be read: positions is partial."),
});

/** `sevdesk_voucher_get`: one voucher with its positions. */
export const voucherGetTool = defineTool({
  name: "sevdesk_voucher_get",
  title: "Get a sevDesk voucher",
  description:
    "Get one voucher (Beleg) by its sevDesk id with its positions (Belegpositionen): per " +
    "position net, tax and gross amount, tax rate and booking account (Buchungskonto: " +
    "accountDatev id in Update 2.0, accountingType id in legacy 1.0 positions), plus the " +
    "voucher's tax rule (Steuerregel) or legacy tax type, dates, status and payment direction. " +
    "Old and new bookkeeping generations are shown per record, also when mixed. Use it after " +
    "sevdesk_vouchers_list, e.g. to see how a supplier's earlier receipts were booked.",
  toolset: "vouchers",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Voucher id, e.g. from sevdesk_vouchers_list."),
  }),
  output,
  handler: async (args, ctx) => {
    const details = await getVoucherDetails(ctx.client, args.id, ctx.signal);
    const count = details.positions.length;
    const partial = details.positionsComplete
      ? ""
      : " Partial: sevDesk had more positions than could be read.";
    return {
      data: {
        voucher: details.voucher,
        positions: [...details.positions],
        positionsComplete: details.positionsComplete,
      },
      summary: `Voucher ${details.voucher.id} with ${count} ${count === 1 ? "position" : "positions"}.${partial}`,
    };
  },
});
