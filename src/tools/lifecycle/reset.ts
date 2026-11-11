/**
 * `sevdesk_{invoice,credit_note,voucher}_reset`: take a document back one step, `to: "open"`
 * (`PUT …/resetToOpen`: unlinks every payment) or `to: "draft"` (`PUT …/resetToDraft`: open →
 * draft). No body. What happens to payments (jernoxit/sevdesk-rs, measured; firsttris/haben): the
 * linked transactions go back to status 100 (created), their log entries are deleted, `paidAmount`
 * returns to 0; there is no counter-booking. sevDesk refuses `resetToOpen` when a payment
 * transaction is enshrined (422/322 "Already enshrined by payment") and `resetToDraft` on an
 * enshrined document (422/322). Unlike the spec says, `resetToOpen` works on a paid, enshrined
 * invoice whose transactions are not enshrined, so that case is not refused here. Vouchers use the
 * same endpoints with their own codes (open 100, draft 50; spec `voucherResetToOpen`,
 * `voucherResetToDraft`); their behavior with payments is assumed to match (not recorded).
 */
import { z } from "zod";

import {
  KINDS,
  type LifecycleDocument,
  type PaymentKind,
  readLifecycleDocument,
  statusOf,
} from "../../domain/lifecycle/documents.js";
import {
  documentFacts,
  documentTitle,
  KIND_DE,
  statusName,
} from "../../domain/lifecycle/preview.js";
import {
  assertResettable,
  RESET_TARGETS,
  type ResetTarget,
} from "../../domain/lifecycle/transitions.js";
import { bothPreviews, type Phrase, phrase } from "../../domain/preview-text.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS } from "../types.js";
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

const DESCRIPTIONS: Readonly<Record<PaymentKind, string>> = {
  invoice:
    'Reset an invoice one step back. to "open" (resetToOpen): a paid or partially paid ' +
    "invoice becomes open again and every booked payment is unlinked (bank transactions return " +
    'to unbooked; no counter-booking). to "draft" (resetToDraft): an open invoice without ' +
    "payments becomes a draft again and can be edited (sevdesk_invoice_update_draft); not for " +
    "enshrined (festgeschrieben) invoices. For a paid invoice reset to open first, then to " +
    "draft. Changing an invoice the customer already received is not allowed bookkeeping: " +
    "prefer sevdesk_invoice_cancel (Storno) or a credit note then. Not for cancellations (SR) " +
    "or recurring templates. Commit tier: asks a human to confirm the preview; dryRun only " +
    "previews.",
  creditNote:
    'Reset a credit note one step back. to "open" (resetToOpen): a paid or partially paid ' +
    "credit note becomes open again and every booked payout is unlinked (bank transactions " +
    'return to unbooked; no counter-booking). to "draft" (resetToDraft): an open credit note ' +
    "without payouts becomes a draft again; not for enshrined (festgeschrieben) credit notes. " +
    "For a paid credit note reset to open first, then to draft. Commit tier: asks a human to " +
    "confirm the preview; dryRun only previews.",
  voucher:
    'Reset a voucher (Beleg) one step back. to "open" (resetToOpen): a paid or partially paid ' +
    "voucher becomes open (100) again and every booked payment is unlinked (bank transactions " +
    'return to unbooked; no counter-booking). to "draft" (resetToDraft): an open voucher without ' +
    "payments becomes a draft (50) again and can be changed with sevdesk_voucher_update_draft " +
    "or deleted with sevdesk_voucher_delete_draft; not for enshrined (festgeschrieben) " +
    "vouchers. For a paid voucher reset to open first, then to draft. Commit tier: asks a human " +
    "to confirm the preview; dryRun only previews.",
};

const ENDPOINT: Readonly<Record<ResetTarget, string>> = {
  open: "resetToOpen",
  draft: "resetToDraft",
};

function resetWarnings(doc: LifecycleDocument<PaymentKind>, to: ResetTarget): Phrase[] {
  const noun = KINDS[doc.kind].noun;
  const german = KIND_DE[doc.kind];
  if (to === "open") {
    const warnings = [
      phrase(
        `Every payment booked on this ${noun} is taken back: linked bank transactions are ` +
          "unlinked from it and return to unbooked (status 100), or to partly linked (status " +
          "200) while they still pay other documents (split payments, recorded), and the paid " +
          "amount goes back to 0. sevDesk makes no counter-booking. Transactions sevDesk " +
          "created itself for payments on offline accounts are deleted (recorded); cash " +
          "registers (Kasse) were not measured, so check them afterwards.",
        `Jede auf ${german.thisOneDative} gebuchte Zahlung wird zurückgenommen: Verknüpfte ` +
          "Kontoumsätze werden davon gelöst und gelten wieder als ungebucht (Status 100) oder, " +
          "solange sie noch andere Dokumente bezahlen (Sammelzahlungen), als teilweise " +
          "verknüpft (Status 200); der bezahlte Betrag geht auf 0 zurück. sevDesk erstellt " +
          "keine Gegenbuchung. Umsätze, die sevDesk für Zahlungen auf Offline-Konten selbst " +
          "angelegt hat, werden gelöscht; für Kassen wurde das nicht geprüft, kontrollieren Sie " +
          "diese daher anschließend.",
      ),
      phrase(
        "sevDesk refuses the reset if one of the payment transactions is enshrined.",
        "sevDesk lehnt das Zurücksetzen ab, wenn einer der Zahlungsumsätze festgeschrieben ist.",
      ),
    ];
    if (doc.enshrined) {
      warnings.push(
        phrase(
          `The ${noun} is enshrined: sevDesk has allowed this reset while the payment ` +
            "transactions were not enshrined, though its documentation says it never does, so " +
            "it may refuse.",
          `${capitalize(german.nominative)} ist festgeschrieben: sevDesk hat dieses ` +
            "Zurücksetzen bisher zugelassen, solange die Zahlungsumsätze nicht festgeschrieben " +
            "waren, obwohl die Dokumentation es ausschließt; es kann also abgelehnt werden.",
        ),
      );
    }
    return warnings;
  }
  if (doc.kind === "voucher") {
    return [
      phrase(
        "The voucher stops being booked and can be changed again " +
          "(sevdesk_voucher_update_draft); it has to be finalized again afterwards " +
          "(sevdesk_voucher_finalize).",
        "Der Beleg ist dann nicht mehr gebucht und kann wieder geändert werden " +
          "(sevdesk_voucher_update_draft); danach muss er erneut fertiggestellt werden " +
          "(sevdesk_voucher_finalize).",
      ),
    ];
  }
  return [
    phrase(
      `The ${noun} stops being binding and booked and can be edited again; it has to be ` +
        "finalized again afterwards.",
      `${capitalize(german.nominative)} ist dann nicht mehr bindend und nicht mehr gebucht und ` +
        "kann wieder bearbeitet werden; danach muss sie erneut fertiggestellt werden.",
    ),
    doc.kind === "invoice"
      ? phrase(
          "Changing an invoice the customer already received is not an allowed bookkeeping " +
            "process (sevDesk's documentation). If it was sent, cancel it " +
            "(sevdesk_invoice_cancel) or issue a credit note instead.",
          "Eine Rechnung zu ändern, die der Kunde bereits erhalten hat, ist kein zulässiger " +
            "Buchhaltungsvorgang (Dokumentation von sevDesk). Wurde sie bereits versendet, " +
            "stornieren Sie sie stattdessen (sevdesk_invoice_cancel) oder stellen Sie eine " +
            "Gutschrift aus.",
        )
      : phrase(
          "Changing a credit note the customer already received is not an allowed bookkeeping " +
            "process; if it was sent, issue a new document instead.",
          "Eine Gutschrift zu ändern, die der Kunde bereits erhalten hat, ist kein zulässiger " +
            "Buchhaltungsvorgang; wurde sie bereits versendet, stellen Sie stattdessen ein " +
            "neues Dokument aus.",
        ),
  ];
}

/** Builds the reset tool of invoices, credit notes or vouchers. */
export function resetTool(kind: PaymentKind) {
  const info = KINDS[kind];
  const names = KIND_TOOLS[kind];
  return defineWriteTool({
    name: `${info.toolPrefix}_reset`,
    title: `Reset a sevDesk ${names.title}`,
    description: DESCRIPTIONS[kind],
    toolset: names.toolset,
    tier: "commit",
    annotations: COMMIT_ANNOTATIONS,
    input: z.strictObject({
      id: idInput(kind),
      to: z
        .enum(RESET_TARGETS)
        .describe(
          "open: unlink all payments of a paid or partially paid document (resetToOpen). " +
            "draft: turn an open document without payments back into a draft (resetToDraft).",
        ),
      ...dryRunInputShape,
    }),
    output: documentOutputSchema(kind),
    // Serialized with other calls on the same record (see WriteToolDefinition.locks).
    locks: (args) => [ACCOUNT_BOOKINGS, documentObject(kind, args.id)],
    prepare: async (args, ctx) => {
      const doc = await readLifecycleDocument(ctx.client, kind, args.id, ctx.signal);
      assertResettable(doc, args.to);
      const codes = statusOf(doc);
      const warnings = resetWarnings(doc, args.to);
      const action =
        args.to === "open"
          ? phrase(
              `Reset ${documentTitle(doc)} to open (${doc.statusLabel} → open ` +
                `${String(codes.open)}) and unlink all its payments.`,
              `${documentTitle(doc, "de")} auf offen zurücksetzen (${statusName(doc, "de")} → ` +
                `offen ${String(codes.open)}) und alle Zahlungen davon lösen.`,
            )
          : phrase(
              `Reset ${documentTitle(doc)} to draft (open ${String(codes.open)} → draft ` +
                `${String(codes.draft)}).`,
              `${documentTitle(doc, "de")} auf Entwurf zurücksetzen (offen ` +
                `${String(codes.open)} → Entwurf ${String(codes.draft)}).`,
            );
      return {
        ...bothPreviews((lang) => ({
          action: action[lang],
          facts: documentFacts(doc, lang),
          warnings: warnings.map((warning) => warning[lang]),
          irreversible: false,
        })),
        state: {},
      };
    },
    execute: async (args, _plan, ctx) => {
      await ctx.client.request({
        method: "PUT",
        path: sevdeskPath(info.objectName, args.id, ENDPOINT[args.to]),
        signal: ctx.signal,
      });
      const changed = documentObject(kind, args.id);
      const after = await readBack(ctx, kind, args.id, [changed]);
      return {
        data: documentOutput(kind, after.dto),
        summary:
          `${capitalize(info.noun)} ${String(args.id)} reset to ${args.to}: status ` +
          `${after.statusLabel} (${String(after.status)}).`,
        affected: [changed],
      };
    },
  });
}
