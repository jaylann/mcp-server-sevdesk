/**
 * Composes the HTTP mode (`mcp-server-sevdesk --http`): configuration, the sevDesk account(s),
 * the safety runtime, authentication (bearer or the built-in OAuth server), the browser pages
 * (the approval inbox with `SEVDESK_CONFIRM=browser`, the upload and download pages with
 * `SEVDESK_HTTP_FILES`, sharing one browser session) and the HTTP server, then serves until
 * SIGTERM/SIGINT.
 *
 * - **bearer:** one account (`SEVDESK_API_TOKEN`), looked up once at startup so approvals and audit
 *   lines carry its id; clients present `SEVDESK_HTTP_BEARER_TOKEN`.
 * - **oauth:** one context per consented account (`createAccountResolver`), the grant store shared
 *   by the OAuth server and the browser sessions.
 *
 * Browser sessions live in the grant store, so bearer mode opens it too when a browser page is
 * on. The transfer store opens after the grant store took the state directory's lock, and only
 * then empties `<stateDir>/files` (a second server never touches a live server's files).
 *
 * Nothing here prints secrets: the HTTP logger redacts every configured secret, sealed tokens and
 * token-shaped hex runs; config problems never contain values.
 */
import { join } from "node:path";

import { createIdentityLookup } from "../accounts/identity.js";
import { createAccountResolver } from "../accounts/resolver.js";
import { IdentityError, type IdentityLookup } from "../accounts/types.js";
import type { Config } from "../config.js";
import type { AuditLog } from "../safety/audit.js";
import { BlobStoreError, openBlobStore } from "../safety/blob-store.js";
import type { SafetyRuntime, SafetyRuntimeConfig } from "../safety/runtime.js";
import { createSafetyRuntime } from "../safety/runtime.js";
import { createTransferStore, type FileTransferStore } from "../safety/transfer-store.js";
import { safeEqual } from "../safety/web.js";
import { createServerFactory, type ServerFactory } from "../server.js";
import { createSevdeskClient } from "../sevdesk/client.js";
import { identifyAccount } from "../startup.js";
import { createApprovalRoutes } from "./approval-routes.js";
import { assetRoute } from "./asset-route.js";
import { createBearerAuthenticator } from "./bearer.js";
import { type BrowserSession, createBrowserSession, type InboxLogin } from "./browser-session.js";
import { httpDeployment, type LoadedHttpConfig, loadHttpConfig, loopbackOrigin } from "./config.js";
import { createServerKeys, type ServerKeys } from "./keys.js";
import { createHttpLog } from "./log.js";
import { createMcpRoute } from "./mcp-route.js";
import type { HttpsGet } from "./oauth/cimd.js";
import { createOAuthModule, openGrantStore, StateDirError } from "./oauth/index.js";
import type { Resolver } from "./oauth/ssrf.js";
import { exitOnSignals, type HttpServerHandle, startHttpServer } from "./serve.js";
import { createEphemeralKeys, createSessionCookie } from "./session.js";
import { createTransferRoutes } from "./transfer-routes.js";
import type {
  GrantStore,
  HttpAuthenticator,
  HttpFilesConfig,
  HttpLog,
  HttpRoute,
  OAuthModule,
} from "./types.js";

/** Concurrent requests per client address with `SEVDESK_OAUTH_ACCOUNTS=any` (default 8). */
const MULTI_TENANT_MAX_PER_CLIENT = 32;
/** After a fatal store error, exit at the latest after this long, drained or not. */
const FATAL_EXIT_MS = 15_000;
/** Where the transfer store keeps its encrypted blobs inside the state directory. */
const FILES_DIR = "files";

/** What the HTTP mode needs from outside; tests inject the network-facing parts. */
export interface RunHttpDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Default: a stderr logger redacting the configured secrets. */
  readonly log?: HttpLog;
  /** Tests: who a sevDesk token belongs to (default: `GET /SevClient`). */
  readonly identity?: IdentityLookup;
  /** Tests: the `fetch` sevDesk API requests go through (tools and the identity lookup). */
  readonly sevdeskFetch?: typeof fetch;
  /** Tests: CIMD host resolution and fetching. */
  readonly cimd?: { readonly resolve?: Resolver; readonly httpsGet?: HttpsGet };
  /**
   * Called when the grant store can no longer be trusted (its state-directory lock was lost).
   * Default: close the server and exit 1, so the platform restarts it with a fresh lock.
   */
  readonly onFatal?: (error: StateDirError) => void;
}

/** A running HTTP mode. */
export interface RunningHttp {
  readonly origin: string;
  readonly port: number;
  /** The redacting logger the mode writes to. */
  readonly log: HttpLog;
  /** The listening server; its `close()` drains requests (what `exitOnSignals` drives). */
  readonly server: HttpServerHandle;
  /** Closes the MCP route, the server factory and the stores; run after the server closed. */
  closeResources(): Promise<void>;
  /** `server.close()`, then {@link RunningHttp.closeResources}; idempotent. */
  close(): Promise<void>;
}

/**
 * Starts the HTTP mode from `deps.env`. Throws `ConfigError` for an invalid configuration and
 * `StateDirError` when the state directory is locked or corrupt; the caller prints and exits 1.
 *
 * Without `SEVDESK_HTTP_PUBLIC_URL` (a loopback bind) the origin is `http://<host>:<port>`; with
 * port 0 (tests) texts that name the origin show port 0.
 */
export async function startHttpMode(deps: RunHttpDeps): Promise<RunningHttp> {
  const loaded = loadHttpConfig(deps.env);
  const log = deps.log ?? createHttpLog({ secrets: loaded.secrets });
  for (const warning of loaded.warnings) log.warn("config_warning", { message: warning });

  const { http, settings } = loaded;
  const keys: ServerKeys =
    http.secret === undefined
      ? createEphemeralKeys()
      : createServerKeys(http.secret, http.previousSecret);
  const fetchDeps = deps.sevdeskFetch === undefined ? {} : { fetch: deps.sevdeskFetch };
  const identity = deps.identity ?? createIdentityLookup(settings, fetchDeps);
  const origin = http.publicOrigin ?? loopbackOrigin(http.host, http.port);
  // Set once the server listens; a fatal error before that only exits.
  const lifecycle: { shutdown?: () => Promise<void> } = {};
  const onFatal = (error: StateDirError): void => {
    log.warn("fatal_shutdown", { message: error.message });
    if (deps.onFatal !== undefined) {
      deps.onFatal(error);
      return;
    }
    const exit = (): void => {
      process.exit(1);
    };
    setTimeout(exit, FATAL_EXIT_MS).unref();
    void (lifecycle.shutdown?.() ?? Promise.resolve()).finally(exit);
  };
  const input: PartsInput = {
    onFatal,
    keys,
    identity,
    log,
    origin,
    inboxWanted: settings.confirm === "browser",
    files: http.files,
    fetchDeps,
    cimd: deps.cimd ?? {},
  };
  const parts =
    http.auth === "bearer" ? await bearerParts(loaded, input) : await oauthParts(loaded, input);

  const mcp = createMcpRoute({ authenticator: parts.authenticator, factory: parts.factory, log });
  let server: HttpServerHandle;
  try {
    server = await startHttpServer({
      http,
      // The asset route comes with the pages: without page routes nothing would load from it.
      routes: [mcp.route, ...parts.routes, ...(parts.routes.length > 0 ? [assetRoute()] : [])],
      log,
      // Multi-tenant OAuth: many claude.ai users can share one egress address.
      ...(http.oauth?.accounts === "any" ? { maxPerClient: MULTI_TENANT_MAX_PER_CLIENT } : {}),
    });
  } catch (error) {
    await parts.factory.close();
    await parts.close();
    throw error;
  }

  let resourcesClosed: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    resourcesClosed ??= (async () => {
      await mcp.close();
      await parts.factory.close();
      await parts.close();
    })();
    return resourcesClosed;
  };
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= server.close().then(closeResources);
    return closed;
  };
  lifecycle.shutdown = close;
  return {
    origin: server.origin,
    port: server.port,
    log,
    server,
    closeResources,
    close,
  };
}

/** Runs the HTTP mode until SIGTERM/SIGINT (exit 0 after draining). */
export async function runHttp(deps: RunHttpDeps): Promise<void> {
  const running = await startHttpMode(deps);
  exitOnSignals(running.server, {
    log: running.log,
    onClosed: () => running.closeResources(),
  });
}

interface PartsInput {
  readonly onFatal: (error: StateDirError) => void;
  readonly fetchDeps: { readonly fetch?: typeof fetch };
  readonly cimd: NonNullable<RunHttpDeps["cimd"]>;
  readonly keys: ServerKeys;
  readonly identity: IdentityLookup;
  readonly log: HttpLog;
  readonly origin: string;
  readonly inboxWanted: boolean;
  /** Remote file transfer (`SEVDESK_HTTP_FILES`); undefined when off. */
  readonly files: HttpFilesConfig | undefined;
}

/** Whether any browser page (approval inbox, upload and download pages) needs sessions. */
function sessionsWanted(input: PartsInput): boolean {
  return input.inboxWanted || input.files !== undefined;
}

interface BrowserPartsOptions {
  /** The session store (the grant store); present whenever {@link sessionsWanted}. */
  readonly sessions: GrantStore | undefined;
  /** What the safety runtime is built from (the bearer config, or the OAuth settings). */
  readonly runtimeConfig: SafetyRuntimeConfig;
  readonly login: InboxLogin;
  readonly accountAllowed: ((accountId: string) => boolean) | undefined;
  readonly origin: string;
  readonly stateDir: string | undefined;
}

interface BrowserParts {
  readonly runtime: SafetyRuntime;
  readonly routes: readonly HttpRoute[];
  readonly transfer: FileTransferStore | undefined;
}

/**
 * The safety runtime and the browser pages: the approval inbox (its channel goes into the
 * runtime) and the upload and download pages, sharing one {@link BrowserSession}. Opens the
 * transfer store (emptying `<stateDir>/files`); rejects with `StateDirError` when it cannot.
 */
async function browserParts(
  input: PartsInput,
  options: BrowserPartsOptions,
): Promise<BrowserParts> {
  const { sessions } = options;
  const routes: HttpRoute[] = [];
  let runtime: SafetyRuntime | undefined;
  let session: BrowserSession | undefined;
  if (input.inboxWanted && sessions !== undefined) {
    const inbox = createApprovalRoutes({
      approvals: () => runtime?.approvals,
      sessions,
      keys: input.keys,
      origin: options.origin,
      login: options.login,
      accountAllowed: options.accountAllowed,
    });
    routes.push(...inbox.routes);
    session = inbox.session;
    runtime = createSafetyRuntime(options.runtimeConfig, { approvalChannel: inbox.channel });
  } else {
    runtime = createSafetyRuntime(options.runtimeConfig);
  }
  let transfer: FileTransferStore | undefined;
  if (input.files !== undefined && sessions !== undefined) {
    if (session === undefined) {
      session = createBrowserSession({
        sessions,
        keys: input.keys,
        origin: options.origin,
        login: options.login,
        accountAllowed: options.accountAllowed,
      });
      routes.push(...session.routes);
    }
    try {
      transfer = await openTransferStore(input.files, options.stateDir, runtime.audit, input.log);
    } catch (error) {
      await runtime.close();
      throw error;
    }
    routes.push(...createTransferRoutes({ store: transfer, session, origin: options.origin }));
  }
  return { runtime, routes, transfer };
}

/** The transfer store, its blobs in `<stateDir>/files` (emptied first) or in memory. */
async function openTransferStore(
  files: HttpFilesConfig,
  stateDir: string | undefined,
  audit: AuditLog,
  log: HttpLog,
): Promise<FileTransferStore> {
  let blobs;
  try {
    blobs = await openBlobStore({
      dir: stateDir === undefined ? undefined : join(stateDir, FILES_DIR),
    });
  } catch (error) {
    if (error instanceof BlobStoreError) throw new StateDirError(error.message);
    throw error;
  }
  return createTransferStore({
    blobs,
    maxBytes: files.maxBytes,
    maxRecordsPerAccount: files.maxPerAccount,
    fileTtlMs: files.ttlSeconds * 1000,
    audit,
    onAuditError: (event) => {
      log.warn("audit_failed", { event });
    },
  });
}

interface Parts {
  readonly authenticator: HttpAuthenticator;
  readonly factory: ServerFactory;
  readonly routes: readonly HttpRoute[];
  /** Closes what the parts opened (stores, modules); runs after the factory closed. */
  close(): Promise<void>;
}

async function bearerParts(loaded: LoadedHttpConfig, input: PartsInput): Promise<Parts> {
  const { http, settings } = loaded;
  const fixed = loaded.fixed;
  if (fixed === undefined) throw new Error("Bearer mode needs the fixed account configuration.");
  const base: Config = {
    ...fixed,
    deployment: httpDeployment("bearer", input.origin, settings.confirm, input.files),
  };
  const config = await identifyAccount(base, input.identity, (line) => {
    if (line.startsWith("warning: ")) {
      input.log.warn("startup", { message: line.slice("warning: ".length) });
    } else {
      input.log.info("startup", { message: line });
    }
  });

  const store = sessionsWanted(input)
    ? await openGrantStore({ stateDir: http.stateDir, log: input.log, onFatal: input.onFatal })
    : undefined;
  const accountScope = config.account?.id ?? "bearer";
  const login: InboxLogin = (token) =>
    Promise.resolve(
      safeEqual(token, config.token)
        ? { accountId: accountScope }
        : { error: "wrong_token" as const },
    );
  let browser: BrowserParts;
  try {
    browser = await browserParts(input, {
      sessions: store,
      runtimeConfig: config,
      login,
      accountAllowed: (accountId) => accountId === accountScope,
      origin: input.origin,
      stateDir: http.stateDir,
    });
  } catch (error) {
    await store?.close();
    throw error;
  }

  const factory = createServerFactory({
    config,
    client: createSevdeskClient(config, input.fetchDeps),
    safety: browser.runtime,
    transfer: browser.transfer,
  });
  return {
    authenticator: createBearerAuthenticator(http.bearerTokens, { tiers: settings.allowedTiers }),
    factory,
    routes: browser.routes,
    close: async () => {
      await browser.transfer?.close();
      await store?.close();
    },
  };
}

async function oauthParts(loaded: LoadedHttpConfig, input: PartsInput): Promise<Parts> {
  const { http, settings } = loaded;
  const oauth = http.oauth;
  if (oauth === undefined || http.publicOrigin === undefined) {
    throw new Error("OAuth mode needs SEVDESK_HTTP_PUBLIC_URL and the OAuth settings.");
  }
  const origin = http.publicOrigin;
  const deployment = httpDeployment("oauth", origin, settings.confirm, input.files);
  const store = await openGrantStore({
    stateDir: http.stateDir,
    log: input.log,
    onFatal: input.onFatal,
  });

  let browser: BrowserParts;
  try {
    browser = await browserParts(input, {
      sessions: store,
      runtimeConfig: { ...settings, deployment },
      login: oauthLogin(input.identity, oauth.accounts),
      accountAllowed: accountAllowlist(oauth.accounts),
      origin,
      stateDir: http.stateDir,
    });
  } catch (error) {
    await store.close();
    throw error;
  }

  const accounts = createAccountResolver({
    mode: "oauth",
    settings,
    deployment,
    clientDeps: input.fetchDeps,
  });
  const factory = createServerFactory({
    settings,
    accounts,
    safety: browser.runtime,
    transfer: browser.transfer,
  });
  let module: OAuthModule;
  try {
    module = await createOAuthModule({
      origin,
      keys: input.keys,
      oauth,
      allowedTiers: settings.allowedTiers,
      unconfirmed: settings.confirm === "off",
      stateDir: http.stateDir,
      identity: input.identity,
      log: input.log,
      store,
      ...(sessionsWanted(input) ? { mintSessionCookie: createSessionCookie } : {}),
      ...(input.cimd.resolve === undefined ? {} : { resolve: input.cimd.resolve }),
      ...(input.cimd.httpsGet === undefined ? {} : { httpsGet: input.cimd.httpsGet }),
    });
  } catch (error) {
    await factory.close();
    await browser.transfer?.close();
    await store.close();
    throw error;
  }
  return {
    authenticator: module.authenticator,
    factory,
    routes: [...module.routes, ...browser.routes],
    close: async () => {
      await module.close();
      await browser.transfer?.close();
      await store.close();
    },
  };
}

/** `SEVDESK_OAUTH_ACCOUNTS` as a check, re-applied to every browser session (`undefined`: any). */
function accountAllowlist(
  accounts: readonly string[] | "any",
): ((accountId: string) => boolean) | undefined {
  return accounts === "any" ? undefined : (accountId) => accounts.includes(accountId);
}

/**
 * The browser sign-in of OAuth mode: the pasted token must belong to an allowed account
 * (`SEVDESK_OAUTH_ACCOUNTS`). Rejects (the page asks to try again) when sevDesk cannot be reached.
 */
function oauthLogin(identity: IdentityLookup, accounts: readonly string[] | "any"): InboxLogin {
  return async (token, signal) => {
    try {
      const found = await identity(token, signal);
      if (accounts !== "any" && !accounts.includes(found.accountId)) {
        return { error: "not_allowed" };
      }
      return { accountId: found.accountId };
    } catch (error) {
      if (error instanceof IdentityError && error.kind === "unauthorized") {
        return { error: "rejected" };
      }
      throw error;
    }
  };
}
