import type { CallToolResult } from "@modelcontextprotocol/server";

import type { ToolOutput } from "./types.js";

export interface SuccessResultOptions {
  /**
   * Also send `data` as `structuredContent`. Only when the tool advertised an `outputSchema`
   * (see `resolveStructuredOutput` in `registry.ts`): the two always go together.
   */
  readonly structured: boolean;
}

/**
 * Formats a successful call. The content is always a single text block, the trusted summary, a
 * blank line, then `data` as indented JSON, so clients that ignore `structuredContent` (or have
 * bugs with it) still get everything. `data` must already be validated against the tool's output
 * schema.
 */
export function successResult(
  output: ToolOutput<unknown>,
  options: SuccessResultOptions,
): CallToolResult {
  const json = JSON.stringify(output.data, null, 2);
  const summary = output.summary.trim();
  const text = summary === "" ? json : `${summary}\n\n${json}`;
  return {
    content: [{ type: "text", text }],
    ...(options.structured ? { structuredContent: output.data } : {}),
  };
}

/**
 * A tool-level failure the model can read and act on (`isError: true`), as opposed to a protocol
 * error. `text` must be trusted: untrusted parts are fenced by the caller.
 */
export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
