import type { AnyToolDefinition } from "../types.js";
import { invoiceCreateDraftTool } from "./draft-create.js";
import { invoiceUpdateDraftTool } from "./draft-update.js";

/** Invoice draft write tools (M3 drafts work). */
export const INVOICE_DRAFT_TOOLS: readonly AnyToolDefinition[] = [
  invoiceCreateDraftTool,
  invoiceUpdateDraftTool,
];
