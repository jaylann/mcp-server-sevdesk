import { z } from "zod";

import { executePartCreate, planPartCreate } from "../../domain/parts-write.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { partFieldsShape, partWriteOutput, taxRateInput } from "./part-fields.js";

/** `sevdesk_part_create`: a new part (Artikel) for documents. */
export const partCreateTool = defineWriteTool({
  name: "sevdesk_part_create",
  title: "Create a sevDesk part",
  description:
    "Create a part (Artikel anlegen) for invoice and offer positions: name, Artikelnummer " +
    "(required, must be free), sales price net or gross (the other is computed with the tax " +
    "rate and rounded to cents), tax rate (default 19), unit (default 1 = Stk), purchase price, " +
    "stock and stock tracking (Lagerbestand), description and internal note. Tier write. Check " +
    "existing parts with sevdesk_parts_list first; change the part later with " +
    "sevdesk_part_update.",
  toolset: "parts",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    name: partFieldsShape.name,
    partNumber: partFieldsShape.partNumber,
    price: partFieldsShape.price.optional(),
    priceType: partFieldsShape.priceType,
    taxRate: taxRateInput.default("19").describe("Tax rate in percent, default 19."),
    unitId: partFieldsShape.unitId.default(1),
    pricePurchase: partFieldsShape.pricePurchase.optional(),
    stock: partFieldsShape.stock.default("0"),
    stockEnabled: partFieldsShape.stockEnabled.default(false),
    description: partFieldsShape.description.optional(),
    internalComment: partFieldsShape.internalComment.optional(),
    ...dryRunInputShape,
  }),
  output: partWriteOutput,
  prepare: (args, ctx) => planPartCreate(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) => {
    const part = await executePartCreate(ctx.client, plan.state, ctx.signal);
    return {
      data: { part },
      summary: `Created part ${part.id}.`,
      affected: [{ objectName: "Part", id: String(part.id) }],
    };
  },
});
