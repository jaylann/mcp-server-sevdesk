/**
 * `sevdesk_invoice_cancel`: cancel an open, unpaid invoice (Storno) with
 * `POST /Invoice/{id}/cancelInvoice` (empty body). sevDesk answers 201 with the new cancellation
 * invoice (type SR, negated sums, status 1000, `origin` = the original), wrapped in `objects`
 * (recorded: jernoxit/sevdesk-rs `tests/fixtures/write_invoice_cancel.json`). The original keeps
 * status 1000 with nothing paid (spec/deviations.md D-037). sevDesk refuses drafts (code 423, in an
 * HTTP 200 error body), partially paid invoices (code 390), invoices already cancelled (421) and
 * invoices a credit note refers to (170); the first two are refused here before sending.
 */
import { z } from "zod";

import { invoiceDetailSchema } from "../../domain/invoices.js";
import { cancelInvoice } from "../../domain/lifecycle/actions.js";
import { readLifecycleDocument } from "../../domain/lifecycle/documents.js";
import { documentFacts, documentTitle, formatMoney } from "../../domain/lifecycle/preview.js";
import { assertCancellable } from "../../domain/lifecycle/transitions.js";
import { money, negate } from "../../domain/money.js";
import { bothPreviews, type Phrase, phrase } from "../../domain/preview-text.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { COMMIT_ANNOTATIONS, documentObject, idInput, readBack } from "./shared.js";

const CANCEL_WARNINGS: readonly Phrase[] = [
  phrase(
    "sevDesk creates a new cancellation invoice with the negated amounts, already marked as " +
      "paid. Both invoices stay in the books; the cancellation cannot be undone.",
    "sevDesk erstellt eine neue Stornorechnung mit denselben Beträgen mit umgekehrtem " +
      "Vorzeichen, die bereits als bezahlt markiert ist. Beide Rechnungen bleiben in der " +
      "Buchhaltung; das Storno lässt sich nicht rückgängig machen.",
  ),
  phrase(
    "The original invoice then shows status paid (1000) with nothing paid: sevDesk has no " +
      '"cancelled" status.',
    "Die ursprüngliche Rechnung zeigt danach den Status „Bezahlt“ (1000), obwohl nichts " +
      "bezahlt wurde: sevDesk kennt keinen Status „Storniert“.",
  ),
  phrase(
    "If the customer already received the invoice, send them the cancellation invoice too.",
    "Hat der Kunde die Rechnung bereits erhalten, senden Sie ihm auch die Stornorechnung.",
  ),
];

export const invoiceCancelTool = defineWriteTool({
  name: "sevdesk_invoice_cancel",
  title: "Cancel a sevDesk invoice",
  description:
    "Cancel an invoice (Rechnung stornieren, Storno): sevDesk creates a cancellation invoice " +
    "(Stornorechnung, type SR) with the negated amounts, already marked as paid, that offsets " +
    "the original; both stay in the books. Only open, unpaid invoices of type RE, AR, TR or ER " +
    "(not drafts, reminders or cancellations); for a paid or partially paid invoice create a " +
    "credit note with sevdesk_credit_note_create_from_invoice. Commit tier: asks a human to " +
    "confirm the preview; dryRun only previews. Cannot be undone. Returns both invoices; send " +
    "the cancellation to the customer with sevdesk_invoice_send_email (its id).",
  toolset: "invoices",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({ id: idInput("invoice"), ...dryRunInputShape }),
  output: z.object({
    invoice: invoiceDetailSchema.describe("The cancelled invoice, read back."),
    cancellationInvoice: invoiceDetailSchema.describe("The new cancellation invoice (SR)."),
    cancellationInvoiceId: z.number().int().describe("Id of the cancellation invoice."),
  }),
  // Serialized with other calls on the same record (see WriteToolDefinition.locks).
  locks: (args) => [ACCOUNT_BOOKINGS, documentObject("invoice", args.id)],
  prepare: async (args, ctx) => {
    const doc = await readLifecycleDocument(ctx.client, "invoice", args.id, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    assertCancellable(doc);
    const gross = doc.totals.gross;
    const offset = gross === undefined ? undefined : money(negate(gross.amount), gross.currency);
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `${documentTitle(doc, lang)} stornieren: sevDesk erstellt eine Stornorechnung (SR)` +
              `${offset === undefined ? "" : ` über ${formatMoney(offset, lang)}`}, die sie ` +
              "ausgleicht."
            : `Cancel ${documentTitle(doc)} (Storno): sevDesk creates a cancellation invoice ` +
              `(Stornorechnung, SR)${offset === undefined ? "" : ` over ${formatMoney(offset)}`} ` +
              "that offsets it.",
        facts: documentFacts(doc, lang),
        warnings: CANCEL_WARNINGS.map((warning) => warning[lang]),
        irreversible: true,
      })),
      state: {},
    };
  },
  execute: async (args, _plan, ctx) => {
    const createdId = await cancelInvoice(ctx.client, args.id, ctx.signal);
    const original = documentObject("invoice", args.id);
    if (createdId === undefined) {
      throw new SevdeskError({
        kind: "unexpected_response",
        message:
          `sevDesk accepted the cancellation of invoice ${String(args.id)}, but its answer did ` +
          `not name the cancellation invoice. Do not cancel again: check the invoice with ` +
          `sevdesk_invoice_get and find the cancellation with sevdesk_invoices_list (type ` +
          `cancellation).`,
        completedWrites: [original],
      });
    }
    const created = documentObject("invoice", createdId);
    const after = await readBack(ctx, "invoice", args.id, [original, created]);
    const cancellation = await readBack(ctx, "invoice", createdId, [original, created]);
    return {
      data: {
        invoice: after.dto,
        cancellationInvoice: cancellation.dto,
        cancellationInvoiceId: createdId,
      },
      summary:
        `Invoice ${String(args.id)} cancelled by cancellation invoice ${String(createdId)} ` +
        `(status ${cancellation.statusLabel}).`,
      affected: [original, created],
    };
  },
});
