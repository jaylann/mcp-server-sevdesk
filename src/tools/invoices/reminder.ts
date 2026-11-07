import { z } from "zod";

import { executeInvoiceReminder, planInvoiceReminder } from "../../domain/derived-documents.js";
import { positionDtoSchema } from "../../domain/document-positions.js";
import { invoiceDetailSchema } from "../../domain/invoices.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";

const output = z.object({
  reminder: invoiceDetailSchema.describe("The new reminder draft (invoice type MA), read back."),
  positions: z.array(positionDtoSchema).describe("Its positions (Positionen)."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more position rows than could be read."),
  invoiceId: z.number().int().describe("The overdue invoice the reminder is for."),
});

/** `sevdesk_invoice_create_reminder`: a dunning reminder draft for an overdue invoice. */
export const invoiceReminderTool = defineWriteTool({
  name: "sevdesk_invoice_create_reminder",
  title: "Create a sevDesk payment reminder",
  description:
    "Create a payment reminder draft (Mahnung / Zahlungserinnerung, invoice type MA) for an " +
    "overdue invoice: open or partially paid, due date passed, not a draft, Storno or Mahnung " +
    "itself. Nothing is sent: finalize or email the reminder afterwards with " +
    "sevdesk_invoice_finalize or sevdesk_invoice_send_email. No reminder fee (Mahngebühr) on " +
    "Update 2.0. Refuses when an unsent reminder draft for the invoice exists (allowDuplicate " +
    "overrides). Tier write. Find overdue invoices with sevdesk_invoices_list overdueOnly.",
  toolset: "invoices",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    invoiceId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Id of the overdue invoice (not its number), e.g. from sevdesk_invoices_list."),
    allowDuplicate: z
      .boolean()
      .default(false)
      .describe("Create it even though an unsent reminder draft for this invoice exists."),
    ...dryRunInputShape,
  }),
  output,
  prepare: (args, ctx) => planInvoiceReminder(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) => {
    const { details, affected } = await executeInvoiceReminder(ctx.client, plan.state, ctx.signal);
    return {
      data: {
        reminder: details.invoice,
        positions: [...details.positions],
        positionsComplete: details.positionsComplete,
        invoiceId: plan.state.invoiceId,
      },
      summary:
        `Created reminder draft ${details.invoice.id} for invoice ${plan.state.invoiceId}; it ` +
        "is not sent yet (sevdesk_invoice_finalize or sevdesk_invoice_send_email).",
      affected,
    };
  },
});
