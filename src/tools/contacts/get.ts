import { z } from "zod";

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
});

/** `sevdesk_contact_get`: one contact with addresses and communication ways. */
export const contactGetTool = defineTool({
  name: "sevdesk_contact_get",
  title: "Get a sevDesk contact",
  description:
    "Get one contact (Kontakt) by its sevDesk id, with its postal addresses (Adressen, e.g. " +
    "Rechnungsanschrift) and communication ways (email, phone, website). Use it after " +
    "sevdesk_contacts_search to check a customer's (Kunde) or supplier's (Lieferant) details, " +
    "e.g. the billing address or invoice email, before working with their documents. " +
    "ISO country codes are included when the country table resolves the ids.",
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
    const details = await getContactDetails(ctx.client, args.id, ctx.signal);
    const { contact, addresses, communicationWays } = details;
    const addressCount = count(addresses.length, "address", "addresses");
    const wayCount = count(communicationWays.length, "communication way", "communication ways");
    const partial = [
      details.addressesComplete ? undefined : "addresses",
      details.communicationWaysComplete ? undefined : "communication ways",
    ].filter((part): part is string => part !== undefined);
    const partialNote =
      partial.length === 0
        ? ""
        : ` Partial: sevDesk had more ${partial.join(" and ")} than could be read.`;
    const summary = `Contact ${contact.id} (${contact.kind}) with ${addressCount} and ${wayCount}.`;
    return {
      data: {
        contact,
        addresses: [...addresses],
        addressesComplete: details.addressesComplete,
        communicationWays: [...communicationWays],
        communicationWaysComplete: details.communicationWaysComplete,
      },
      summary: `${summary}${partialNote}`,
    };
  },
});

function count(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
