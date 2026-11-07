import type { AnyToolDefinition } from "../types.js";
import { contactCreateTool } from "./create.js";
import { contactUpdateTool } from "./update.js";

/** Contact write tools (M3 master-data work). */
export const CONTACT_WRITE_TOOLS: readonly AnyToolDefinition[] = [
  contactCreateTool,
  contactUpdateTool,
];
