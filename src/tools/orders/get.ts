import { z } from "zod";

import { positionDtoSchema } from "../../domain/document-positions.js";
import { getOrder, orderDetailSchema, relatedDocumentSchema } from "../../domain/orders.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  order: orderDetailSchema,
  positions: z.array(positionDtoSchema).describe("Positionen, in position-number order."),
  positionsComplete: z
    .boolean()
    .describe(
      "False when sevDesk had more position rows than could be read: positions is partial.",
    ),
  related: z
    .array(relatedDocumentSchema)
    .optional()
    .describe(
      "Documents sevDesk links to this order, e.g. invoices or delivery notes created from " +
        "it. Left out when sevDesk could not provide them (the summary says so).",
    ),
});

/** `sevdesk_order_get`: one offer, order confirmation or delivery note with positions. */
export const orderGetTool = defineTool({
  name: "sevdesk_order_get",
  title: "Get a sevDesk order",
  description:
    "Get one order by its sevDesk id: an offer (Angebot), order confirmation " +
    "(Auftragsbestätigung) or delivery note (Lieferschein), with its positions (name, quantity, " +
    "unit, unit price net/gross, tax rate, discount, optional positions), totals (net, " +
    "Umsatzsteuer, gross), tax rule, payment and delivery terms, recipient address, the order " +
    "it was created from (origin) and related documents such as the invoices created from it " +
    "(open them with sevdesk_invoice_get). Use it after sevdesk_orders_list.",
  toolset: "orders",
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
      .describe("Order id (not its number), e.g. from sevdesk_orders_list."),
  }),
  output,
  handler: async (args, ctx) => {
    const details = await getOrder(ctx.client, args.id, ctx.signal, ctx.config);
    const { order, positions, related } = details;
    const count = `${positions.length} position${positions.length === 1 ? "" : "s"}`;
    const partial = details.positionsComplete
      ? ""
      : " Partial: sevDesk had more positions than could be read.";
    const relatedNote =
      related === undefined
        ? " Related documents could not be read."
        : ` ${related.length} related document${related.length === 1 ? "" : "s"}.`;
    return {
      data: {
        order,
        positions: [...positions],
        positionsComplete: details.positionsComplete,
        ...(related === undefined ? {} : { related: [...related] }),
      },
      // Labels come from reference data (or "unknown"), never from sevDesk's text.
      summary:
        `Order ${order.id} (${order.type.label}, status ${order.status.label}) ` +
        `with ${count}.${partial}${relatedNote}`,
    };
  },
});
