/**
 * The OAuth authorization server end to end with the real SDK client: CIMD (`clientMetadataUrl`),
 * PKCE S256, the RFC 8707 resource and the RFC 9207 `iss` check, the consent page in a "browser",
 * MCP calls with the issued token, refresh on 401, and revocation through the `grants` command.
 * Requests go through an injected `fetch` into the module's routes; CIMD documents and sevDesk's
 * identity lookup are fakes. The MCP server is a one-tool stand-in that reports the verified grant.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auth,
  Client,
  IssuerMismatchError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { grantOf } from "../../src/accounts/types.js";
import { runGrantsCommand } from "../../src/grants-cli.js";
import { createServerKeys } from "../../src/http/keys.js";
import { createHttpLog } from "../../src/http/log.js";
import { createMcpRoute } from "../../src/http/mcp-route.js";
import { openGrantStore } from "../../src/http/oauth/grant-store.js";
import { createOAuthModule } from "../../src/http/oauth/index.js";
import { createRouter } from "../../src/http/router.js";
import type { GrantStore } from "../../src/http/types.js";
import {
  ACCOUNT,
  CLAUDE_AI_CLIENT,
  CLAUDE_AI_REDIRECT,
  CLAUDE_CODE_CLIENT,
  completeConsent,
  CookieJar,
  createOAuthRig,
  DEFAULT_OAUTH,
  fakeCimd,
  fakeClock,
  fakeIdentity,
  type McpEndpoint,
  type OAuthRig,
  openAuthorize,
  ORIGIN,
  RESOURCE,
  SEVDESK_TOKEN,
  submitConsent,
} from "../helpers/oauth-browser.js";

/** An in-memory OAuth client, as Claude Code or claude.ai keep their state. */
class TestProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  #client: StoredOAuthClientInformation | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #verifier = "";
  #discovery: OAuthDiscoveryState | undefined;

  constructor(
    readonly clientMetadataUrl: string,
    readonly redirectUrl: string,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Test client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return "e2e-state";
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.#client;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.#client = info;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.#tokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    return this.#verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this.#tokens = undefined;
    if (scope === "all" || scope === "client") this.#client = undefined;
  }
}

/** A one-tool MCP server that reports the grant the request was verified with. */
function whoamiServer(): McpServer {
  const server = new McpServer({ name: "oauth-e2e", version: "0.0.0" });
  server.registerTool(
    "whoami",
    { description: "Reports the verified grant.", inputSchema: z.object({}) },
    (_args, ctx) => {
      const grant = grantOf(ctx.http?.authInfo);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              account: grant?.accountId,
              tiers: grant === undefined ? [] : [...grant.tiers],
              tokenLength: grant?.token().length,
            }),
          },
        ],
      };
    },
  );
  return server;
}

function whoamiEndpoint(): McpEndpoint {
  const handler = createMcpHandler(whoamiServer);
  return (request, authInfo) => handler.fetch(request, { authInfo });
}

async function whoami(
  client: Client,
): Promise<{ account: string; tiers: string[]; tokenLength: number }> {
  const result = await client.callTool({ name: "whoami", arguments: {} });
  const [content] = result.content as { type: string; text: string }[];
  return JSON.parse(content?.text ?? "{}") as {
    account: string;
    tiers: string[];
    tokenLength: number;
  };
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function persistentRig(): Promise<{
  rig: OAuthRig;
  store: GrantStore;
  dir: string;
  clock: ReturnType<typeof fakeClock>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "sdmcp-oauth-e2e-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const clock = fakeClock();
  const store = await openGrantStore({ stateDir: dir, now: clock.now, heartbeatMs: 0 });
  cleanup.push(() => store.close());
  const rig = await createOAuthRig({ store, now: clock.now, mcp: whoamiEndpoint() });
  cleanup.push(() => rig.close());
  return { rig, store, dir, clock };
}

describe("OAuth end to end with the SDK client", () => {
  it("connects Claude Code (loopback, CIMD), calls tools, refreshes on 401 and is cut off by grants revoke", async () => {
    const { rig, store, dir, clock } = await persistentRig();
    const provider = new TestProvider(CLAUDE_CODE_CLIENT, "http://127.0.0.1:53111/callback");
    const serverUrl = new URL(RESOURCE);

    // 1. Unauthenticated: 401 with resource_metadata, discovery, and a redirect to /authorize.
    const first = new Client({ name: "claude-code", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(serverUrl, {
      authProvider: provider,
      fetch: rig.fetch,
    });
    await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    const authorizationUrl = provider.authorizationUrl;
    if (authorizationUrl === undefined) throw new Error("no authorization URL");
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(`${ORIGIN}/authorize`);
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLAUDE_CODE_CLIENT,
      code_challenge_method: "S256",
      redirect_uri: "http://127.0.0.1:53111/callback",
      state: "e2e-state",
      resource: RESOURCE,
      scope: "sevdesk:read sevdesk:write sevdesk:commit offline_access",
    });
    expect(rig.cimd.fetched).toEqual([]);

    // 2. The user consents in the browser and chooses the write tier.
    const { redirect, pages } = await completeConsent(rig.fetch, authorizationUrl, {
      tiers: ["write"],
    });
    expect(pages[0]).toContain("This app runs on your own computer");
    expect(rig.cimd.resolved).toEqual(["claude.ai"]);
    expect(`${redirect.origin}${redirect.pathname}`).toBe("http://127.0.0.1:53111/callback");
    expect(redirect.searchParams.get("state")).toBe("e2e-state");
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);

    // 3. The client redeems the code (iss checked against the metadata) and connects.
    await transport.finishAuth(redirect.searchParams);
    expect(provider.tokens()).toMatchObject({
      token_type: "Bearer",
      scope: "sevdesk:read sevdesk:write",
    });
    const client = new Client({ name: "claude-code", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(serverUrl, { authProvider: provider, fetch: rig.fetch }),
    );
    cleanup.push(() => client.close());
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["whoami"]);
    expect(await whoami(client)).toEqual({
      account: ACCOUNT,
      tiers: ["read", "write"],
      tokenLength: 32,
    });

    // 4. After the access token expired, the 401 makes the client refresh and retry.
    const before = provider.tokens()?.refresh_token;
    clock.advance(3_601_000);
    expect(await whoami(client)).toMatchObject({ account: ACCOUNT });
    expect(provider.tokens()?.refresh_token).not.toBe(before);
    expect(store.list()[0]).toMatchObject({ status: "active", gen: 2 });

    // 5. The operator revokes the grant from another process: the next call fails for good.
    const output: string[] = [];
    const exit = await runGrantsCommand(
      { kind: "grants-revoke", target: { grantId: store.list()[0]?.gid ?? "" } },
      { SEVDESK_HTTP_STATE_DIR: dir },
      { out: (text) => output.push(text), err: (text) => output.push(text), now: clock.now },
    );
    expect(exit).toBe(0);
    clock.advance(1000);
    await expect(whoami(client)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(store.list()[0]).toMatchObject({ status: "revoked", reason: "operator" });

    // Nothing secret in the server's log or in any page, header or redirect it answered.
    expect(rig.log.text()).not.toContain(SEVDESK_TOKEN);
    expect(rig.log.text()).not.toContain("sdmcp_");
    for (const entry of rig.fetch.transcript) {
      expect(entry.body).not.toContain(SEVDESK_TOKEN);
      expect(JSON.stringify(entry.headers)).not.toContain(SEVDESK_TOKEN);
    }
  });

  it("runs claude.ai's flow through auth() and refuses a mixed-up or missing iss", async () => {
    const { rig } = await persistentRig();
    const serverUrl = new URL(RESOURCE);
    const provider = new TestProvider(CLAUDE_AI_CLIENT, CLAUDE_AI_REDIRECT);
    await expect(auth(provider, { serverUrl, fetchFn: rig.fetch })).resolves.toBe("REDIRECT");
    const { redirect } = await completeConsent(rig.fetch, provider.authorizationUrl ?? "");
    const code = redirect.searchParams.get("code") ?? "";

    await expect(
      auth(provider, {
        serverUrl,
        authorizationCode: code,
        iss: "https://evil.example",
        fetchFn: rig.fetch,
      }),
    ).rejects.toBeInstanceOf(IssuerMismatchError);
    await expect(
      auth(provider, { serverUrl, authorizationCode: code, fetchFn: rig.fetch }),
    ).rejects.toBeInstanceOf(IssuerMismatchError);
    // Neither attempt reached the token endpoint: the code is still good.
    expect(rig.fetch.transcript.filter((entry) => entry.path === "/token")).toEqual([]);

    await expect(
      auth(provider, { serverUrl, authorizationCode: code, iss: ORIGIN, fetchFn: rig.fetch }),
    ).resolves.toBe("AUTHORIZED");
    const client = new Client({ name: "claude-ai", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(serverUrl, { authProvider: provider, fetch: rig.fetch }),
    );
    cleanup.push(() => client.close());
    expect(await whoami(client)).toEqual({ account: ACCOUNT, tiers: ["read"], tokenLength: 32 });

    // The client can revoke its own tokens (RFC 7009); the next call is refused.
    const refreshToken = provider.tokens()?.refresh_token ?? "";
    const revoked = await rig.fetch(
      new Request(`${ORIGIN}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken, client_id: CLAUDE_AI_CLIENT }),
      }),
    );
    expect(revoked.status).toBe(200);
    await expect(whoami(client)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("works through the HTTP router: Host and Origin checks, security headers, redacted logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sdmcp-oauth-router-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const clock = fakeClock();
    const lines: string[] = [];
    const log = createHttpLog({ write: (line) => lines.push(line), now: clock.now });
    const cimd = fakeCimd();
    const identity = fakeIdentity();
    const module = await createOAuthModule({
      origin: ORIGIN,
      keys: createServerKeys(randomBytes(32)),
      oauth: DEFAULT_OAUTH,
      allowedTiers: new Set(["read", "write"]),
      stateDir: dir,
      identity: identity.lookup,
      log,
      now: clock.now,
      resolve: cimd.resolve,
      httpsGet: cimd.httpsGet,
    });
    cleanup.push(() => module.close());
    const mcp = createMcpRoute({ authenticator: module.authenticator, factory: whoamiServer, log });
    cleanup.push(() => mcp.close());
    const router = createRouter({
      http: { allowedHosts: ["mcp.example.com"], allowedOrigins: [ORIGIN], trustProxy: 0 },
      origin: ORIGIN,
      routes: [...module.routes, mcp.route],
      log,
      now: clock.now,
    });
    const viaRouter = (input: Request | string | URL, init?: RequestInit): Promise<Response> =>
      router.fetch(input instanceof Request ? input : new Request(input, init));

    const provider = new TestProvider(CLAUDE_AI_CLIENT, CLAUDE_AI_REDIRECT);
    const serverUrl = new URL(RESOURCE);
    await expect(auth(provider, { serverUrl, fetchFn: viaRouter })).resolves.toBe("REDIRECT");
    const authorizationUrl = provider.authorizationUrl ?? new URL(ORIGIN);

    // The router refuses a consent POST from another site and a foreign Host before the handler.
    const jar = new CookieJar();
    const page = await openAuthorize(viaRouter, authorizationUrl, jar);
    expect(page.response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.response.headers.get("strict-transport-security")).toContain("max-age=");
    const crossSite = await submitConsent(viaRouter, page.form!, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
      origin: "https://evil.example",
    });
    expect(crossSite.response.status).toBe(403);
    const foreignHost = await router.fetch(
      new Request(authorizationUrl, { headers: { Host: "evil.example" } }),
    );
    expect(foreignHost.status).toBe(403);
    expect(identity.calls).toEqual([]);

    const { redirect } = await completeConsent(viaRouter, authorizationUrl, { tiers: ["write"] });
    await expect(
      auth(provider, {
        serverUrl,
        authorizationCode: redirect.searchParams.get("code") ?? "",
        iss: redirect.searchParams.get("iss") ?? "",
        fetchFn: viaRouter,
      }),
    ).resolves.toBe("AUTHORIZED");
    const client = new Client({ name: "claude-ai", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(serverUrl, { authProvider: provider, fetch: viaRouter }),
    );
    cleanup.push(() => client.close());
    expect(await whoami(client)).toEqual({
      account: ACCOUNT,
      tiers: ["read", "write"],
      tokenLength: 32,
    });

    const text = lines.join("\n");
    expect(text).toContain('"route":"/authorize"');
    expect(text).toContain('"event":"consent_granted"');
    expect(text).not.toContain(SEVDESK_TOKEN);
    expect(text).not.toContain("sdmcp_");
    expect(text).not.toContain(redirect.searchParams.get("code") ?? "-");
  });
});
