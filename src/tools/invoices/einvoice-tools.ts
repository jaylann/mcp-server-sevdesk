import type { AnyToolDefinition } from "../types.js";
import { invoiceEInvoicePreflightTool } from "./einvoice-preflight.js";

/** E-invoice tools on outgoing invoices: the e-invoice preflight. */
export const INVOICE_EINVOICE_TOOLS: readonly AnyToolDefinition[] = [invoiceEInvoicePreflightTool];
