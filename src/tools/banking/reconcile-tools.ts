import type { AnyToolDefinition } from "../types.js";
import { reconcileSuggestTool } from "./reconcile-suggest.js";
import { transactionBookTool } from "./transaction-book.js";
import { transactionCreateTool } from "./transaction-create.js";
import { transactionDeleteTool } from "./transaction-delete.js";
import { transactionEnshrineTool } from "./transaction-enshrine.js";
import { transactionGetTool } from "./transaction-get.js";
import { transactionMarkPrivateTool } from "./transaction-private.js";
import { transactionResetTool } from "./transaction-reset.js";

/**
 * Bank reconciliation tools: transaction details, match suggestions, booking (with splits),
 * private marking and reset; transactions entered by hand, deleted and locked (enshrined).
 */
export const BANKING_RECONCILE_TOOLS: readonly AnyToolDefinition[] = [
  transactionGetTool,
  reconcileSuggestTool,
  transactionBookTool,
  transactionMarkPrivateTool,
  transactionResetTool,
  transactionCreateTool,
  transactionDeleteTool,
  transactionEnshrineTool,
];
