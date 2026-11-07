import type { AnyToolDefinition } from "../types.js";
import { bankAccountsListTool } from "./accounts.js";
import { transactionsListTool } from "./transactions.js";

/** Tools of the `banking` toolset (Bankkonten, Umsätze). */
export const BANKING_TOOLS: readonly AnyToolDefinition[] = [
  bankAccountsListTool,
  transactionsListTool,
];
