import { z } from "zod";

import { executePartUpdate, planPartUpdate } from "../../domain/parts-write.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { partFieldsShape, partWriteOutput, taxRateInput } from "./part-fields.js";

/** `sevdesk_part_update`: change given fields of a part, keep everything else. */
export const partUpdateTool = defineWriteTool({
  name: "sevdesk_part_update",
  title: "Update a sevDesk part",
  description:
    "Change a part (Artikel ändern): only the fields you give change, nothing is cleared. Name, " +
    "Artikelnummer (must be free), sales price net or gross (the other is computed), tax rate " +
    "(alone: the net price stays, the gross price is recomputed), unit, purchase price, stock, " +
    "stock tracking, active/inactive, description, internal note. Existing documents keep " +
    "their prices. Tier write. Reads the part first (sevdesk_part_get shows the current values) " +
    "and fails when nothing would change.",
  toolset: "parts",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Part id, e.g. from sevdesk_parts_list."),
    name: partFieldsShape.name.optional(),
    partNumber: partFieldsShape.partNumber.optional(),
    price: partFieldsShape.price.optional(),
    priceType: partFieldsShape.priceType,
    taxRate: taxRateInput.optional().describe("Tax rate in percent."),
    unitId: partFieldsShape.unitId.optional(),
    pricePurchase: partFieldsShape.pricePurchase.optional(),
    stock: partFieldsShape.stock.optional(),
    stockEnabled: partFieldsShape.stockEnabled.optional(),
    active: z
      .boolean()
      .optional()
      .describe("false deactivates the part (inactive), true activates it."),
    description: partFieldsShape.description.optional(),
    internalComment: partFieldsShape.internalComment.optional(),
    ...dryRunInputShape,
  }),
  output: partWriteOutput,
  prepare: (args, ctx) => planPartUpdate(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) => {
    const part = await executePartUpdate(ctx.client, plan.state, ctx.signal);
    return {
      data: { part },
      summary: `Updated part ${part.id}.`,
      affected: [{ objectName: "Part", id: String(part.id) }],
    };
  },
});
