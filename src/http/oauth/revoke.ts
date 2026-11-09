/**
 * Token revocation (`POST /revoke`, RFC 7009). Revoking a refresh or an access token revokes its
 * whole grant: access tokens are not stored individually, and the grant check on every MCP request
 * makes the revocation effective on the next call.
 *
 * Holding a token of the grant is the authority to revoke it (public clients have no
 * credentials). Unknown, foreign or malformed tokens get the same empty `200` as revoked ones, as
 * RFC 7009 requires, so the endpoint does not tell which tokens are valid.
 */
import type { GrantStore, HttpLog, HttpRoute } from "../types.js";
import { StateDirError } from "./grant-store.js";
import { corsPreflight, oauthError, readOAuthForm } from "./token.js";
import { grantOfToken, type TokenScope } from "./tokens.js";

export interface RevokeOptions extends TokenScope {
  readonly store: GrantStore;
  readonly log: HttpLog;
}

/** The `/revoke` route. */
export function revokeRoute(options: RevokeOptions): HttpRoute {
  return {
    path: "/revoke",
    methods: ["POST", "OPTIONS"],
    maxBodyBytes: 4 * 1024,
    origin: "none",
    rateLimit: { name: "oauth-revoke", perMinute: 30 },
    async handle(request) {
      if (request.method === "OPTIONS") return corsPreflight(request);
      const form = await readOAuthForm(request);
      if (form instanceof Response) return form;
      const token = form.get("token");
      if (token === null || token === "")
        return oauthError("invalid_request", "token is required.");
      const hint =
        form.get("token_type_hint") === "access_token" ? "access_token" : "refresh_token";
      const grant = grantOfToken(options, token, hint);
      if (grant !== undefined) {
        try {
          await options.store.sync(true);
          if (await options.store.revoke(grant.gid, "user")) {
            options.log.info("grant_revoked", { grant: grant.gid.slice(0, 8), reason: "user" });
          }
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
      }
      return new Response(null, {
        status: 200,
        headers: {
          "Cache-Control": "no-store, no-transform",
          Pragma: "no-cache",
          "Access-Control-Allow-Origin": "*",
        },
      });
    },
  };
}
