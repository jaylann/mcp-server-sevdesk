import type { AnyToolDefinition } from "../types.js";
import { partGetTool } from "./get.js";
import { partsListTool } from "./list.js";

/** Tools of the `parts` toolset (Artikel). */
export const PART_TOOLS: readonly AnyToolDefinition[] = [partsListTool, partGetTool];
