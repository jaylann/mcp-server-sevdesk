/**
 * Contracts for serving more than one sevDesk account from one process (the HTTP mode with OAuth).
 *
 * Every request is served with the {@link AccountContext} of its principal: its own frozen
 * `Config` (domain caches are keyed by the config object, so accounts never share them) and its
 * own sevDesk client (pacing per account). Over stdio and in bearer mode there is exactly one
 * context. In OAuth mode the HTTP layer verifies the access token, puts a {@link VerifiedGrant}
 * into `AuthInfo.extra[GRANT_EXTRA_KEY]`, and the resolver derives the context from it.
 *
 * Invariant: the sevDesk token inside a {@link VerifiedGrant} never reaches logs, errors or
 * serialized output: it is a private field, and `toJSON`/`inspect` leave it out.
 */
import { inspect } from "node:util";

import type { AuthInfo } from "@modelcontextprotocol/server";

import type { Config } from "../config.js";
import type { Tier } from "../safety/tiers.js";
import type { SevdeskClient } from "../sevdesk/types.js";

/** Key of the {@link VerifiedGrant} in `AuthInfo.extra`. */
export const GRANT_EXTRA_KEY = "sevdeskGrant";

/** The fields of a {@link VerifiedGrant} other than the token (what may be logged). */
export interface GrantSummary {
  /** Random grant id (base64url); stable across token refreshes. */
  readonly grantId: string;
  /** The sevDesk account (`SevClient` id) the grant was consented for. */
  readonly accountId: string;
  /** The OAuth client (`client_id`, a CIMD URL). */
  readonly clientId: string;
  /** Tiers the user granted on the consent page (always includes `read`). */
  readonly tiers: ReadonlySet<Tier>;
}

/**
 * A grant whose access token was verified for this request. Carries the user's sevDesk token
 * privately; {@link VerifiedGrant.token} is the only way to read it.
 */
export class VerifiedGrant implements GrantSummary {
  readonly grantId: string;
  readonly accountId: string;
  readonly clientId: string;
  readonly tiers: ReadonlySet<Tier>;
  readonly #token: string;

  constructor(summary: GrantSummary, token: string) {
    this.grantId = summary.grantId;
    this.accountId = summary.accountId;
    this.clientId = summary.clientId;
    this.tiers = new Set(summary.tiers);
    this.#token = token;
    Object.freeze(this);
  }

  /** The sevDesk API token. Secret: never log, echo or serialize it. */
  token(): string {
    return this.#token;
  }

  toJSON(): Record<string, unknown> {
    return {
      grantId: this.grantId,
      accountId: this.accountId,
      clientId: this.clientId,
      tiers: [...this.tiers],
    };
  }

  [inspect.custom](): string {
    return `VerifiedGrant ${JSON.stringify(this.toJSON())}`;
  }
}

/** The grant of an OAuth request, or `undefined` (stdio, bearer, or no auth). */
export function grantOf(authInfo: AuthInfo | undefined): VerifiedGrant | undefined {
  const value = authInfo?.extra?.[GRANT_EXTRA_KEY];
  return value instanceof VerifiedGrant ? value : undefined;
}

/** What one request is served with: one account's config and client. */
export interface AccountContext {
  /**
   * Cache key of the context (account, token fingerprint, tiers). Not secret, but not meant for
   * display either.
   */
  readonly key: string;
  readonly config: Config;
  readonly client: SevdeskClient;
}

/**
 * Picks the {@link AccountContext} for a request. Stdio and bearer mode always return the same
 * one; OAuth mode derives (and caches) one per grant's account, token and tiers. Throws only for a
 * request that should never have passed authentication (an OAuth request without a grant).
 */
export interface AccountResolver {
  resolve(authInfo: AuthInfo | undefined): AccountContext;
  /** Drops cached contexts. */
  close(): void;
}

/**
 * Who is asking, for scoping confirmation state. `grantKey` separates connections (an approval
 * made for one grant is only taken by a retry of the same grant); `accountScope` separates
 * accounts (the approval inbox lists and decides per account).
 */
export interface RequestPrincipal {
  /** `"stdio"`, `"bearer"`, or the OAuth grant id. */
  readonly grantKey: string;
  /** The sevDesk account id when known, else `"local"` (stdio) or `"bearer"`. */
  readonly accountScope: string;
}

/** The {@link RequestPrincipal} of a request served with `config`. */
export function requestPrincipal(
  authInfo: AuthInfo | undefined,
  config: Pick<Config, "account" | "deployment">,
): RequestPrincipal {
  const grant = grantOf(authInfo);
  if (grant !== undefined) {
    return { grantKey: grant.grantId, accountScope: grant.accountId };
  }
  if (config.deployment.kind === "http") {
    return { grantKey: "bearer", accountScope: config.account?.id ?? "bearer" };
  }
  return { grantKey: "stdio", accountScope: config.account?.id ?? "local" };
}

/** The account behind a sevDesk token, as `GET /SevClient` reports it. */
export interface AccountIdentity {
  /** `SevClient` id. */
  readonly accountId: string;
  /** Company name, cleaned; untrusted (user-entered sevDesk data). */
  readonly name?: string | undefined;
}

/** Why an identity lookup failed. Messages are trusted text and never contain the token. */
export type IdentityErrorKind = "unauthorized" | "unreachable" | "unexpected";

export class IdentityError extends Error {
  readonly kind: IdentityErrorKind;

  constructor(kind: IdentityErrorKind, message: string) {
    super(message);
    this.name = "IdentityError";
    this.kind = kind;
  }
}

/**
 * Looks up the account of a sevDesk token (consent page, approval login, refresh check, bearer
 * startup). Rejects with {@link IdentityError}; never logs or echoes the token.
 */
export type IdentityLookup = (token: string, signal: AbortSignal) => Promise<AccountIdentity>;
