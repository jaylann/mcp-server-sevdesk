import type { AnyToolDefinition } from "../types.js";
import { reconcileSuggestTool } from "./reconcile-suggest.js";
import { transactionBookTool } from "./transaction-book.js";
import { transactionGetTool } from "./transaction-get.js";
import { transactionMarkPrivateTool } from "./transaction-private.js";
import { transactionResetTool } from "./transaction-reset.js";

/** Bank reconciliation tools, M4: transaction details, match suggestions, booking (with splits), private marking and reset. Owned by the m4-reconcile agent. */
export const BANKING_RECONCILE_TOOLS: readonly AnyToolDefinition[] = [
  transactionGetTool,
  reconcileSuggestTool,
  transactionBookTool,
  transactionMarkPrivateTool,
  transactionResetTool,
];
