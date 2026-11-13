import { z } from "zod";

import { positionDtoSchema } from "../../domain/document-positions.js";
import { getInvoice, invoiceDetailSchema } from "../../domain/invoices.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  invoice: invoiceDetailSchema,
  positions: z.array(positionDtoSchema).describe("Positionen, in position-number order."),
  positionsComplete: z
    .boolean()
    .describe(
      "False when sevDesk had more position rows than could be read: positions is partial.",
    ),
});

/** `sevdesk_invoice_get`: one invoice with positions, totals, tax rule and terms. */
export const invoiceGetTool = defineTool({
  name: "sevdesk_invoice_get",
  title: "Get a sevDesk invoice",
  description:
    "Get one invoice (Rechnung) by its sevDesk id with its positions (Positionen: name, " +
    "quantity, unit, unit price net/gross, tax rate, discount, sums), totals (net, " +
    "Umsatzsteuer, gross; EUR and document currency for foreign-currency invoices), tax rule " +
    "(Steuerregel), recipient address, payment terms (Zahlungsziel, Skonto), delivery date " +
    "(Leistungsdatum), paid amount, the order it was created from (origin; open it with " +
    "sevdesk_order_get), the invoice a cancellation (SR) cancels and dunning data (Mahnung). " +
    "Use it after sevdesk_invoices_list. Contact details: sevdesk_contact_get.",
  toolset: "invoices",
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
      .describe("Invoice id (not the invoice number), e.g. from sevdesk_invoices_list."),
  }),
  output,
  handler: async (args, ctx) => {
    const details = await getInvoice(ctx.client, args.id, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    const { invoice, positions } = details;
    const count = `${positions.length} position${positions.length === 1 ? "" : "s"}`;
    const partial = details.positionsComplete
      ? ""
      : " Partial: sevDesk had more positions than could be read.";
    return {
      data: { invoice, positions: [...positions], positionsComplete: details.positionsComplete },
      // Labels come from reference data (or "unknown"), never from sevDesk's text.
      summary:
        `Invoice ${invoice.id} (${invoice.type.label}, status ${invoice.status.label}) ` +
        `with ${count}.${partial}`,
    };
  },
});
