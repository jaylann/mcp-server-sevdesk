import { z } from "zod";

import {
  contactDtoSchema,
  type ContactSearchResult,
  searchContacts,
} from "../../domain/contacts.js";
import { CONTACT_CATEGORY_KEYS, contactCategoryIdByKey } from "../../domain/reference-data.js";
import { defineTool } from "../define-tool.js";

/** Default and maximum page size: enough to pick from, small enough for the context window. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const output = z.object({
  items: z.array(contactDtoSchema),
  total: z.number().int().optional().describe("All matches in sevDesk, when sevDesk reports it."),
  offset: z.number().int(),
  limit: z.number().int(),
  hasMore: z
    .boolean()
    .describe("More matches may follow: call again with offset = nextOffset. An empty page ends."),
  nextOffset: z
    .number()
    .int()
    .optional()
    .describe("offset plus the rows sevDesk returned; sevDesk may return fewer rows than limit."),
});

/** `sevdesk_contacts_search`: find organisations and persons. */
export const contactsSearchTool = defineTool({
  name: "sevdesk_contacts_search",
  title: "Search sevDesk contacts",
  description:
    "Search contacts (Kontakte) in sevDesk: organisations and persons, such as customers " +
    "(Kunden), suppliers (Lieferanten), partners and prospects (Interessenten). Filter by name, " +
    "exact customer number (Kundennummer) and category. sevDesk does the name matching against " +
    "organisation names and persons' first and last names; if nothing is found, try a shorter " +
    "or different part of the name. Results are compact and paged (limit/offset, total, " +
    "hasMore). Use an id with sevdesk_contact_get for addresses, emails and phone numbers.",
  toolset: "contacts",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    query: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Name or part of a name, e.g. 'Musterfirma' or 'Mustermann'."),
    customerNumber: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Exact customer number (Kundennummer), e.g. 'K-1001'."),
    category: z
      .enum(CONTACT_CATEGORY_KEYS)
      .optional()
      .describe("customer (Kunde), supplier (Lieferant), partner or prospect (Interessent)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Page size, 1–${MAX_LIMIT}.`),
    offset: z.number().int().min(0).default(0).describe("Matches to skip, for paging."),
  }),
  output,
  handler: async (args, ctx) => {
    const result = await searchContacts(
      ctx.client,
      {
        query: args.query,
        customerNumber: args.customerNumber,
        categoryId: args.category === undefined ? undefined : contactCategoryIdByKey(args.category),
        limit: args.limit,
        offset: args.offset,
      },
      ctx.signal,
    );
    const data = {
      items: [...result.items],
      ...(result.total === undefined ? {} : { total: result.total }),
      offset: args.offset,
      limit: args.limit,
      hasMore: result.hasMore,
      ...(result.hasMore ? { nextOffset: result.nextOffset } : {}),
    };
    return { data, summary: summarize(args.offset, result) };
  },
});

function summarize(offset: number, result: ContactSearchResult): string {
  const { received, total, hasMore, nextOffset } = result;
  if (received === 0) {
    return offset > 0 && total !== undefined && total > 0
      ? `No contacts at offset ${offset}; there are ${total} matches in total.`
      : offset > 0
        ? `No more contacts after offset ${offset}.`
        : "No contacts matched.";
  }
  const range = `${offset + 1}–${nextOffset}`;
  const of = total === undefined ? "" : ` of ${total}`;
  const more = hasMore ? `; more may follow (nextOffset ${nextOffset})` : "";
  return `Contacts ${range}${of}${more}.`;
}
