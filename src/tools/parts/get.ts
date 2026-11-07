import { z } from "zod";

import { getPartDetails, partDetailDtoSchema } from "../../domain/parts.js";
import { defineTool } from "../define-tool.js";

const output = z.object({ part: partDetailDtoSchema });

/** `sevdesk_part_get`: one part with description and current stock. */
export const partGetTool = defineTool({
  name: "sevdesk_part_get",
  title: "Get a sevDesk part",
  description:
    "Get one part (Artikel) by its sevDesk id: Artikelnummer, name, description (Beschreibung), " +
    "unit, prices, tax rate, internal note and stock (Bestand), including the current stock " +
    "from sevDesk's stock endpoint when stock tracking (Lagerbestand) is on. Use it after " +
    "sevdesk_parts_list. Unit ids resolve with sevdesk_reference_lookup kind=units.",
  toolset: "parts",
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
      .describe("Part id, e.g. from sevdesk_parts_list."),
  }),
  output,
  handler: async (args, ctx) => {
    const part = await getPartDetails(ctx.client, args.id, ctx.signal);
    const stock = part.currentStock === undefined ? "" : `, current stock ${part.currentStock}`;
    return { data: { part }, summary: `Part ${part.id}${stock}.` };
  },
});
