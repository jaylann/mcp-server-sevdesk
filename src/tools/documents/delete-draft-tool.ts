/**
 * `sevdesk_document_delete_draft`: delete a draft invoice, credit note or order
 * (`DELETE /{Invoice|CreditNote|Order}/{id}`). One tool with a `kind` argument instead of three, to
 * keep the tool count down (ADR 0001), named like `sevdesk_voucher_delete_draft` and
 * `sevdesk_document_save`.
 *
 * What sevDesk does (recorded on a trial account, spec/deviations.md D-109, D-074, D-024): a draft
 * (status 100) answers `{objects: [null]}` and a GET afterwards answers 404; anything else is
 * refused with 409 "… can only be deleted in status 100 but is status 200" and stays.
 *
 * Numbers: a draft can carry a number that was already issued, because an open invoice or credit
 * note can be reset to draft (`sevdesk_invoice_reset`, `sevdesk_credit_note_reset`); deleting it
 * then leaves a gap in the number range. The record does not tell whether the number was issued,
 * so the preview warns instead of refusing (decided for #106; a human approves every call):
 * - an invoice draft with a number gets the gap warning, which names the send date when sevDesk
 *   records one, and points an issued invoice to `sevdesk_invoice_cancel`. This server creates
 *   invoice drafts without a number (`sendBy` numbers them, D-066). Where sevDesk enshrines on
 *   finalizing, an issued invoice cannot come back as a draft, since an enshrined invoice refuses
 *   `resetToDraft` and deletion (D-023, D-059);
 * - an order or credit note draft with a number gets the softer note: the number came back after
 *   deleting the draft that held the most recently reserved number (D-066); a number from further
 *   back was not measured and may leave a gap.
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
import {
  bothPreviews,
  dateText,
  inLanguage,
  type Phrase,
  phrase,
} from "../../domain/preview-text.js";
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

/**
 * Orders and credit notes with a number (see the module doc): recorded only for the most recently
 * reserved number (D-066, D-109), so the note promises no more than that.
 */
const NUMBER_MAY_RETURN: Phrase = phrase(
  "If the draft's number is the last one sevDesk handed out in its number range, sevDesk gives " +
    "it to the next document again; otherwise the number stays unused and the range has a gap.",
  "Ist die Nummer des Entwurfs die zuletzt vergebene seines Nummernkreises, vergibt sevDesk sie " +
    "an das nächste Dokument erneut; sonst bleibt die Nummer unbenutzt und der Nummernkreis hat " +
    "eine Lücke.",
);

/** The way out for an issued invoice, the last sentence of both invoice number warnings. */
const CANCEL_INSTEAD: Phrase = phrase(
  "An issued invoice is cancelled, not deleted: finalize it again and cancel it with " +
    "sevdesk_invoice_cancel (Storno).",
  "Eine ausgestellte Rechnung wird nicht gelöscht, sondern storniert: Stelle sie erneut fertig " +
    "und storniere sie mit sevdesk_invoice_cancel (Storno).",
);

/** An invoice draft with a number that sevDesk does not record as sent (see the module doc). */
const INVOICE_NUMBER_GAP: Phrase = phrase(
  "This invoice draft already has a number. If that number was issued (for example, the " +
    "invoice was finalized and later reset to draft), deleting the draft leaves a gap in the " +
    `invoice number range. ${CANCEL_INSTEAD.en}`,
  "Dieser Rechnungsentwurf hat bereits eine Nummer. Wurde sie schon vergeben (etwa weil die " +
    "Rechnung fertiggestellt und später auf Entwurf zurückgesetzt wurde), hinterlässt das " +
    `Löschen eine Lücke im Nummernkreis der Rechnungen. ${CANCEL_INSTEAD.de}`,
);

/**
 * An invoice draft with a number that sevDesk records as sent (`sendDate` or a send type), with
 * the date when there is one: the customer has probably received it under that number.
 */
function invoiceSentGap(date: string | undefined): Phrase {
  const on = date === undefined ? "" : ` on ${dateText(date, "en")}`;
  const am = date === undefined ? "" : ` (am ${dateText(date, "de")})`;
  return phrase(
    `This invoice draft has a number, and sevDesk records it as sent${on}: the customer has ` +
      "probably received it under that number. Deleting it leaves a gap in the invoice number " +
      `range and removes an invoice the customer holds. ${CANCEL_INSTEAD.en}`,
    `Dieser Rechnungsentwurf hat eine Nummer, und sevDesk führt ihn als versendet${am}: Der ` +
      "Kunde hat die Rechnung wahrscheinlich unter dieser Nummer erhalten. Das Löschen " +
      "hinterlässt eine Lücke im Nummernkreis der Rechnungen und entfernt eine Rechnung, die " +
      `beim Kunden liegt. ${CANCEL_INSTEAD.de}`,
  );
}

/** The number warning of `doc`'s preview, if it has a number (see the module doc). */
function numberWarning(doc: LifecycleDocument<SalesKind>): Phrase | undefined {
  if (doc.number === undefined || doc.number.trim() === "") return undefined;
  if (doc.kind !== "invoice") return NUMBER_MAY_RETURN;
  const { sent } = doc.dto;
  return sent === undefined ? INVOICE_NUMBER_GAP : invoiceSentGap(sent.date);
}

/** `sevdesk_document_delete_draft`: deletes a draft invoice, credit note or order. */
export const documentDeleteDraftTool = defineWriteTool({
  name: "sevdesk_document_delete_draft",
  title: "Delete a draft invoice, credit note or order",
  description:
    "Delete a draft invoice (Rechnungsentwurf), credit note (Gutschrift) or order (Angebot, " +
    "Auftragsbestätigung, Lieferschein) with its positions, e.g. one created by mistake, for the " +
    "wrong customer, or a duplicate. Only drafts (status 100); a finalized invoice is cancelled " +
    "(sevdesk_invoice_cancel) or corrected with a credit note, never deleted. Recurring invoice " +
    "templates (Abo-Rechnung) are not deleted here. Deleting a draft with a number can leave a " +
    "gap in the number range: sevDesk hands the number out again only if it was the last one, " +
    "and an invoice draft with a number may be an issued invoice reset to draft, which is " +
    "cancelled instead; the preview warns. Cannot be undone. Commit tier: asks a human to " +
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
    const number = numberWarning(doc);
    const warnings = [IRREVERSIBLE, ...(number === undefined ? [] : [number])];
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
