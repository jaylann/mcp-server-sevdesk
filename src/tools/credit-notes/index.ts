import type { AnyToolDefinition } from "../types.js";
import { creditNoteGetTool } from "./get.js";
import { creditNotesListTool } from "./list.js";

/** Tools of the `credit-notes` toolset (Gutschriften). */
export const CREDIT_NOTE_TOOLS: readonly AnyToolDefinition[] = [
  creditNotesListTool,
  creditNoteGetTool,
];
