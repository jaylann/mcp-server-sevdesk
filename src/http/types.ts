/**
 * Contracts of the HTTP mode (`--http`): configuration, routes, authentication and the small state
 * store. The pieces are built by separate modules (`serve.ts` and the router, `bearer.ts`,
 * `oauth/`, `approval-routes.ts`) and composed in `src/index.ts`.
 *
 * Request handling works on Web `Request`/`Response` objects; `node-bridge.ts` converts from and
 * to `node:http`. URLs the server prints or redirects to are always built from the configured
 * public origin, never from `Host` or `X-Forwarded-*` headers.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";

import type { Tier } from "../safety/tiers.js";

export type HttpAuthMode = "bearer" | "oauth";

/** OAuth settings (`SEVDESK_OAUTH_*`). */
export interface OAuthSettings {
  /** sevDesk account ids (`SevClient` ids) that may connect, or `any` (explicit multi-tenant). */
  readonly accounts: readonly string[] | "any";
  /** Hosts allowed to serve a CIMD `client_id` (default `claude.ai`), or `any`. */
  readonly clients: readonly string[] | "any";
  /** Access token lifetime (default 3600 s). */
  readonly accessTtlSeconds: number;
  /** A refresh token expires after this long unused (default 14 days). */
  readonly refreshIdleTtlSeconds: number;
  /** Absolute grant lifetime from consent (default 90 days). */
  readonly grantTtlSeconds: number;
}

/** Remote file transfer (`SEVDESK_HTTP_FILES`, on by default): upload pages and download links. */
export interface HttpFilesConfig {
  /** `SEVDESK_HTTP_FILES_MAX_MB` in bytes: what all uploads and links hold together. */
  readonly maxBytes: number;
  /** `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`: live tickets, uploads and links per account (1–1000). */
  readonly maxPerAccount: number;
  /** `SEVDESK_HTTP_FILES_TTL`: lifetime of an uploaded file and of a download link. */
  readonly ttlSeconds: number;
}

/** Validated HTTP-mode configuration (`loadHttpConfig` in `config.ts`). */
export interface HttpConfig {
  readonly auth: HttpAuthMode;
  /** Bind address (default `127.0.0.1`). */
  readonly host: string;
  /** Bind port (default `$PORT`, else 8080; 0 picks a free port, for tests). */
  readonly port: number;
  /**
   * The public origin (`SEVDESK_HTTP_PUBLIC_URL`), e.g. `https://mcp.example.com`, without a
   * trailing slash. `undefined` only for a loopback bind without one; the origin is then
   * `http://127.0.0.1:<port>` once listening.
   */
  readonly publicOrigin: string | undefined;
  /** Hostnames accepted in `Host` (from the public origin plus `SEVDESK_HTTP_ALLOWED_HOSTS`). */
  readonly allowedHosts: readonly string[];
  /** Origins accepted in `Origin` on `/mcp` (the public origin plus `SEVDESK_HTTP_ALLOWED_ORIGINS`). */
  readonly allowedOrigins: readonly string[];
  /** Trusted reverse-proxy hops in `X-Forwarded-For` (0–5). */
  readonly trustProxy: number;
  /** `SEVDESK_HTTP_STATE_DIR`: where grants and sessions persist; `undefined` keeps them in memory. */
  readonly stateDir: string | undefined;
  /** Bearer mode: the accepted secrets (one, or two while rotating). Secret. */
  readonly bearerTokens: readonly string[];
  /** `SEVDESK_HTTP_SECRET` decoded (≥ 32 bytes); required for OAuth. Secret. */
  readonly secret: Uint8Array | undefined;
  /** `SEVDESK_HTTP_SECRET_PREVIOUS` decoded, accepted for opening tokens during rotation. Secret. */
  readonly previousSecret: Uint8Array | undefined;
  /** OAuth only. */
  readonly oauth: OAuthSettings | undefined;
  /** Remote file transfer; `undefined` with `SEVDESK_HTTP_FILES=off`. */
  readonly files?: HttpFilesConfig | undefined;
}

/** Structured, redacted log lines on stderr (one JSON object per line). */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

export interface HttpLog {
  info(event: string, fields?: LogFields): void;
  /** Security-relevant events (`refresh_replay`, `code_replay`, `account_refused`, …). */
  warn(event: string, fields?: LogFields): void;
}

/** A token bucket: `perMinute` sustained, bursts up to `burst` (default `perMinute`). */
export interface RateRule {
  /** Bucket family, e.g. `token-check`; buckets are keyed by family plus key. */
  readonly name: string;
  readonly perMinute: number;
  readonly burst?: number;
}

/** Per-request context the router hands to route handlers. */
export interface HttpRequestContext {
  /** Client IP after `SEVDESK_HTTP_TRUST_PROXY` (the socket address without proxies). */
  readonly clientIp: string;
  /** The public origin, e.g. `https://mcp.example.com`. */
  readonly origin: string;
  /** Aborted when the client disconnects or the per-request deadline passes. */
  readonly signal: AbortSignal;
  readonly log: HttpLog;
  /** Takes one token from the bucket `rule.name` + `key`; false when it is empty (answer 429). */
  limit(rule: RateRule, key: string): boolean;
}

/** Answers a request, or `undefined` to let the router answer 404. */
type RouteHandler = (request: Request, ctx: HttpRequestContext) => Promise<Response | undefined>;

/**
 * Which `Origin` a route accepts:
 * - `mcp`: the SDK's `originValidationResponse` against {@link HttpConfig.allowedOrigins} (no
 *   `Origin` passes: non-browser clients send none);
 * - `form`: GET and HEAD pass; POST must come from the server's own pages (exact origin, or
 *   `Sec-Fetch-Site: same-origin` without one; never `Origin: null`);
 * - `none`: no check (`/token`, `/revoke` and metadata, protected by PKCE and CORS without
 *   credentials).
 */
export type OriginPolicy = "mcp" | "form" | "none";

export interface HttpRoute {
  /** Exact path (`/token`), or a prefix ending in `/` with `match: "prefix"` (`/approvals/`). */
  readonly path: string;
  readonly match?: "exact" | "prefix";
  /** Allowed methods; others get 405 with `Allow`. `HEAD` is never implied. */
  readonly methods: readonly string[];
  /** Largest request body accepted; larger bodies get 413 before the handler runs. */
  readonly maxBodyBytes: number;
  readonly origin: OriginPolicy;
  /** Applied per client IP before the handler runs. */
  readonly rateLimit?: RateRule;
  /** Default true. `/healthz` opts out: platform health checks send their own `Host`. */
  readonly hostCheck?: boolean;
  /**
   * Checks the request on its headers alone, after the Origin policy (and authentication) and
   * before the body is read: a refusal here means the body is never read (an upload without a
   * session, of a used ticket, or declaring too many bytes). Runs for every method; `undefined`
   * or a {@link PreflightPass} lets the request go on.
   */
  readonly preflight?: (
    head: Request,
    ctx: HttpRequestContext,
  ) => Promise<Response | PreflightPass | undefined>;
  /** Time this route's body may take to arrive (default: the router's, 15 s; 408 beyond). */
  readonly bodyTimeoutMs?: number;
  /**
   * How fast this route's body must keep arriving (default: no check besides `bodyTimeoutMs`): a
   * body that sends nothing for `idleMs`, or that after `graceMs` has averaged fewer than
   * `minBytesPerSecond`, gets a 408 at once. Keeps a trickled body from holding a body slot for
   * the whole `bodyTimeoutMs`. Checked about once a second.
   */
  readonly bodyPace?: BodyPace;
  /**
   * Requests with a body on this route at once, each counted from its preflight until its
   * response is complete. Bounds the memory large uploads take, and keeps one party from taking
   * them all. The router keeps the counts, so no refusal can leak a slot.
   * - `max`: on the whole route; beyond it the router answers `busy("route")`;
   * - `perKey`: per {@link PreflightPass.bodySlotKey} (e.g. the session's account); beyond it the
   *   router answers `busy("key")`. Requests whose preflight names no key share one key;
   * - `busy`: the refusal for the request with these headers (default: a JSON 503).
   */
  readonly bodySlots?: {
    readonly max: number;
    readonly perKey?: number;
    readonly busy?: (scope: "route" | "key", head: Request) => Response;
  };
  readonly handle: RouteHandler;
}

/** What a preflight that lets the request go on may tell the router. */
export interface PreflightPass {
  /** The key the route's `bodySlots.perKey` counts this request under. Never logged. */
  readonly bodySlotKey?: string;
}

/** See {@link HttpRoute.bodyPace}. */
export interface BodyPace {
  readonly idleMs: number;
  readonly graceMs: number;
  readonly minBytesPerSecond: number;
}

/**
 * Verifies the credentials of an MCP request. Returns the `AuthInfo` handed to the MCP handler,
 * or the challenge response (401/403 with `WWW-Authenticate`).
 */
export interface HttpAuthenticator {
  authenticate(request: Request, ctx: HttpRequestContext): Promise<AuthInfo | Response>;
}

/** A grant: one consented connection of one client to one account. Never holds a token. */
export interface GrantRecord {
  /** Random id (base64url, 128 bit). */
  readonly gid: string;
  readonly accountId: string;
  /** The CIMD `client_id` URL. */
  readonly clientId: string;
  /** Host of the `client_id` (shown in `grants list`). */
  readonly clientHost: string;
  /** Granted tiers (always includes `read`). */
  readonly tiers: readonly Tier[];
  /** Epoch seconds. */
  readonly createdAt: number;
  /** Absolute expiry, epoch seconds. */
  readonly expiresAt: number;
  /** `pending` until the authorization code is exchanged. */
  readonly status: "pending" | "active" | "revoked";
  /** Current refresh-token generation (1 after the code exchange). */
  readonly gen: number;
  /** When `gen` last advanced, epoch seconds (for the 30 s reuse grace). */
  readonly rotatedAt: number | undefined;
  readonly revokedAt: number | undefined;
  /** Why it was revoked (`user`, `operator`, `refresh_replay`, `code_replay`, `sevdesk_401`). */
  readonly reason: string | undefined;
}

/** A browser session of the approval inbox. Never holds a token. */
export interface SessionRecord {
  /** Random id (base64url, 128 bit); rotated on every login. */
  readonly sid: string;
  readonly accountId: string;
  /** The grant whose consent created the session, if any; revoked together with it. */
  readonly gid: string | undefined;
  readonly via: "consent" | "token";
  /** Epoch seconds. */
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Sessions of the approval inbox (both auth modes). */
export interface SessionStore {
  createSession(input: {
    readonly accountId: string;
    readonly gid?: string | undefined;
    readonly via: "consent" | "token";
    readonly ttlSeconds: number;
  }): Promise<SessionRecord>;
  /** The session when it exists, is unexpired and not revoked, and its grant (if any) is not revoked. */
  getSession(sid: string): SessionRecord | undefined;
  revokeSession(sid: string): Promise<void>;
  /**
   * Applies events another process appended (`grants revoke`; at most once per second unless
   * forced). Awaited before a session is trusted, since `getSession` answers from memory.
   */
  sync(force?: boolean): Promise<void>;
}

/** Result of {@link GrantStore.rotate}. */
export type RotateResult =
  | { readonly ok: true; readonly gen: number }
  | { readonly ok: false; readonly reason: "replay" | "unknown" | "revoked" | "expired" };

/**
 * Grants and sessions (OAuth mode; sessions also in bearer mode). Holds only non-secret metadata.
 * With a state directory it persists as an append-only `grants.jsonl` (mode 0600) that the
 * `grants revoke` command can append to while the server runs; {@link GrantStore.sync} reads such
 * appended events. One live server per directory (heartbeat lock).
 */
export interface GrantStore extends SessionStore {
  createPending(input: {
    readonly accountId: string;
    readonly clientId: string;
    readonly clientHost: string;
    readonly tiers: readonly Tier[];
    readonly ttlSeconds: number;
  }): Promise<GrantRecord>;
  /**
   * Marks the grant active when its authorization code `codeJti` is exchanged for the first time.
   * A second exchange of a code for an active or revoked grant is a replay: the grant is revoked.
   */
  activate(gid: string, codeJti: string): Promise<"activated" | "replay" | "unknown">;
  /**
   * Checks a presented refresh-token generation: the current one advances `gen`; the previous one
   * within 30 s of the last rotation is accepted without advancing (concurrent refreshes);
   * anything else is a replay and revokes the grant.
   */
  rotate(gid: string, presentedGen: number): Promise<RotateResult>;
  /** The grant when known (any status). */
  get(gid: string): GrantRecord | undefined;
  /** Revokes one grant and its sessions; false when unknown. */
  revoke(gid: string, reason: string): Promise<boolean>;
  /** Revokes every grant of an account and their sessions; returns how many were active. */
  revokeAccount(accountId: string, reason: string): Promise<number>;
  /**
   * Revokes every grant and every browser session, those without a grant included; returns how
   * many grants were active.
   */
  revokeAll(reason: string): Promise<number>;
  /** All known grants, newest first. */
  list(): readonly GrantRecord[];
  /** Flushes, releases the lock. */
  close(): Promise<void>;
}

/** What the OAuth module adds to the HTTP server. */
export interface OAuthModule {
  /** Metadata, `/authorize`, `/token`, `/revoke`. */
  readonly routes: readonly HttpRoute[];
  readonly authenticator: HttpAuthenticator;
  readonly store: GrantStore;
  close(): Promise<void>;
}
