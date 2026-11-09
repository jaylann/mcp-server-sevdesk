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
import { openGrantStore, type StateDirError } from "./grant-store.js";
import { metadataRoutes } from "./metadata.js";
import { disallowedReason } from "./policy.js";
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
  /**
   * For a store the module opens itself: called when the store stops being trustworthy (its
   * state directory lock was taken); the process should exit so the platform restarts it.
   */
  readonly onFatal?: (error: StateDirError) => void;
}

/** The MCP endpoint (and OAuth resource) of `origin`. */
function resourceOf(origin: string): string {
  return `${origin}/mcp`;
}

/**
 * Revokes the grants the allowlists no longer cover (an account or client host the operator
 * removed): the account's grants and inbox sessions with reason `account_removed`, a client's
 * grants with `client_removed`. The verifier and the token endpoint check the same on every use.
 */
async function sweepRemoved(store: GrantStore, oauth: OAuthSettings, log: HttpLog): Promise<void> {
  const removedAccounts = new Set<string>();
  for (const grant of store.list()) {
    if (grant.status === "revoked") continue;
    const reason = disallowedReason(oauth, grant);
    if (reason === "account_removed") {
      removedAccounts.add(grant.accountId);
    } else if (reason === "client_removed") {
      await store.revoke(grant.gid, reason);
      log.warn("grant_revoked", { grant: grant.gid.slice(0, 8), reason });
    }
  }
  for (const account of removedAccounts) {
    const count = await store.revokeAccount(account, "account_removed");
    log.warn("account_removed", { account, grants: count });
  }
}

/**
 * Builds the authorization server: opens the grant store (taking the state directory's lock;
 * rejects with `StateDirError` when that fails) unless one is passed, revokes grants outside the
 * current allowlists, and returns its routes and the `/mcp` authenticator.
 */
export async function createOAuthModule(options: OAuthModuleOptions): Promise<OAuthModule> {
  const now = options.now ?? Date.now;
  const resource = resourceOf(options.origin);
  const ownStore = options.store === undefined;
  const store =
    options.store ??
    (await openGrantStore({
      stateDir: options.stateDir,
      now,
      log: options.log,
      ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
    }));
  try {
    await sweepRemoved(store, options.oauth, options.log);
  } catch (error) {
    if (ownStore) await store.close();
    throw error;
  }
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
    oauth: options.oauth,
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
export { isAccountAllowed, isClientAllowed } from "./policy.js";
