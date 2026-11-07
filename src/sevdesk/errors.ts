/**
 * Typed sevDesk failures. Everything the client throws is a {@link SevdeskError}; its `message` is
 * trusted text built here from templates, while sevDesk's own wording is kept separately in
 * `upstreamMessage` (untrusted, truncated, redacted).
 */
import { redactSecrets } from "../safety/redact.js";

/**
 * Failure categories of a sevDesk call. Tools map them to actionable `isError` results; the kind,
 * not the HTTP status, decides retry behavior and wording.
 */
export type SevdeskErrorKind =
  /** 401/403: token missing, wrong or revoked. Final, never retried. */
  | "auth"
  /** 404, or sevDesk's 400 "… not found", or an empty GET-by-id array. */
  | "not_found"
  /** 400/422 and 500s that are really validation errors; also local request validation. */
  | "validation"
  /** 429. */
  | "rate_limited"
  /** Other 5xx. */
  | "server"
  /** DNS/TLS/connection failure. */
  | "network"
  /** Request exceeded the configured timeout. */
  | "timeout"
  /** Cancelled by the client (MCP cancellation). */
  | "aborted"
  /** Refused locally: the request needs a tier that is not enabled (read-only mode etc.). */
  | "blocked"
  /** The response did not have the expected shape. */
  | "unexpected_response";

export interface SevdeskErrorInit {
  readonly kind: SevdeskErrorKind;
  /** Safe, trusted text for the model and logs: never the token, never raw upstream text. */
  readonly message: string;
  readonly status?: number;
  /** sevDesk's `exceptionUUID`, useful for sevDesk support. */
  readonly exceptionUuid?: string;
  /**
   * sevDesk's own error message. Upstream text is untrusted (it can echo user input), so it is
   * only shown fenced, never interpolated into instructions.
   */
  readonly upstreamMessage?: string;
  readonly method?: string;
  readonly path?: string;
  readonly cause?: unknown;
}

export class SevdeskError extends Error {
  readonly kind: SevdeskErrorKind;
  readonly status: number | undefined;
  readonly exceptionUuid: string | undefined;
  readonly upstreamMessage: string | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;

  constructor(init: SevdeskErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "SevdeskError";
    this.kind = init.kind;
    this.status = init.status;
    this.exceptionUuid = init.exceptionUuid;
    this.upstreamMessage = init.upstreamMessage;
    this.method = init.method;
    this.path = init.path;
  }

  /** Whether a GET may be retried after this error (writes are never retried). */
  get retryableForReads(): boolean {
    return isRetryableKind(this.kind);
  }
}

/** Kinds after which a side-effect-free GET may be retried. */
export function isRetryableKind(kind: SevdeskErrorKind): boolean {
  return kind === "rate_limited" || kind === "server" || kind === "network" || kind === "timeout";
}

/** Upstream messages are cut to this many characters before they are stored on an error. */
export const MAX_UPSTREAM_MESSAGE_LENGTH = 500;

/** What could be extracted from a sevDesk error body. */
export interface ParsedErrorBody {
  readonly message: string | undefined;
  readonly exceptionUuid: string | undefined;
}

/**
 * Extracts sevDesk's message and `exceptionUUID` from an error body. Handles the full envelope
 * `{"objects":null,"error":{"message":…,"code":null,"data":null,"exceptionUUID":…}}`, the short
 * `{"error":{…}}`, `{"error":"text"}`, `{"message":…}`, and non-JSON bodies (whose text, with
 * whitespace collapsed, becomes the message). The result is untrusted and not yet redacted.
 */
export function parseErrorBody(text: string): ParsedErrorBody {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { message: undefined, exceptionUuid: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { message: collapseWhitespace(trimmed), exceptionUuid: undefined };
  }

  if (typeof parsed === "string") {
    return { message: optionalText(parsed), exceptionUuid: undefined };
  }
  if (!isRecord(parsed)) return { message: undefined, exceptionUuid: undefined };

  const error = parsed["error"];
  if (typeof error === "string") return { message: optionalText(error), exceptionUuid: undefined };
  const source = isRecord(error) ? error : parsed;
  return {
    message: optionalText(source["message"]),
    exceptionUuid: optionalText(source["exceptionUUID"] ?? source["exceptionUuid"]),
  };
}

/**
 * Phrases sevDesk uses in 500 responses that are really input validation failures. Word
 * boundaries keep a generic "An unexpected error occurred" a (retryable) server error.
 */
const VALIDATION_LIKE_500 =
  /\bmust (?:not )?be\b|\bexpected\b|TypeError|Argument #\d|\binvalid\b|\bis required\b|\bnot allowed\b|\bcannot be\b/i;

/**
 * Maps an HTTP error status (plus sevDesk's message, which some statuses need) to a kind:
 * 401/403 → auth; 404 and 400 "… not found" → not_found; 408 → timeout; 429 → rate_limited;
 * other 4xx → validation; 5xx that reads like a validation problem → validation; other 5xx →
 * server; anything else (1xx/3xx) → unexpected_response.
 */
export function classifyHttpError(
  status: number,
  upstreamMessage: string | undefined,
): SevdeskErrorKind {
  const message = upstreamMessage ?? "";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 400 && /not found/i.test(message)) return "not_found";
  if (status >= 400 && status < 500) return "validation";
  if (status >= 500 && status < 600) {
    return VALIDATION_LIKE_500.test(message) ? "validation" : "server";
  }
  return "unexpected_response";
}

/** Trusted message for a kind. Never contains upstream text or secrets. */
export function messageForKind(kind: SevdeskErrorKind, status?: number): string {
  const http = status === undefined ? "" : ` (HTTP ${status})`;
  switch (kind) {
    case "auth":
      return (
        `sevDesk rejected the API token${http}. Check SEVDESK_API_TOKEN: the token may be wrong ` +
        "or revoked, or the account may lack API access (it needs the Buchhaltung Pro plan)."
      );
    case "not_found":
      return `sevDesk could not find the requested object${http}.`;
    case "validation":
      return `sevDesk rejected the request: validation error${http}.`;
    case "rate_limited":
      return `sevDesk is limiting the request rate${http}. Wait a moment and try again.`;
    case "server":
      return `sevDesk had an internal error${http}. Try again later.`;
    case "network":
      return (
        "Could not reach sevDesk (network error). Check the internet connection and " +
        "SEVDESK_BASE_URL."
      );
    case "timeout":
      return `sevDesk did not answer in time${http}. Raise SEVDESK_TIMEOUT_MS if this persists.`;
    case "aborted":
      return "The request to sevDesk was cancelled.";
    case "blocked":
      return "The request was blocked locally because writes to sevDesk are not enabled.";
    case "unexpected_response":
      return `sevDesk returned a response in an unexpected format${http}.`;
  }
}

/** Context shared by the error factories below. */
export interface ErrorContext {
  readonly method: string;
  readonly path: string;
  /** Values to redact from upstream text, i.e. the API token. */
  readonly secrets: readonly string[];
}

/**
 * Builds the error for a non-2xx response from its status and body text. The upstream message is
 * redacted and truncated; the trusted `message` comes from {@link messageForKind}.
 */
export function errorFromResponse(
  status: number,
  bodyText: string,
  context: ErrorContext,
): SevdeskError {
  const parsed = parseErrorBody(bodyText);
  const kind = classifyHttpError(status, parsed.message);
  const isRedirect = status >= 300 && status < 400;
  return new SevdeskError({
    kind,
    message: isRedirect
      ? `sevDesk answered with a redirect (HTTP ${status}), which the client does not follow.`
      : messageForKind(kind, status),
    status,
    method: context.method,
    path: context.path,
    ...upstreamFields(parsed, context.secrets),
  });
}

/**
 * Error for a 2xx response that is not the expected JSON envelope. `detail` is trusted text
 * describing what was wrong; any sevDesk `error` member in the body becomes the upstream message.
 */
export function unexpectedResponse(
  status: number,
  bodyText: string,
  context: ErrorContext,
  detail: string,
): SevdeskError {
  return new SevdeskError({
    kind: "unexpected_response",
    message: `sevDesk returned a response in an unexpected format (HTTP ${status}): ${detail}`,
    status,
    method: context.method,
    path: context.path,
    ...upstreamFields(parseErrorBody(bodyText), context.secrets),
  });
}

/** Redacts secrets and truncates to {@link MAX_UPSTREAM_MESSAGE_LENGTH} characters. */
export function sanitizeUpstream(text: string, secrets: readonly string[]): string {
  const redacted = redactSecrets(text, secrets);
  return redacted.length > MAX_UPSTREAM_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_UPSTREAM_MESSAGE_LENGTH - 1)}…`
    : redacted;
}

function upstreamFields(
  parsed: ParsedErrorBody,
  secrets: readonly string[],
): { upstreamMessage?: string; exceptionUuid?: string } {
  const fields: { upstreamMessage?: string; exceptionUuid?: string } = {};
  if (parsed.message !== undefined) {
    fields.upstreamMessage = sanitizeUpstream(parsed.message, secrets);
  }
  if (parsed.exceptionUuid !== undefined) {
    fields.exceptionUuid = sanitizeUpstream(parsed.exceptionUuid, secrets);
  }
  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  const text = collapseWhitespace(value);
  return text.length > 0 ? text : undefined;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
