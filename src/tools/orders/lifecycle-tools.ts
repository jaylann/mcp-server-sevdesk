import { finalizeTool } from "../lifecycle/finalize.js";
import { sendEmailTool } from "../lifecycle/send-email.js";
import type { AnyToolDefinition } from "../types.js";

/** Order lifecycle tools: finalize and send (M3 lifecycle work). */
export const ORDER_LIFECYCLE_TOOLS: readonly AnyToolDefinition[] = [
  finalizeTool("order"),
  sendEmailTool("order"),
];
