/**
 * `sevdesk_{invoice,credit_note,order}_finalize`: finalize a draft by marking it as sent
 * (`PUT /{Invoice|CreditNote|Order}/{id}/sendBy` with `sendDraft: false`). sevDesk then assigns the
 * final number and books the document (status 100 → 200); it sends nothing to anyone. Send types:
 * spec `invoiceSendBy` (`VPR` print, `VP` postal, `VM` mail, `VPDF` downloaded PDF); measured by
 * jernoxit/sevdesk-rs (`VPDF`, draft → 200 with a number, enshrined only when the account setting
 * "Automatische Festschreibung" is on).
 */
import { z } from "zod";

import { SEND_TYPE_CODES, SENT_VIA, type SentVia } from "../../domain/document-positions.js";
import { KINDS, readLifecycleDocument, type SalesKind } from "../../domain/lifecycle/documents.js";
import { documentFacts, documentTitle } from "../../domain/lifecycle/preview.js";
import { assertFinalizable } from "../../domain/lifecycle/transitions.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import {
  capitalize,
  COMMIT_ANNOTATIONS,
  documentObject,
  documentOutput,
  documentOutputSchema,
  idInput,
  KIND_TOOLS,
  readBack,
} from "./shared.js";

const SENT_VIA_TEXT: Readonly<Record<SentVia, string>> = {
  pdf_download: "as a downloaded PDF (VPDF)",
  post: "by post (VP)",
  print: "as printed (VPR)",
  email: "by email outside sevDesk (VM)",
};

const sendByPayloadSchema = z.strictObject({
  sendType: z.enum(["VPDF", "VP", "VPR", "VM"]),
  sendDraft: z.literal(false),
});

type SendByPayload = z.output<typeof sendByPayloadSchema>;

const DESCRIPTIONS: Readonly<Record<SalesKind, string>> = {
  invoice:
    "Finalize a draft invoice (Rechnung fertigstellen): sevDesk marks it as sent, assigns its " +
    "final invoice number and books it, so it becomes legally binding (draft 100 → open 200). " +
    "Nothing is sent to the customer: sentVia only records how you send it. To email it through " +
    "sevDesk use sevdesk_invoice_send_email instead (that finalizes too). Commit tier: asks a " +
    "human to confirm the shown preview; dryRun only previews. Drafts only (create one with " +
    "sevdesk_invoice_create_draft). Next: sevdesk_invoice_pdf, sevdesk_invoice_book_payment " +
    "(Zahlung buchen), sevdesk_invoice_enshrine (festschreiben).",
  creditNote:
    "Finalize a draft credit note (Gutschrift fertigstellen): sevDesk marks it as sent and books " +
    "it (draft 100 → open 200) under the number the draft carries. Nothing is sent to the " +
    "customer: sentVia only records how you send it. To email it through sevDesk use " +
    "sevdesk_credit_note_send_email instead. Commit tier: asks a human to confirm the shown " +
    "preview; dryRun only previews. Drafts with a number only (sevDesk can fail half-way on a " +
    "draft without one; sevdesk_credit_note_create_draft assigns one). Next: " +
    "sevdesk_credit_note_book_payment (Auszahlung buchen), sevdesk_credit_note_enshrine.",
  order:
    "Finalize a draft order (Angebot, Auftragsbestätigung or Lieferschein fertigstellen): " +
    "sevDesk marks it as sent and assigns its final number (draft 100 → sent 200). Nothing is " +
    "sent to the customer: sentVia only records how you send it. To email it through sevDesk " +
    "use sevdesk_order_send_email instead. Commit tier: asks a human to confirm the shown " +
    "preview; dryRun only previews. Drafts only (create one with sevdesk_order_create_draft). " +
    "Next: sevdesk_order_pdf, sevdesk_invoice_create_from_order.",
};

/** What sevDesk does to an invoice or credit note it finalizes. */
const BOOKS = {
  invoice: "assigns its final number and books it",
  creditNote: "books it under the number the draft carries",
} as const;

/** Consequences of finalizing, per kind. */
function finalizeWarnings(kind: SalesKind): string[] {
  const { toolPrefix } = KINDS[kind];
  const binding =
    kind === "order"
      ? "The order is marked as sent (status 200) and sevDesk assigns its final number."
      : `The ${KINDS[kind].noun} becomes legally binding: sevDesk ${BOOKS[kind]}. Afterwards ` +
        `it can only be corrected by a reset to draft (while not enshrined), ` +
        `${kind === "invoice" ? "a cancellation (Storno) or a credit note" : "or a new document"}.`;
  const warnings = [
    binding,
    `sevDesk sends nothing to the customer: this only records how the document was sent. To ` +
      `email it through sevDesk, use ${toolPrefix}_send_email instead.`,
  ];
  if (kind !== "order") {
    warnings.push(
      'If the sevDesk account enshrines documents on completion (setting "Automatische ' +
        'Festschreibung"), it is also enshrined (festgeschrieben) and can never be changed or ' +
        "reset again.",
    );
  }
  return warnings;
}

/** Builds the finalize tool of one document kind. */
export function finalizeTool(kind: SalesKind) {
  const info = KINDS[kind];
  const names = KIND_TOOLS[kind];
  return defineWriteTool({
    name: `${info.toolPrefix}_finalize`,
    title: `Finalize a sevDesk ${names.title}`,
    description: DESCRIPTIONS[kind],
    toolset: names.toolset,
    tier: "commit",
    annotations: COMMIT_ANNOTATIONS,
    input: z.strictObject({
      id: idInput(kind),
      sentVia: z
        .enum(SENT_VIA)
        .optional()
        .describe(
          "How the document is or was sent, recorded as its send type: pdf_download (VPDF, " +
            "default: PDF downloaded and sent your own way), post (VP, Briefversand), print " +
            "(VPR, printed and handed over), email (VM, emailed outside sevDesk).",
        ),
      ...dryRunInputShape,
    }),
    output: documentOutputSchema(kind),
    prepare: async (args, ctx) => {
      const doc = await readLifecycleDocument(ctx.client, kind, args.id, ctx.signal);
      assertFinalizable(doc);
      const via: SentVia = args.sentVia ?? "pdf_download";
      const payload: SendByPayload = sendByPayloadSchema.parse({
        sendType: SEND_TYPE_CODES[via],
        sendDraft: false,
      });
      const warnings = finalizeWarnings(kind);
      if (doc.number?.includes("%") === true) {
        warnings.push(
          "The document number still contains placeholders (%…%); check the number range in " +
            "sevDesk and the number after finalizing.",
        );
      }
      return {
        preview: {
          action:
            `Finalize ${documentTitle(doc)}: draft → ${kind === "order" ? "sent" : "open"}, ` +
            `marked as sent ${SENT_VIA_TEXT[via]}.`,
          facts: [...documentFacts(doc), { label: "Marked as sent", value: SENT_VIA_TEXT[via] }],
          warnings,
          irreversible: false,
        },
        state: { payload },
      };
    },
    execute: async (args, plan, ctx) => {
      await ctx.client.request({
        method: "PUT",
        path: sevdeskPath(info.objectName, args.id, "sendBy"),
        body: plan.state.payload,
        signal: ctx.signal,
      });
      const changed = documentObject(kind, args.id);
      const after = await readBack(ctx, kind, args.id, [changed]);
      return {
        data: documentOutput(kind, after.dto),
        summary:
          `${capitalize(info.noun)} ${String(args.id)} finalized: status ${after.statusLabel} ` +
          `(${String(after.status)}).`,
        affected: [changed],
      };
    },
  });
}
