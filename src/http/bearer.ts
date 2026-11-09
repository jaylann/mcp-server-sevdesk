/**
 * Bearer mode (`SEVDESK_HTTP_AUTH=bearer`): every MCP request must carry one of the configured
 * secrets as `Authorization: Bearer <value>`. Meant for one operator's own clients (Claude Code,
 * Cursor, scripts); OAuth clients such as claude.ai need `oauth` mode.
 *
 * Comparison is constant time and leaks neither which value matched nor their lengths: the
 * presented value and every configured one are HMACed with a random per-process key, and the
 * digests are compared with `timingSafeEqual` against every configured value, without an early
 * exit. The challenge carries no `resource_metadata`: there is no authorization server to
 * discover in this mode.
 *
 * The secret never leaves this module: `AuthInfo.token` is the constant `"bearer"`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/server";

import type { Tier } from "../safety/tiers.js";
import { errorResponse } from "./hardening.js";
import type { HttpAuthenticator } from "./types.js";

export const BEARER_REALM = "mcp-server-sevdesk";
/** `AuthInfo.clientId` (and `token`) of bearer requests. */
const BEARER_CLIENT_ID = "bearer";
/** Lifetime stamped on bearer `AuthInfo` (seconds); the secret itself does not expire. */
const AUTH_INFO_TTL_SECONDS = 300;
/** Longest `Authorization` value examined; longer ones are refused without hashing. */
const MAX_AUTHORIZATION_LENGTH = 4_096;

export interface BearerAuthenticatorOptions {
  /** Tiers bearer clients may use (`SEVDESK_ALLOW`), stamped into `AuthInfo.scopes`. */
  readonly tiers: Iterable<Tier>;
  /** Epoch ms (tests pass a fake clock). */
  readonly now?: () => number;
}

/**
 * Creates the bearer authenticator for `tokens` (one, or two while rotating; validated by
 * `loadHttpConfig`). Throws when `tokens` is empty.
 */
export function createBearerAuthenticator(
  tokens: readonly string[],
  options: BearerAuthenticatorOptions,
): HttpAuthenticator {
  if (tokens.length === 0) throw new RangeError("Bearer mode needs at least one token.");
  const key = randomBytes(32);
  const digest = (value: string): Buffer =>
    createHmac("sha256", key).update(value, "utf8").digest();
  const expected = tokens.map(digest);
  const scopes = [...new Set(options.tiers)];
  const now = options.now ?? Date.now;

  return {
    authenticate: (request) => {
      const presented = presentedToken(request.headers.get("authorization"));
      if (presented === undefined) return Promise.resolve(challenge(false));
      const received = digest(presented);
      let matched = 0;
      for (const candidate of expected) {
        // Bitwise OR: every candidate is compared, whatever the outcome of the previous ones.
        matched |= timingSafeEqual(candidate, received) ? 1 : 0;
      }
      if (matched === 0) return Promise.resolve(challenge(true));
      const authInfo: AuthInfo = {
        token: BEARER_CLIENT_ID,
        clientId: BEARER_CLIENT_ID,
        scopes: [...scopes],
        expiresAt: Math.floor(now() / 1000) + AUTH_INFO_TTL_SECONDS,
      };
      return Promise.resolve(authInfo);
    },
  };
}

/** The value of an `Authorization: Bearer <value>` header, or `undefined`. */
function presentedToken(header: string | null): string | undefined {
  if (header === null || header.length > MAX_AUTHORIZATION_LENGTH) return undefined;
  const match = /^Bearer +(\S+) *$/i.exec(header);
  return match?.[1];
}

/**
 * 401 with `WWW-Authenticate: Bearer realm="mcp-server-sevdesk"` (RFC 6750); `error="invalid_token"`
 * is added when a token was presented.
 */
function challenge(presented: boolean): Response {
  const header = presented
    ? `Bearer realm="${BEARER_REALM}", error="invalid_token"`
    : `Bearer realm="${BEARER_REALM}"`;
  return errorResponse(
    401,
    "invalid_token",
    'Send the server\'s bearer token (SEVDESK_HTTP_BEARER_TOKEN) as "Authorization: Bearer <token>".',
    { "WWW-Authenticate": header },
  );
}
