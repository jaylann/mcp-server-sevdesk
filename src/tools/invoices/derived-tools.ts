import type { AnyToolDefinition } from "../types.js";
import { invoiceFromOrderTool } from "./from-order.js";
import { invoiceReminderTool } from "./reminder.js";

/**
 * Derived documents of the invoices toolset: a dunning reminder from an invoice, an invoice from
 * an order (M3 master-data work).
 */
export const INVOICE_DERIVED_TOOLS: readonly AnyToolDefinition[] = [
  invoiceReminderTool,
  invoiceFromOrderTool,
];
