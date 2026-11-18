/**
 * What the two order factory tools share (`sevdesk_order_create_confirmation`,
 * `sevdesk_order_create_delivery_note`): the order id argument, the output schema and how a
 * result is turned into it.
 */
import { z } from "zod";

import { positionDtoSchema, statusDtoSchema } from "../../domain/document-positions.js";
import type { DerivedOrderResult } from "../../domain/order-follow-ups.js";
import { orderDetailSchema } from "../../domain/orders.js";

/** The source order id argument (not its number). */
export function sourceOrderInput(what: string) {
  return z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .describe(`${what} id (not its number), e.g. from sevdesk_orders_list.`);
}

export const allowDuplicateInput = (what: string) =>
  z
    .boolean()
    .default(false)
    .describe(`Create it even though ${what} from this order exists already.`);

export const derivedOrderOutput = z.object({
  order: orderDetailSchema.describe("The new draft, read back from sevDesk."),
  positions: z.array(positionDtoSchema).describe("Its positions (Positionen)."),
  positionsComplete: z
    .boolean()
    .describe("False when not every position could be read for certain."),
  sourceOrderId: z.number().int().describe("The order it was created from."),
  sourceOrderStatus: statusDtoSchema
    .optional()
    .describe("The source order's status after the call, when it could be read again."),
  notes: z
    .array(z.string())
    .optional()
    .describe(
      "Things to check, e.g. whether sevDesk's number counter was moved on, or other orders " +
        "that carry the same number.",
    ),
});

/** The tool output of a factory result. */
export function derivedOrderData(
  result: DerivedOrderResult,
  sourceOrderId: number,
  extraNotes: readonly string[] = [],
): z.output<typeof derivedOrderOutput> {
  const notes = [...extraNotes, ...result.notes];
  return {
    order: result.details.order,
    positions: [...result.details.positions],
    positionsComplete: result.details.positionsComplete,
    sourceOrderId,
    ...(result.source === undefined ? {} : { sourceOrderStatus: result.source.dto.status }),
    ...(notes.length === 0 ? {} : { notes }),
  };
}
