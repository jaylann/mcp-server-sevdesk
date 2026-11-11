import { z } from "zod";

import {
  executeInvoiceDraft,
  invoiceUpdateInputShape,
  prepareInvoiceUpdate,
} from "../../domain/drafts/invoice.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { invoiceDraftOutput, invoiceDraftToolOutput } from "./draft-output.js";

/** `sevdesk_invoice_update_draft`: change a draft invoice; given positions replace all. */
export const invoiceUpdateDraftTool = defineWriteTool({
  name: "sevdesk_invoice_update_draft",
  title: "Update a draft invoice",
  description:
    "Change a draft invoice (Rechnungsentwurf, status draft, type RE). Tier write. Only the " +
    "fields you give change; everything else keeps its stored value. positions, when given, " +
    "replace ALL stored positions in one request; leave them out to keep the positions. " +
    "Changing priceMode needs the positions too (stored prices would be re-read), and a new " +
    "tax rule must allow every stored rate and fit the account's VAT regulation (regular or " +
    "Kleinunternehmer). A new contactId also takes that contact's invoice " +
    "address unless you give an address. Open, paid or enshrined (festgeschrieben) invoices " +
    "cannot be changed: reset an open one to a draft with sevdesk_invoice_reset first. dryRun " +
    "shows the changes without saving. Before: sevdesk_invoice_get. After: sevdesk_invoice_pdf, " +
    "sevdesk_invoice_finalize.",
  toolset: "invoices",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({ ...invoiceUpdateInputShape, ...dryRunInputShape }),
  output: invoiceDraftOutput,
  // Serialized with other calls on the same record (see WriteToolDefinition.locks).
  locks: (args) => [{ objectName: "Invoice", id: String(args.id) }],
  prepare: (args, ctx) =>
    prepareInvoiceUpdate(ctx.client, args, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (_args, plan, ctx) =>
    invoiceDraftToolOutput(
      await executeInvoiceDraft(ctx.client, plan.state, ctx.signal),
      "Updated",
    ),
});
