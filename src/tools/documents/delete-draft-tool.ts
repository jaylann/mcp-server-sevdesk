/**
 * `sevdesk_document_delete_draft`: delete a draft invoice, credit note or order
 * (`DELETE /{Invoice|CreditNote|Order}/{id}`). One tool with a `kind` argument instead of three, to
 * keep the tool count down (ADR 0001), named like `sevdesk_voucher_delete_draft` and
 * `sevdesk_document_save`.
 *
 * What sevDesk does (recorded on a trial account, spec/deviations.md D-109, D-074, D-024): a draft
 * (status 100) answers `{objects: [null]}` and a GET afterwards answers 404; anything else is
 * refused with 409 "… can only be deleted in status 100 but is status 200" and stays. A number
 * reserved for a draft (orders and credit notes, D-066) is handed out again after the draft is
 * deleted, so the number range keeps no gap.
 *
 * Commit tier although the endpoint needs only `write`, like `sevdesk_voucher_delete_draft`: a
 * deletion cannot be undone, so a human confirms the preview, which names the document. The
 * approval is bound to the stored record and its positions (`readDocumentContent`), so a draft
 * changed between the preview and the approval is asked about again instead of deleted unseen.
 *
 * Registration: toolset `meta` (it spans three document toolsets, as `sevdesk_document_save`
 * does) with an `available` condition (at least one of them enabled); each call is checked
 * against the toolset of its kind before any request, so disabling `orders` keeps orders out of
 * reach here too.
 */
import { z } from "zod";

import { creditNoteDetailSchema } from "../../domain/credit-notes.js";
import { invoiceDetailSchema } from "../../domain/invoices.js";
import { deleteDocument } from "../../domain/lifecycle/actions.js";
import {
  type DetailByKind,
  KINDS,
  type LifecycleDocument,
  readLifecycleDocument,
  type SalesKind,
} from "../../domain/lifecycle/documents.js";
import { documentTitle } from "../../domain/lifecycle/preview.js";
import { assertDeletable, refuse } from "../../domain/lifecycle/transitions.js";
import { orderDetailSchema } from "../../domain/orders.js";
import { bothPreviews, inLanguage, type Phrase, phrase } from "../../domain/preview-text.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { defineWriteTool } from "../define-tool.js";
import {
  capitalize,
  documentContent,
  documentObject,
  documentOutput,
  KIND_TOOLS,
} from "../lifecycle/shared.js";
import type { ToolContext } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

/** The values of the `kind` argument. */
const KIND_ARGS = ["invoice", "credit_note", "order"] as const;

type DeleteKindArg = (typeof KIND_ARGS)[number];

/** The lifecycle kind each `kind` argument names. */
const DELETE_KINDS: Readonly<Record<DeleteKindArg, SalesKind>> = {
  invoice: "invoice",
  credit_note: "creditNote",
  order: "order",
};

const SALES_KINDS: readonly SalesKind[] = KIND_ARGS.map((arg) => DELETE_KINDS[arg]);

const output = z.object({
  kind: z.enum(KIND_ARGS).describe("The kind of the deleted document."),
  invoice: invoiceDetailSchema.optional().describe("The invoice as it was before the deletion."),
  creditNote: creditNoteDetailSchema
    .optional()
    .describe("The credit note as it was before the deletion."),
  order: orderDetailSchema.optional().describe("The order as it was before the deletion."),
  deleted: z.boolean().describe("True when a read afterwards confirmed it is gone."),
  notes: z.array(z.string()).optional(),
});

const IRREVERSIBLE: Phrase = phrase(
  "The draft and all its positions are deleted from sevDesk; this cannot be undone.",
  "Der Entwurf und alle seine Positionen werden aus sevDesk gelöscht; das lässt sich nicht " +
    "rückgängig machen.",
);

/** Recorded for orders and credit notes (D-066, D-109); invoice drafts are numbered on finalize. */
const NUMBER_RETURNS: Phrase = phrase(
  "The draft's number is not used up: sevDesk gives it to the next document of the number " +
    "range, so the range keeps no gap.",
  "Die Nummer des Entwurfs ist nicht verbraucht: sevDesk vergibt sie an das nächste Dokument " +
    "des Nummernkreises, der Nummernkreis bleibt also lückenlos.",
);

/** `sevdesk_document_delete_draft`: deletes a draft invoice, credit note or order. */
export const documentDeleteDraftTool = defineWriteTool({
  name: "sevdesk_document_delete_draft",
  title: "Delete a draft invoice, credit note or order",
  description:
    "Delete a draft invoice (Rechnungsentwurf), credit note (Gutschrift) or order (Angebot, " +
    "Auftragsbestätigung, Lieferschein) with its positions, e.g. one created by mistake, for the " +
    "wrong customer, or a duplicate. Only drafts (status 100); a finalized invoice is cancelled " +
    "(sevdesk_invoice_cancel) or corrected with a credit note, never deleted. Recurring invoice " +
    "templates (Abo-Rechnung) are not deleted here (end one with " +
    "sevdesk_invoice_end_recurring). The number an order or credit note draft " +
    "holds is handed out again, so the number range keeps no gap. Cannot be undone. Commit tier: asks a human to " +
    "confirm the preview, which names the document; dryRun only previews. Vouchers: " +
    "sevdesk_voucher_delete_draft. Before: the kind's get tool, e.g. sevdesk_invoice_get.",
  toolset: "meta",
  tier: "commit",
  available: (config) => SALES_KINDS.some((kind) => config.toolsets.has(KIND_TOOLS[kind].toolset)),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    kind: z.enum(KIND_ARGS).describe("Which document: invoice, credit_note or order."),
    id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe(
        "Document id (not its number), e.g. from sevdesk_invoices_list, " +
          "sevdesk_credit_notes_list or sevdesk_orders_list.",
      ),
    ...dryRunInputShape,
  }),
  output,
  // Serialized with other calls on the same record (see WriteToolDefinition.locks).
  locks: (args) => [documentObject(DELETE_KINDS[args.kind], args.id)],
  prepare: async (args, ctx) => {
    const kind = DELETE_KINDS[args.kind];
    const { toolset } = KIND_TOOLS[kind];
    // First, so a refusal costs no sevDesk request.
    if (!ctx.config.toolsets.has(toolset)) {
      refuse(
        `Deleting ${KINDS[kind].noun} drafts needs the ${toolset} toolset, which is not enabled ` +
          "(SEVDESK_TOOLSETS).",
      );
    }
    let doc: LifecycleDocument<SalesKind>;
    try {
      doc = await readLifecycleDocument(ctx.client, kind, args.id, {
        signal: ctx.signal,
        cacheOwner: ctx.config,
      });
    } catch (error) {
      if (error instanceof SevdeskError && error.kind === "not_found") {
        refuse(
          `${capitalize(KINDS[kind].noun)} ${String(args.id)} does not exist in sevDesk (or was ` +
            "deleted already).",
        );
      }
      throw error;
    }
    assertDeletable(doc);
    // The identifying facts and the approval binding over the record and all its positions.
    const content = await documentContent(ctx, doc);
    const numbered = kind !== "invoice" && doc.number !== undefined && doc.number.trim() !== "";
    const warnings = [IRREVERSIBLE, ...(numbered ? [NUMBER_RETURNS] : [])];
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `${documentTitle(doc, lang)} (Entwurf) aus sevDesk löschen.`
            : `Delete ${documentTitle(doc)} (draft) from sevDesk.`,
        facts: content.identity(lang),
        warnings: inLanguage(warnings, lang),
        irreversible: true,
      })),
      binding: content.binding,
      state: { dto: doc.dto },
    };
  },
  execute: async (args, plan, ctx) => {
    const kind = DELETE_KINDS[args.kind];
    const { noun, toolPrefix } = KINDS[kind];
    const id = String(args.id);
    try {
      await deleteDocument(ctx.client, kind, args.id, ctx.signal);
    } catch (error) {
      if (error instanceof SevdeskError && error.status === 409) {
        throw new SevdeskError({
          kind: error.kind,
          status: 409,
          message:
            `sevDesk refused to delete ${noun} ${id}: only drafts (status 100) can be deleted, ` +
            "and it is no longer one (probably finalized in the meantime). Nothing was deleted; " +
            `check it with ${toolPrefix}_get.`,
          ...(error.upstreamMessage === undefined
            ? {}
            : { upstreamMessage: error.upstreamMessage }),
          cause: error,
        });
      }
      throw error;
    }
    const changed = documentObject(kind, args.id);
    const deleted = await confirmGone(ctx, kind, args.id);
    const dto: DetailByKind[SalesKind] = plan.state.dto;
    return {
      data: {
        kind: args.kind,
        ...documentOutput(kind, dto),
        deleted,
        ...(deleted
          ? {}
          : {
              notes: [
                `sevDesk accepted the deletion, but still returns ${noun} ${id}. Check it with ` +
                  `${toolPrefix}_get.`,
              ],
            }),
      },
      summary: deleted
        ? `Deleted draft ${noun} ${id}.`
        : `Asked sevDesk to delete ${noun} ${id}; it is still there. See notes.`,
      affected: [changed],
    };
  },
});

/**
 * Reads the document after the DELETE: `true` when sevDesk answers 404 (gone), `false` when it
 * still returns it. Any other failure is rethrown with the deletion as a completed write, so the
 * user is told not to delete again.
 */
async function confirmGone(ctx: ToolContext, kind: SalesKind, id: number): Promise<boolean> {
  try {
    await readLifecycleDocument(ctx.client, kind, id, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    return false;
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    if (error.kind === "not_found") return true;
    const { noun, toolPrefix } = KINDS[kind];
    throw new SevdeskError({
      kind: error.kind,
      message:
        `sevDesk accepted the deletion of ${noun} ${String(id)}, but the check afterwards ` +
        `failed: ${error.message} Do not delete again; check with ${toolPrefix}_get.`,
      cause: error,
      completedWrites: [documentObject(kind, id)],
    });
  }
}
