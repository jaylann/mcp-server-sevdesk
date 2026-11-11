/**
 * Small helpers for the server's own HTML pages (the consent page, the approval inbox) on Web
 * `Request`/`Response`: constant-time comparison, cookies, same-origin checks, bounded form
 * reading and HTML responses under a strict Content-Security-Policy.
 *
 * Pages built with these have no scripts, one inline style block allowed by a per-response nonce,
 * fonts and images only from the server's own `/assets/` path (`src/pages/assets.ts`), no framing,
 * and forms only to themselves (plus, for the consent page, the one validated redirect origin,
 * because browsers apply `form-action` to the redirect after a form POST).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { assetSource } from "../pages/assets.js";
import type { PageContext } from "../pages/context.js";

/**
 * Compares two strings in constant time (by their SHA-256 digests, so the length of the expected
 * value does not leak either).
 */
export function safeEqual(received: string, expected: string): boolean {
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && received.length === expected.length;
}

/** A random id or secret: `bytes` random bytes, base64url (default 32 bytes = 256 bit). */
export function randomId(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A nonce for the page's inline style block. */
export function styleNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** The value of cookie `name` in a `Cookie` header, if present. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  /** Default `/`. A `__Host-` cookie must use `/`. */
  readonly path?: string;
  /** `Secure`; required for `__Host-` cookies (https). */
  readonly secure: boolean;
  readonly sameSite: "Strict" | "Lax";
}

/** A `Set-Cookie` value: always `HttpOnly`. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) && !/^__Host-[A-Za-z0-9_-]+$/.test(name)) {
    throw new RangeError(`Invalid cookie name: ${name}`);
  }
  if (!/^[A-Za-z0-9_.~-]*$/.test(value)) throw new RangeError("Invalid cookie value.");
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
    "HttpOnly",
    `SameSite=${options.sameSite}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** A `Set-Cookie` value that deletes cookie `name`. */
export function clearCookie(name: string, options: Omit<CookieOptions, "maxAgeSeconds">): string {
  return serializeCookie(name, "", { ...options, maxAgeSeconds: 0 });
}

/**
 * Whether a POST comes from the server's own page: `Origin` equals `origin`, or, without an
 * `Origin` header, `Sec-Fetch-Site: same-origin` (set by the browser). `Origin: null` (opaque or
 * privacy-stripped) is always refused; pages use the `same-origin` referrer policy so browsers
 * send the real origin.
 */
export function sameOriginPost(request: Request, origin: string): boolean {
  const received = request.headers.get("origin");
  if (received !== null) return received === origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** Why a form could not be read. */
export class FormError extends Error {
  readonly reason: "unsupported_type" | "too_large" | "malformed";

  constructor(reason: FormError["reason"]) {
    super(`The form could not be read (${reason}).`);
    this.name = "FormError";
    this.reason = reason;
  }
}

/**
 * Reads an `application/x-www-form-urlencoded` body of at most `maxBytes` bytes. Rejects with
 * {@link FormError}.
 */
export async function readForm(request: Request, maxBytes: number): Promise<URLSearchParams> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new FormError("unsupported_type");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new FormError("too_large");
  if (request.body === null) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the stream, so an oversized body is not read to the end.
  for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new FormError("too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.includes("\u0000")) throw new FormError("malformed");
  return new URLSearchParams(text);
}

export interface HtmlResponseOptions {
  readonly status: number;
  /** The nonce of the page's inline style block (from {@link styleNonce}). */
  readonly nonce: string;
  /**
   * The request's page context: the language the page was rendered in, and the server's origin,
   * whose `/assets/` path is the only place the page may load fonts and images from.
   */
  readonly page: PageContext;
  /**
   * Origins forms may submit to besides the page itself: the consent page adds the validated
   * redirect origin, because `form-action` also covers the redirect after the POST.
   */
  readonly formActions?: readonly string[];
  /**
   * Send `Cross-Origin-Opener-Policy: same-origin` (default true). Off on the consent page:
   * it would cut the link to the client window that opened it.
   */
  readonly isolateOpener?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** An HTML response with the page security headers. */
export function htmlResponse(html: string, options: HtmlResponseOptions): Response {
  const formAction = ["'self'", ...(options.formActions ?? [])].join(" ");
  // Not `'self'`: other paths of the origin (a download link counts its uses) are no business of
  // an image or font request.
  const assets = assetSource(options.page.origin);
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'nonce-${options.nonce}'; font-src ${assets}; ` +
      `img-src ${assets}; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    // Not `no-referrer`: under it browsers send `Origin: null` with form POSTs, which
    // sameOriginPost must refuse. `same-origin` keeps the page's URL from other sites.
    "Referrer-Policy": "same-origin",
    // no-transform: proxies must not rewrite the page (Cloudflare, for example, replaces e-mail
    // addresses in HTML with a script-based link unless told not to).
    "Cache-Control": "no-store, no-transform",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Language": options.page.locale,
    Vary: "Accept-Language",
  });
  if (options.isolateOpener ?? true) headers.set("Cross-Origin-Opener-Policy", "same-origin");
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  return new Response(html, { status: options.status, headers });
}
