import { z } from "zod";

import { amountInput } from "../../domain/common.js";
import { executeOrderToInvoice, planOrderToInvoice } from "../../domain/derived-documents.js";
import { positionDtoSchema, statusDtoSchema } from "../../domain/document-positions.js";
import { invoiceDetailSchema } from "../../domain/invoices.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";

const output = z.object({
  invoice: invoiceDetailSchema.describe("The new invoice draft, read back from sevDesk."),
  positions: z.array(positionDtoSchema).describe("Its positions (Positionen)."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more position rows than could be read."),
  orderId: z.number().int().describe("The order the invoice was created from."),
  orderStatus: statusDtoSchema
    .optional()
    .describe("The order's status after the call (e.g. 750 partially invoiced), when read back."),
});

/**
 * `sevdesk_invoice_create_from_order`: an invoice draft from an offer or order confirmation. It
 * lives in the `invoices` toolset like its counterpart `sevdesk_credit_note_create_from_invoice`
 * lives in `credit-notes`: the toolset of the document it creates.
 */
export const invoiceFromOrderTool = defineWriteTool({
  name: "sevdesk_invoice_create_from_order",
  title: "Create an invoice from a sevDesk order",
  description:
    "Create an invoice draft (Rechnung) from an offer (Angebot, AN) or order confirmation " +
    "(Auftragsbestätigung, AB) with its positions: the whole order (mode full), or a partial " +
    "invoice (Teilrechnung, mode partial) or advance invoice (Abschlagsrechnung, mode advance) " +
    "for an amount as percentage, net or gross. The order must be sent, accepted or partially " +
    "invoiced, not a draft, rejected or fully invoiced; partial/advance need tax rule 1 or 11. " +
    "Refuses when an invoice draft from the order exists (allowDuplicate overrides). Tier " +
    "write. Then check it with sevdesk_invoice_get and finalize it with " +
    "sevdesk_invoice_finalize.",
  toolset: "invoices",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    orderId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Order id (not its number), e.g. from sevdesk_orders_list."),
    mode: z
      .enum(["full", "partial", "advance"])
      .default("full")
      .describe("full: whole order; partial: Teilrechnung; advance: Abschlagsrechnung."),
    amount: amountInput({ places: 2, allowZero: false })
      .optional()
      .describe("partial/advance only: the amount, in the unit of amountType."),
    amountType: z
      .enum(["percentage", "net", "gross"])
      .default("percentage")
      .describe("partial/advance only: percent of the order, or an amount net or gross."),
    allowDuplicate: z
      .boolean()
      .default(false)
      .describe("Create it even though an invoice draft from this order exists."),
    ...dryRunInputShape,
  }),
  output,
  prepare: (args, ctx) => planOrderToInvoice(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) => {
    const { details, affected, order } = await executeOrderToInvoice(
      ctx.client,
      plan.state,
      ctx.signal,
    );
    return {
      data: {
        invoice: details.invoice,
        positions: [...details.positions],
        positionsComplete: details.positionsComplete,
        orderId: plan.state.orderId,
        ...(order === undefined ? {} : { orderStatus: order.status }),
      },
      summary:
        `Created invoice draft ${details.invoice.id} (${details.invoice.type.code}) from order ` +
        `${plan.state.orderId}; finalize it with sevdesk_invoice_finalize.`,
      affected,
    };
  },
});
