import type { AnyToolDefinition } from "../types.js";

/**
 * The `advanced` toolset: opt-in power tools (`SEVDESK_TOOLSETS=advanced` or `all`), off by
 * default. `sevdesk_api_get`, the generic read-only GET, lands here.
 */
export const ADVANCED_TOOLS: readonly AnyToolDefinition[] = [];
