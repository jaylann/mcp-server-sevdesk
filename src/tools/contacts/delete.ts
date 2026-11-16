import { z } from "zod";

import { contactDtoSchema } from "../../domain/contacts.js";
import { executeContactDelete, prepareContactDelete } from "../../domain/contacts-delete.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { recordIdInput } from "./contact-fields.js";

/**
 * `sevdesk_contact_delete`: delete a contact with its addresses and communication ways
 * (`DELETE /Contact/{id}`). Commit tier although the endpoint needs only `write`: the deletion
 * cannot be undone, and it takes the addresses and communication ways with it (D-084), so a human
 * confirms it, like the deletion of a draft voucher.
 */
export const contactDeleteTool = defineWriteTool({
  name: "sevdesk_contact_delete",
  title: "Delete a sevDesk contact",
  description:
    "Delete a contact (Kontakt löschen) with all its addresses and communication ways, e.g. a " +
    "duplicate, a test contact or for an erasure request (DSGVO). Cannot be undone. sevDesk " +
    "refuses it while documents (invoices, also drafts) still reference the contact; then " +
    "nothing is deleted and the result says so (stillReferenced). To remove only one address, " +
    "e-mail or phone number, or a person's link to its organisation, use sevdesk_contact_update " +
    "with remove. Commit tier: asks a human to confirm the preview, which names the contact and " +
    "what goes with it; dryRun only previews. Before: sevdesk_contact_get.",
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
    notes: z.array(z.string()).optional(),
  }),
  // Serialized with updates of the same contact, and with creates and updates that make it the
  // organisation of a person (they lock it too).
  locks: (args) => [{ objectName: "Contact", id: String(args.id) }],
  prepare: (args, ctx) =>
    prepareContactDelete(ctx.client, args.id, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (args, plan, ctx) => {
    const { contact, addressIds, communicationWayIds } = plan.state;
    const result = await executeContactDelete(ctx.client, args.id, ctx.signal);
    const id = String(args.id);
    const data = {
      contact,
      addresses: addressIds.length,
      communicationWays: communicationWayIds.length,
      deleted: result.deleted,
      ...(result.stillReferenced ? { stillReferenced: true } : {}),
      ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
    };
    if (result.stillReferenced) {
      return {
        data,
        summary: `sevDesk refused to delete contact ${id}: documents still reference it. Nothing was deleted.`,
        affected: [],
      };
    }
    if (!result.deleted) {
      return {
        data,
        summary: `Asked sevDesk to delete contact ${id}; it is still there. See notes.`,
        affected: [{ objectName: "Contact", id }],
      };
    }
    const addresses = addressIds.length;
    const ways = communicationWayIds.length;
    return {
      data,
      summary:
        `Deleted contact ${id} with ${addresses} address${addresses === 1 ? "" : "es"} and ` +
        `${ways} communication way${ways === 1 ? "" : "s"}.`,
      affected: [
        { objectName: "Contact", id },
        ...addressIds.map((addressId) => ({ objectName: "ContactAddress", id: String(addressId) })),
        ...communicationWayIds.map((wayId) => ({
          objectName: "CommunicationWay",
          id: String(wayId),
        })),
      ],
    };
  },
});
