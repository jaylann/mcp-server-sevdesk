/**
 * The token endpoint (`POST /token`, form-encoded, public clients only).
 *
 * `authorization_code`: the code must be intact and unexpired, issued to this `client_id` for
 * this exact `redirect_uri`, and the PKCE verifier (`[A-Za-z0-9._~-]{43,128}`) must hash (S256)
 * to the code's challenge, compared in constant time. The first exchange activates the grant; a
 * second exchange of a code is a replay and revokes the grant (the code may have leaked).
 *
 * `refresh_token`: refresh tokens rotate. The current generation is exchanged for a new pair; the
 * previous generation is accepted for 30 s after a rotation and answered at the current
 * generation (Claude refreshes proactively and on 401, possibly at once); any other generation is
 * a replay and revokes the grant. Each refresh first asks sevDesk whether the token still works
 * (5 s) and only then commits the rotation, so a client that drops during the check can retry
 * with the same refresh token: a 401 revokes the grant (regenerating the token in sevDesk ends the
 * connection); when sevDesk cannot be reached the refresh still succeeds, as the access token is
 * useless without a working sevDesk token anyway.
 *
 * Both grant types also re-check the account and client allowlists (`policy.ts`): a grant they no
 * longer cover is revoked and answered `invalid_grant`. While the grant store cannot be trusted
 * (lost state directory lock) the endpoint answers 503 `temporarily_unavailable`.
 *
 * Every failure of a code or refresh token is `invalid_grant` (what clients expect for a dead
 * token); a `resource` other than this server's is `invalid_target`. Responses are JSON with
 * `Cache-Control: no-store` and CORS `*` (no credentials are involved).
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { IdentityError, type IdentityLookup } from "../../accounts/types.js";
import type { Tier } from "../../safety/tiers.js";
import { FormError, readForm } from "../../safety/web.js";
import type {
  GrantRecord,
  GrantStore,
  HttpLog,
  HttpRequestContext,
  HttpRoute,
  OAuthSettings,
} from "../types.js";
import { StateDirError } from "./grant-store.js";
import { enforceAllowlists } from "./policy.js";
import {
  intersectTiers,
  openCode,
  openRefresh,
  scopeOf,
  sealAccess,
  sealRefresh,
  tiersOfScope,
  type TokenScope,
  toSeconds,
} from "./tokens.js";

const MAX_FORM_BYTES = 4 * 1024;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const IDENTITY_TIMEOUT_MS = 5_000;

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, no-transform",
  Pragma: "no-cache",
  "Access-Control-Allow-Origin": "*",
};

/** An OAuth error response (RFC 6749 §5.2). The description is trusted text. */
export function oauthError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: JSON_HEADERS },
  );
}

/** CORS preflight of `/token` and `/revoke` (no credentials are ever involved). */
export function corsPreflight(request: Request): Response {
  const requested = request.headers.get("access-control-request-headers");
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": requested ?? "Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Access-Control-Request-Headers",
    },
  });
}

/**
 * Reads the form of a token or revocation request. Returns the error response instead when the
 * body is not a form, is too large, repeats a parameter, or carries client credentials (this
 * server only has public clients).
 */
export async function readOAuthForm(request: Request): Promise<URLSearchParams | Response> {
  let form: URLSearchParams;
  try {
    form = await readForm(request, MAX_FORM_BYTES);
  } catch (error) {
    if (error instanceof FormError) {
      return oauthError(
        "invalid_request",
        "Send the parameters form-encoded (application/x-www-form-urlencoded), at most 4 KiB.",
        error.reason === "too_large" ? 413 : 400,
      );
    }
    throw error;
  }
  for (const name of new Set(form.keys())) {
    if (form.getAll(name).length > 1) {
      return oauthError("invalid_request", "Each parameter may appear only once.");
    }
  }
  if (
    request.headers.has("authorization") ||
    form.has("client_secret") ||
    form.has("client_assertion")
  ) {
    return oauthError(
      "invalid_client",
      "This server only accepts public clients (token_endpoint_auth_method none).",
      401,
    );
  }
  return form;
}

/** Whether the S256 hash of `verifier` equals `challenge`, compared in constant time. */
function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier)) return false;
  const expected = Buffer.from(challenge, "base64url");
  const actual = createHash("sha256").update(verifier, "ascii").digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface TokenEndpointOptions extends TokenScope {
  /** `<origin>/mcp`. */
  readonly resource: string;
  readonly oauth: OAuthSettings;
  readonly store: GrantStore;
  readonly identity: IdentityLookup;
  readonly now: () => number;
  readonly log: HttpLog;
}

const INVALID_GRANT = "invalid_grant";
const GONE = "The connection was revoked or has expired. Connect again.";
const NOT_ALLOWED =
  "This server no longer accepts the account or the client of this connection. Connect again.";

/** The `/token` route. */
export function tokenRoute(options: TokenEndpointOptions): HttpRoute {
  function issue(
    grant: GrantRecord,
    sevdeskToken: string,
    gen: number,
    tiers: readonly Tier[],
    grantType: string,
  ): Response {
    const now = toSeconds(options.now());
    const accessExp = Math.min(now + options.oauth.accessTtlSeconds, grant.expiresAt);
    const refreshExp = Math.min(now + options.oauth.refreshIdleTtlSeconds, grant.expiresAt);
    const common = {
      gid: grant.gid,
      cid: grant.clientId,
      res: options.resource,
      tok: sevdeskToken,
      iat: now,
    };
    const accessToken = sealAccess(options, {
      ...common,
      acct: grant.accountId,
      tiers: [...tiers],
      exp: accessExp,
    });
    const refreshToken = sealRefresh(options, { ...common, gen, exp: refreshExp });
    options.log.info("token_issued", { grant: grant.gid.slice(0, 8), grant_type: grantType });
    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: accessExp - now,
        refresh_token: refreshToken,
        scope: scopeOf(tiers),
      },
      { status: 200, headers: JSON_HEADERS },
    );
  }

  function resourceMismatch(form: URLSearchParams, expected: string): boolean {
    const requested = form.get("resource");
    return requested !== null && requested !== expected;
  }

  async function exchangeCode(form: URLSearchParams): Promise<Response> {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    const clientId = form.get("client_id");
    if (code === null || redirectUri === null || verifier === null || clientId === null) {
      return oauthError(
        "invalid_request",
        "code, redirect_uri, code_verifier and client_id are required.",
      );
    }
    const payload = openCode(options, code, toSeconds(options.now()));
    if (payload === undefined) {
      return oauthError(INVALID_GRANT, "The authorization code is invalid or expired.");
    }
    if (payload.cid !== clientId || payload.ruri !== redirectUri) {
      return oauthError(
        INVALID_GRANT,
        "The authorization code was issued to another client or redirect URI.",
      );
    }
    if (!pkceMatches(verifier, payload.cc)) {
      return oauthError(INVALID_GRANT, "The code verifier does not match the code challenge.");
    }
    if (resourceMismatch(form, payload.res)) {
      return oauthError("invalid_target", `The resource must be ${payload.res}.`);
    }
    const pending = options.store.get(payload.gid);
    if (
      pending !== undefined &&
      !(await enforceAllowlists(options.store, options.oauth, pending, options.log))
    ) {
      return oauthError(INVALID_GRANT, NOT_ALLOWED);
    }
    const outcome = await options.store.activate(payload.gid, payload.jti);
    if (outcome === "replay") {
      options.log.warn("code_replay", { grant: payload.gid.slice(0, 8) });
      return oauthError(
        INVALID_GRANT,
        "The authorization code was already used; the connection was revoked for safety. " +
          "Connect again.",
      );
    }
    const grant = options.store.get(payload.gid);
    if (
      outcome !== "activated" ||
      grant?.status !== "active" ||
      grant.accountId !== payload.acct ||
      grant.clientId !== payload.cid
    ) {
      return oauthError(INVALID_GRANT, "The authorization code is invalid or expired.");
    }
    return issue(grant, payload.tok, grant.gen, payload.tiers, "authorization_code");
  }

  async function refresh(form: URLSearchParams, ctx: HttpRequestContext): Promise<Response> {
    const raw = form.get("refresh_token");
    if (raw === null) return oauthError("invalid_request", "refresh_token is required.");
    const payload = openRefresh(options, raw, toSeconds(options.now()));
    const clientId = form.get("client_id");
    if (payload === undefined || (clientId !== null && clientId !== payload.cid)) {
      return oauthError(INVALID_GRANT, "The refresh token is invalid or expired.");
    }
    if (resourceMismatch(form, payload.res)) {
      return oauthError("invalid_target", `The resource must be ${payload.res}.`);
    }
    const before = options.store.get(payload.gid);
    if (before?.clientId !== payload.cid) {
      return oauthError(INVALID_GRANT, "The refresh token is invalid or expired.");
    }
    if (before.status !== "active" || before.expiresAt <= toSeconds(options.now())) {
      return oauthError(INVALID_GRANT, GONE);
    }
    if (!(await enforceAllowlists(options.store, options.oauth, before, options.log))) {
      return oauthError(INVALID_GRANT, NOT_ALLOWED);
    }
    const requested = tiersOfScope(form.get("scope"));
    if (requested !== undefined && [...requested].some((tier) => !before.tiers.includes(tier))) {
      return oauthError("invalid_scope", "A refresh cannot add tiers; connect again for more.");
    }
    const prefix = payload.gid.slice(0, 8);
    // sevDesk is asked before the rotation is committed: a client that gives up during the
    // check still holds a usable refresh token.
    try {
      const identity = await options.identity(
        payload.tok,
        AbortSignal.any([ctx.signal, AbortSignal.timeout(IDENTITY_TIMEOUT_MS)]),
      );
      if (identity.accountId !== before.accountId) {
        await options.store.revoke(payload.gid, "account_changed");
        options.log.warn("grant_revoked", { grant: prefix, reason: "account_changed" });
        return oauthError(
          INVALID_GRANT,
          "The connection's sevDesk account changed. Connect again.",
        );
      }
    } catch (error) {
      if (error instanceof IdentityError && error.kind === "unauthorized") {
        await options.store.revoke(payload.gid, "sevdesk_401");
        options.log.warn("grant_revoked", { grant: prefix, reason: "sevdesk_401" });
        return oauthError(
          INVALID_GRANT,
          "sevDesk no longer accepts the token of this connection. Connect again with a current " +
            "sevDesk API token.",
        );
      }
      if (ctx.signal.aborted) {
        // The client is gone: keep the generation, so its retry with the same token works.
        return oauthError("temporarily_unavailable", "The request was cancelled.", 503);
      }
      options.log.warn("identity_check_skipped", { grant: prefix });
    }
    const rotated = await options.store.rotate(payload.gid, payload.gen);
    if (!rotated.ok) {
      if (rotated.reason === "replay") options.log.warn("refresh_replay", { grant: prefix });
      return oauthError(
        INVALID_GRANT,
        rotated.reason === "replay"
          ? "The refresh token was already used; the connection was revoked for safety. " +
              "Connect again."
          : GONE,
      );
    }
    const grant = options.store.get(payload.gid);
    if (grant?.status !== "active") {
      return oauthError(INVALID_GRANT, GONE);
    }
    const tiers =
      requested === undefined ? grant.tiers : intersectTiers(grant.tiers, new Set(requested));
    return issue(grant, payload.tok, rotated.gen, tiers, "refresh_token");
  }

  return {
    path: "/token",
    methods: ["POST", "OPTIONS"],
    maxBodyBytes: MAX_FORM_BYTES,
    origin: "none",
    rateLimit: { name: "oauth-token", perMinute: 60 },
    async handle(request, ctx) {
      if (request.method === "OPTIONS") return corsPreflight(request);
      const form = await readOAuthForm(request);
      if (form instanceof Response) return form;
      const grantType = form.get("grant_type");
      if (grantType === null) return oauthError("invalid_request", "grant_type is required.");
      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        return oauthError(
          "unsupported_grant_type",
          "Only authorization_code and refresh_token are supported.",
        );
      }
      try {
        // Revocations by the `grants` command apply before any token is issued.
        await options.store.sync(true);
        return grantType === "authorization_code"
          ? await exchangeCode(form)
          : await refresh(form, ctx);
      } catch (error) {
        if (error instanceof StateDirError) {
          return oauthError(
            "temporarily_unavailable",
            "The server is restarting; retry shortly.",
            503,
          );
        }
        throw error;
      }
    },
  };
}
