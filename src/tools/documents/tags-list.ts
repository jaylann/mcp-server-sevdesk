import { z } from "zod";

import { pageOutput, pageOutputShape, pageSummary, pagingInputShape } from "../../domain/paging.js";
import { listTags, TAG_READ_MAX, tagDtoSchema } from "../../domain/tags.js";
import { defineTool } from "../define-tool.js";
import { anyTaggableToolset } from "./tag-kinds.js";

const output = z.object({
  items: z.array(tagDtoSchema),
  ...pageOutputShape,
  usesComplete: z
    .boolean()
    .describe(
      `False when the account has more than ${TAG_READ_MAX.toLocaleString("en-US")} tag uses: ` +
        "uses then count the first ones only and are lower bounds.",
    ),
});

/**
 * `sevdesk_tags_list`: the account's tags with how often each is used. Toolset `meta` with the
 * tag tools' registration rule (see `tag-kinds.ts`): tags span four document toolsets.
 */
export const tagsListTool = defineTool({
  name: "sevdesk_tags_list",
  title: "List sevDesk tags",
  description:
    "List the tags (Tags, Schlagworte) that group invoices, credit notes, orders and vouchers, " +
    "e.g. by project, customer or branch, with how many documents carry each, per kind. " +
    "Paged: pass nextOffset as offset while hasMore is true. Filter a document list by tag with " +
    "its tag argument (sevdesk_invoices_list, sevdesk_vouchers_list, …); add or remove a tag " +
    "with sevdesk_document_tag.",
  toolset: "meta",
  tier: "read",
  available: anyTaggableToolset,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    ...pagingInputShape({ limit: 50, max: 100 }),
  }),
  output,
  handler: async (args, ctx) => {
    const result = await listTags(ctx.client, args, ctx.signal);
    const cut = result.usesComplete
      ? ""
      : ` Uses are lower bounds: the account has more than ${TAG_READ_MAX.toLocaleString("en-US")} tag uses.`;
    return {
      data: {
        items: [...result.items],
        ...pageOutput(result.window, result.state, args.limit),
        usesComplete: result.usesComplete,
      },
      summary: pageSummary("Tags", result.window, result.state) + cut,
    };
  },
});
