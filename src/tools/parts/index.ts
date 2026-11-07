import type { AnyToolDefinition } from "../types.js";
import { partGetTool } from "./get.js";
import { partsListTool } from "./list.js";
import { PART_WRITE_TOOLS } from "./write-tools.js";

/** Tools of the `parts` toolset (Artikel). */
export const PART_TOOLS: readonly AnyToolDefinition[] = [
  partsListTool,
  partGetTool,
  ...PART_WRITE_TOOLS,
];
