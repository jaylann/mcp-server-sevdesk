import type { AnyToolDefinition } from "../types.js";
import { invoiceGetTool } from "./get.js";
import { invoicesListTool } from "./list.js";

/** Tools of the `invoices` toolset (Rechnungen). */
export const INVOICE_TOOLS: readonly AnyToolDefinition[] = [invoicesListTool, invoiceGetTool];
