/**
 * The MCP endpoint, `POST /mcp`: an {@link AuthenticatedRoute}, so the router authenticates the
 * request on its headers (bearer or OAuth, see {@link HttpAuthenticator}) before it reads the
 * body, and the handler hands it to the SDK's stateless handler
 * (`createMcpHandler(factory, {legacy: "stateless"})`), which serves both protocol eras: 2026-07-28
 * requests natively, 2025-era requests through a fresh instance per request. GET and DELETE (2025
 * session operations) are authenticated too and then answered 405 by the SDK. The verified
 * `AuthInfo` reaches the server factory, which picks the account context from it.
 *
 * Origin checks (`mcp` policy) and the 1 MiB body limit run in the router before this handler; the
 * SDK enforces the same limit again on what it reads.
 *
 * A JSON-RPC batch (an array body; only 2025-03-26 clients send one, later protocol versions have
 * none) is checked here before the SDK sees it: see {@link batchRefusal}.
 */
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";

import { jsonResponse } from "./hardening.js";
import { principalLogFields } from "./log.js";
import { annotateRequest, type AuthenticatedRoute, requestAuth } from "./router.js";
import type { HttpAuthenticator, HttpLog, RateRule } from "./types.js";

export const MCP_PATH = "/mcp";
/** Largest MCP request body (1 MiB). */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;
/**
 * Default per-IP limit on `/mcp`: generous for one user's agent (tool calls are paced towards
 * sevDesk anyway), a brake for scripted floods. Many users behind one egress IP (claude.ai in
 * multi-tenant mode) may need a higher limit.
 */
export const DEFAULT_MCP_RATE_LIMIT: RateRule = { name: "mcp", perMinute: 600, burst: 120 };
/**
 * Most messages in one JSON-RPC batch: the number of requests one account may have in progress
 * (the router's per-account cap), since every request of a batch runs at once inside one HTTP
 * request. The SDK alone would accept 100.
 */
export const MCP_MAX_BATCH_MESSAGES = 8;
/** JSON-RPC "Invalid Request". */
const INVALID_REQUEST = -32_600;

export interface McpRouteOptions {
  readonly authenticator: HttpAuthenticator;
  readonly factory: McpServerFactory;
  /** Errors the SDK reports out of band (rejected requests, failing instances). */
  readonly onerror?: (error: Error) => void;
  /** Logger for those errors when `onerror` is not given. */
  readonly log?: HttpLog;
  /** Per-IP limit (default {@link DEFAULT_MCP_RATE_LIMIT}). */
  readonly rateLimit?: RateRule;
}

export interface McpRoute {
  readonly route: AuthenticatedRoute;
  /** Aborts in-flight 2026-07-28 exchanges (shutdown). */
  close(): Promise<void>;
}

export function createMcpRoute(options: McpRouteOptions): McpRoute {
  const onerror =
    options.onerror ??
    ((error: Error): void => {
      options.log?.warn("mcp_error", { message: `${error.name}: ${error.message}` });
    });
  const handler = createMcpHandler(options.factory, {
    legacy: "stateless",
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
    onerror,
  });
  const route: AuthenticatedRoute = {
    path: MCP_PATH,
    methods: ["POST", "GET", "DELETE"],
    maxBodyBytes: MCP_MAX_BODY_BYTES,
    origin: "mcp",
    rateLimit: options.rateLimit ?? DEFAULT_MCP_RATE_LIMIT,
    authenticator: options.authenticator,
    handle: async (request, ctx) => {
      // The router has authenticated the headers; a caller outside the router has not.
      let auth = requestAuth(ctx);
      if (auth === undefined) {
        const result = await options.authenticator.authenticate(request, ctx);
        if (result instanceof Response) return result;
        auth = result;
        annotateRequest(ctx, principalLogFields(auth));
      }
      if (request.method !== "POST" || request.body === null) {
        return handler.fetch(request, { authInfo: auth });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      const refusal = batchRefusal(body);
      if (refusal !== undefined) {
        onerror(new Error(refusal.message));
        return jsonResponse(400, {
          jsonrpc: "2.0",
          error: { code: INVALID_REQUEST, message: refusal.message },
          id: null,
        });
      }
      // The body was read for the check: the SDK gets the same bytes in a fresh request.
      const checked = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: body.byteLength > 0 ? body : null,
        signal: request.signal,
      });
      return handler.fetch(checked, { authInfo: auth });
    },
  };
  return { route, close: () => handler.close() };
}

/**
 * Why a request body is refused before the SDK sees it, or `undefined`. Only a JSON array (a
 * legacy batch) is looked at; a single message, or a body that is not JSON, is the SDK's to
 * answer.
 *
 * - Two requests of one batch with the same id: the SDK keeps the abort controller and the
 *   pending answer of a request under its id, so the second request replaces the first one's
 *   controller, and the response ends as soon as that id has one answer. The first tool call
 *   would run on, with nothing left to abort it, outside the router's slot and deadline (review
 *   2026-11, round 3). Ids are compared as text, so `7` and `"7"` count as the same id.
 * - More than {@link MCP_MAX_BATCH_MESSAGES} messages.
 *
 * The messages are fixed text: nothing of the body is echoed.
 */
export function batchRefusal(body: Uint8Array): { readonly message: string } | undefined {
  // The SDK refuses a body over the limit itself; nothing that large is parsed here.
  if (body.byteLength > MCP_MAX_BODY_BYTES) return undefined;
  const text = new TextDecoder().decode(body);
  if (!/^\s*\[/.test(text)) return undefined;
  let batch: unknown;
  try {
    batch = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(batch)) return undefined;
  if (batch.length > MCP_MAX_BATCH_MESSAGES) {
    return {
      message:
        `Invalid Request: a batch may hold at most ${String(MCP_MAX_BATCH_MESSAGES)} messages. ` +
        "Send the requests one by one.",
    };
  }
  const ids = new Set<string>();
  for (const message of batch as readonly unknown[]) {
    const id = requestId(message);
    if (id === undefined) continue;
    if (ids.has(id)) {
      return { message: "Invalid Request: two requests of the batch have the same id." };
    }
    ids.add(id);
  }
  return undefined;
}

/** The id of a batch member that is a request (it has a method and an id), as text. */
function requestId(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { method, id } = message as { readonly method?: unknown; readonly id?: unknown };
  if (typeof method !== "string") return undefined;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}
