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
 * Formats a successful call. The content starts with one text block, the trusted summary, a
 * blank line, then `data` as minified JSON, so clients that ignore `structuredContent` (or have
 * bugs with it) still get everything. The handler's `extraContent` blocks (resource links) follow
 * in order; `structuredContent` is `data` alone. `data` must already be validated against the
 * tool's output schema. JSON string escaping keeps untrusted DTO text inside its value;
 * that boundary does not depend on indentation or line breaks between fields.
 */
export function successResult(
  output: ToolOutput<unknown>,
  options: SuccessResultOptions,
): CallToolResult {
  const json = JSON.stringify(output.data);
  const summary = output.summary.trim();
  const text = summary === "" ? json : `${summary}\n\n${json}`;
  return {
    content: [{ type: "text", text }, ...(output.extraContent ?? [])],
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
