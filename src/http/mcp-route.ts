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
 */
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";

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
      return handler.fetch(request, { authInfo: auth });
    },
  };
  return { route, close: () => handler.close() };
}
