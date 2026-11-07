import { z } from "zod";

import {
  contactDtoSchema,
  type ContactSearchResult,
  searchContacts,
} from "../../domain/contacts.js";
import {
  pageOutput,
  pageOutputShape,
  pageSummary,
  type PageWindow,
  pagingInputShape,
} from "../../domain/paging.js";
import { CONTACT_CATEGORY_KEYS, contactCategoryIdByKey } from "../../domain/reference-data.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  items: z.array(contactDtoSchema),
  ...pageOutputShape,
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
    ...pagingInputShape({ limit: 25, max: 100 }),
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
    const window: PageWindow = {
      offset: args.offset,
      received: result.received,
      total: result.total,
    };
    return {
      data: { items: [...result.items], ...pageOutput(window, result, args.limit) },
      summary: summarize(window, result),
    };
  },
});

/** {@link pageSummary}, with a more specific sentence for an empty page. */
function summarize(window: PageWindow, result: ContactSearchResult): string {
  if (window.received === 0) {
    if (window.offset === 0) return "No contacts matched.";
    if (window.total !== undefined && window.total > 0) {
      return `No contacts at offset ${window.offset}; there are ${window.total} matches in total.`;
    }
  }
  return pageSummary("Contacts", window, result);
}
