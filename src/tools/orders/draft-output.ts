import { z } from "zod";

import { positionDtoSchema } from "../../domain/document-positions.js";
import type { OrderDraftResult } from "../../domain/drafts/order.js";
import { orderDetailSchema } from "../../domain/orders.js";
import type { ToolOutput } from "../types.js";

/** Output of the order draft tools: the order as read back after the save. */
export const orderDraftOutput = z.object({
  order: orderDetailSchema,
  positions: z.array(positionDtoSchema).describe("Positionen as sevDesk stored them."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more position rows than could be read back."),
  notes: z
    .array(z.string())
    .optional()
    .describe("Things to check, e.g. a total that differs from the preview or a missing number."),
});

type OrderDraftOutput = z.output<typeof orderDraftOutput>;

/** The tool output of a saved order draft; `verb` is "Created" or "Updated". */
export function orderDraftToolOutput(
  result: OrderDraftResult,
  verb: "Created" | "Updated",
): ToolOutput<OrderDraftOutput> {
  const { order, positions, positionsComplete } = result.details;
  const gross = order.totals.gross;
  const total = gross === undefined ? "" : `, gross ${gross.amount} ${gross.currency}`;
  const count = `${positions.length} position${positions.length === 1 ? "" : "s"}`;
  return {
    data: {
      order,
      positions: [...positions],
      positionsComplete,
      ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
    },
    summary:
      `${verb} draft order ${result.id} (${order.type.code}, ${count}${total}).` +
      (result.notes.length === 0 ? "" : " See notes."),
    affected: [{ objectName: "Order", id: String(result.id) }],
  };
}
