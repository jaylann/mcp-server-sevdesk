/**
 * Request and response hardening of the HTTP mode: the Host allowlist (DNS-rebinding defence),
 * the per-route Origin policies, the security headers every response carries, and the small JSON
 * error responses the router answers with (404, 405, 413, 429, 503).
 *
 * Refusals never echo request values (Host, Origin, paths): their messages are fixed, trusted
 * text that tells the operator which variable to change.
 */
import { validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";

import { sameOriginPost } from "../safety/web.js";
import type { BodyPace, OriginPolicy } from "./types.js";

/** `Strict-Transport-Security` on https origins: one year, this host only. */
const HSTS_VALUE = "max-age=31536000";

/** A JSON response (`Content-Type: application/json`). */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** An OAuth-style error body: `{"error": code, "error_description": description}`. */
export function errorResponse(
  status: number,
  error: string,
  description: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return jsonResponse(status, { error, error_description: description }, headers);
}

/**
 * A JSON-RPC error envelope (`id: null`), the shape MCP clients parse on `/mcp`; used for Host
 * and Origin refusals, as the SDK's own validators answer.
 */
function jsonRpcErrorResponse(status: number, message: string): Response {
  return jsonResponse(status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export function notFound(): Response {
  return errorResponse(404, "not_found", "There is nothing at this path.");
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return errorResponse(405, "method_not_allowed", `Use ${allowed.join(" or ")}.`, {
    Allow: allowed.join(", "),
  });
}

export function payloadTooLarge(maxBytes: number): Response {
  return errorResponse(
    413,
    "payload_too_large",
    `The request body exceeds the limit of ${String(maxBytes)} bytes for this path.`,
  );
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return errorResponse(
    429,
    "rate_limited",
    `Too many requests; retry in ${String(retryAfterSeconds)} s.`,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

/** 429 for a client with too many requests in progress at once. */
export function tooManyConcurrentRequests(): Response {
  return errorResponse(
    429,
    "rate_limited",
    "Too many requests from this client at once; retry when one has finished.",
    { "Retry-After": "1" },
  );
}

/** 408 for a request body that did not arrive in time. */
export function requestTimeout(timeoutMs: number): Response {
  return errorResponse(
    408,
    "request_timeout",
    `The request body did not arrive within ${String(timeoutMs / 1000)} s.`,
  );
}

/** 408 for a body that stalled or trickled (see `HttpRoute.bodyPace`). */
export function bodyTooSlow(pace: BodyPace): Response {
  return errorResponse(
    408,
    "request_timeout",
    `The request body arrived too slowly: it must keep sending at least ` +
      `${String(Math.round(pace.minBytesPerSecond / 1024))} KB/s and never pause for ` +
      `${String(pace.idleMs / 1000)} s.`,
  );
}

export function serviceUnavailable(description: string, retryAfterSeconds = 1): Response {
  return errorResponse(503, "unavailable", description, {
    "Retry-After": String(retryAfterSeconds),
  });
}

export function badRequest(description: string): Response {
  return errorResponse(400, "invalid_request", description);
}

export function serverError(): Response {
  return errorResponse(500, "server_error", "The server could not handle the request.");
}

/**
 * The refusal for a request whose `Host` is not on `allowedHosts` (compared by hostname, without
 * port, by the SDK's `validateHostHeader`), or `undefined` when it passes. A missing or malformed
 * `Host` is refused.
 */
export function hostRefusal(
  headers: Headers,
  allowedHosts: readonly string[],
): Response | undefined {
  const result = validateHostHeader(headers.get("host"), [...allowedHosts]);
  if (result.ok) return undefined;
  return jsonRpcErrorResponse(
    403,
    "This server does not answer for that Host. Set SEVDESK_HTTP_PUBLIC_URL to the URL clients " +
      "use, or add the hostname to SEVDESK_HTTP_ALLOWED_HOSTS.",
  );
}

export interface OriginContext {
  /** The server's public origin (exact match for `form` POSTs). */
  readonly origin: string;
  /** Hostnames accepted in `Origin` under the `mcp` policy. */
  readonly allowedOriginHostnames: readonly string[];
}

/**
 * The refusal for a request that breaks the route's {@link OriginPolicy}, or `undefined`:
 * - `mcp`: the SDK's `validateOriginHeader` (no `Origin` passes; `null` and unparsable values are
 *   refused; otherwise the hostname must be allowed);
 * - `form`: GET and HEAD pass; other methods need {@link sameOriginPost};
 * - `none`: always passes.
 */
export function originRefusal(
  request: Request,
  policy: OriginPolicy,
  context: OriginContext,
): Response | undefined {
  switch (policy) {
    case "none":
      return undefined;
    case "mcp": {
      const result = validateOriginHeader(request.headers.get("origin"), [
        ...context.allowedOriginHostnames,
      ]);
      if (result.ok) return undefined;
      return jsonRpcErrorResponse(
        403,
        "Requests from this Origin are not allowed. Add the web app's origin to " +
          "SEVDESK_HTTP_ALLOWED_ORIGINS if it should reach the server.",
      );
    }
    case "form": {
      if (request.method === "GET" || request.method === "HEAD") return undefined;
      if (sameOriginPost(request, context.origin)) return undefined;
      return errorResponse(
        403,
        "forbidden",
        "This form must be submitted from the server's own page. Reload the page and try again.",
      );
    }
  }
}

/** The hostnames of `origins` (for the SDK's hostname-based Origin check). */
export function originHostnames(origins: readonly string[]): string[] {
  const names = new Set<string>();
  for (const origin of origins) {
    try {
      names.add(new URL(origin).hostname);
    } catch {
      // Validated by the config loader; an unparsable entry simply allows nothing.
    }
  }
  return [...names];
}

/**
 * Copies `response` with the headers every response gets: `X-Content-Type-Options: nosniff`,
 * `Cache-Control: no-store, no-transform` and `Referrer-Policy: no-referrer` unless the route set its own, and
 * HSTS when the server is reached over https. Always a new `Response` (the headers of
 * `Response.redirect()` are immutable); `body` replaces the original body stream when given.
 */
export function withSecurityHeaders(
  response: Response,
  options: { readonly https: boolean; readonly body?: ReadableStream<Uint8Array> | null },
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store, no-transform");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "no-referrer");
  if (options.https) headers.set("Strict-Transport-Security", HSTS_VALUE);
  return new Response(options.body === undefined ? response.body : options.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
