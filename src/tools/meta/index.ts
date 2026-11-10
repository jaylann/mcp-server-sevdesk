import type { AnyToolDefinition } from "../types.js";
import { accountInfoTool } from "./account-info.js";
import { referenceLookupTool } from "./reference-lookup.js";
import { uploadRequestTool } from "./upload-request.js";

/**
 * Tools of the `meta` toolset (orientation, reference data and, on a remote server with file
 * transfer, upload requests).
 */
export const META_TOOLS: readonly AnyToolDefinition[] = [
  accountInfoTool,
  referenceLookupTool,
  uploadRequestTool,
];
