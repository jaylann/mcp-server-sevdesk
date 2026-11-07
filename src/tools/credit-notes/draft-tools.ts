import type { AnyToolDefinition } from "../types.js";
import { creditNoteCreateDraftTool } from "./draft-create.js";

/** Credit note draft write tools (M3 drafts work). */
export const CREDIT_NOTE_DRAFT_TOOLS: readonly AnyToolDefinition[] = [creditNoteCreateDraftTool];
