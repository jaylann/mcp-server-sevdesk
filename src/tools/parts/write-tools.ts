import type { AnyToolDefinition } from "../types.js";
import { partCreateTool } from "./create.js";
import { partUpdateTool } from "./update.js";

/** Part write tools (M3 master-data work). */
export const PART_WRITE_TOOLS: readonly AnyToolDefinition[] = [partCreateTool, partUpdateTool];
