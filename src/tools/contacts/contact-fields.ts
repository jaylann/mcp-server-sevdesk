/**
 * Input fields and the output schema shared by `sevdesk_contact_create` and
 * `sevdesk_contact_update`. Text is trimmed; empty strings are rejected, so a write never clears
 * a field by accident (clearing is not supported).
 */
import { z } from "zod";

import {
  addressDtoSchema,
  communicationWayDtoSchema,
  type ContactDetails,
  contactDtoSchema,
} from "../../domain/contacts.js";
import { CONTACT_CATEGORY_KEYS } from "../../domain/reference-data.js";

function textInput(max: number) {
  return z.string().trim().min(1).max(max);
}

/** USt-IdNr.: spaces removed, upper case, two-letter country prefix (EL for Greece). */
const vatNumberInput = z
  .string()
  .transform((value) => value.replace(/\s+/g, "").toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}[A-Z0-9+*]{2,13}$/, "expected a VAT ID such as DE123456789"));

/** Name, numbers and category fields (all optional here; the create tool adds the default). */
export const contactFieldsShape = {
  organisationName: textInput(255)
    .optional()
    .describe("Organisation (company) name. Leave firstName/lastName out for organisations."),
  firstName: textInput(100)
    .optional()
    .describe("Person: first name (sevDesk field surename). Leave organisationName out."),
  lastName: textInput(100).optional().describe("Person: last name (sevDesk field familyname)."),
  customerNumber: textInput(50).optional().describe("Kundennummer; must not be used yet."),
  vatNumber: vatNumberInput.optional().describe("USt-IdNr. (VAT ID), e.g. DE123456789."),
  taxNumber: textInput(30).optional().describe("Steuernummer (tax number)."),
  buyerReference: textInput(100)
    .optional()
    .describe("Leitweg-ID / buyer reference for e-invoices (XRechnung) to public bodies."),
};

/** The contact category argument. */
export const categoryInput = z
  .enum(CONTACT_CATEGORY_KEYS)
  .describe("customer (Kunde), supplier (Lieferant), partner or prospect (Interessent).");

/** Billing address and communication fields. */
export const addressAndCommunicationShape = {
  street: textInput(255).optional().describe("Street and house number (Straße)."),
  zip: textInput(20).optional().describe("Postal code (PLZ)."),
  city: textInput(100).optional().describe("City (Ort)."),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "expected an ISO 3166-1 alpha-2 code such as DE")
    .transform((value) => value.toUpperCase())
    .optional()
    .describe("Country as ISO 3166-1 alpha-2 code, e.g. DE (default for a new address), AT, CH."),
  email: z.email().max(254).optional().describe("E-mail address."),
  phone: z
    .string()
    .trim()
    .min(3)
    .max(50)
    .regex(/^[0-9+()/.\- ]+$/, "expected a phone number such as +49 30 1234567")
    .optional()
    .describe("Phone number (Telefon)."),
  website: z
    .string()
    .trim()
    .max(255)
    .regex(
      /^(https?:\/\/)?[^\s/.]+(\.[^\s/.]+)+(\/\S*)?$/i,
      "expected a website such as example.com",
    )
    .optional()
    .describe("Website, e.g. https://example.com."),
};

/** Output of both tools: the contact as `sevdesk_contact_get` returns it, read back after the write. */
export const contactWriteOutput = z.object({
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

export type ContactWriteOutput = z.output<typeof contactWriteOutput>;

/** The read-back contact as tool output. */
export function contactWriteData(details: ContactDetails): ContactWriteOutput {
  return {
    contact: details.contact,
    addresses: [...details.addresses],
    addressesComplete: details.addressesComplete,
    communicationWays: [...details.communicationWays],
    communicationWaysComplete: details.communicationWaysComplete,
  };
}
