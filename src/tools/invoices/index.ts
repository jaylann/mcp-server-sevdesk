import type { AnyToolDefinition } from "../types.js";
import { INVOICE_DERIVED_TOOLS } from "./derived-tools.js";
import { INVOICE_DRAFT_TOOLS } from "./draft-tools.js";
import { INVOICE_EINVOICE_TOOLS } from "./einvoice-tools.js";
import { invoiceGetTool } from "./get.js";
import { INVOICE_LIFECYCLE_TOOLS } from "./lifecycle-tools.js";
import { invoicesListTool } from "./list.js";

/** Tools of the `invoices` toolset (Rechnungen). */
export const INVOICE_TOOLS: readonly AnyToolDefinition[] = [
  invoicesListTool,
  invoiceGetTool,
  ...INVOICE_DRAFT_TOOLS,
  ...INVOICE_LIFECYCLE_TOOLS,
  ...INVOICE_DERIVED_TOOLS,
  ...INVOICE_EINVOICE_TOOLS,
];
