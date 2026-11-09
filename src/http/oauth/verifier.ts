/**
 * Authentication of MCP requests in OAuth mode: the SDK's `requireBearerAuth` with our access
 * token verifier, the RFC 8707 audience check (`expectedResource`) and the RFC 9728
 * `resource_metadata` link in every 401 challenge.
 *
 * An access token is accepted only when it opens under the current or previous key as an
 * unexpired `at` token of this issuer, names this server's resource, and its grant is known,
 * active, unexpired and still belongs to the same account and client. The grant store is checked
 * on every request (an in-memory lookup; other processes' revocations are read at most once a
 * second), so revoking a grant takes effect on the next call.
 *
 * The grant must also still be covered by `SEVDESK_OAUTH_ACCOUNTS` and `SEVDESK_OAUTH_CLIENTS`;
 * one that is not any more (the operator removed its account or client host) is revoked
 * (`account_removed` / `client_removed`). While the grant store cannot be trusted (its state
 * directory lock was lost) every request gets 500, not 401, so clients keep their tokens for
 * the restarted server.
 *
 * The verified request carries a {@link VerifiedGrant} in `AuthInfo.extra[GRANT_EXTRA_KEY]` with
 * the tiers token ∩ grant ∩ `SEVDESK_ALLOW`. `AuthInfo.token` is the marker `"oauth"`, not the
 * access token, so the sealed token goes no further than this module.
 */
import {
  type AuthInfo,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  requireBearerAuth,
} from "@modelcontextprotocol/server";

import { GRANT_EXTRA_KEY, VerifiedGrant } from "../../accounts/types.js";
import type { Tier } from "../../safety/tiers.js";
import type { GrantStore, HttpAuthenticator, HttpLog, OAuthSettings } from "../types.js";
import { StateDirError } from "./grant-store.js";
import { enforceAllowlists } from "./policy.js";
import { intersectTiers, openAccess, scopeOf, type TokenScope, toSeconds } from "./tokens.js";

export interface VerifierOptions extends TokenScope {
  /** The MCP endpoint (`<origin>/mcp`), the only accepted audience. */
  readonly resource: string;
  readonly store: GrantStore;
  /** The account and client allowlists, checked on every request. */
  readonly oauth: Pick<OAuthSettings, "accounts" | "clients">;
  /** `SEVDESK_ALLOW` (settings): caps the tiers of every grant. */
  readonly allowedTiers: ReadonlySet<Tier>;
  readonly now: () => number;
  readonly log: HttpLog;
}

const INVALID = "The access token is invalid or expired.";
const REVOKED = "The access token's grant was revoked or has expired; reconnect the client.";

/** Verifies sealed access tokens (see the module comment). */
function createAccessTokenVerifier(options: VerifierOptions): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const payload = openAccess(options, token, toSeconds(options.now()));
      if (payload === undefined) throw new OAuthError(OAuthErrorCode.InvalidToken, INVALID);
      if (payload.res !== options.resource) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "The access token is not for this server.",
        );
      }
      let grant;
      try {
        await options.store.sync();
        grant = options.store.get(payload.gid);
      } catch (error) {
        if (error instanceof StateDirError) {
          throw new OAuthError(OAuthErrorCode.ServerError, "The server is restarting.");
        }
        throw error;
      }
      if (
        grant?.status !== "active" ||
        grant.expiresAt <= toSeconds(options.now()) ||
        grant.accountId !== payload.acct ||
        grant.clientId !== payload.cid
      ) {
        options.log.info("access_refused", { grant: payload.gid.slice(0, 8) });
        throw new OAuthError(OAuthErrorCode.InvalidToken, REVOKED);
      }
      if (!(await enforceAllowlists(options.store, options.oauth, grant, options.log))) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "This server no longer accepts the account or the client of this connection.",
        );
      }
      const tiers = intersectTiers(
        intersectTiers(payload.tiers, new Set(grant.tiers)),
        options.allowedTiers,
      );
      if (tiers.length === 0) throw new OAuthError(OAuthErrorCode.InvalidToken, REVOKED);
      const verified = new VerifiedGrant(
        {
          grantId: grant.gid,
          accountId: grant.accountId,
          clientId: grant.clientId,
          tiers: new Set(tiers),
        },
        payload.tok,
      );
      return {
        token: "oauth",
        clientId: grant.clientId,
        scopes: scopeOf(tiers).split(" "),
        expiresAt: payload.exp,
        resource: new URL(payload.res),
        extra: { [GRANT_EXTRA_KEY]: verified },
      };
    },
  };
}

/** The `/mcp` authenticator of OAuth mode. */
export function createOAuthAuthenticator(options: VerifierOptions): HttpAuthenticator {
  const resource = new URL(options.resource);
  const gate = requireBearerAuth({
    verifier: createAccessTokenVerifier(options),
    expectedResource: resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  });
  return {
    authenticate: (request) => gate(request),
  };
}
