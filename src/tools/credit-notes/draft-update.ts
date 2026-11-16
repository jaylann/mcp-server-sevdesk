import { z } from "zod";

import {
  creditNoteUpdateInputShape,
  executeCreditNoteDraft,
  prepareCreditNoteUpdate,
} from "../../domain/drafts/credit-note.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { creditNoteDraftOutput, creditNoteDraftToolOutput } from "./draft-output.js";

/** `sevdesk_credit_note_update_draft`: change a draft credit note; given positions replace all. */
export const creditNoteUpdateDraftTool = defineWriteTool({
  name: "sevdesk_credit_note_update_draft",
  title: "Update a draft credit note",
  description:
    "Change a draft credit note (Gutschriftsentwurf, status draft). Tier write. Only the fields " +
    "you give change; everything else keeps its stored value, also the number, the booking " +
    "category and the invoice it reduces. positions, when given, replace ALL stored positions " +
    "in one request (add or remove one by passing the full new list); leave them out to keep " +
    "the positions. Changing priceMode needs the positions too, and a new tax rule must allow " +
    "every stored rate and fit the account's VAT regulation. A credit note that reduces an " +
    "invoice (underachievement) keeps that invoice's contact, currency and tax rates. A new " +
    "contactId also takes that contact's invoice address unless you give an address. discount " +
    "replaces the discount on the whole credit note (Rabatt); null removes it. Open or " +
    "enshrined (festgeschrieben) credit notes cannot be changed: reset an open one to a draft " +
    "with sevdesk_credit_note_reset first. dryRun shows the changes without saving. Before: " +
    "sevdesk_credit_note_get. After: sevdesk_credit_note_pdf, sevdesk_credit_note_finalize.",
  toolset: "credit-notes",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({ ...creditNoteUpdateInputShape, ...dryRunInputShape }),
  output: creditNoteDraftOutput,
  // Serialized with other calls on the same record (see WriteToolDefinition.locks). No number is
  // reserved, so the credit note number range is not locked.
  locks: (args) => [{ objectName: "CreditNote", id: String(args.id) }],
  prepare: (args, ctx) =>
    prepareCreditNoteUpdate(ctx.client, args, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (_args, plan, ctx) =>
    creditNoteDraftToolOutput(
      await executeCreditNoteDraft(ctx.client, plan.state, {
        signal: ctx.signal,
        cacheOwner: ctx.config,
      }),
      "Updated",
    ),
});
