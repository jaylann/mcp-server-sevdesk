import type { AnyToolDefinition } from "../types.js";
import { accountInfoTool } from "./account-info.js";
import { referenceLookupTool } from "./reference-lookup.js";

/** Tools of the `meta` toolset (orientation and reference data). */
export const META_TOOLS: readonly AnyToolDefinition[] = [accountInfoTool, referenceLookupTool];
