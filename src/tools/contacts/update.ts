import { z } from "zod";

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
} from "./contact-fields.js";

/** `sevdesk_contact_update`: change given fields of a contact, keep everything else. */
export const contactUpdateTool = defineWriteTool({
  name: "sevdesk_contact_update",
  title: "Update a sevDesk contact",
  description:
    "Change a contact (Kontakt ändern): only the fields you give are changed, everything else " +
    "stays; fields cannot be cleared. Name (organisationName for organisations, " +
    "firstName/lastName for persons; the kind cannot change), category, Kundennummer (must be " +
    "free), USt-IdNr., Steuernummer, Leitweg-ID; street/zip/city/country change the billing " +
    "address (Rechnungsanschrift, or the only address; added when there is none); email/phone/" +
    "website change the main entry of that type or add one. Tier write. Reads the contact " +
    "first (sevdesk_contact_get shows the current values) and fails when nothing would change.",
  toolset: "contacts",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
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
    ...contactFieldsShape,
    category: categoryInput.optional(),
    ...addressAndCommunicationShape,
    ...dryRunInputShape,
  }),
  output: contactWriteOutput,
  // The contact: the change is worked out from what was read (an address or e-mail entry is
  // added when there is none), so two updates at once added two. A new customer number is
  // checked against the other contacts first, like on create (review 2026-11, round 3).
  locks: (args) => [
    { objectName: "Contact", id: String(args.id) },
    ...(args.customerNumber === undefined ? [] : [ACCOUNT_CONTACT_NUMBERS]),
  ],
  prepare: (args, ctx) =>
    planContactUpdate(ctx.client, args, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (_args, plan, ctx) => {
    const { details, affected } = await executeContactUpdate(ctx.client, plan.state, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    return {
      data: contactWriteData(details),
      summary:
        `Updated contact ${details.contact.id}: ${affected.length} record` +
        `${affected.length === 1 ? "" : "s"} changed or added.`,
      affected,
    };
  },
});
