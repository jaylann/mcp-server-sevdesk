import { z } from "zod";

import {
  creditNoteCreateInputShape,
  executeCreditNoteDraft,
  prepareCreditNoteCreate,
} from "../../domain/drafts/credit-note.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_CREDIT_NOTE_NUMBERS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { creditNoteDraftOutput, creditNoteDraftToolOutput } from "./draft-output.js";

/** `sevdesk_credit_note_create_draft`: a new draft credit note (Gutschrift) with positions. */
export const creditNoteCreateDraftTool = defineWriteTool({
  name: "sevdesk_credit_note_create_draft",
  title: "Create a draft credit note",
  description:
    "Create a draft credit note (Gutschrift) for a contact with its positions. Tier write: it " +
    "only creates a draft; nothing is sent or booked. Saving reserves the next number of " +
    "sevDesk's number range (shown in the preview). " +
    "bookingCategory is required: underachievement (Minderleistung) reduces a finalized invoice " +
    "of the same contact given as sourceInvoiceId (not cancelled; refused when a credit note " +
    "for it exists unless allowDuplicate), and every rate must be one of that invoice's " +
    "rates; provision (Provisionsgutschrift) uses tax rule 9; royalty_assigned/_unassigned " +
    "(Lizenzen) are not verified live yet. To credit a whole invoice use " +
    "sevdesk_credit_note_create_from_invoice instead. Defaults: today, net prices, EUR (or the " +
    "invoice's currency), the contact's invoice address, the account's only user as contact " +
    "person, tax rule 1 (11 on a Kleinunternehmer account). discount: a discount on the " +
    "whole credit note (Rabatt, percent or a fixed net amount). dryRun previews without saving. " +
    "After: sevdesk_credit_note_update_draft to change it, sevdesk_document_set_layout for " +
    "language, template or letterhead, sevdesk_credit_note_pdf, sevdesk_credit_note_finalize.",
  toolset: "credit-notes",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({ ...creditNoteCreateInputShape, ...dryRunInputShape }),
  output: creditNoteDraftOutput,
  // The number range it reserves from is the one sevdesk_credit_note_create_from_invoice takes
  // its numbers from, so the two run one at a time; with a source invoice, also the "no credit
  // note for it yet" check of both tools (review 2026-11, round 3).
  locks: (args) => [
    ACCOUNT_CREDIT_NOTE_NUMBERS,
    ...(args.sourceInvoiceId === undefined
      ? []
      : [{ objectName: "Invoice", id: String(args.sourceInvoiceId) }]),
  ],
  prepare: (args, ctx) =>
    prepareCreditNoteCreate(ctx.client, args, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (_args, plan, ctx) =>
    creditNoteDraftToolOutput(
      await executeCreditNoteDraft(ctx.client, plan.state, {
        signal: ctx.signal,
        cacheOwner: ctx.config,
      }),
      "Created",
    ),
});
