/**
 * `sevdesk_{invoice,credit_note,order}_finalize`: finalize a draft by marking it as sent
 * (`PUT /{Invoice|CreditNote|Order}/{id}/sendBy` with `sendDraft: false`). sevDesk then assigns the
 * final number and books the document (status 100 → 200); it sends nothing to anyone. Send types:
 * spec `invoiceSendBy` (`VPR` print, `VP` postal, `VM` mail, `VPDF` downloaded PDF); measured by
 * jernoxit/sevdesk-rs (`VPDF`, draft → 200 with a number, enshrined only when the account setting
 * "Automatische Festschreibung" is on).
 */
import { z } from "zod";

import { SENT_VIA, type SentVia } from "../../domain/document-positions.js";
import {
  finalizeDocument,
  type SendByPayload,
  sendByPayload,
} from "../../domain/lifecycle/actions.js";
import { KINDS, readLifecycleDocument, type SalesKind } from "../../domain/lifecycle/documents.js";
import { documentTitle } from "../../domain/lifecycle/preview.js";
import { assertFinalizable } from "../../domain/lifecycle/transitions.js";
import { bothPreviews, type Phrase, phrase } from "../../domain/preview-text.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import {
  capitalize,
  COMMIT_ANNOTATIONS,
  documentContent,
  documentObject,
  documentOutput,
  documentOutputSchema,
  idInput,
  KIND_TOOLS,
  readBack,
} from "./shared.js";

/** How the document was sent, as the preview words it. */
const SENT_VIA_TEXT: Readonly<Record<SentVia, Phrase>> = {
  pdf_download: phrase("as a downloaded PDF (VPDF)", "PDF-Download (VPDF)"),
  post: phrase("by post (VP)", "Post (VP)"),
  print: phrase("as printed (VPR)", "Ausdruck (VPR)"),
  email: phrase("by email outside sevDesk (VM)", "E-Mail außerhalb von sevDesk (VM)"),
};

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

/** That the document becomes binding, and how it can be corrected afterwards. */
const BINDING: Readonly<Record<SalesKind, Phrase>> = {
  invoice: phrase(
    "The invoice becomes legally binding: sevDesk assigns its final number and books it. " +
      "Afterwards it can only be corrected by a reset to draft (while not enshrined), a " +
      "cancellation (Storno) or a credit note.",
    "Die Rechnung wird rechtlich bindend: sevDesk vergibt ihre endgültige Nummer und bucht " +
      "sie. Danach lässt sie sich nur noch durch Zurücksetzen auf Entwurf (solange sie nicht " +
      "festgeschrieben ist), ein Storno oder eine Gutschrift korrigieren.",
  ),
  creditNote: phrase(
    "The credit note becomes legally binding: sevDesk books it under the number the draft " +
      "carries. Afterwards it can only be corrected by a reset to draft (while not enshrined), " +
      "or a new document.",
    "Die Gutschrift wird rechtlich bindend: sevDesk bucht sie unter der Nummer, die der " +
      "Entwurf trägt. Danach lässt sie sich nur noch durch Zurücksetzen auf Entwurf (solange " +
      "sie nicht festgeschrieben ist) oder ein neues Dokument korrigieren.",
  ),
  order: phrase(
    "The order is marked as sent (status 200) and sevDesk assigns its final number.",
    "Der Auftrag wird als versendet markiert (Status 200), und sevDesk vergibt seine " +
      "endgültige Nummer.",
  ),
};

/** Consequences of finalizing, per kind. */
function finalizeWarnings(kind: SalesKind): Phrase[] {
  const { toolPrefix } = KINDS[kind];
  const warnings = [
    BINDING[kind],
    phrase(
      `sevDesk sends nothing to the customer: this only records how the document was sent. To ` +
        `email it through sevDesk, use ${toolPrefix}_send_email instead.`,
      `sevDesk sendet nichts an den Kunden: Es wird nur vermerkt, wie das Dokument versendet ` +
        `wurde. Für den Versand per E-Mail über sevDesk gibt es stattdessen ` +
        `${toolPrefix}_send_email.`,
    ),
  ];
  if (kind !== "order") {
    warnings.push(
      phrase(
        'If the sevDesk account enshrines documents on completion (setting "Automatische ' +
          'Festschreibung"), it is also enshrined (festgeschrieben) and can never be changed or ' +
          "reset again.",
        "Schreibt das sevDesk-Konto Dokumente beim Abschließen automatisch fest (Einstellung " +
          "„Automatische Festschreibung“), wird das Dokument dabei auch festgeschrieben und " +
          "kann nie wieder geändert oder zurückgesetzt werden.",
      ),
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
    // Serialized with other calls on the same record (see WriteToolDefinition.locks).
    locks: (args) => [documentObject(kind, args.id)],
    prepare: async (args, ctx) => {
      const doc = await readLifecycleDocument(ctx.client, kind, args.id, ctx.signal);
      assertFinalizable(doc);
      const via: SentVia = args.sentVia ?? "pdf_download";
      const payload: SendByPayload = sendByPayload(via);
      // The stored texts, address and positions, and the binding over the same read: all of
      // it is writable without confirmation, so the human sees it here (review 2026-11, round 3).
      const content = await documentContent(ctx, doc);
      // Consequences first, then what the facts leave out, then notes on this document.
      const warnings = [...finalizeWarnings(kind), content.notShown];
      if (doc.number?.includes("%") === true) {
        warnings.push(
          phrase(
            "The document number still contains placeholders (%…%); check the number range in " +
              "sevDesk and the number after finalizing.",
            "Die Dokumentnummer enthält noch Platzhalter (%…%); prüfen Sie den Nummernkreis in " +
              "sevDesk und die Nummer nach dem Fertigstellen.",
          ),
        );
      }
      const sent = SENT_VIA_TEXT[via];
      return {
        ...bothPreviews((lang) => ({
          action:
            lang === "de"
              ? `${documentTitle(doc, lang)} fertigstellen: Entwurf → ` +
                `${kind === "order" ? "versendet" : "offen"}, als Versandart wird ` +
                `„${sent.de}“ vermerkt.`
              : `Finalize ${documentTitle(doc)}: draft → ${kind === "order" ? "sent" : "open"}, ` +
                `marked as sent ${sent.en}.`,
          facts: [
            ...content.identity(lang),
            {
              label: lang === "de" ? "Vermerkte Versandart" : "Marked as sent",
              value: sent[lang],
            },
            ...content.printed(lang),
          ],
          warnings: warnings.map((warning) => warning[lang]),
          irreversible: false,
        })),
        binding: content.binding,
        state: { payload },
      };
    },
    execute: async (args, plan, ctx) => {
      await finalizeDocument(ctx.client, kind, args.id, plan.state.payload, ctx.signal);
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
