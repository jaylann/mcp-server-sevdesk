/**
 * The sealed tokens of the OAuth authorization server (`seal.ts` does the cryptography) and their
 * payloads, checked with strict zod schemas and the injected clock on every open:
 *
 * | Type | Lifetime | Payload |
 * |---|---|---|
 * | `ac` code | 60 s | `jti, gid, cid, ruri, cc, res, acct, tiers, tok` |
 * | `at` access | `SEVDESK_OAUTH_ACCESS_TTL`, ≤ grant expiry | `gid, cid, acct, tiers, res, tok` |
 * | `rt` refresh | `SEVDESK_OAUTH_REFRESH_IDLE_TTL`, ≤ grant expiry | `gid, cid, gen, res, tok` |
 * | `cs` consent state | 10 min | the authorization request, the CSRF tag, after the token check also `acct`, `name`, `tok` |
 *
 * Every payload carries `iat` and `exp` (epoch seconds). `tok` is the user's sevDesk token: it
 * exists only inside these sealed tokens, never in the grant store, logs or pages.
 */
import { z } from "zod";

import { type Tier, TIERS } from "../../safety/tiers.js";
import type { ServerKeys } from "../keys.js";
import { seal, type SealType, unseal } from "../seal.js";

/** Scope of a tier: `sevdesk:read`, `sevdesk:write`, … */
const SCOPE_PREFIX = "sevdesk:";
/** Advertised so clients ask for refresh tokens; refresh tokens are issued either way. */
export const OFFLINE_ACCESS = "offline_access";

/** Lifetime of an authorization code. */
export const CODE_TTL_SECONDS = 60;
/** Lifetime of the consent form state (and its CSRF cookie). */
export const CONSENT_TTL_SECONDS = 600;
/** Tolerated clock skew for `iat` in the future. */
const MAX_SKEW_SECONDS = 60;

/** A sevDesk API token as sevDesk issues them: 32 hex digits. */
export const SEVDESK_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;
/** A sevDesk account id (`SevClient` id) as the grants CLI accepts it. */
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** An S256 code challenge: base64url of a SHA-256 digest, without padding. */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const tier = z.enum(TIERS);
const tiers = z.array(tier).min(1).max(TIERS.length);
const randomIdField = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const seconds = z.number().int().nonnegative();
const url = z.string().min(1).max(2048);
const sevdeskToken = z.string().regex(SEVDESK_TOKEN_PATTERN);
const accountId = z.string().regex(ACCOUNT_ID_PATTERN);

const timestamps = { iat: seconds, exp: seconds };

const codeSchema = z.strictObject({
  jti: randomIdField,
  gid: randomIdField,
  cid: url,
  ruri: url,
  cc: z.string().regex(CODE_CHALLENGE_PATTERN),
  res: url,
  acct: accountId,
  tiers,
  tok: sevdeskToken,
  ...timestamps,
});

const accessSchema = z.strictObject({
  gid: randomIdField,
  cid: url,
  acct: accountId,
  tiers,
  res: url,
  tok: sevdeskToken,
  ...timestamps,
});

const refreshSchema = z.strictObject({
  gid: randomIdField,
  cid: url,
  gen: z.number().int().positive(),
  res: url,
  tok: sevdeskToken,
  ...timestamps,
});

const consentSchema = z.strictObject({
  /** The validated authorization request. */
  cid: url,
  ruri: url,
  /** The client's `state`, echoed back unchanged (absent when it sent none). */
  st: z.string().max(1024).optional(),
  /** The client's self-declared name (sanitized), for the second page. */
  cn: z.string().max(400).optional(),
  cc: z.string().regex(CODE_CHALLENGE_PATTERN),
  res: url,
  /** Tiers the consent page may offer (requested ∩ allowed; always `read`). */
  offer: tiers,
  /** The CSRF tag this state belongs to (`keyedTag(csrf, cookie)`). */
  csrf: z.string().min(1).max(128),
  /** After the token check: the tiers the user chose, the account and its token. */
  tiers: tiers.optional(),
  acct: accountId.optional(),
  name: z.string().max(400).optional(),
  tok: sevdeskToken.optional(),
  ...timestamps,
});

export type CodePayload = z.infer<typeof codeSchema>;
export type AccessPayload = z.infer<typeof accessSchema>;
export type RefreshPayload = z.infer<typeof refreshSchema>;
export type ConsentPayload = z.infer<typeof consentSchema>;

/** What sealing and opening need: the keys and the issuer (bound into every token). */
export interface TokenScope {
  readonly keys: ServerKeys;
  readonly issuer: string;
}

function open<T extends { readonly iat: number; readonly exp: number }>(
  scope: TokenScope,
  type: SealType,
  schema: z.ZodType<T>,
  token: string,
  nowSeconds: number,
): T | undefined {
  const parsed = schema.safeParse(unseal(scope.keys, type, scope.issuer, token));
  if (!parsed.success) return undefined;
  const { iat, exp } = parsed.data;
  if (exp <= nowSeconds || iat > nowSeconds + MAX_SKEW_SECONDS || iat > exp) return undefined;
  return parsed.data;
}

export function sealCode(scope: TokenScope, payload: CodePayload): string {
  return seal(scope.keys, "ac", scope.issuer, codeSchema.parse(payload));
}

/** The payload of an intact, unexpired authorization code, or `undefined`. */
export function openCode(scope: TokenScope, token: string, now: number): CodePayload | undefined {
  return open(scope, "ac", codeSchema, token, now);
}

export function sealAccess(scope: TokenScope, payload: AccessPayload): string {
  return seal(scope.keys, "at", scope.issuer, accessSchema.parse(payload));
}

/** The payload of an intact, unexpired access token, or `undefined`. */
export function openAccess(
  scope: TokenScope,
  token: string,
  now: number,
): AccessPayload | undefined {
  return open(scope, "at", accessSchema, token, now);
}

export function sealRefresh(scope: TokenScope, payload: RefreshPayload): string {
  return seal(scope.keys, "rt", scope.issuer, refreshSchema.parse(payload));
}

/** The payload of an intact, unexpired refresh token, or `undefined`. */
export function openRefresh(
  scope: TokenScope,
  token: string,
  now: number,
): RefreshPayload | undefined {
  return open(scope, "rt", refreshSchema, token, now);
}

export function sealConsent(scope: TokenScope, payload: ConsentPayload): string {
  return seal(scope.keys, "cs", scope.issuer, consentSchema.parse(payload));
}

/** The payload of an intact, unexpired consent state, or `undefined`. */
export function openConsent(
  scope: TokenScope,
  token: string,
  now: number,
): ConsentPayload | undefined {
  return open(scope, "cs", consentSchema, token, now);
}

/**
 * The grant of an intact refresh or access token of this issuer, ignoring its expiry (revoking a
 * grant with an expired token of it is still a valid request), or `undefined`.
 */
export function grantOfToken(
  scope: TokenScope,
  token: string,
  prefer: "access_token" | "refresh_token",
): { readonly gid: string; readonly cid: string } | undefined {
  const order: readonly ["at" | "rt", z.ZodType<{ gid: string; cid: string }>][] =
    prefer === "access_token"
      ? [
          ["at", accessSchema],
          ["rt", refreshSchema],
        ]
      : [
          ["rt", refreshSchema],
          ["at", accessSchema],
        ];
  for (const [type, schema] of order) {
    const parsed = schema.safeParse(unseal(scope.keys, type, scope.issuer, token));
    if (parsed.success) return { gid: parsed.data.gid, cid: parsed.data.cid };
  }
  return undefined;
}

/** Epoch seconds of an epoch-millisecond clock reading. */
export function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** The scope string of `tiers` (`sevdesk:read sevdesk:write`), in tier order. */
export function scopeOf(tierList: Iterable<Tier>): string {
  const set = new Set(tierList);
  return TIERS.filter((t) => set.has(t))
    .map((t) => `${SCOPE_PREFIX}${t}`)
    .join(" ");
}

/**
 * The tiers named by `sevdesk:<tier>` entries of a `scope` parameter, or `undefined` when it names
 * none (absent scope, or only `offline_access` and other scopes this server ignores).
 */
export function tiersOfScope(scope: string | null | undefined): Set<Tier> | undefined {
  const named = new Set<Tier>();
  for (const entry of (scope ?? "").split(" ")) {
    if (!entry.startsWith(SCOPE_PREFIX)) continue;
    const name = entry.slice(SCOPE_PREFIX.length);
    const match = TIERS.find((t) => t === name);
    if (match !== undefined) named.add(match);
  }
  return named.size === 0 ? undefined : named;
}

/** Tiers in `a` and `b`, in tier order. */
export function intersectTiers(a: Iterable<Tier>, b: ReadonlySet<Tier>): Tier[] {
  const set = new Set(a);
  return TIERS.filter((t) => set.has(t) && b.has(t));
}
