import type { AnyToolDefinition } from "../types.js";
import { bankAccountArchiveTool } from "./account-archive.js";
import { bankAccountCreateTool } from "./account-create.js";
import { bankAccountUpdateTool } from "./account-update.js";
import { bankAccountsListTool } from "./accounts.js";
import {
  privateRuleCreateTool,
  privateRuleDeleteTool,
  privateRulesListTool,
} from "./private-rules.js";
import { BANKING_RECONCILE_TOOLS } from "./reconcile-tools.js";
import { transactionsListTool } from "./transactions.js";

/** Tools of the `banking` toolset (Bankkonten, Umsätze, Regeln für private Umsätze). */
export const BANKING_TOOLS: readonly AnyToolDefinition[] = [
  bankAccountsListTool,
  transactionsListTool,
  ...BANKING_RECONCILE_TOOLS,
  bankAccountCreateTool,
  bankAccountUpdateTool,
  bankAccountArchiveTool,
  privateRulesListTool,
  privateRuleCreateTool,
  privateRuleDeleteTool,
];
