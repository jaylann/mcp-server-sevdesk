import { bookPaymentTool } from "../lifecycle/book-payment.js";
import { enshrineTool } from "../lifecycle/enshrine.js";
import { finalizeTool } from "../lifecycle/finalize.js";
import { resetTool } from "../lifecycle/reset.js";
import { sendEmailTool } from "../lifecycle/send-email.js";
import type { AnyToolDefinition } from "../types.js";

/** Credit note lifecycle tools: finalize, send, book, enshrine, reset (M3 lifecycle work). */
export const CREDIT_NOTE_LIFECYCLE_TOOLS: readonly AnyToolDefinition[] = [
  finalizeTool("creditNote"),
  sendEmailTool("creditNote"),
  bookPaymentTool("creditNote"),
  enshrineTool("creditNote"),
  resetTool("creditNote"),
];
