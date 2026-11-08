import type { AnyToolDefinition } from "../types.js";
import { invoiceEInvoicePreflightTool } from "./einvoice-preflight.js";

/** E-invoice tools on outgoing invoices, M4: the e-invoice preflight. Owned by the m4-einvoice agent. */
export const INVOICE_EINVOICE_TOOLS: readonly AnyToolDefinition[] = [invoiceEInvoicePreflightTool];
