import { z } from "zod";

import { preflightInvoice, preflightResultSchema } from "../../domain/einvoice/preflight.js";
import { defineTool } from "../define-tool.js";

/** `sevdesk_invoice_einvoice_preflight`: is an outgoing invoice ready to be an e-invoice? */
export const invoiceEInvoicePreflightTool = defineTool({
  name: "sevdesk_invoice_einvoice_preflight",
  title: "Check an invoice for e-invoice readiness",
  description:
    "Check whether an outgoing invoice (Rechnung) can go out as an e-invoice (E-Rechnung: " +
    "XRechnung / ZUGFeRD) before finalizing it: your company data (USt-IdNr./Steuernummer, " +
    "address, IBAN, BIC, e-mail, phone), the customer (name, address, country, e-mail, buyer " +
    "reference / Leitweg-ID for public authorities, USt-IdNr. for reverse charge and intra-EU " +
    "supplies), Leistungsdatum, Zahlungsziel, payment method, unit codes of the positions and " +
    "the tax rule (One-Stop-Shop rules 18–20 are not supported). For a finalized invoice it " +
    "also reads the XML sevDesk generated and checks it against EN 16931 rules. Read only. " +
    "Returns ready plus problems and warnings, each with the field and the tool that fixes it " +
    "(sevdesk_invoice_update_draft, sevdesk_contact_update). Before: sevdesk_invoice_get. " +
    "After: sevdesk_invoice_finalize.",
  toolset: "invoices",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Invoice id (not the invoice number), e.g. from sevdesk_invoices_list."),
  }),
  output: preflightResultSchema,
  handler: async (args, ctx) => {
    const result = await preflightInvoice(ctx.client, args.id, {
      cacheOwner: ctx.config,
      signal: ctx.signal,
    });
    const counts =
      `${String(result.problems.length)} problem(s), ` +
      `${String(result.warnings.length)} warning(s)`;
    const xml =
      result.xml.status === "checked"
        ? " sevDesk's XML was parsed and checked."
        : result.xml.status === "not_available"
          ? " sevDesk has no e-invoice XML for it."
          : "";
    return {
      data: result,
      // Status labels come from reference data; no sevDesk text.
      summary:
        `Invoice ${String(result.invoice.id)} (status ${result.invoice.status.label}) is ` +
        `${result.ready ? "ready" : "not ready"} for an e-invoice: ${counts}.${xml}`,
    };
  },
});
