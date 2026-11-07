/**
 * Turns failures of a `resources/read` into protocol errors with trusted text. Unlike tool calls,
 * a resource read has no `isError` result: the error message goes back to the client as is, so
 * it is built only from trusted parts (a {@link SevdeskError}'s `message`, which is trusted by
 * contract, and fixed templates), never from sevDesk's own wording or the requested URI.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from "@modelcontextprotocol/server";

import type { Config } from "../config.js";
import { REDACTED, redactSecrets } from "../safety/redact.js";
import { SevdeskError } from "../sevdesk/errors.js";

const ISSUE_TRACKER = "https://github.com/jaylann/mcp-server-sevdesk/issues";
/** sevDesk tokens are 32 hex chars; masked in logs even when they are not the configured one. */
const TOKEN_LIKE = /\b[0-9a-f]{32}\b/gi;

/**
 * Maps an error thrown while reading the resource `uri` to a protocol error:
 * - `not_found` → {@link ResourceNotFoundError} (wire code -32602 with `data.uri`);
 * - local `validation` (no HTTP status: our own checks refused it) → invalid params;
 * - any other {@link SevdeskError} → internal error with its trusted message;
 * - anything else → internal error; details go to stderr with the token redacted.
 *
 * `label` is trusted text naming the resource in logs, e.g. `invoice_pdf 12`.
 */
export function resourceReadError(
  error: unknown,
  uri: string,
  label: string,
  config: Pick<Config, "token">,
): ProtocolError {
  if (ProtocolError.isInstance(error)) {
    return error;
  }
  if (error instanceof SevdeskError) {
    switch (error.kind) {
      case "not_found":
        return new ResourceNotFoundError(uri, error.message);
      case "validation":
        if (error.status === undefined) {
          return new ProtocolError(ProtocolErrorCode.InvalidParams, error.message);
        }
        return new ProtocolError(ProtocolErrorCode.InternalError, error.message);
      case "unexpected_response":
      case "server":
        log(label, `${error.kind} error: ${error.message}`, config.token);
        return new ProtocolError(ProtocolErrorCode.InternalError, error.message);
      default:
        return new ProtocolError(ProtocolErrorCode.InternalError, error.message);
    }
  }
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(label, `internal error: ${detail}`, config.token);
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    "Internal error in mcp-server-sevdesk while reading the resource. The details were written " +
      `to the server log (stderr); if it keeps failing, report it at ${ISSUE_TRACKER}.`,
  );
}

/** Writes a diagnostic line to stderr (stdout belongs to the stdio transport), token redacted. */
function log(label: string, message: string, token: string): void {
  const redacted = redactSecrets(message, [token]).replace(TOKEN_LIKE, REDACTED);
  console.error(`mcp-server-sevdesk: resource ${label}: ${redacted}`);
}
