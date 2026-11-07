import type { AnyToolDefinition } from "../types.js";
import { orderCreateDraftTool } from "./draft-create.js";
import { orderUpdateDraftTool } from "./draft-update.js";

/** Order draft write tools: offers, order confirmations, delivery notes (M3 drafts work). */
export const ORDER_DRAFT_TOOLS: readonly AnyToolDefinition[] = [
  orderCreateDraftTool,
  orderUpdateDraftTool,
];
