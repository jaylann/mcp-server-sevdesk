import type { AnyToolDefinition } from "../types.js";
import { creditNoteCreateDraftTool } from "./draft-create.js";
import { creditNoteUpdateDraftTool } from "./draft-update.js";

/** Credit note draft write tools (M3 drafts work; update: #90). */
export const CREDIT_NOTE_DRAFT_TOOLS: readonly AnyToolDefinition[] = [
  creditNoteCreateDraftTool,
  creditNoteUpdateDraftTool,
];
