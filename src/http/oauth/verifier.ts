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
import type { GrantStore, HttpAuthenticator, HttpLog } from "../types.js";
import { intersectTiers, openAccess, scopeOf, type TokenScope, toSeconds } from "./tokens.js";

export interface VerifierOptions extends TokenScope {
  /** The MCP endpoint (`<origin>/mcp`), the only accepted audience. */
  readonly resource: string;
  readonly store: GrantStore;
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
      await options.store.sync();
      const grant = options.store.get(payload.gid);
      if (
        grant?.status !== "active" ||
        grant.expiresAt <= toSeconds(options.now()) ||
        grant.accountId !== payload.acct ||
        grant.clientId !== payload.cid
      ) {
        options.log.info("access_refused", { grant: payload.gid.slice(0, 8) });
        throw new OAuthError(OAuthErrorCode.InvalidToken, REVOKED);
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
