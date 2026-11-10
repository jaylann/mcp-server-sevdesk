/**
 * Sealed tokens: authenticated encryption (AES-256-GCM) of a JSON payload under a purpose key
 * from `keys.ts`. Authorization codes, access and refresh tokens, the inbox session cookie and
 * the consent form state are sealed this way, so the server keeps no token database: the sevDesk
 * token a grant needs travels inside its own tokens, readable only with the server secret.
 *
 * Format: `sdmcp_<type>_` + base64url(version 0x01 ‖ kid (4) ‖ nonce (12) ‖ ciphertext ‖ tag (16)).
 * The additional authenticated data binds the type, the issuer and the key id, so a token cannot
 * be replayed as another type (whose key differs anyway) or at another server sharing the
 * secret. Nonces are random (96 bit); that is safe far beyond the number of tokens one key seals.
 *
 * The readable prefix lets log redaction and secret scanners find tokens
 * ({@link SEALED_TOKEN_PATTERN}). Opening never throws on bad input: it returns `undefined`, and
 * callers validate the payload's shape and expiry themselves.
 *
 * {@link sealBytes} / {@link openBytes} encrypt the bytes of transferred files (uploads, download
 * links) the same way, as raw bytes without a prefix: they never leave the server.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { type KeySet, KID_BYTES, type ServerKeys } from "./keys.js";

/** What a sealed token is: code, access, refresh, session cookie, consent state. */
export type SealType = "ac" | "at" | "rt" | "ss" | "cs";

const VERSION = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KID_BYTES + NONCE_BYTES;
/** Longest token accepted for opening (characters); refuses oversized input cheaply. */
export const MAX_SEALED_LENGTH = 8_192;

/** Finds sealed tokens in text, for redaction. */
export const SEALED_TOKEN_PATTERN = /sdmcp_(?:ac|at|rt|ss|cs)_[A-Za-z0-9_-]+/g;

/** Replaces every sealed token in `text` with `[redacted token]`. */
export function redactSealed(text: string): string {
  return text.replace(SEALED_TOKEN_PATTERN, "[redacted token]");
}

function prefix(type: SealType): string {
  return `sdmcp_${type}_`;
}

function aad(type: SealType, issuer: string, kid: Buffer): Buffer {
  return Buffer.from(`mcp-server-sevdesk|v1|${type}|${issuer}|${kid.toString("hex")}`, "utf8");
}

function keyFor(set: KeySet, type: SealType): Buffer {
  return set.key(`seal:${type}`);
}

/** Seals `payload` (JSON-serializable) as a `type` token of `issuer` under the current key. */
export function seal(keys: ServerKeys, type: SealType, issuer: string, payload: unknown): string {
  const set = keys.current;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(set, type), nonce);
  cipher.setAAD(aad(type, issuer, set.kid));
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([Buffer.from([VERSION]), set.kid, nonce, ciphertext, tag]);
  return `${prefix(type)}${body.toString("base64url")}`;
}

/**
 * Opens a `type` token of `issuer`, with the current or the previous key (by key id). Returns the
 * parsed JSON payload, or `undefined` for anything that is not an intact token of that type and
 * issuer. The payload is not validated here.
 */
export function unseal(keys: ServerKeys, type: SealType, issuer: string, token: string): unknown {
  if (token.length > MAX_SEALED_LENGTH) return undefined;
  const expected = prefix(type);
  if (!token.startsWith(expected)) return undefined;
  const encoded = token.slice(expected.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  const body = Buffer.from(encoded, "base64url");
  if (body.length < HEADER_BYTES + TAG_BYTES + 1 || body[0] !== VERSION) return undefined;
  const kid = body.subarray(1, 1 + KID_BYTES);
  const set = keys.byKid(kid);
  if (set === undefined) return undefined;
  const nonce = body.subarray(1 + KID_BYTES, HEADER_BYTES);
  const ciphertext = body.subarray(HEADER_BYTES, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(set, type), nonce);
    decipher.setAAD(aad(type, issuer, set.kid));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Version byte of {@link sealBytes} output. */
const BYTES_VERSION = 0x01;

function bytesAad(context: string): Buffer {
  return Buffer.from(`mcp-server-sevdesk|v1|fl|${context}`, "utf8");
}

/**
 * Encrypts `plaintext` (a transferred file) with AES-256-GCM under the `seal:fl` key of `keys`.
 * `context` is bound as additional data (the blob store passes `blobId|accountScope|kind`), so
 * the result opens only with the same context: a blob file swapped for another fails to open.
 * Output: version (1) ‖ nonce (12) ‖ ciphertext ‖ tag (16). No key id: the blob store's key set
 * is random per process (`createEphemeralKeys`), so nothing sealed survives a restart.
 */
export function sealBytes(keys: KeySet, context: string, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.key("seal:fl"), nonce);
  cipher.setAAD(bytesAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([BYTES_VERSION]), nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * Opens what {@link sealBytes} produced for the same `keys` and `context`. Returns `undefined`
 * for anything else (other key, other context, truncated or altered bytes); never throws on bad
 * input.
 */
export function openBytes(keys: KeySet, context: string, sealed: Uint8Array): Buffer | undefined {
  const body = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (body.length < 1 + NONCE_BYTES + TAG_BYTES || body[0] !== BYTES_VERSION) return undefined;
  const nonce = body.subarray(1, 1 + NONCE_BYTES);
  const ciphertext = body.subarray(1 + NONCE_BYTES, body.length - TAG_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.key("seal:fl"), nonce);
    decipher.setAAD(bytesAad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return undefined;
  }
}

/** Whether `token` was sealed with the previous key (it is resealed with the current one on refresh). */
export function sealedWithPrevious(keys: ServerKeys, token: string): boolean {
  if (keys.previous === undefined) return false;
  const match = /^sdmcp_[a-z]{2}_([A-Za-z0-9_-]+)$/.exec(token);
  if (match === null) return false;
  const body = Buffer.from(match[1] ?? "", "base64url");
  return body.length > KID_BYTES && body.subarray(1, 1 + KID_BYTES).equals(keys.previous.kid);
}
