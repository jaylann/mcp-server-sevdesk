import { z } from "zod";

import { contactDtoSchema } from "../../domain/contacts.js";
import {
  contactPersonOutcomeSchema,
  executeContactDelete,
  prepareContactDelete,
} from "../../domain/contacts-delete.js";
import { defineWriteTool } from "../define-tool.js";
import type { SevdeskObjectRef } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { recordIdInput } from "./contact-fields.js";

/**
 * `sevdesk_contact_delete`: delete a contact with its addresses and communication ways and, for
 * an organisation, its contact persons (`DELETE /Contact/{id}`, D-084). Commit tier although the
 * endpoint needs only `write`: the deletion cannot be undone and takes all of these with it, so a
 * human confirms it, like the deletion of a draft voucher. The approval is bound to every record
 * that goes, contact persons included.
 */
export const contactDeleteTool = defineWriteTool({
  name: "sevdesk_contact_delete",
  title: "Delete a sevDesk contact",
  description:
    "Delete a contact (Kontakt löschen) with all its addresses and communication ways, e.g. a " +
    "duplicate, a test contact or for an erasure request (DSGVO). Deleting an organisation also " +
    "deletes all its contact persons (Ansprechpartner); the preview lists them. Cannot be " +
    "undone. sevDesk refuses it while documents (invoices, also drafts) still reference the " +
    "contact; then nothing is deleted and the result says so (stillReferenced). To remove only " +
    "one address, e-mail or phone number, or a person's link to its organisation (which keeps " +
    "the person), use sevdesk_contact_update with remove. Commit tier: asks a human to confirm " +
    "the preview, which names the contact and what goes with it; dryRun only previews. Before: " +
    "sevdesk_contact_get.",
  toolset: "contacts",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    id: recordIdInput().describe("Contact id, e.g. from sevdesk_contacts_search."),
    ...dryRunInputShape,
  }),
  output: z.object({
    contact: contactDtoSchema.describe("The contact as it was before the deletion."),
    addresses: z
      .number()
      .int()
      .describe("Addresses the contact had; sevDesk deletes them with it."),
    communicationWays: z
      .number()
      .int()
      .describe("Communication ways the contact had; sevDesk deletes them with it."),
    deleted: z.boolean().describe("True only when a read afterwards found the contact gone."),
    stillReferenced: z
      .boolean()
      .optional()
      .describe("True when sevDesk refused because documents still reference the contact."),
    contactPersons: z
      .array(contactPersonOutcomeSchema)
      .optional()
      .describe(
        "An organisation's contact persons, which sevDesk deletes with it, each read back " +
          "afterwards.",
      ),
    notes: z.array(z.string()).optional(),
  }),
  // Serialized with updates of the same contact, and with creates and updates that make it the
  // organisation of a person (they lock it too), so no person joins between preview and DELETE.
  locks: (args) => [{ objectName: "Contact", id: String(args.id) }],
  prepare: (args, ctx) =>
    prepareContactDelete(ctx.client, args.id, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (args, plan, ctx) => {
    const { contact, addressIds, communicationWayIds, persons } = plan.state;
    const result = await executeContactDelete(ctx.client, args.id, persons, ctx.signal);
    const id = String(args.id);
    const data = {
      contact,
      addresses: addressIds.length,
      communicationWays: communicationWayIds.length,
      deleted: result.deleted,
      ...(result.stillReferenced ? { stillReferenced: true } : {}),
      ...(result.persons.length === 0 ? {} : { contactPersons: [...result.persons] }),
      ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
    };
    const gonePersons: SevdeskObjectRef[] = result.persons
      .filter((person) => person.outcome === "deleted")
      .map((person) => ({ objectName: "Contact", id: String(person.id) }));
    const seeNotes = result.notes.length === 0 ? "" : " See notes.";
    if (result.stillReferenced) {
      return {
        data,
        summary:
          `sevDesk refused to delete contact ${id}: documents still reference it. Nothing was ` +
          `deleted.${seeNotes}`,
        affected: gonePersons,
      };
    }
    if (!result.deleted) {
      return {
        data,
        summary: `Asked sevDesk to delete contact ${id}; it is still there. See notes.`,
        affected: [{ objectName: "Contact", id }, ...gonePersons],
      };
    }
    const addresses = addressIds.length;
    const ways = communicationWayIds.length;
    const people = gonePersons.length;
    const withPersons =
      persons.length === 0
        ? `${addresses} address${addresses === 1 ? "" : "es"} and ${ways} communication ` +
          `way${ways === 1 ? "" : "s"}`
        : `${addresses} address${addresses === 1 ? "" : "es"}, ${ways} communication ` +
          `way${ways === 1 ? "" : "s"} and ${people} contact person${people === 1 ? "" : "s"}`;
    return {
      data,
      summary: `Deleted contact ${id} with ${withPersons}.${seeNotes}`,
      affected: [
        { objectName: "Contact", id },
        ...addressIds.map((addressId) => ({ objectName: "ContactAddress", id: String(addressId) })),
        ...communicationWayIds.map((wayId) => ({
          objectName: "CommunicationWay",
          id: String(wayId),
        })),
        ...gonePersons,
      ],
    };
  },
});
