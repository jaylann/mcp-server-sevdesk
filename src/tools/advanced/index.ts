import type { AnyToolDefinition } from "../types.js";
import { apiGetTool } from "./api-get.js";

/**
 * The `advanced` toolset: opt-in power tools (`SEVDESK_TOOLSETS=advanced` or `all`), off by
 * default. `sevdesk_api_get` is the generic read-only GET for endpoints no curated tool covers.
 */
export const ADVANCED_TOOLS: readonly AnyToolDefinition[] = [apiGetTool];
