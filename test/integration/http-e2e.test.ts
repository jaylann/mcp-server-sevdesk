/**
 * The composed HTTP mode (`startHttpMode`, what `mcp-server-sevdesk --http` runs) end to end, the
 * way claude.ai uses it: OAuth consent with a CIMD client, the real tool catalog for the granted
 * tiers, a `commit` tool answered with `approval_pending`, the approval made in the inbox with the
 * session the consent left in the browser, the retry executing it, and audit lines that name the
 * account and grant. Only the network edges are fakes: sevDesk's API, its identity lookup and the
 * CIMD host.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auth,
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpLog } from "../../src/http/log.js";
import { type RunningHttp, startHttpMode } from "../../src/http/run.js";
import { loadFixture } from "../helpers/fake-client.js";
import {
  ACCOUNT,
  CLAUDE_AI_CLIENT,
  CLAUDE_AI_REDIRECT,
  completeConsent,
  type CookieJar,
  DEAD_TOKEN,
  fakeCimd,
  fakeIdentity,
  ORIGIN,
  OTHER_TOKEN,
  RESOURCE,
  SEVDESK_TOKEN,
} from "../helpers/oauth-browser.js";
import { csrfOf, inboxLinks } from "../helpers/remote-approvals.js";
import { resultData } from "../helpers/write-flow.js";
import { invoiceRow } from "../unit/tools/lifecycle/helpers.js";

/** An in-memory OAuth client with claude.ai's identity. */
class ClaudeAiProvider implements OAuthClientProvider {
  readonly clientMetadataUrl = CLAUDE_AI_CLIENT;
  readonly redirectUrl = CLAUDE_AI_REDIRECT;
  authorizationUrl: URL | undefined;
  #client: StoredOAuthClientInformation | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #verifier = "";
  #discovery: OAuthDiscoveryState | undefined;

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Claude",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state(): string {
    return "e2e";
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
}

/** sevDesk's API for invoice 1001 (open), recording every request. */
function fakeSevdesk(): { fetch: typeof fetch; calls: string[]; tokens: Set<string> } {
  const calls: string[] = [];
  const tokens = new Set<string>();
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^\/api\/v1/, "");
    calls.push(`${request.method} ${path}`);
    tokens.add(request.headers.get("authorization") ?? "");
    if (request.method === "GET" && path === "/Invoice/1001") {
      return Promise.resolve(json({ objects: [invoiceRow()] }));
    }
    if (request.method === "PUT" && path === "/Invoice/1001/enshrine") {
      return Promise.resolve(json(loadFixture("lifecycle/enshrine.json").body));
    }
    return Promise.resolve(json({ error: { message: "Not found" } }, 404));
  };
  return { fetch: fetchImpl, calls, tokens };
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

interface Setup {
  readonly running: RunningHttp;
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly sevdesk: ReturnType<typeof fakeSevdesk>;
  readonly lines: string[];
  readonly dir: string;
}

async function start(env: Record<string, string> = {}): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), "sdmcp-http-e2e-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  const sevdesk = fakeSevdesk();
  const running = await startHttpMode({
    env: {
      SEVDESK_HTTP_AUTH: "oauth",
      SEVDESK_HTTP_PUBLIC_URL: ORIGIN,
      SEVDESK_HTTP_HOST: "127.0.0.1",
      SEVDESK_HTTP_PORT: "0",
      SEVDESK_HTTP_SECRET: randomBytes(32).toString("base64url"),
      SEVDESK_HTTP_STATE_DIR: join(dir, "state"),
      SEVDESK_OAUTH_ACCOUNTS: ACCOUNT,
      SEVDESK_ALLOW: "read,write,commit",
      SEVDESK_CONFIRM: "browser",
      SEVDESK_AUDIT_LOG: join(dir, "audit.jsonl"),
      ...env,
    },
    log: createHttpLog({ write: (line) => lines.push(line) }),
    identity: fakeIdentity().lookup,
    sevdeskFetch: sevdesk.fetch,
    cimd: fakeCimd(),
  });
  cleanup.push(() => running.close());
  return {
    running,
    fetch: (input, init) => running.server.router.fetch(new Request(input, init), "203.0.113.7"),
    sevdesk,
    lines,
    dir,
  };
}

/** Connects claude.ai's OAuth client after the user consented to `tiers`. */
async function connectClaudeAi(
  setup: Setup,
  tiers: readonly string[],
): Promise<{ client: Client; jar: CookieJar }> {
  const serverUrl = new URL(RESOURCE);
  const provider = new ClaudeAiProvider();
  expect(await auth(provider, { serverUrl, fetchFn: setup.fetch })).toBe("REDIRECT");
  const { redirect, jar } = await completeConsent(setup.fetch, provider.authorizationUrl ?? "", {
    tiers,
  });
  expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
  const code = redirect.searchParams.get("code") ?? "";
  expect(
    await auth(provider, { serverUrl, authorizationCode: code, iss: ORIGIN, fetchFn: setup.fetch }),
  ).toBe("AUTHORIZED");
  const client = new Client({ name: "claude-ai", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(serverUrl, { authProvider: provider, fetch: setup.fetch }),
  );
  cleanup.push(() => client.close());
  return { client, jar };
}

describe("HTTP mode end to end (OAuth, approvals inbox)", () => {
  it("consents, lists the granted tools, and runs a commit tool after an approval in the inbox", async () => {
    const setup = await start();
    const { client, jar } = await connectClaudeAi(setup, ["write", "commit"]);

    // Tools follow the grant: commit tools are there, external tools are not. File transfer is on
    // by default, so the file tools are listed (uploads and download links, no server folders).
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("sevdesk_invoice_enshrine");
    expect(names).toContain("sevdesk_contact_create");
    expect(names).not.toContain("sevdesk_invoice_send_email");
    expect(names).toContain("sevdesk_document_save");
    expect(names).toContain("sevdesk_upload_request");
    expect(names).toContain("sevdesk_voucher_import_einvoice");

    // 1. The commit call asks for approval in the inbox; nothing is written yet.
    const first = await client.callTool({
      name: "sevdesk_invoice_enshrine",
      arguments: { id: 1001 },
    });
    const pending = resultData(first);
    expect(pending["status"]).toBe("approval_pending");
    const reference = (pending["approval"] as { reference: string }).reference;
    expect(JSON.stringify(first)).toContain(`${ORIGIN}/approvals`);
    expect(setup.sevdesk.calls).not.toContain("PUT /Invoice/1001/enshrine");

    // 2. The browser that consented is signed in to the inbox and sees the approval.
    const inbox = await setup.fetch(`${ORIGIN}/approvals`, { headers: { Cookie: jar.header() } });
    expect(inbox.status).toBe(200);
    const list = await inbox.text();
    expect(list).toContain(reference);
    const [detailPath] = inboxLinks(list);
    if (detailPath === undefined) throw new Error("no approval in the inbox");
    const detail = await setup.fetch(`${ORIGIN}${detailPath}`, {
      headers: { Cookie: jar.header() },
    });
    const csrf = csrfOf(await detail.text()) ?? "";
    const decided = await setup.fetch(`${ORIGIN}${detailPath}`, {
      method: "POST",
      headers: {
        Cookie: jar.header(),
        Origin: ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf, decision: "approve" }),
    });
    expect(decided.status).toBe(200);
    expect(await decided.text()).toContain("Approved");

    // 3. The retry with the same arguments runs the approved action.
    const second = await client.callTool({
      name: "sevdesk_invoice_enshrine",
      arguments: { id: 1001 },
    });
    expect(resultData(second as never)["status"]).toBe("done");
    expect(setup.sevdesk.calls).toContain("PUT /Invoice/1001/enshrine");
    expect([...setup.sevdesk.tokens]).toEqual([SEVDESK_TOKEN]);

    // The audit log names the account and grant, never the token.
    const audit = await readFile(join(setup.dir, "audit.jsonl"), "utf8");
    const events = audit
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event["event"])).toEqual(
      expect.arrayContaining([
        "confirmation_requested",
        "approval_decided",
        "executing",
        "executed",
      ]),
    );
    for (const event of events) expect(event["account"]).toBe(ACCOUNT);
    expect(audit).not.toContain(SEVDESK_TOKEN);

    // No secret in the server's log lines.
    const logText = setup.lines.join("\n");
    expect(logText).not.toContain(SEVDESK_TOKEN);
    expect(logText).not.toContain("sdmcp_");
  });

  it("offers only read tools to a read-only grant and refuses requests without a token", async () => {
    const setup = await start();
    const unauthenticated = await setup.fetch(RESOURCE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.text();
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    const { client } = await connectClaudeAi(setup, []);
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(10);
    // Read tier only; the two file writers change nothing in sevDesk but hand out download
    // links, so they say readOnlyHint: false.
    expect(
      tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name),
    ).toEqual(["sevdesk_csv_export", "sevdesk_document_save"]);
  });

  it("lists no file tools with SEVDESK_HTTP_FILES=off", async () => {
    const setup = await start({ SEVDESK_HTTP_FILES: "off" });
    const { client } = await connectClaudeAi(setup, ["write"]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("sevdesk_voucher_create_draft");
    for (const name of [
      "sevdesk_upload_request",
      "sevdesk_document_save",
      "sevdesk_csv_export",
      "sevdesk_einvoice_parse",
      "sevdesk_voucher_import_einvoice",
    ]) {
      expect(names, name).not.toContain(name);
    }
  });

  it("lets another browser sign in to the inbox with the token of an allowed account only", async () => {
    const setup = await start();
    const login = (token: string): Promise<Response> =>
      setup.fetch(`${ORIGIN}/approvals/login`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });

    const dead = await login(DEAD_TOKEN);
    expect(await dead.text()).toContain("sevDesk did not accept this API token");

    const refused = await login(OTHER_TOKEN);
    const refusedPage = await refused.text();
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(refusedPage).toContain("not set up for the sevDesk account");
    expect(refusedPage).not.toContain(OTHER_TOKEN);

    const accepted = await login(SEVDESK_TOKEN);
    await accepted.text();
    expect(accepted.status).toBe(303);
    const cookie = accepted.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-sevdesk_session=/);
    const inbox = await setup.fetch(`${ORIGIN}/approvals`, {
      headers: { Cookie: cookie.split(";")[0] ?? "" },
    });
    expect(inbox.status).toBe(200);
    expect(await inbox.text()).not.toContain('name="token"');
  });

  it("serves bearer mode with the inbox unlocked by the configured sevDesk token", async () => {
    const bearer = randomBytes(32).toString("base64url");
    const setup = await start({
      SEVDESK_HTTP_AUTH: "bearer",
      SEVDESK_HTTP_BEARER_TOKEN: bearer,
      SEVDESK_API_TOKEN: SEVDESK_TOKEN,
      SEVDESK_OAUTH_ACCOUNTS: "",
      SEVDESK_HTTP_SECRET: "",
    });
    const client = new Client({ name: "bearer-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: setup.fetch,
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      }),
    );
    cleanup.push(() => client.close());
    const first = await client.callTool({
      name: "sevdesk_invoice_enshrine",
      arguments: { id: 1001 },
    });
    expect(resultData(first as never)["status"]).toBe("approval_pending");

    const wrong = await setup.fetch(`${ORIGIN}/approvals/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: OTHER_TOKEN }),
    });
    expect(await wrong.text()).toContain("not the sevDesk API token");
    const login = await setup.fetch(`${ORIGIN}/approvals/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: SEVDESK_TOKEN }),
    });
    await login.text();
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const inbox = await setup.fetch(`${ORIGIN}/approvals`, { headers: { Cookie: cookie } });
    const list = await inbox.text();
    expect(list).toContain(
      (resultData(first as never)["approval"] as { reference: string }).reference,
    );
    expect(setup.lines.join("\n")).not.toContain(bearer);
  });

  it("serves without the inbox when confirmations use elicitation, in both modes", async () => {
    const oauth = await start({ SEVDESK_CONFIRM: "elicit" });
    const noInbox = await oauth.fetch(`${ORIGIN}/approvals`);
    await noInbox.text();
    expect(noInbox.status).toBe(404);

    const bearer = await start({
      SEVDESK_HTTP_AUTH: "bearer",
      SEVDESK_HTTP_BEARER_TOKEN: randomBytes(32).toString("base64url"),
      SEVDESK_API_TOKEN: SEVDESK_TOKEN,
      SEVDESK_OAUTH_ACCOUNTS: "",
      SEVDESK_HTTP_SECRET: "",
      SEVDESK_CONFIRM: "elicit",
    });
    const health = await bearer.fetch(`${ORIGIN}/healthz`);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("closes what it opened when the port is taken", async () => {
    const first = await start();
    await expect(start({ SEVDESK_HTTP_PORT: String(first.running.port) })).rejects.toThrow();
    // The failed start closed its grant store and factory; the first server still serves.
    const health = await first.fetch(`${ORIGIN}/healthz`);
    expect(health.status).toBe(200);
    await health.text();
    const again = await start();
    expect(again.running.port).toBeGreaterThan(0);
  });
});
