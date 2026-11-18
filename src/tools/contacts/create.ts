import { z } from "zod";

import { executeContactCreate, planContactCreate } from "../../domain/contacts-write.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_CONTACT_NUMBERS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import {
  addressAndCommunicationShape,
  categoryInput,
  contactFieldsShape,
  contactWriteData,
  contactWriteOutput,
  customFieldReadBackNote,
  customFieldsInput,
} from "./contact-fields.js";

/** `sevdesk_contact_create`: a new organisation or person, with address and e-mail/phone/web. */
export const contactCreateTool = defineWriteTool({
  name: "sevdesk_contact_create",
  title: "Create a sevDesk contact",
  description:
    "Create a contact (Kontakt anlegen): an organisation (organisationName) or a person " +
    "(firstName/lastName), as customer (Kunde, default), supplier (Lieferant), partner or " +
    "prospect, with optional customer number (Kundennummer; default: sevDesk assigns the next " +
    "free one), USt-IdNr., Steuernummer, Leitweg-ID, billing address (Rechnungsanschrift) and " +
    "e-mail, phone, website; a person can belong to an organisation as its contact person " +
    "(Ansprechpartner, parentOrganisationId), and customFields sets custom field values " +
    "(Kontaktfelder) by field id or name. Tier write. Checks first that no contact with the " +
    "same name or e-mail exists (allowDuplicate: true creates one anyway), that the customer " +
    "number is free, that parentOrganisationId is an organisation and that each custom field " +
    "exists. Search with sevdesk_contacts_search before; change it later with " +
    "sevdesk_contact_update.",
  toolset: "contacts",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    ...contactFieldsShape,
    category: categoryInput.default("customer"),
    ...addressAndCommunicationShape,
    customFields: customFieldsInput.optional(),
    allowDuplicate: z
      .boolean()
      .default(false)
      .describe(
        "Create the contact even though one with the same name or e-mail exists. Only after " +
          "checking that the existing one is really someone else.",
      ),
    ...dryRunInputShape,
  }),
  output: contactWriteOutput,
  // "No contact with this name or e-mail yet" and "the customer number is free" are checked,
  // then the contact is created: two creations at once both passed (review 2026-11, round 3).
  // The organisation is checked to be one, so a deletion of it must not run in between.
  locks: (args) => [
    ACCOUNT_CONTACT_NUMBERS,
    ...(args.parentOrganisationId === undefined
      ? []
      : [{ objectName: "Contact", id: String(args.parentOrganisationId) }]),
  ],
  prepare: (args, ctx) => planContactCreate(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) => {
    const { details, customFields, affected } = await executeContactCreate(ctx.client, plan.state, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    const addresses = details.addresses.length;
    const ways = details.communicationWays.length;
    const parts = [
      `${addresses} address${addresses === 1 ? "" : "es"}`,
      `${ways} communication way${ways === 1 ? "" : "s"}`,
    ];
    if (customFields?.readable === true) {
      const fields = customFields.rows.length;
      parts.push(`${fields} custom field value${fields === 1 ? "" : "s"}`);
    }
    const last = parts.pop();
    return {
      data: contactWriteData(details, customFields),
      summary:
        `Created contact ${details.contact.id} (${details.contact.kind}) with ` +
        `${parts.join(", ")} and ${last ?? ""}.${customFieldReadBackNote(customFields)}`,
      affected,
    };
  },
});
