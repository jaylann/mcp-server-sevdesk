import { z } from "zod";

import { listDetailInputShape, partSummary, partSummarySchema } from "../../domain/list-summary.js";
import { pageOutputShape, pageSummary, pagingInputShape } from "../../domain/paging.js";
import { listParts, partDtoSchema } from "../../domain/parts.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  items: z.array(z.union([partDtoSchema, partSummarySchema])),
  ...pageOutputShape,
});

/** `sevdesk_parts_list`: products and services (Artikel). */
export const partsListTool = defineTool({
  name: "sevdesk_parts_list",
  title: "List sevDesk parts",
  description:
    "List parts (Artikel): the products and services of the account with Artikelnummer, name, " +
    "unit, net and gross sales price, purchase price, tax rate, stock (Bestand) and active flag. " +
    "Filter by part number (Artikelnummer) or name; both filters run in sevDesk, which may " +
    "match them exactly, so try the full value if a part is missing. Paged: pass nextOffset as " +
    "offset while hasMore is true. Use detail=summary to browse/find. Use sevdesk_part_get for the description and current stock.",
  toolset: "parts",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    ...listDetailInputShape,
    partNumber: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Part number (Artikelnummer), e.g. 'ART-001'."),
    name: z.string().trim().min(1).max(100).optional().describe("Part name."),
    ...pagingInputShape({ limit: 25, max: 100 }),
  }),
  output,
  handler: async (args, ctx) => {
    const result = await listParts(ctx.client, args, ctx.signal);
    const { window, state } = result;
    return {
      data: {
        items: args.detail === "summary" ? result.items.map(partSummary) : [...result.items],
        ...(window.total === undefined ? {} : { total: window.total }),
        offset: args.offset,
        limit: args.limit,
        hasMore: state.hasMore,
        ...(state.hasMore ? { nextOffset: state.nextOffset } : {}),
      },
      summary: pageSummary("Parts", window, state),
    };
  },
});
