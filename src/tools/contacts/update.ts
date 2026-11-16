import { z } from "zod";

import { removedEntrySchema } from "../../domain/contacts-delete.js";
import { executeContactUpdate, planContactUpdate } from "../../domain/contacts-write.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_CONTACT_NUMBERS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import {
  addressAndCommunicationShape,
  categoryInput,
  contactFieldsShape,
  contactWriteData,
  contactWriteOutput,
  recordIdInput,
  removeInput,
} from "./contact-fields.js";

/**
 * `sevdesk_contact_update`: change given fields of a contact, keep everything else, and remove
 * the entries `remove` names.
 *
 * Removing stays in this `write` tool (no human confirmation), like changing: a removed address,
 * e-mail address or organisation link is re-entered with this tool, and the result lists every
 * removed entry as it was. Overwriting the billing address or the main e-mail, which this tool
 * always did, loses the old value the same way. Deleting a whole contact cannot be undone and is
 * the `commit` tool `sevdesk_contact_delete`.
 */
export const contactUpdateTool = defineWriteTool({
  name: "sevdesk_contact_update",
  title: "Update a sevDesk contact",
  description:
    "Change a contact (Kontakt ändern): only the fields you give are changed, everything else " +
    "stays; text fields cannot be cleared. Name (organisationName for organisations, " +
    "firstName/lastName for persons; the kind cannot change), category, Kundennummer (must be " +
    "free), USt-IdNr., Steuernummer, Leitweg-ID; parentOrganisationId links a person to its " +
    "organisation as contact person (Ansprechpartner; only an organisation is accepted); " +
    "street/zip/city/country change the billing address (Rechnungsanschrift, or the only " +
    "address; added when there is none); email/phone/website change the main entry of that type " +
    "or add one. remove deletes single entries of this contact (an address, e-mail, phone, " +
    "mobile or website, by the id sevdesk_contact_get shows) or the organisation link (kind " +
    "parentOrganisation, id of that organisation); ids of other contacts are refused, and the " +
    "result lists what was removed. Delete the whole contact with sevdesk_contact_delete. Tier " +
    "write. Reads the contact first (sevdesk_contact_get shows the current values) and fails " +
    "when nothing would change.",
  toolset: "contacts",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    id: recordIdInput().describe("Contact id, e.g. from sevdesk_contacts_search."),
    ...contactFieldsShape,
    category: categoryInput.optional(),
    ...addressAndCommunicationShape,
    remove: removeInput
      .optional()
      .describe(
        "Entries to take off this contact, each {kind, id}. Removed after the other changes; " +
          "the changes apply to what remains.",
      ),
    ...dryRunInputShape,
  }),
  output: contactWriteOutput.extend({
    removed: z
      .array(removedEntrySchema)
      .optional()
      .describe("What remove took off, as it was: re-enter it with this tool if needed."),
  }),
  // The contact: the change is worked out from what was read (an address or e-mail entry is
  // added when there is none, an id to remove must be one of its entries), so two updates at
  // once added two. A new customer number is checked against the other contacts first, like on
  // create (review 2026-11, round 3). A new organisation is checked to be one, so a deletion of
  // it must not run in between.
  locks: (args) => [
    { objectName: "Contact", id: String(args.id) },
    ...(args.customerNumber === undefined ? [] : [ACCOUNT_CONTACT_NUMBERS]),
    ...(args.parentOrganisationId === undefined
      ? []
      : [{ objectName: "Contact", id: String(args.parentOrganisationId) }]),
  ],
  prepare: (args, ctx) =>
    planContactUpdate(ctx.client, args, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (_args, plan, ctx) => {
    const { details, affected, removed } = await executeContactUpdate(ctx.client, plan.state, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    const deletedRecords = removed.filter((entry) => entry.kind !== "parentOrganisation").length;
    const changed = affected.length - deletedRecords;
    const summary =
      `Updated contact ${details.contact.id}: ${changed} record` +
      `${changed === 1 ? "" : "s"} changed or added`;
    if (removed.length === 0) {
      return { data: contactWriteData(details), summary: `${summary}.`, affected };
    }
    const addresses = details.addresses.length;
    const ways = details.communicationWays.length;
    return {
      data: { ...contactWriteData(details), removed },
      summary:
        `${summary}, ${removed.length} removed (see removed). It has ${addresses} ` +
        `address${addresses === 1 ? "" : "es"} and ${ways} communication ` +
        `way${ways === 1 ? "" : "s"} left.`,
      affected,
    };
  },
});
