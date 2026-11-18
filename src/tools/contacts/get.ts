import { z } from "zod";

import {
  customFieldDtoSchema,
  readCustomFieldsForDisplay,
} from "../../domain/contact-custom-fields.js";
import {
  addressDtoSchema,
  communicationWayDtoSchema,
  contactDtoSchema,
  getContactDetails,
} from "../../domain/contacts.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  contact: contactDtoSchema,
  addresses: z.array(addressDtoSchema).describe("Postal addresses (Adressen)."),
  addressesComplete: z
    .boolean()
    .describe("False when sevDesk had more rows than could be read: addresses is partial."),
  communicationWays: z
    .array(communicationWayDtoSchema)
    .describe("Emails, phone numbers and websites (Kommunikationswege)."),
  communicationWaysComplete: z
    .boolean()
    .describe("False when sevDesk had more rows than could be read: communicationWays is partial."),
  customFields: z
    .array(customFieldDtoSchema)
    .describe("Custom field values (Kontaktfelder), with the field's id and name."),
  customFieldsComplete: z
    .boolean()
    .describe(
      "False when sevDesk had more values than could be read, or they could not be read at all " +
        "(see the summary): customFields is partial.",
    ),
});

/** `sevdesk_contact_get`: one contact with addresses, communication ways and custom fields. */
export const contactGetTool = defineTool({
  name: "sevdesk_contact_get",
  title: "Get a sevDesk contact",
  description:
    "Get one contact (Kontakt) by its sevDesk id, with its postal addresses (Adressen, e.g. " +
    "Rechnungsanschrift), communication ways (email, phone, website) and custom field values " +
    "(Kontaktfelder). Use it after sevdesk_contacts_search to check a customer's (Kunde) or " +
    "supplier's (Lieferant) details, e.g. the billing address or invoice email, before working " +
    "with their documents. ISO country codes are included when the country table resolves the ids.",
  toolset: "contacts",
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
      .describe("Contact id, e.g. from sevdesk_contacts_search."),
  }),
  output,
  handler: async (args, ctx) => {
    const details = await getContactDetails(ctx.client, args.id, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    // After the contact read, so a missing contact costs no further request (D-086: no contact
    // read shows custom fields, so they are one extra read).
    const customFields = await readCustomFieldsForDisplay(ctx.client, args.id, ctx.signal);
    const { contact, addresses, communicationWays } = details;
    const fields = customFields.readable ? customFields.rows : [];
    const addressCount = count(addresses.length, "address", "addresses");
    const wayCount = count(communicationWays.length, "communication way", "communication ways");
    const parts = [addressCount, wayCount];
    // An unreadable list is no count: "0 custom field values" would read as a fact.
    if (customFields.readable) {
      parts.push(count(fields.length, "custom field value", "custom field values"));
    }
    const last = parts.pop();
    const partial = [
      details.addressesComplete ? undefined : "addresses",
      details.communicationWaysComplete ? undefined : "communication ways",
      customFields.readable && !customFields.complete ? "custom field values" : undefined,
    ].filter((part): part is string => part !== undefined);
    const partialNote =
      partial.length === 0
        ? ""
        : ` Partial: sevDesk had more ${partial.join(" and ")} than could be read.`;
    const unreadableNote = customFields.readable
      ? ""
      : " Its custom field values could not be read.";
    const summary = `Contact ${contact.id} (${contact.kind}) with ${parts.join(", ")} and ${last ?? ""}.`;
    return {
      data: {
        contact,
        addresses: [...addresses],
        addressesComplete: details.addressesComplete,
        communicationWays: [...communicationWays],
        communicationWaysComplete: details.communicationWaysComplete,
        customFields: [...fields],
        customFieldsComplete: customFields.readable && customFields.complete,
      },
      summary: `${summary}${partialNote}${unreadableNote}`,
    };
  },
});

function count(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
