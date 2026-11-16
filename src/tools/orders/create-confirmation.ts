/**
 * `sevdesk_order_create_confirmation`: an order confirmation (Auftragsbestätigung, AB) draft from
 * an offer with `POST /Order/Factory/createContractNoteFromOrder` (spec/deviations.md D-107).
 *
 * Commit tier although it creates a draft: sevDesk marks the offer as accepted (500) in the same
 * request, which is the binding step `sevdesk_order_set_offer_status` asks a human for too. The
 * preview shows the offer with its stored texts and positions (what the confirmation takes over),
 * and the approval is bound to that stored content (`readDocumentContent`), like finalize.
 */
import { z } from "zod";

import { idList } from "../../domain/derived-documents.js";
import { documentRef, readLifecycleDocument } from "../../domain/lifecycle/documents.js";
import { assertConfirmable, refuse } from "../../domain/lifecycle/transitions.js";
import {
  createOrderFromOrder,
  derivedOrderState,
  findOrdersFrom,
} from "../../domain/order-follow-ups.js";
import {
  bothPreviews,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../../domain/preview-text.js";
import { defineWriteTool } from "../define-tool.js";
import { COMMIT_ANNOTATIONS, documentContent, documentObject } from "../lifecycle/shared.js";
import { dryRunInputShape } from "../write-input.js";
import {
  allowDuplicateInput,
  derivedOrderData,
  derivedOrderOutput,
  sourceOrderInput,
} from "./follow-up-output.js";

/** At most this many earlier confirmations are named in a warning. */
const NAMED_MAX = 5;

/** "offer AN-1001", "offer 3001 (no number yet)"; German with its article for "aus dem …". */
function offerTitle(
  doc: { readonly id: number; readonly number: string | undefined },
  lang: PreviewLanguage,
): string {
  if (lang === "de") {
    return doc.number === undefined
      ? `dem Angebot ${String(doc.id)} (noch ohne Nummer)`
      : `dem Angebot ${doc.number}`;
  }
  return doc.number === undefined
    ? `offer ${String(doc.id)} (no number yet)`
    : `offer ${doc.number}`;
}

/** `idList` in German: "Auftrag 3101, Auftrag 3102 und 2 weitere". */
function germanIdList(list: readonly number[]): string {
  const shown = list.slice(0, NAMED_MAX).map((id) => `Auftrag ${String(id)}`);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} und ${String(rest)} weitere` : shown.join(", ");
}

const ACCEPTS: Phrase = phrase(
  "sevDesk marks the offer as accepted (status 500) in the same request: that is the binding " +
    "step of this action. If that was not meant, set the offer back with " +
    'sevdesk_order_set_offer_status (action "reopen").',
  "sevDesk markiert das Angebot in derselben Anfrage als angenommen (Status 500): Das ist der " +
    "bindende Schritt dieser Aktion. War das nicht gewollt, setze das Angebot mit " +
    "sevdesk_order_set_offer_status (Aktion „reopen“) zurück.",
);

const STAYS_ACCEPTED: Phrase = phrase(
  "The offer is accepted already (status 500) and stays so.",
  "Das Angebot ist bereits angenommen (Status 500) und bleibt es.",
);

const DRAFT: Phrase = phrase(
  "The confirmation is created as a draft (Entwurf) with the offer's contact, texts and " +
    "positions as listed here; check it with sevdesk_order_get and finalize it with " +
    "sevdesk_order_finalize.",
  "Die Auftragsbestätigung wird als Entwurf mit Kontakt, Texten und Positionen des Angebots " +
    "erstellt, wie hier aufgeführt; prüfe sie mit sevdesk_order_get und stelle sie mit " +
    "sevdesk_order_finalize fertig.",
);

const NUMBER: Phrase = phrase(
  "sevDesk gives the confirmation the next number of the AB range without moving its counter, " +
    "so another confirmation may carry the same number; the result names any it finds.",
  "sevDesk gibt der Auftragsbestätigung die nächste Nummer des AB-Nummernkreises, ohne den " +
    "Zähler weiterzuschalten; eine andere Auftragsbestätigung kann daher dieselbe Nummer " +
    "tragen. Das Ergebnis nennt solche, die es findet.",
);

const TRUNCATED: Phrase = phrase(
  "Not every order could be checked for an earlier confirmation from this offer.",
  "Nicht alle Aufträge konnten auf eine frühere Auftragsbestätigung aus diesem Angebot geprüft " +
    "werden.",
);

export const orderCreateConfirmationTool = defineWriteTool({
  name: "sevdesk_order_create_confirmation",
  title: "Create an order confirmation from a sevDesk offer",
  description:
    "Create an order confirmation (Auftragsbestätigung, AB) draft from an offer (Angebot, AN) " +
    "with its contact, texts and positions. sevDesk marks the offer as accepted (angenommen, " +
    "500) in the same request, so this is commit tier: a human confirms the preview first; " +
    "dryRun only previews. Only sent (200) or already accepted (500) offers: not drafts (send " +
    "them first) and not rejected offers (reopen them first with " +
    "sevdesk_order_set_offer_status). Refuses when a confirmation from the offer exists " +
    "(allowDuplicate overrides). sevDesk gives it the next AB number without moving its " +
    "counter; the result names other confirmations with the same number. Next: " +
    "sevdesk_order_get, sevdesk_order_finalize, sevdesk_order_create_delivery_note, " +
    "sevdesk_invoice_create_from_order.",
  toolset: "orders",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({
    orderId: sourceOrderInput("The offer's order"),
    allowDuplicate: allowDuplicateInput("an order confirmation"),
    ...dryRunInputShape,
  }),
  output: derivedOrderOutput,
  // The offer: its status and the "no confirmation from it yet" check are read, then the
  // confirmation is created and the offer accepted.
  locks: (args) => [documentObject("order", args.orderId)],
  prepare: async (args, ctx) => {
    const doc = await readLifecycleDocument(ctx.client, "order", args.orderId, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    const { accepts } = assertConfirmable(doc);
    const existing = await findOrdersFrom(ctx.client, doc, "confirmation", false, ctx.signal);
    if (existing.ids.length > 0 && !args.allowDuplicate) {
      refuse(
        `An order confirmation from ${documentRef(doc)} exists already: ` +
          `${idList("order", existing.ids)}. Check it with sevdesk_order_get, or call again with ` +
          "allowDuplicate: true to create another one.",
      );
    }
    const content = await documentContent(ctx, doc);
    const warnings: Phrase[] = [accepts ? ACCEPTS : STAYS_ACCEPTED, DRAFT, NUMBER];
    if (existing.ids.length > 0) {
      warnings.push(
        phrase(
          `Creating another one (allowDuplicate): ${idList("order", existing.ids)} was created ` +
            "from this offer already.",
          `Es wird trotzdem eine weitere erstellt (allowDuplicate): Aus diesem Angebot wurde ` +
            `bereits ${germanIdList(existing.ids)} erstellt.`,
        ),
      );
    }
    if (existing.truncated) warnings.push(TRUNCATED);
    warnings.push(content.notShown);
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `Aus ${offerTitle(doc, lang)} eine Auftragsbestätigung (AB) als Entwurf erstellen` +
              (accepts
                ? "; sevDesk markiert das Angebot dabei als angenommen (versendet 200 → " +
                  "angenommen 500)."
                : "; das Angebot bleibt angenommen (500).")
            : `Create an order confirmation (Auftragsbestätigung, AB) draft from ` +
              offerTitle(doc, lang) +
              (accepts
                ? "; sevDesk marks the offer as accepted (sent 200 → accepted 500)."
                : "; the offer stays accepted (500)."),
        facts: [
          ...content.identity(lang),
          {
            label: lang === "de" ? "Wird erstellt" : "Creates",
            value:
              lang === "de"
                ? "Auftragsbestätigung (AB) als Entwurf"
                : "order confirmation (Auftragsbestätigung, AB) as a draft",
          },
          ...content.printed(lang),
        ],
        warnings: warnings.map((warning) => warning[lang]),
        irreversible: false,
      })),
      binding: content.binding,
      state: derivedOrderState("confirmation", doc),
    };
  },
  execute: async (_args, plan, ctx) => {
    const result = await createOrderFromOrder(ctx.client, plan.state, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    const offerId = plan.state.sourceId;
    const offerStatus = result.source?.status;
    // The preview promised an accepted offer: say so when sevDesk did otherwise.
    const extra =
      offerStatus === undefined
        ? [
            `Offer ${String(offerId)} could not be read again; check its status with sevdesk_order_get.`,
          ]
        : offerStatus === 500
          ? []
          : [
              `sevDesk did not mark offer ${String(offerId)} as accepted: it has status ` +
                `${String(offerStatus)}. Check it with sevdesk_order_get.`,
            ];
    return {
      data: derivedOrderData(result, offerId, extra),
      summary:
        `Created order confirmation draft ${String(result.details.order.id)} from offer ` +
        String(offerId) +
        (offerStatus === undefined ? "." : `; the offer has status ${String(offerStatus)}.`) +
        " Finalize it with sevdesk_order_finalize.",
      affected: result.affected,
    };
  },
});
