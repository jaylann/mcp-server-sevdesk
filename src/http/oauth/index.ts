/**
 * The OAuth 2.1 authorization server of the HTTP mode (`SEVDESK_HTTP_AUTH=oauth`), for itself:
 * discovery metadata, the consent page, the token and revocation endpoints, and the verifier of
 * `/mcp` requests. Clients are identified by Client ID Metadata Documents (no registration), PKCE
 * S256 is required, tokens are bound to `<origin>/mcp` (RFC 8707), authorization responses carry
 * `iss` (RFC 9207). The issuer is the public origin.
 *
 * The user's sevDesk token is pasted once on the consent page and then lives only inside the
 * grant's sealed tokens (`tokens.ts`); the grant store keeps non-secret metadata only.
 */
import type { IdentityLookup } from "../../accounts/types.js";
import type { Tier } from "../../safety/tiers.js";
import type { ServerKeys } from "../keys.js";
import type { GrantStore, HttpLog, OAuthModule, OAuthSettings } from "../types.js";
import { authorizeRoute, type SessionCookieMinter } from "./authorize.js";
import { createCimdFetcher, type HttpsGet } from "./cimd.js";
import { openGrantStore } from "./grant-store.js";
import { metadataRoutes } from "./metadata.js";
import { revokeRoute } from "./revoke.js";
import type { Resolver } from "./ssrf.js";
import { tokenRoute } from "./token.js";
import { createOAuthAuthenticator } from "./verifier.js";

export interface OAuthModuleOptions {
  /** The public origin (`SEVDESK_HTTP_PUBLIC_URL`, no trailing slash); also the issuer. */
  readonly origin: string;
  /** Server keys from `SEVDESK_HTTP_SECRET` (and `_PREVIOUS` during a rotation). */
  readonly keys: ServerKeys;
  readonly oauth: OAuthSettings;
  /** `SEVDESK_ALLOW` after `SEVDESK_READ_ONLY` (`Settings.allowedTiers`): caps every grant. */
  readonly allowedTiers: ReadonlySet<Tier>;
  /** `SEVDESK_HTTP_STATE_DIR`; `undefined` keeps grants in memory. Ignored with `store`. */
  readonly stateDir: string | undefined;
  /** Who a sevDesk token belongs to (consent check, refresh check). */
  readonly identity: IdentityLookup;
  readonly log: HttpLog;
  /** Mints the approval inbox session at consent (`createSessionCookie` from `session.ts`). */
  readonly mintSessionCookie?: SessionCookieMinter;
  /** Epoch milliseconds (default `Date.now`). */
  readonly now?: () => number;
  /** CIMD host resolution and fetching (tests). */
  readonly resolve?: Resolver;
  readonly httpsGet?: HttpsGet;
  /** An already opened store (shared with the approval inbox, or tests); not closed by `close`. */
  readonly store?: GrantStore;
}

/** The MCP endpoint (and OAuth resource) of `origin`. */
function resourceOf(origin: string): string {
  return `${origin}/mcp`;
}

/**
 * Builds the authorization server: opens the grant store (taking the state directory's lock;
 * rejects with `StateDirError` when that fails) unless one is passed, and returns its routes and
 * the `/mcp` authenticator.
 */
export async function createOAuthModule(options: OAuthModuleOptions): Promise<OAuthModule> {
  const now = options.now ?? Date.now;
  const resource = resourceOf(options.origin);
  const ownStore = options.store === undefined;
  const store =
    options.store ?? (await openGrantStore({ stateDir: options.stateDir, now, log: options.log }));
  const scope = { keys: options.keys, issuer: options.origin };
  const cimd = createCimdFetcher({
    clients: options.oauth.clients,
    now,
    log: options.log,
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
    ...(options.httpsGet === undefined ? {} : { get: options.httpsGet }),
  });
  const routes = [
    ...metadataRoutes({ origin: options.origin, resource, allowedTiers: options.allowedTiers }),
    authorizeRoute({
      ...scope,
      origin: options.origin,
      resource,
      oauth: options.oauth,
      allowedTiers: options.allowedTiers,
      cimd,
      store,
      identity: options.identity,
      mintSessionCookie: options.mintSessionCookie,
      now,
      log: options.log,
    }),
    tokenRoute({
      ...scope,
      resource,
      oauth: options.oauth,
      store,
      identity: options.identity,
      now,
      log: options.log,
    }),
    revokeRoute({ ...scope, store, log: options.log }),
  ];
  const authenticator = createOAuthAuthenticator({
    ...scope,
    resource,
    store,
    allowedTiers: options.allowedTiers,
    now,
    log: options.log,
  });
  return {
    routes,
    authenticator,
    store,
    async close() {
      if (ownStore) await store.close();
    },
  };
}

export type { SessionCookieMinter } from "./authorize.js";
export { openGrantStore, StateDirError } from "./grant-store.js";
