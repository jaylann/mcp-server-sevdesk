/**
 * Client ID Metadata Documents (CIMD, MCP 2026-07-28): a client's `client_id` is an https URL
 * whose JSON document names the client and its redirect URIs. There is no registration endpoint;
 * the document is fetched when a user starts connecting.
 *
 * The URL is attacker-chosen, so fetching is fenced in:
 * - the `client_id` must be a canonical https URL with a DNS host, the default port, a path, and
 *   no query, fragment, credentials or dot segments;
 * - its host must be on the `SEVDESK_OAUTH_CLIENTS` allowlist (checked before any network I/O),
 *   which also defends against consent phishing through attacker-hosted documents;
 * - the host is resolved once and every address must be public (`ssrf.ts`); the request goes to
 *   that address with `https.request` (pinned `lookup`, SNI and certificate check for the host
 *   name), never through `fetch`;
 * - no redirects, 3 s to connect, 5 s in total, `application/json` only, at most 5 KiB;
 * - the document's `client_id` must equal the URL, it lists 1–10 redirect URIs, declares no
 *   client secret and no token endpoint auth method other than `none`.
 *
 * Good documents are cached (LRU of 64, `max-age` clamped to 60 s–24 h); failures never are.
 */
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";

import { z } from "zod";

import { sanitizeUntrusted } from "../../safety/fence.js";
import type { HttpLog } from "../types.js";
import {
  type ResolvedAddress,
  resolvePublicAddress,
  type Resolver,
  SsrfError,
  systemResolver,
} from "./ssrf.js";

/** Largest metadata document accepted. */
const MAX_DOCUMENT_BYTES = 5 * 1024;
const CONNECT_TIMEOUT_MS = 3_000;
/** Host name resolution gets its own budget: the system resolver can wait much longer. */
const RESOLVE_TIMEOUT_MS = 3_000;
const TOTAL_TIMEOUT_MS = 5_000;
const CACHE_SIZE = 64;
const MIN_CACHE_SECONDS = 60;
const MAX_CACHE_SECONDS = 86_400;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 80;

/** A validated client metadata document. */
export interface ClientMetadata {
  /** The `client_id` (the document's URL). */
  readonly clientId: string;
  /** Host of the `client_id` (what the consent page and `grants list` show). */
  readonly host: string;
  /** The client's self-declared name, sanitized; untrusted. */
  readonly name: string | undefined;
  readonly redirectUris: readonly string[];
}

export type CimdErrorReason =
  | "invalid_client_id"
  | "client_not_allowed"
  | "unresolvable"
  | "blocked_address"
  | "fetch_failed"
  | "redirect"
  | "bad_status"
  | "bad_content_type"
  | "too_large"
  | "invalid_document";

/** Why a client could not be accepted. The message is trusted text (no document content). */
export class CimdError extends Error {
  readonly reason: CimdErrorReason;

  constructor(reason: CimdErrorReason, message: string) {
    super(message);
    this.name = "CimdError";
    this.reason = reason;
  }
}

/** One HTTPS GET to an already checked address. */
export interface HttpsGetRequest {
  /** Host name: sent as `Host` and SNI, and checked against the certificate. */
  readonly hostname: string;
  /** Path and nothing else (no query). */
  readonly path: string;
  /** The checked address to connect to. */
  readonly address: ResolvedAddress;
}

/** The response headers the fetcher looks at; everything else is dropped. */
const READ_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
] as const;

export interface HttpsGetResponse {
  readonly status: number;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

/**
 * Performs one request. Rejects on network errors, timeouts and bodies over
 * {@link MAX_DOCUMENT_BYTES}; never follows redirects.
 */
export type HttpsGet = (request: HttpsGetRequest) => Promise<HttpsGetResponse>;

export interface HttpsGetOptions {
  readonly connectTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxBytes?: number;
  /** Tests only: the port to connect to (default 443) and extra trusted CAs. */
  readonly port?: number;
  readonly ca?: string | Buffer;
}

/** The production {@link HttpsGet}: `https.request` pinned to the checked address. */
export function createHttpsGet(options: HttpsGetOptions = {}): HttpsGet {
  const connectTimeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const totalTimeout = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_BYTES;
  return (target) =>
    new Promise<HttpsGetResponse>((resolve, reject) => {
      const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all === true) {
          callback(null, [{ address: target.address.address, family: target.address.family }]);
        } else {
          callback(null, target.address.address, target.address.family);
        }
      };
      let settled = false;
      const request = httpsRequest({
        host: target.hostname,
        servername: target.hostname,
        port: options.port ?? 443,
        path: target.path,
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "mcp-server-sevdesk (CIMD)" },
        lookup: pinned,
        agent: false,
        maxHeaderSize: 16 * 1024,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      });
      const totalTimer = setTimeout(() => {
        finish(new Error("timeout"));
      }, totalTimeout);
      const connectTimer = setTimeout(() => {
        finish(new Error("connect timeout"));
      }, connectTimeout);
      function finish(error: Error | undefined, response?: HttpsGetResponse): void {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(connectTimer);
        if (error !== undefined) {
          request.destroy();
          reject(error);
        } else if (response !== undefined) {
          resolve(response);
        }
      }
      request.once("socket", (socket) => {
        socket.once("secureConnect", () => {
          clearTimeout(connectTimer);
        });
      });
      request.once("error", (error) => {
        finish(error);
      });
      request.once("response", (response) => {
        const status = response.statusCode ?? 0;
        // Only the headers the fetcher reads, into an object without a prototype: header names
        // come from the remote host and must never become arbitrary property names.
        const headers: Record<string, string | undefined> = Object.create(null) as Record<
          string,
          string | undefined
        >;
        for (const name of READ_HEADERS) {
          const value = response.headers[name];
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        if (status !== 200) {
          // Redirects and errors are not followed or read.
          response.destroy();
          finish(undefined, { status, headers, body: Buffer.alloc(0) });
          return;
        }
        if (Number(headers["content-length"] ?? "0") > maxBytes) {
          response.destroy();
          finish(new CimdError("too_large", "The client's metadata document is too large."));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            finish(new CimdError("too_large", "The client's metadata document is too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          finish(undefined, { status, headers, body: Buffer.concat(chunks) });
        });
        response.once("error", (error) => {
          finish(error);
        });
      });
      request.end();
    });
}

/**
 * The `client_id` as a URL when it is acceptable as a CIMD URL: https, a DNS host name (not an
 * IP literal), the default port, a non-root path, no query, fragment, credentials or dot
 * segments, and canonical (`href` equals the input).
 */
export function parseClientIdUrl(raw: string): URL | undefined {
  if (raw.length === 0 || raw.length > MAX_CLIENT_ID_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.href !== raw || url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  if (raw.includes("?") || raw.includes("#") || url.pathname === "/") return undefined;
  const host = url.hostname;
  if (host.startsWith("[") || isIP(host) !== 0) return undefined;
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(
      host,
    )
  ) {
    return undefined;
  }
  return url;
}

const documentSchema = z.looseObject({
  client_id: z.string(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
  client_name: z.string().max(1000).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.string()).max(10).optional(),
  response_types: z.array(z.string()).max(10).optional(),
});

/** Parses and checks a document body for `clientId`. */
function parseDocument(body: Buffer, url: URL): ClientMetadata {
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new CimdError("invalid_document", "The client's metadata document is not valid JSON.");
  }
  const parsed = documentSchema.safeParse(json);
  if (!parsed.success) {
    throw new CimdError(
      "invalid_document",
      "The client's metadata document lacks redirect URIs or declares an unsupported " +
        "authentication method.",
    );
  }
  const doc = parsed.data;
  if (doc.client_id !== url.href) {
    throw new CimdError(
      "invalid_document",
      "The client's metadata document names a different client_id than its own URL.",
    );
  }
  if (Object.keys(doc).some((key) => key.startsWith("client_secret"))) {
    throw new CimdError("invalid_document", "The client's metadata document declares a secret.");
  }
  if (doc.grant_types !== undefined && !doc.grant_types.includes("authorization_code")) {
    throw new CimdError(
      "invalid_document",
      "The client's metadata document does not allow the authorization code flow.",
    );
  }
  if (doc.response_types !== undefined && !doc.response_types.includes("code")) {
    throw new CimdError(
      "invalid_document",
      "The client's metadata document does not allow the code response type.",
    );
  }
  const name =
    doc.client_name === undefined
      ? undefined
      : sanitizeUntrusted(doc.client_name, MAX_NAME_LENGTH).replace(/\s+/g, " ").trim();
  return {
    clientId: url.href,
    host: url.hostname,
    name: name === "" ? undefined : name,
    redirectUris: doc.redirect_uris,
  };
}

/** `promise`, or a rejection after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("timeout"));
    }, ms);
  });
  return Promise.race([promise, expired]).finally(() => {
    clearTimeout(timer);
  });
}

function cacheSeconds(header: string | undefined): number {
  const match = /(?:^|[,\s])max-age=(\d{1,10})(?:$|[,\s])/i.exec(header ?? "");
  const value = match?.[1] === undefined ? MIN_CACHE_SECONDS : Number(match[1]);
  return Math.min(MAX_CACHE_SECONDS, Math.max(MIN_CACHE_SECONDS, value));
}

export interface CimdFetcherOptions {
  /** Allowed `client_id` hosts (`SEVDESK_OAUTH_CLIENTS`), or `any`. */
  readonly clients: readonly string[] | "any";
  readonly resolve?: Resolver;
  /** Default 3 s. */
  readonly resolveTimeoutMs?: number;
  readonly get?: HttpsGet;
  readonly now: () => number;
  readonly log: HttpLog;
}

export interface CimdFetcher {
  /** The validated metadata of `clientId`; rejects with {@link CimdError}. */
  readonly load: (clientId: string) => Promise<ClientMetadata>;
}

interface CacheEntry {
  readonly metadata: ClientMetadata;
  readonly expiresAt: number;
}

/** Loads client metadata documents under the rules in the module comment. */
export function createCimdFetcher(options: CimdFetcherOptions): CimdFetcher {
  const resolve = options.resolve ?? systemResolver;
  const get = options.get ?? createHttpsGet();
  const allowed =
    options.clients === "any" ? "any" : new Set(options.clients.map((h) => h.toLowerCase()));
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ClientMetadata>>();

  async function fetchDocument(url: URL): Promise<ClientMetadata> {
    let address: ResolvedAddress;
    try {
      address = await resolvePublicAddress(url.hostname, (hostname) =>
        withTimeout(resolve(hostname), options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS),
      );
    } catch (error) {
      if (error instanceof SsrfError && error.reason === "unresolvable") {
        throw new CimdError("unresolvable", "The client's host could not be resolved.");
      }
      throw new CimdError(
        "blocked_address",
        "The client's host resolves to an address this server does not connect to.",
      );
    }
    let response: HttpsGetResponse;
    try {
      response = await get({ hostname: url.hostname, path: url.pathname, address });
    } catch (error) {
      if (error instanceof CimdError) throw error;
      throw new CimdError("fetch_failed", "The client's metadata document could not be loaded.");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CimdError(
        "redirect",
        "The client's metadata document redirects; redirects are not followed.",
      );
    }
    if (response.status !== 200) {
      throw new CimdError("bad_status", "The client's metadata document could not be loaded.");
    }
    const type = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      throw new CimdError("bad_content_type", "The client's metadata document is not JSON.");
    }
    if (response.body.length > MAX_DOCUMENT_BYTES) {
      throw new CimdError("too_large", "The client's metadata document is too large.");
    }
    const metadata = parseDocument(response.body, url);
    remember(url.href, metadata, cacheSeconds(response.headers["cache-control"]));
    return metadata;
  }

  function remember(key: string, metadata: ClientMetadata, seconds: number): void {
    cache.delete(key);
    if (cache.size >= CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { metadata, expiresAt: options.now() + seconds * 1000 });
  }

  async function load(clientId: string): Promise<ClientMetadata> {
    const url = parseClientIdUrl(clientId);
    if (url === undefined) {
      throw new CimdError(
        "invalid_client_id",
        "The client_id is not an https URL of a client metadata document.",
      );
    }
    if (allowed !== "any" && !allowed.has(url.hostname)) {
      throw new CimdError("client_not_allowed", "This server does not accept that client.");
    }
    const cached = cache.get(url.href);
    if (cached !== undefined) {
      if (cached.expiresAt > options.now()) {
        cache.delete(url.href);
        cache.set(url.href, cached);
        return cached.metadata;
      }
      cache.delete(url.href);
    }
    const pending = inFlight.get(url.href);
    if (pending !== undefined) return pending;
    const started = fetchDocument(url).finally(() => {
      inFlight.delete(url.href);
    });
    inFlight.set(url.href, started);
    return started;
  }

  return {
    async load(clientId) {
      try {
        return await load(clientId);
      } catch (error) {
        const reason = error instanceof CimdError ? error.reason : "fetch_failed";
        const host = parseClientIdUrl(clientId)?.hostname;
        options.log.warn("cimd_blocked", { reason, ...(host === undefined ? {} : { host }) });
        if (error instanceof CimdError) throw error;
        throw new CimdError("fetch_failed", "The client's metadata document could not be loaded.");
      }
    },
  };
}
