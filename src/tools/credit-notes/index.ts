import type { AnyToolDefinition } from "../types.js";
import { CREDIT_NOTE_DERIVED_TOOLS } from "./derived-tools.js";
import { CREDIT_NOTE_DRAFT_TOOLS } from "./draft-tools.js";
import { creditNoteGetTool } from "./get.js";
import { CREDIT_NOTE_LIFECYCLE_TOOLS } from "./lifecycle-tools.js";
import { creditNotesListTool } from "./list.js";

/** Tools of the `credit-notes` toolset (Gutschriften). */
export const CREDIT_NOTE_TOOLS: readonly AnyToolDefinition[] = [
  creditNotesListTool,
  creditNoteGetTool,
  ...CREDIT_NOTE_DRAFT_TOOLS,
  ...CREDIT_NOTE_LIFECYCLE_TOOLS,
  ...CREDIT_NOTE_DERIVED_TOOLS,
];
