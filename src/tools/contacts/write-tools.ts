import type { AnyToolDefinition } from "../types.js";
import { contactCreateTool } from "./create.js";
import { contactDeleteTool } from "./delete.js";
import { contactUpdateTool } from "./update.js";

/** Contact write tools (M3 master-data work; deleting from #86). */
export const CONTACT_WRITE_TOOLS: readonly AnyToolDefinition[] = [
  contactCreateTool,
  contactUpdateTool,
  contactDeleteTool,
];
