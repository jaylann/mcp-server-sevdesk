/**
 * `sevdesk_order_set_offer_status`: record that the customer accepted (500) or rejected (300) an
 * offer, or set it back to sent (200), with `PUT /Order/{id}` and a body of only `{status}`
 * (spec/deviations.md D-108). Offers only, never drafts (sevDesk renumbers a draft on this
 * request); which change is allowed from which status is `assertOfferStatusChange`.
 *
 * Commit tier: an accepted offer is the customer's binding order, and a rejection ends it. The
 * preview shows the offer with its stored texts and positions, and the approval is bound to that
 * stored content (`readDocumentContent`), like the other lifecycle tools.
 */
import { z } from "zod";

import { orderStatusPayload, setOrderStatus } from "../../domain/lifecycle/actions.js";
import { readLifecycleDocument } from "../../domain/lifecycle/documents.js";
import {
  assertOfferStatusChange,
  OFFER_STATUS_ACTIONS,
  type OfferStatusAction,
  type OfferStatusTarget,
} from "../../domain/lifecycle/transitions.js";
import { bothPreviews, type Phrase, phrase } from "../../domain/preview-text.js";
import { defineWriteTool } from "../define-tool.js";
import {
  COMMIT_ANNOTATIONS,
  documentContent,
  documentObject,
  documentOutput,
  documentOutputSchema,
  idInput,
  readBack,
} from "../lifecycle/shared.js";
import { dryRunInputShape } from "../write-input.js";

/** The offer statuses in preview sentences. */
const STATUS_WORDS: Readonly<Record<number, Phrase>> = {
  200: phrase("sent", "versendet"),
  300: phrase("rejected", "abgelehnt"),
  500: phrase("accepted", "angenommen"),
};

function statusWord(code: number): Phrase {
  return STATUS_WORDS[code] ?? phrase(`status ${String(code)}`, `Status ${String(code)}`);
}

const CONSEQUENCES: Readonly<Record<OfferStatusAction, Phrase>> = {
  accept: phrase(
    "The offer is recorded as accepted by the customer (status 500); nothing is sent to " +
      "anyone. Next: sevdesk_order_create_confirmation or sevdesk_invoice_create_from_order. " +
      'It can be set back with action "reopen".',
    "Das Angebot wird als vom Kunden angenommen vermerkt (Status 500); an niemanden wird " +
      "etwas gesendet. Danach: sevdesk_order_create_confirmation oder " +
      "sevdesk_invoice_create_from_order. Mit der Aktion „reopen“ lässt es sich zurücksetzen.",
  ),
  reject: phrase(
    "The offer is recorded as rejected by the customer (status 300); nothing is sent to " +
      "anyone. No confirmation or invoice is created from a rejected offer until it is " +
      'reopened (action "reopen").',
    "Das Angebot wird als vom Kunden abgelehnt vermerkt (Status 300); an niemanden wird etwas " +
      "gesendet. Aus einem abgelehnten Angebot wird keine Auftragsbestätigung und keine " +
      "Rechnung erstellt, bis es wieder geöffnet wird (Aktion „reopen“).",
  ),
  reopen: phrase(
    "The offer goes back to sent (status 200), as if the customer had not answered yet. " +
      "Documents already created from it (order confirmations, invoices) stay as they are.",
    "Das Angebot geht zurück auf versendet (Status 200), als hätte der Kunde noch nicht " +
      "geantwortet. Bereits daraus erstellte Dokumente (Auftragsbestätigungen, Rechnungen) " +
      "bleiben unverändert.",
  ),
};

const ONLY_STATUS: Phrase = phrase(
  "sevDesk changes only the offer's status: the request carries nothing else.",
  "sevDesk ändert nur den Status des Angebots: Die Anfrage enthält nichts anderes.",
);

const VERBS: Readonly<Record<OfferStatusAction, string>> = {
  accept: "accepted",
  reject: "rejected",
  reopen: "reopened",
};

export const orderSetOfferStatusTool = defineWriteTool({
  name: "sevdesk_order_set_offer_status",
  title: "Accept, reject or reopen a sevDesk offer",
  description:
    "Record the customer's answer to an offer (Angebot, AN): action accept (angenommen, 500) " +
    "or reject (abgelehnt, 300), only for sent offers (200); action reopen sets an accepted or " +
    "rejected offer back to sent (200). Offers only: not drafts (send them first: sevDesk " +
    "would renumber a draft), not order confirmations or delivery notes. Sends nothing to the " +
    "customer. Commit tier: asks a human to confirm the preview; dryRun only previews. Next " +
    "for an accepted offer: sevdesk_order_create_confirmation or " +
    "sevdesk_invoice_create_from_order. To find open offers use sevdesk_orders_list (type " +
    "offer, status sent, a date range).",
  toolset: "orders",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({
    id: idInput("order"),
    action: z
      .enum(OFFER_STATUS_ACTIONS)
      .describe(
        "accept: the customer accepted (sent → accepted 500). reject: the customer declined " +
          "(sent → rejected 300). reopen: back to sent (200) from accepted or rejected.",
      ),
    ...dryRunInputShape,
  }),
  output: documentOutputSchema("order"),
  // Serialized with other calls on the same record (see WriteToolDefinition.locks).
  locks: (args) => [documentObject("order", args.id)],
  prepare: async (args, ctx) => {
    const doc = await readLifecycleDocument(ctx.client, "order", args.id, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    const target: OfferStatusTarget = assertOfferStatusChange(doc, args.action);
    const content = await documentContent(ctx, doc);
    const from = statusWord(doc.status);
    const to = statusWord(target);
    const warnings = [CONSEQUENCES[args.action], ONLY_STATUS, content.notShown, ...content.notes];
    return {
      ...bothPreviews((lang) => {
        // By id: the stored number is text this server did not write; the facts show it (#129).
        const title = String(doc.id);
        const change = `${from[lang]} ${String(doc.status)} → ${to[lang]} ${String(target)}`;
        const action =
          lang === "de"
            ? args.action === "reopen"
              ? `Angebot ${title} wieder öffnen (${change}).`
              : `Angebot ${title} als ${to.de} markieren (${change}).`
            : args.action === "reopen"
              ? `Reopen offer ${title} (${change}).`
              : `Mark offer ${title} as ${to.en} (${change}).`;
        return {
          action,
          facts: content.facts(lang),
          warnings: warnings.map((warning) => warning[lang]),
          irreversible: false,
        };
      }),
      binding: content.binding,
      state: { payload: orderStatusPayload(target) },
    };
  },
  execute: async (args, plan, ctx) => {
    await setOrderStatus(ctx.client, args.id, plan.state.payload, ctx.signal);
    const changed = documentObject("order", args.id);
    const after = await readBack(ctx, "order", args.id, [changed]);
    const target = plan.state.payload.status;
    // sevDesk answered without an error; when the offer still reads back otherwise, the summary
    // says so instead of claiming the change (like the read-back of the other lifecycle tools).
    const summary =
      after.status === target
        ? `Offer ${String(args.id)} ${VERBS[args.action]}: status ${after.statusLabel} ` +
          `(${String(after.status)}).`
        : `sevDesk accepted the request, but offer ${String(args.id)} reads back with status ` +
          `${after.statusLabel} (${String(after.status)}) instead of ${String(target)}. Check ` +
          "it with sevdesk_order_get before trying again.";
    return { data: documentOutput("order", after.dto), summary, affected: [changed] };
  },
});
