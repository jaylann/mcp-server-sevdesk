import type { AnyToolDefinition } from "../types.js";
import { invoiceReminderTool } from "./reminder.js";

/** Documents derived from invoices, e.g. a dunning reminder (M3 master-data work). */
export const INVOICE_DERIVED_TOOLS: readonly AnyToolDefinition[] = [invoiceReminderTool];
