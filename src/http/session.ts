/**
 * Browser sessions of the approval inbox (`/approvals`, HTTP mode with `SEVDESK_CONFIRM=browser`).
 *
 * A session proves that the browser holds the sevDesk account: it is created at OAuth consent
 * (the user pasted the account's token there) or by a login on the inbox with the token. The
 * {@link SessionStore} keeps the session record (account, grant, expiry; never a token); the
 * browser holds a cookie with the sealed (`ss`, AES-GCM) payload `{v, sid, acct, gid, iat, exp}`.
 * Both must agree: a cookie that does not unseal under the server keys for this origin, has
 * expired, or names a session the store no longer has (logged out, revoked with its grant,
 * expired, lost on a restart) is no session.
 *
 * Cookie: `__Host-sevdesk_session` with `Secure` (and `Path=/`, no `Domain`, as the prefix
 * requires) on an https origin. On a plain-http loopback origin (development) browsers refuse the
 * prefix and `Secure`, so the cookie is `sevdesk_session` without them. Always `HttpOnly` and
 * `SameSite=Lax`: the inbox link is clicked inside the client (claude.ai), a cross-site top-level
 * navigation that must carry the cookie, while cross-site POSTs do not get it (decisions also need
 * a CSRF tag and a same-origin `Origin`).
 *
 * Every login creates a new session id (no fixation). Without `SEVDESK_HTTP_SECRET` (bearer mode),
 * {@link createEphemeralKeys} gives a per-process key set: sessions then end with the process.
 */
import { randomBytes } from "node:crypto";

import { z } from "zod";

import { clearCookie, readCookie, serializeCookie } from "../safety/web.js";
import { createServerKeys, MIN_SECRET_BYTES, type ServerKeys } from "./keys.js";
import { seal, unseal } from "./seal.js";
import type { SessionRecord, SessionStore } from "./types.js";

/** Default session lifetime: 12 hours. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const SECURE_COOKIE_NAME = "__Host-sevdesk_session";
const PLAIN_COOKIE_NAME = "sevdesk_session";
const PAYLOAD_VERSION = 1;
/** How far `iat` may lie in the future (clock differences between restarts). */
const MAX_CLOCK_SKEW_SECONDS = 60;

/** The sealed cookie payload. Ids only; the store has the rest. */
const SessionPayload = z.strictObject({
  v: z.literal(PAYLOAD_VERSION),
  sid: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  acct: z.string().min(1).max(64),
  gid: z.string().min(1).max(64).optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

type SessionPayload = z.infer<typeof SessionPayload>;

/** Whether `origin` is served over https (then the cookie is `__Host-` and `Secure`). */
function isSecureOrigin(origin: string): boolean {
  return origin.startsWith("https://");
}

/** Name of the session cookie for `origin`: `__Host-sevdesk_session` on https, else `sevdesk_session`. */
export function sessionCookieName(origin: string): string {
  return isSecureOrigin(origin) ? SECURE_COOKIE_NAME : PLAIN_COOKIE_NAME;
}

export interface CreateSessionCookieInput {
  readonly keys: ServerKeys;
  readonly store: SessionStore;
  /** The sevDesk account the browser proved (`SevClient` id). */
  readonly accountId: string;
  /** The grant whose consent creates the session; the session is revoked together with it. */
  readonly gid?: string | undefined;
  readonly via: "consent" | "token";
  /** The public origin (`https://mcp.example.com`); also the issuer the cookie is sealed for. */
  readonly origin: string;
  /** Session lifetime, normally {@link SESSION_TTL_SECONDS}. */
  readonly ttlSeconds: number;
}

/**
 * Creates a new session in the store and returns the `Set-Cookie` value that hands it to the
 * browser. Each call creates a new session id; the caller revokes a session it replaces. Secret:
 * the returned value must only ever go into a `Set-Cookie` header, never into a log or a page.
 */
export async function createSessionCookie(input: CreateSessionCookieInput): Promise<string> {
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new RangeError("The session lifetime must be a positive number of seconds.");
  }
  const record = await input.store.createSession({
    accountId: input.accountId,
    gid: input.gid,
    via: input.via,
    ttlSeconds: input.ttlSeconds,
  });
  const payload: SessionPayload = {
    v: PAYLOAD_VERSION,
    sid: record.sid,
    acct: record.accountId,
    ...(record.gid === undefined ? {} : { gid: record.gid }),
    iat: record.createdAt,
    exp: record.expiresAt,
  };
  return serializeCookie(
    sessionCookieName(input.origin),
    seal(input.keys, "ss", input.origin, payload),
    {
      maxAgeSeconds: record.expiresAt - record.createdAt,
      secure: isSecureOrigin(input.origin),
      sameSite: "Lax",
    },
  );
}

export interface ReadSessionOptions {
  readonly keys: ServerKeys;
  readonly store: SessionStore;
  /** The public origin the cookie was sealed for. */
  readonly origin: string;
  /** Epoch milliseconds (default `Date.now`). */
  readonly now?: () => number;
}

/**
 * The session of `request`: its cookie must unseal under the server keys (current or previous)
 * for this origin, carry a valid payload, be unexpired, and name a session the store still has
 * for the same account and grant. `undefined` otherwise; never throws on bad input.
 */
export function readSession(
  request: Request,
  options: ReadSessionOptions,
): SessionRecord | undefined {
  const raw = readCookie(request.headers.get("cookie"), sessionCookieName(options.origin));
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = SessionPayload.safeParse(unseal(options.keys, "ss", options.origin, raw));
  if (!parsed.success) return undefined;
  const payload = parsed.data;
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (payload.exp <= now || payload.exp <= payload.iat) return undefined;
  if (payload.iat > now + MAX_CLOCK_SKEW_SECONDS) return undefined;
  const record = options.store.getSession(payload.sid);
  if (record === undefined) return undefined;
  if (record.accountId !== payload.acct || record.gid !== payload.gid) return undefined;
  if (record.expiresAt <= now) return undefined;
  return record;
}

/** A `Set-Cookie` value that deletes the session cookie of `origin`. */
export function clearSessionCookie(origin: string): string {
  return clearCookie(sessionCookieName(origin), {
    secure: isSecureOrigin(origin),
    sameSite: "Lax",
  });
}

/**
 * Server keys from fresh random bytes, for bearer mode without `SEVDESK_HTTP_SECRET`: inbox
 * sessions (and their CSRF tags) then only hold until the process ends.
 */
export function createEphemeralKeys(): ServerKeys {
  return createServerKeys(new Uint8Array(randomBytes(MIN_SECRET_BYTES)));
}
