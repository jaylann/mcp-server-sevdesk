import { z } from "zod";

import {
  executeInvoiceDraft,
  invoiceCreateInputShape,
  prepareInvoiceCreate,
} from "../../domain/drafts/invoice.js";
import { defineWriteTool } from "../define-tool.js";
import { dryRunInputShape } from "../write-input.js";
import { invoiceDraftOutput, invoiceDraftToolOutput } from "./draft-output.js";

/** `sevdesk_invoice_create_draft`: a new draft invoice (Rechnungsentwurf) with positions. */
export const invoiceCreateDraftTool = defineWriteTool({
  name: "sevdesk_invoice_create_draft",
  title: "Create a draft invoice",
  description:
    "Create a draft invoice (Rechnungsentwurf, type RE) for a contact with its positions " +
    "(Positionen). Tier write: it only creates a draft. Nothing is sent to the customer, no " +
    "invoice number is assigned (sevDesk does that when the invoice is finalized) and nothing " +
    "is booked. Defaults: today's date, delivery date = invoice date, net prices, tax rule 1 " +
    "(Umsatzsteuerpflichtige Umsätze, rates 0/7/19 %), EUR, the contact's invoice address, and " +
    "the account's only user as contact person (several users: pass contactPersonId). Every " +
    "position's tax rate is checked against the tax rule before anything is sent; the preview " +
    "warns about a possible duplicate. dryRun previews without saving. Before: " +
    "sevdesk_contacts_search for contactId. After: sevdesk_invoice_update_draft to change it, " +
    "sevdesk_invoice_pdf to look at it, sevdesk_invoice_finalize to make it binding.",
  toolset: "invoices",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({ ...invoiceCreateInputShape, ...dryRunInputShape }),
  output: invoiceDraftOutput,
  prepare: (args, ctx) => prepareInvoiceCreate(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) =>
    invoiceDraftToolOutput(
      await executeInvoiceDraft(ctx.client, plan.state, ctx.signal),
      "Created",
    ),
});
