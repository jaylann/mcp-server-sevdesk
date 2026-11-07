import type { AnyToolDefinition } from "../types.js";
import { orderToInvoiceTool } from "./to-invoice.js";

/** Documents derived from orders, e.g. an invoice from an order (M3 master-data work). */
export const ORDER_DERIVED_TOOLS: readonly AnyToolDefinition[] = [orderToInvoiceTool];
