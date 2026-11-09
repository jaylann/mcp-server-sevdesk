/**
 * Test helpers for the OAuth authorization server (`src/http/oauth/`): a rig with fake time, a
 * fake CIMD host and a fake sevDesk identity lookup; a minimal router that dispatches requests to
 * the module's routes (and `/mcp` through its authenticator) the way the HTTP server does; and a
 * "browser" that opens the consent page, parses its forms and submits the steps with the CSRF
 * cookie and a same-origin `Origin`.
 *
 * Every response the router answers is recorded in `transcript`, so tests can assert that no
 * secret appears in any page, header or redirect.
 */
import { randomBytes } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/server";

import {
  type AccountIdentity,
  IdentityError,
  type IdentityLookup,
} from "../../src/accounts/types.js";
import { createServerKeys, type ServerKeys } from "../../src/http/keys.js";
import type { HttpsGet, HttpsGetRequest } from "../../src/http/oauth/cimd.js";
import {
  createOAuthModule,
  type OAuthModuleOptions,
  type SessionCookieMinter,
} from "../../src/http/oauth/index.js";
import type { ResolvedAddress, Resolver } from "../../src/http/oauth/ssrf.js";
import type {
  HttpAuthenticator,
  HttpLog,
  HttpRequestContext,
  HttpRoute,
  LogFields,
  OAuthModule,
  OAuthSettings,
} from "../../src/http/types.js";
import type { Tier } from "../../src/safety/tiers.js";

export const ORIGIN = "https://mcp.example.com";
export const RESOURCE = `${ORIGIN}/mcp`;
export const CLAUDE_AI_CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
export const CLAUDE_AI_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const CLAUDE_CODE_CLIENT = "https://claude.ai/oauth/claude-code-client-metadata";
/** A fake sevDesk token of account {@link ACCOUNT} (32 hex digits, never valid at sevDesk). */
export const SEVDESK_TOKEN = "0123456789abcdef0123456789abcdef";
/** A fake token of {@link OTHER_ACCOUNT}, which is not on the allowlist. */
export const OTHER_TOKEN = "fedcba9876543210fedcba9876543210";
/** A fake token sevDesk answers with 401. */
export const DEAD_TOKEN = "deaddeaddeaddeaddeaddeaddeaddead";
export const ACCOUNT = "4711";
export const OTHER_ACCOUNT = "4712";

/** A clock that starts now (the SDK compares `expiresAt` with the real time) and only advances. */
export function fakeClock(start = Date.now()): { now: () => number; advance(ms: number): void } {
  let time = start;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

export interface CapturedLog extends HttpLog {
  readonly lines: { level: "info" | "warn"; event: string; fields: LogFields }[];
  /** Every line as JSON text, for secret scans. */
  text(): string;
  events(): string[];
}

export function captureLog(): CapturedLog {
  const lines: CapturedLog["lines"] = [];
  return {
    lines,
    info(event, fields = {}) {
      lines.push({ level: "info", event, fields });
    },
    warn(event, fields = {}) {
      lines.push({ level: "warn", event, fields });
    },
    text: () => lines.map((line) => JSON.stringify(line)).join("\n"),
    events: () => lines.map((line) => line.event),
  };
}

/** A request context as the router builds it; `limit` allows everything unless overridden. */
export function testContext(
  log: HttpLog,
  overrides: Partial<HttpRequestContext> = {},
): HttpRequestContext {
  return {
    clientIp: "198.51.100.7",
    origin: ORIGIN,
    signal: new AbortController().signal,
    log,
    limit: () => true,
    ...overrides,
  };
}

/** The CIMD documents of claude.ai and Claude Code (as published, reduced to what matters). */
export function claudeDocuments(): Map<string, Record<string, unknown>> {
  return new Map<string, Record<string, unknown>>([
    [
      CLAUDE_AI_CLIENT,
      {
        client_id: CLAUDE_AI_CLIENT,
        client_name: "Claude",
        redirect_uris: [CLAUDE_AI_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    ],
    [
      CLAUDE_CODE_CLIENT,
      {
        client_id: CLAUDE_CODE_CLIENT,
        client_name: "Claude Code",
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    ],
  ]);
}

export interface FakeCimd {
  readonly resolve: Resolver;
  readonly httpsGet: HttpsGet;
  readonly resolved: string[];
  readonly fetched: HttpsGetRequest[];
  readonly documents: Map<string, Record<string, unknown>>;
}

/** A CIMD host: every name resolves to a public address and serves its document from the map. */
export function fakeCimd(
  documents = claudeDocuments(),
  addresses: readonly ResolvedAddress[] = [{ address: "160.79.104.10", family: 4 }],
): FakeCimd {
  const resolved: string[] = [];
  const fetched: HttpsGetRequest[] = [];
  return {
    documents,
    resolved,
    fetched,
    resolve: (hostname) => {
      resolved.push(hostname);
      return Promise.resolve(addresses);
    },
    httpsGet: (request) => {
      fetched.push(request);
      const doc = documents.get(`https://${request.hostname}${request.path}`);
      if (doc === undefined) {
        return Promise.resolve({ status: 404, headers: {}, body: Buffer.alloc(0) });
      }
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "max-age=300" },
        body: Buffer.from(JSON.stringify(doc)),
      });
    },
  };
}

export interface FakeIdentity {
  readonly lookup: IdentityLookup;
  readonly calls: string[];
  /** Makes `token` answer 401 from now on (as after regenerating it in sevDesk). */
  kill(token: string): void;
  /** Makes `token` belong to `identity` from now on. */
  set(token: string, identity: AccountIdentity): void;
  /** Makes every lookup fail as unreachable (or work again). */
  unreachable(down: boolean): void;
}

/** sevDesk's `/SevClient` as the consent check and the refresh check see it. */
export function fakeIdentity(): FakeIdentity {
  const accounts = new Map<string, AccountIdentity>([
    [SEVDESK_TOKEN, { accountId: ACCOUNT, name: "Muster <b>GmbH</b>" }],
    [OTHER_TOKEN, { accountId: OTHER_ACCOUNT, name: "Other AG" }],
  ]);
  const calls: string[] = [];
  let down = false;
  return {
    calls,
    kill(token) {
      accounts.delete(token);
    },
    set(token, identity) {
      accounts.set(token, identity);
    },
    unreachable(value) {
      down = value;
    },
    lookup: (token) => {
      calls.push(token);
      if (down) return Promise.reject(new IdentityError("unreachable", "sevDesk is unreachable."));
      const identity = accounts.get(token);
      return identity === undefined
        ? Promise.reject(new IdentityError("unauthorized", "sevDesk refused the token."))
        : Promise.resolve(identity);
    },
  };
}

export const DEFAULT_OAUTH: OAuthSettings = {
  accounts: [ACCOUNT],
  clients: ["claude.ai"],
  accessTtlSeconds: 3600,
  refreshIdleTtlSeconds: 14 * 86_400,
  grantTtlSeconds: 90 * 86_400,
};

interface TranscriptEntry {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: string;
}

/** Answers MCP requests after authentication (the real server's `handler.fetch`). */
export type McpEndpoint = (request: Request, authInfo: AuthInfo) => Promise<Response>;

export interface TestRouter {
  (input: Request | string | URL, init?: RequestInit): Promise<Response>;
  readonly transcript: TranscriptEntry[];
}

/**
 * Dispatches like the HTTP server: exact (or prefix) route match, 405 with `Allow`, the route's
 * handler with a {@link testContext}; `/mcp` through `authenticator` to `mcp`. No Host, Origin or
 * rate checks (those are the router's, tested in http-core).
 */
export function createTestRouter(
  routes: readonly HttpRoute[],
  options: {
    readonly log: HttpLog;
    readonly authenticator?: HttpAuthenticator;
    readonly mcp?: McpEndpoint;
    readonly context?: Partial<HttpRequestContext>;
  },
): TestRouter {
  const transcript: TranscriptEntry[] = [];
  const router = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const ctx = testContext(options.log, options.context);
    if (url.pathname === "/mcp" && options.authenticator !== undefined) {
      const auth = await options.authenticator.authenticate(request, ctx);
      if (auth instanceof Response) return record(request, auth);
      if (options.mcp === undefined) return new Response(null, { status: 204 });
      return options.mcp(request, auth);
    }
    const route = routes.find((candidate) =>
      candidate.match === "prefix"
        ? url.pathname.startsWith(candidate.path)
        : url.pathname === candidate.path,
    );
    if (route === undefined) return record(request, new Response("Not found", { status: 404 }));
    if (!route.methods.includes(request.method)) {
      return record(
        request,
        new Response(null, { status: 405, headers: { Allow: route.methods.join(", ") } }),
      );
    }
    const response = await route.handle(request, ctx);
    return record(request, response ?? new Response("Not found", { status: 404 }));
  };

  async function record(request: Request, response: Response): Promise<Response> {
    const body = await response.clone().text();
    transcript.push({
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      headers: [...response.headers.entries()],
      body,
    });
    return response;
  }

  return Object.assign(router, { transcript });
}

export interface OAuthRig {
  readonly module: OAuthModule;
  readonly keys: ServerKeys;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly log: CapturedLog;
  readonly identity: FakeIdentity;
  readonly cimd: FakeCimd;
  readonly fetch: TestRouter;
  readonly sessionMints: { accountId: string; gid: string }[];
  route(path: string): HttpRoute;
  close(): Promise<void>;
}

/** The OAuth module on fake time, a fake CIMD host and a fake sevDesk, with a test router. */
export async function createOAuthRig(
  overrides: Omit<Partial<OAuthModuleOptions>, "mintSessionCookie"> & {
    readonly secret?: Uint8Array;
    readonly mcp?: McpEndpoint;
    readonly cimd?: FakeCimd;
    /** `null`: no inbox session minting. Default: a recording stub. */
    readonly mintSessionCookie?: SessionCookieMinter | null;
  } = {},
): Promise<OAuthRig> {
  const { secret, mcp, cimd: cimdOverride, mintSessionCookie, ...options } = overrides;
  const clock = fakeClock();
  const log = captureLog();
  const identity = fakeIdentity();
  const cimd = cimdOverride ?? fakeCimd();
  const keys = options.keys ?? createServerKeys(secret ?? randomBytes(32));
  const sessionMints: OAuthRig["sessionMints"] = [];
  const recordingMinter: SessionCookieMinter = (input) => {
    sessionMints.push({ accountId: input.accountId, gid: input.gid });
    return Promise.resolve(
      "__Host-sevdesk_session=fake-session; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  };
  const minter = mintSessionCookie === null ? undefined : (mintSessionCookie ?? recordingMinter);
  const module = await createOAuthModule({
    origin: ORIGIN,
    keys,
    oauth: DEFAULT_OAUTH,
    allowedTiers: new Set<Tier>(["read", "write", "commit"]),
    stateDir: undefined,
    identity: identity.lookup,
    log,
    now: clock.now,
    resolve: cimd.resolve,
    httpsGet: cimd.httpsGet,
    ...(minter === undefined ? {} : { mintSessionCookie: minter }),
    ...options,
  });
  const fetch = createTestRouter(module.routes, {
    log,
    authenticator: module.authenticator,
    ...(mcp === undefined ? {} : { mcp }),
  });
  return {
    module,
    keys,
    clock,
    log,
    identity,
    cimd,
    fetch,
    sessionMints,
    route(path) {
      const found = module.routes.find((route) => route.path === path);
      if (found === undefined) throw new Error(`no route ${path}`);
      return found;
    },
    close: () => module.close(),
  };
}

/** Reverses `escapeHtml`. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The consent form of a page, as a browser would see it. */
export interface ConsentForm {
  readonly action: string;
  /** Hidden fields (`consent`, `csrf`, and `tier=read`). */
  readonly hidden: readonly (readonly [string, string])[];
  /** Tier checkboxes the user can change. */
  readonly tiers: readonly { readonly value: string; readonly checked: boolean }[];
  /** Values of the `step` submit buttons. */
  readonly steps: readonly string[];
  readonly hasTokenField: boolean;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? undefined : unescapeHtml(match[1]);
}

/** Parses the (only) form of a consent page; `undefined` when the page has none. */
export function parseConsentForm(html: string): ConsentForm | undefined {
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(html);
  if (form === null) return undefined;
  const [, formTag = "", body = ""] = form;
  const inputs = [...body.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
  const hidden: [string, string][] = [];
  const tiers: { value: string; checked: boolean }[] = [];
  let hasTokenField = false;
  for (const input of inputs) {
    const type = attribute(input, "type");
    const name = attribute(input, "name");
    if (type === "hidden" && name !== undefined)
      hidden.push([name, attribute(input, "value") ?? ""]);
    if (type === "checkbox" && name === "tier") {
      tiers.push({ value: attribute(input, "value") ?? "", checked: /\schecked\b/.test(input) });
    }
    if (type === "password" && name === "sevdesk_token") hasTokenField = true;
  }
  const steps = [...body.matchAll(/<button\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((button) => attribute(button, "name") === "step")
    .map((button) => attribute(button, "value") ?? "");
  return { action: attribute(formTag, "action") ?? "", hidden, tiers, steps, hasTokenField };
}

/** Cookies a browser keeps between the consent steps (no expiry handling; tests are short). */
export class CookieJar {
  readonly #cookies = new Map<string, string>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/Max-Age=0\b/i.test(header) || value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  header(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export interface PageResult {
  readonly response: Response;
  readonly html: string;
  readonly form: ConsentForm | undefined;
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** Opens the authorization URL in the "browser". */
export async function openAuthorize(
  fetch: Fetch,
  url: string | URL,
  jar: CookieJar,
): Promise<PageResult> {
  const response = await fetch(new Request(url, { headers: { Cookie: jar.header() } }));
  jar.store(response);
  const html = await response.text();
  return { response, html, form: parseConsentForm(html) };
}

export interface SubmitOptions {
  readonly step: string;
  readonly token?: string;
  /** Tiers to tick (others unticked); default: as the page had them. */
  readonly tiers?: readonly string[];
  /** Replaces fields before sending (tamper tests). */
  readonly override?: Readonly<Record<string, string>>;
  /** Default: the server's own origin. `null` sends no Origin header. */
  readonly origin?: string | null;
}

/** Submits a consent form like the browser (same-origin POST with the cookie jar). */
export async function submitConsent(
  fetch: Fetch,
  form: ConsentForm,
  jar: CookieJar,
  options: SubmitOptions,
): Promise<PageResult> {
  const body = new URLSearchParams();
  for (const [name, value] of form.hidden) body.append(name, value);
  for (const tier of form.tiers) {
    const ticked = options.tiers === undefined ? tier.checked : options.tiers.includes(tier.value);
    if (ticked) body.append("tier", tier.value);
  }
  if (options.token !== undefined) body.set("sevdesk_token", options.token);
  body.set("step", options.step);
  for (const [name, value] of Object.entries(options.override ?? {})) body.set(name, value);
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  const cookie = jar.header();
  if (cookie !== "") headers.set("Cookie", cookie);
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);
  const response = await fetch(
    new Request(new URL(form.action, ORIGIN), { method: "POST", headers, body }),
  );
  jar.store(response);
  const html = response.status === 303 ? "" : await response.text();
  return { response, html, form: html === "" ? undefined : parseConsentForm(html) };
}

/**
 * Goes through both consent steps (token check, then connect) and returns the final redirect
 * (`code`, `state`, `iss` in its query), every page's HTML and the cookie jar.
 */
export async function completeConsent(
  fetch: Fetch,
  authorizeUrl: string | URL,
  options: { readonly token?: string; readonly tiers?: readonly string[] } = {},
): Promise<{ redirect: URL; pages: string[]; jar: CookieJar }> {
  const jar = new CookieJar();
  const first = await openAuthorize(fetch, authorizeUrl, jar);
  if (first.form === undefined)
    throw new Error(`no consent form (${String(first.response.status)})`);
  const checked = await submitConsent(fetch, first.form, jar, {
    step: "check",
    token: options.token ?? SEVDESK_TOKEN,
    ...(options.tiers === undefined ? {} : { tiers: options.tiers }),
  });
  if (checked.form === undefined) {
    throw new Error(`token check failed (${String(checked.response.status)}): ${checked.html}`);
  }
  const connected = await submitConsent(fetch, checked.form, jar, { step: "connect" });
  const location = connected.response.headers.get("location");
  if (connected.response.status !== 303 || location === null) {
    throw new Error(`connect did not redirect (${String(connected.response.status)})`);
  }
  return { redirect: new URL(location), pages: [first.html, checked.html], jar };
}

/** A PKCE pair (verifier, S256 challenge). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

/** An authorization URL as claude.ai builds it. */
export function authorizeUrl(params: Readonly<Record<string, string | undefined>>): URL {
  const url = new URL(`${ORIGIN}/authorize`);
  const defaults: Record<string, string | undefined> = {
    response_type: "code",
    client_id: CLAUDE_AI_CLIENT,
    redirect_uri: CLAUDE_AI_REDIRECT,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "sevdesk:read sevdesk:write offline_access",
    resource: RESOURCE,
  };
  for (const [name, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url;
}

/** Posts a form to `/token` (or another path) of the router. */
export function postForm(
  fetch: Fetch,
  path: string,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    }),
  );
}

/**
 * Runs consent for claude.ai and exchanges the code: the tokens of a fresh grant, plus the PKCE
 * verifier and the redirect (for replay tests).
 */
export async function connectClaudeAi(
  rig: Pick<OAuthRig, "fetch">,
  options: {
    readonly tiers?: readonly string[];
    readonly token?: string;
    /** Overrides of the authorization request's parameters. */
    readonly params?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<{
  readonly access: string;
  readonly refresh: string;
  readonly body: Record<string, unknown>;
  readonly code: string;
  readonly verifier: string;
  readonly redirect: URL;
}> {
  const { verifier, challenge } = await pkcePair();
  const { redirect } = await completeConsent(
    rig.fetch,
    authorizeUrl({ code_challenge: challenge, ...options.params }),
    options,
  );
  const code = redirect.searchParams.get("code") ?? "";
  const response = await postForm(rig.fetch, "/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: CLAUDE_AI_REDIRECT,
    code_verifier: verifier,
    client_id: CLAUDE_AI_CLIENT,
    resource: RESOURCE,
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) throw new Error(`code exchange failed: ${JSON.stringify(body)}`);
  return {
    access: String(body["access_token"]),
    refresh: String(body["refresh_token"]),
    body,
    code,
    verifier,
    redirect,
  };
}

/** A request to `/mcp` with a bearer token. */
export function mcpRequest(token: string | undefined): Request {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}
