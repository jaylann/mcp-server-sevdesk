/**
 * The operator's allowlists (`SEVDESK_OAUTH_ACCOUNTS`, `SEVDESK_OAUTH_CLIENTS`) as checks. They
 * apply at consent and again on every use of a grant (each `/mcp` request and each refresh), so
 * removing an account or a client host from the list and restarting ends its existing grants
 * too: they are revoked with reason `account_removed` or `client_removed`.
 */
import type { GrantRecord, GrantStore, HttpLog, OAuthSettings } from "../types.js";

/** Whether `SEVDESK_OAUTH_ACCOUNTS` allows the sevDesk account `accountId`. */
export function isAccountAllowed(
  oauth: Pick<OAuthSettings, "accounts">,
  accountId: string,
): boolean {
  return oauth.accounts === "any" || oauth.accounts.includes(accountId);
}

/** Whether `SEVDESK_OAUTH_CLIENTS` allows clients whose `client_id` is served by `host`. */
export function isClientAllowed(oauth: Pick<OAuthSettings, "clients">, host: string): boolean {
  const name = host.toLowerCase();
  return oauth.clients === "any" || oauth.clients.some((allowed) => allowed.toLowerCase() === name);
}

/** Why a grant is outside the current allowlists (its revocation reason), or `undefined`. */
export function disallowedReason(
  oauth: Pick<OAuthSettings, "accounts" | "clients">,
  grant: Pick<GrantRecord, "accountId" | "clientHost">,
): "account_removed" | "client_removed" | undefined {
  if (!isAccountAllowed(oauth, grant.accountId)) return "account_removed";
  if (!isClientAllowed(oauth, grant.clientHost)) return "client_removed";
  return undefined;
}

/**
 * Revokes `grant` when the allowlists no longer cover it (logging `grant_revoked` as a warning)
 * and returns false; true when it is still allowed.
 */
export async function enforceAllowlists(
  store: GrantStore,
  oauth: Pick<OAuthSettings, "accounts" | "clients">,
  grant: Pick<GrantRecord, "gid" | "accountId" | "clientHost">,
  log: HttpLog,
): Promise<boolean> {
  const reason = disallowedReason(oauth, grant);
  if (reason === undefined) return true;
  await store.revoke(grant.gid, reason);
  log.warn("grant_revoked", { grant: grant.gid.slice(0, 8), reason });
  return false;
}
