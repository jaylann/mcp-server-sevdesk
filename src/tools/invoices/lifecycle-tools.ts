import { bookPaymentTool } from "../lifecycle/book-payment.js";
import { invoiceCancelTool } from "../lifecycle/cancel.js";
import { enshrineTool } from "../lifecycle/enshrine.js";
import { finalizeTool } from "../lifecycle/finalize.js";
import { resetTool } from "../lifecycle/reset.js";
import { sendEmailTool } from "../lifecycle/send-email.js";
import type { AnyToolDefinition } from "../types.js";

/** Invoice lifecycle tools: finalize, send, book, cancel, enshrine, reset (M3 lifecycle work). */
export const INVOICE_LIFECYCLE_TOOLS: readonly AnyToolDefinition[] = [
  finalizeTool("invoice"),
  sendEmailTool("invoice"),
  bookPaymentTool("invoice"),
  invoiceCancelTool,
  enshrineTool("invoice"),
  resetTool("invoice"),
];
