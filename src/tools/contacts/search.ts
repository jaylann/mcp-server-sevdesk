import { z } from "zod";

import {
  findContactsByCustomField,
  listCustomFieldSettings,
  resolveSetting,
  VALUE_MAX as CUSTOM_FIELD_VALUE_MAX,
} from "../../domain/contact-custom-fields.js";
import {
  contactDtoSchema,
  type ContactSearchResult,
  searchContacts,
} from "../../domain/contacts.js";
import { contactSummary, listDetailInputShape } from "../../domain/list-summary.js";
import {
  pageOutput,
  pageOutputShape,
  pageSummary,
  type PageWindow,
  pagingInputShape,
} from "../../domain/paging.js";
import { CONTACT_CATEGORY_KEYS, contactCategoryIdByKey } from "../../domain/reference-data.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { defineTool } from "../define-tool.js";
import type { ToolContext } from "../types.js";
import { customFieldRefShape } from "./contact-fields.js";

const output = z.object({
  items: z.array(contactDtoSchema),
  ...pageOutputShape,
});

const input = z.strictObject({
  ...listDetailInputShape,
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
  customField: z
    .strictObject({
      ...customFieldRefShape,
      value: z
        .string()
        .trim()
        .min(1)
        .max(CUSTOM_FIELD_VALUE_MAX)
        .describe(
          "The whole value, compared ignoring case: 'EXT-4711' finds 'ext-4711', but a part " +
            "such as 'EXT' finds nothing.",
        ),
    })
    .optional()
    .describe(
      "Contacts whose custom field (Zusatzfeld) has this value: {settingId or name, value}. " +
        "Not combined with query, customerNumber or category.",
    ),
  ...pagingInputShape({ limit: 25, max: 100 }),
});

type SearchArgs = z.output<typeof input>;

/** `sevdesk_contacts_search`: find organisations and persons. */
export const contactsSearchTool = defineTool({
  name: "sevdesk_contacts_search",
  title: "Search sevDesk contacts",
  description:
    "Search contacts (Kontakte) in sevDesk: organisations and persons, such as customers " +
    "(Kunden), suppliers (Lieferanten), partners and prospects (Interessenten). Filter by name, " +
    "exact customer number (Kundennummer) and category, or by a custom field value " +
    "(customField: whole value, any case). sevDesk does the name matching against " +
    "organisation names and persons' first and last names; if nothing is found, try a shorter " +
    "or different part of the name. Results are compact and paged (limit/offset, total, " +
    "hasMore). Use detail=summary to browse/find. Use sevdesk_contact_get for addresses, emails, phone numbers and custom fields.",
  toolset: "contacts",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input,
  output,
  handler: async (args, ctx) => {
    if (args.customField !== undefined) return searchByCustomField(args, args.customField, ctx);
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
      data: {
        items: args.detail === "summary" ? result.items.map(contactSummary) : [...result.items],
        ...pageOutput(window, result, args.limit),
      },
      summary: summarize(window, result),
    };
  },
});

/**
 * The custom-field search: the field resolved against the account's fields, one read of the
 * matching contacts (`findContactsByCustomField`), paged here. The other filters are refused
 * rather than combined, so what matched is always clear.
 */
async function searchByCustomField(
  args: SearchArgs,
  customField: NonNullable<SearchArgs["customField"]>,
  ctx: ToolContext,
) {
  const combined = (["query", "customerNumber", "category"] as const).filter(
    (key) => args[key] !== undefined,
  );
  if (combined.length > 0) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `customField is not combined with ${combined.join(", ")}: search by the custom field ` +
        "alone, then narrow the result yourself.",
    });
  }
  const settings = await listCustomFieldSettings(ctx.client, ctx.signal);
  const setting = resolveSetting(settings, customField, "customField");
  const matches = await findContactsByCustomField(
    ctx.client,
    setting.id,
    customField.value,
    ctx.signal,
  );
  const page = matches.items.slice(args.offset, args.offset + args.limit);
  const end = args.offset + page.length;
  const hasMore = end < matches.items.length;
  const truncatedNote = matches.truncated
    ? ` sevDesk returned ${matches.items.length} or more matches; only those are paged here.`
    : "";
  const range =
    page.length === 0
      ? args.offset === 0
        ? "No contacts have this value in that custom field."
        : `No contacts at offset ${args.offset}; ${matches.items.length} matched.`
      : `Contacts ${args.offset + 1}–${end} of ${matches.items.length} with this value in ` +
        `custom field ${setting.id}${hasMore ? `; more follow (nextOffset ${end})` : ""}.`;
  return {
    data: {
      items: args.detail === "summary" ? page.map(contactSummary) : [...page],
      ...(matches.truncated ? {} : { total: matches.items.length }),
      offset: args.offset,
      limit: args.limit,
      hasMore,
      ...(hasMore ? { nextOffset: end } : {}),
    },
    summary: `${range}${truncatedNote}`,
  };
}

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
