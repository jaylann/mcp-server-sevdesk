/**
 * Server keys of the HTTP mode, all derived from one operator secret (`SEVDESK_HTTP_SECRET`) with
 * HKDF-SHA256, one key per purpose, so a token sealed for one purpose cannot be opened as another
 * and a CSRF tag cannot be confused with a cookie. The key id (`kid`, 4 bytes) is derived too: it
 * tells which secret sealed a token, so the previous secret (`SEVDESK_HTTP_SECRET_PREVIOUS`) can
 * still open tokens during a rotation.
 *
 * Rotating the secret without keeping the previous one signs every client out (all grants become
 * unreadable); that is the documented way to revoke everything at once.
 */
import { createHmac, hkdfSync, randomBytes } from "node:crypto";

/** Every purpose a key is derived for. `seal:<type>` keys encrypt tokens (`seal.ts`). */
const KEY_PURPOSES = [
  "seal:ac",
  "seal:at",
  "seal:rt",
  "seal:ss",
  "seal:cs",
  "csrf",
  "cookie",
  "kid",
] as const;

/** @public */
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/** Shortest accepted secret, after decoding. */
export const MIN_SECRET_BYTES = 32;
/** A secret must contain at least this many distinct byte values (refuses "aaaa…" and the like). */
const MIN_DISTINCT_BYTES = 16;
const HKDF_SALT = "mcp-server-sevdesk/v1";
const KEY_BYTES = 32;
export const KID_BYTES = 4;

/** The keys derived from one secret. */
export interface KeySet {
  /** Key id: 4 bytes, derived from the secret (not secret itself). */
  readonly kid: Buffer;
  /** The 32-byte key for `purpose`. */
  key(purpose: KeyPurpose): Buffer;
}

/** The current key set, plus the previous one while a rotation is in progress. */
export interface ServerKeys {
  readonly current: KeySet;
  readonly previous: KeySet | undefined;
  /** The key set whose id is `kid`, if any. */
  byKid(kid: Uint8Array): KeySet | undefined;
}

/**
 * Decodes an operator secret: hex (an even number of hex digits), or base64 / base64url. Returns
 * `undefined` when it is shorter than {@link MIN_SECRET_BYTES} after decoding or too uniform to be
 * random. Never include the value in a message.
 */
export function decodeSecret(raw: string): Uint8Array | undefined {
  const text = raw.trim();
  let bytes: Buffer;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(text) && text.length >= MIN_SECRET_BYTES * 2) {
    bytes = Buffer.from(text, "hex");
  } else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    // Node's base64 decoder accepts both alphabets (`+/` and `-_`).
    bytes = Buffer.from(text, "base64");
  } else {
    return undefined;
  }
  if (bytes.length < MIN_SECRET_BYTES) return undefined;
  if (new Set(bytes).size < MIN_DISTINCT_BYTES) return undefined;
  return new Uint8Array(bytes);
}

/** A fresh random secret for `generate-secret`: 32 bytes, base64url. */
export function generateSecret(): string {
  return randomBytes(MIN_SECRET_BYTES).toString("base64url");
}

/** Derives the key set of `secret` (which must already be decoded and checked). */
export function deriveKeySet(secret: Uint8Array): KeySet {
  if (secret.length < MIN_SECRET_BYTES) {
    throw new RangeError(`The secret must have at least ${String(MIN_SECRET_BYTES)} bytes.`);
  }
  const keys = new Map<KeyPurpose, Buffer>();
  for (const purpose of KEY_PURPOSES) {
    keys.set(purpose, Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, purpose, KEY_BYTES)));
  }
  const kid = (keys.get("kid") ?? Buffer.alloc(KEY_BYTES)).subarray(0, KID_BYTES);
  return {
    kid: Buffer.from(kid),
    key(purpose) {
      const key = keys.get(purpose);
      if (key === undefined) throw new RangeError(`Unknown key purpose: ${purpose}`);
      return key;
    },
  };
}

/**
 * The server keys for `secret` and, during a rotation, `previous`. Throws when both are the same
 * secret (the rotation would be a no-op that hides a configuration mistake).
 */
export function createServerKeys(secret: Uint8Array, previous?: Uint8Array): ServerKeys {
  const current = deriveKeySet(secret);
  const old = previous === undefined ? undefined : deriveKeySet(previous);
  if (old !== undefined && old.kid.equals(current.kid)) {
    throw new RangeError("SEVDESK_HTTP_SECRET_PREVIOUS must differ from SEVDESK_HTTP_SECRET.");
  }
  return {
    current,
    previous: old,
    byKid(kid) {
      const id = Buffer.from(kid);
      if (id.equals(current.kid)) return current;
      if (old !== undefined && id.equals(old.kid)) return old;
      return undefined;
    },
  };
}

/** HMAC-SHA256 of `data` under the `purpose` key, base64url (CSRF tags, cookie fingerprints). */
export function keyedTag(keys: KeySet, purpose: "csrf" | "cookie", data: string): string {
  return createHmac("sha256", keys.key(purpose)).update(data, "utf8").digest("base64url");
}
