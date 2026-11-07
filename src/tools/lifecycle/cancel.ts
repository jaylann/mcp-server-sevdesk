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
import { readLifecycleDocument } from "../../domain/lifecycle/documents.js";
import { documentFacts, documentTitle, formatMoney } from "../../domain/lifecycle/preview.js";
import { assertCancellable } from "../../domain/lifecycle/transitions.js";
import { money, negate } from "../../domain/money.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { parseUpstream, zId } from "../../sevdesk/schema.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { COMMIT_ANNOTATIONS, documentObject, idInput, readBack } from "./shared.js";

const createdSchema = z.object({ id: zId });

/** The id of the cancellation invoice in sevDesk's answer, or `undefined` when it has none. */
function cancellationId(payload: unknown): number | undefined {
  try {
    return parseUpstream(
      createdSchema,
      expectSingle(payload, "cancellation invoice"),
      "a cancellation invoice",
    ).id;
  } catch (error) {
    if (error instanceof SevdeskError) return undefined;
    throw error;
  }
}

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
  prepare: async (args, ctx) => {
    const doc = await readLifecycleDocument(ctx.client, "invoice", args.id, ctx.signal);
    assertCancellable(doc);
    const gross = doc.totals.gross;
    const offset =
      gross === undefined
        ? ""
        : ` over ${formatMoney(money(negate(gross.amount), gross.currency))}`;
    return {
      preview: {
        action:
          `Cancel ${documentTitle(doc)} (Storno): sevDesk creates a cancellation invoice ` +
          `(Stornorechnung, SR)${offset} that offsets it.`,
        facts: documentFacts(doc),
        warnings: [
          "sevDesk creates a new cancellation invoice with the negated amounts, already marked " +
            "as paid. Both invoices stay in the books; the cancellation cannot be undone.",
          "The original invoice then shows status paid (1000) with nothing paid: sevDesk has no " +
            '"cancelled" status.',
          "If the customer already received the invoice, send them the cancellation invoice too.",
        ],
        irreversible: true,
      },
      state: {},
    };
  },
  execute: async (args, _plan, ctx) => {
    const payload = await ctx.client.request({
      method: "POST",
      path: sevdeskPath("Invoice", args.id, "cancelInvoice"),
      signal: ctx.signal,
    });
    const original = documentObject("invoice", args.id);
    const createdId = cancellationId(payload);
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
