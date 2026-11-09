/**
 * Composes the HTTP mode (`mcp-server-sevdesk --http`): configuration, the sevDesk account(s),
 * the safety runtime, authentication (bearer or the built-in OAuth server), the approval inbox
 * (`SEVDESK_CONFIRM=browser`) and the HTTP server, then serves until SIGTERM/SIGINT.
 *
 * - **bearer:** one account (`SEVDESK_API_TOKEN`), looked up once at startup so approvals and audit
 *   lines carry its id; clients present `SEVDESK_HTTP_BEARER_TOKEN`.
 * - **oauth:** one context per consented account (`createAccountResolver`), the grant store shared
 *   by the OAuth server and the inbox sessions.
 *
 * Nothing here prints secrets: the HTTP logger redacts every configured secret, sealed tokens and
 * token-shaped hex runs; config problems never contain values.
 */
import { createIdentityLookup } from "../accounts/identity.js";
import { createAccountResolver } from "../accounts/resolver.js";
import { IdentityError, type IdentityLookup } from "../accounts/types.js";
import type { Config } from "../config.js";
import type { SafetyRuntime } from "../safety/runtime.js";
import { createSafetyRuntime } from "../safety/runtime.js";
import { safeEqual } from "../safety/web.js";
import { createServerFactory, type ServerFactory } from "../server.js";
import { createSevdeskClient } from "../sevdesk/client.js";
import { identifyAccount } from "../startup.js";
import { createApprovalRoutes, type InboxLogin } from "./approval-routes.js";
import { createBearerAuthenticator } from "./bearer.js";
import { httpDeployment, type LoadedHttpConfig, loadHttpConfig, loopbackOrigin } from "./config.js";
import { createServerKeys, type ServerKeys } from "./keys.js";
import { createHttpLog } from "./log.js";
import { createMcpRoute } from "./mcp-route.js";
import type { HttpsGet } from "./oauth/cimd.js";
import { createOAuthModule, openGrantStore } from "./oauth/index.js";
import type { Resolver } from "./oauth/ssrf.js";
import { exitOnSignals, type HttpServerHandle, startHttpServer } from "./serve.js";
import { createEphemeralKeys, createSessionCookie } from "./session.js";
import type { GrantStore, HttpAuthenticator, HttpLog, HttpRoute, OAuthModule } from "./types.js";

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
  const input: PartsInput = {
    keys,
    identity,
    log,
    origin,
    inboxWanted: settings.confirm === "browser",
    fetchDeps,
    cimd: deps.cimd ?? {},
  };
  const parts =
    http.auth === "bearer" ? await bearerParts(loaded, input) : await oauthParts(loaded, input);

  const mcp = createMcpRoute({ authenticator: parts.authenticator, factory: parts.factory, log });
  let server: HttpServerHandle;
  try {
    server = await startHttpServer({ http, routes: [mcp.route, ...parts.routes], log });
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
  return {
    origin: server.origin,
    port: server.port,
    log,
    server,
    closeResources,
    close: () => {
      closed ??= server.close().then(closeResources);
      return closed;
    },
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
  readonly fetchDeps: { readonly fetch?: typeof fetch };
  readonly cimd: NonNullable<RunHttpDeps["cimd"]>;
  readonly keys: ServerKeys;
  readonly identity: IdentityLookup;
  readonly log: HttpLog;
  readonly origin: string;
  readonly inboxWanted: boolean;
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
    deployment: httpDeployment("bearer", input.origin, settings.confirm),
  };
  const config = await identifyAccount(base, input.identity, (line) => {
    if (line.startsWith("warning: ")) {
      input.log.warn("startup", { message: line.slice("warning: ".length) });
    } else {
      input.log.info("startup", { message: line });
    }
  });

  let runtime: SafetyRuntime | undefined;
  let store: GrantStore | undefined;
  let routes: readonly HttpRoute[] = [];
  if (input.inboxWanted) {
    store = await openGrantStore({ stateDir: http.stateDir, log: input.log });
    const accountScope = config.account?.id ?? "bearer";
    const login: InboxLogin = (token) =>
      Promise.resolve(
        safeEqual(token, config.token)
          ? { accountId: accountScope }
          : { error: "This is not the sevDesk API token this server is configured with." },
      );
    const inbox = createApprovalRoutes({
      approvals: () => runtime?.approvals,
      sessions: store,
      keys: input.keys,
      origin: input.origin,
      login,
    });
    routes = inbox.routes;
    runtime = createSafetyRuntime(config, { approvalChannel: inbox.channel });
  } else {
    runtime = createSafetyRuntime(config);
  }

  const factory = createServerFactory({
    config,
    client: createSevdeskClient(config, input.fetchDeps),
    safety: runtime,
  });
  const openedStore = store;
  return {
    authenticator: createBearerAuthenticator(http.bearerTokens, { tiers: settings.allowedTiers }),
    factory,
    routes,
    close: async () => {
      await openedStore?.close();
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
  const deployment = httpDeployment("oauth", origin, settings.confirm);
  const store = await openGrantStore({ stateDir: http.stateDir, log: input.log });

  let runtime: SafetyRuntime | undefined;
  let inboxRoutes: readonly HttpRoute[] = [];
  if (input.inboxWanted) {
    const inbox = createApprovalRoutes({
      approvals: () => runtime?.approvals,
      sessions: store,
      keys: input.keys,
      origin,
      login: oauthLogin(input.identity, oauth.accounts),
    });
    inboxRoutes = inbox.routes;
    runtime = createSafetyRuntime({ ...settings, deployment }, { approvalChannel: inbox.channel });
  } else {
    runtime = createSafetyRuntime({ ...settings, deployment });
  }

  const accounts = createAccountResolver({
    mode: "oauth",
    settings,
    deployment,
    clientDeps: input.fetchDeps,
  });
  const factory = createServerFactory({ settings, accounts, safety: runtime });
  let module: OAuthModule;
  try {
    module = await createOAuthModule({
      origin,
      keys: input.keys,
      oauth,
      allowedTiers: settings.allowedTiers,
      stateDir: http.stateDir,
      identity: input.identity,
      log: input.log,
      store,
      ...(input.inboxWanted ? { mintSessionCookie: createSessionCookie } : {}),
      ...(input.cimd.resolve === undefined ? {} : { resolve: input.cimd.resolve }),
      ...(input.cimd.httpsGet === undefined ? {} : { httpsGet: input.cimd.httpsGet }),
    });
  } catch (error) {
    await factory.close();
    await store.close();
    throw error;
  }
  return {
    authenticator: module.authenticator,
    factory,
    routes: [...module.routes, ...inboxRoutes],
    close: async () => {
      await module.close();
      await store.close();
    },
  };
}

/**
 * The inbox sign-in of OAuth mode: the pasted token must belong to an allowed account
 * (`SEVDESK_OAUTH_ACCOUNTS`). Rejects (the page asks to try again) when sevDesk cannot be reached.
 */
function oauthLogin(identity: IdentityLookup, accounts: readonly string[] | "any"): InboxLogin {
  return async (token, signal) => {
    try {
      const found = await identity(token, signal);
      if (accounts !== "any" && !accounts.includes(found.accountId)) {
        return { error: "This server is not set up for the sevDesk account of this token." };
      }
      return { accountId: found.accountId };
    } catch (error) {
      if (error instanceof IdentityError && error.kind === "unauthorized") {
        return { error: "sevDesk did not accept this API token." };
      }
      throw error;
    }
  };
}
