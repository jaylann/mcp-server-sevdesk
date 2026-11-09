import { X509Certificate } from "node:crypto";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CimdError,
  createCimdFetcher,
  createHttpsGet,
  type HttpsGet,
  type HttpsGetResponse,
  parseClientIdUrl,
} from "../../../../src/http/oauth/cimd.js";
import {
  captureLog,
  CLAUDE_AI_CLIENT,
  CLAUDE_AI_REDIRECT,
  fakeCimd,
  fakeClock,
} from "../../../helpers/oauth-browser.js";
import { selfSignedCertificate } from "./self-signed.js";

const DOC = {
  client_id: CLAUDE_AI_CLIENT,
  client_name: "Claude",
  redirect_uris: [CLAUDE_AI_REDIRECT],
};

function serving(response: Partial<HttpsGetResponse> & { json?: unknown }): HttpsGet {
  return vi.fn(() =>
    Promise.resolve({
      status: response.status ?? 200,
      headers: response.headers ?? { "content-type": "application/json" },
      body: response.body ?? Buffer.from(JSON.stringify(response.json ?? DOC)),
    }),
  );
}

function fetcher(get: HttpsGet, overrides: { clients?: readonly string[] | "any" } = {}) {
  const clock = fakeClock();
  const log = captureLog();
  const cimd = fakeCimd();
  const resolve = vi.fn(cimd.resolve);
  return {
    clock,
    log,
    resolve,
    load: createCimdFetcher({
      clients: overrides.clients ?? ["claude.ai"],
      resolve,
      get,
      now: clock.now,
      log,
    }).load,
  };
}

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.catch((e: unknown) => e);
  return error instanceof CimdError ? error.reason : undefined;
}

describe("parseClientIdUrl", () => {
  it("accepts canonical https URLs with a DNS host and a path", () => {
    expect(parseClientIdUrl(CLAUDE_AI_CLIENT)?.hostname).toBe("claude.ai");
    expect(parseClientIdUrl("https://app.example.co.uk/oauth/client.json")).toBeDefined();
  });

  it.each([
    "http://claude.ai/oauth/x",
    "https://claude.ai/",
    "https://claude.ai",
    "https://claude.ai/oauth/x?a=1",
    "https://claude.ai/oauth/x?",
    "https://claude.ai/oauth/x#f",
    "https://user:pw@claude.ai/oauth/x",
    "https://claude.ai:443/oauth/x",
    "https://claude.ai:8443/oauth/x",
    "https://CLAUDE.ai/oauth/x",
    "https://claude.ai/oauth/../x",
    "https://claude.ai/oauth/%2e%2e/x",
    "https://claude.ai/./oauth/x",
    "https://127.0.0.1/oauth/x",
    "https://[::1]/oauth/x",
    "https://localhost/oauth/x",
    "https://intranet/oauth/x",
    "https://claude.ai/oauth/x ",
    "https://claude.ai\\oauth\\x",
    "",
    `https://claude.ai/${"a".repeat(600)}`,
    "not a url",
  ])("refuses %s", (raw) => {
    expect(parseClientIdUrl(raw)).toBeUndefined();
  });
});

describe("CIMD fetcher", () => {
  it("loads, validates and caches a document", async () => {
    const get = serving({
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "max-age=120",
      },
    });
    const { load, resolve, clock } = fetcher(get);
    const metadata = await load(CLAUDE_AI_CLIENT);
    expect(metadata).toEqual({
      clientId: CLAUDE_AI_CLIENT,
      host: "claude.ai",
      name: "Claude",
      redirectUris: [CLAUDE_AI_REDIRECT],
    });
    expect(get).toHaveBeenCalledWith({
      hostname: "claude.ai",
      path: "/oauth/mcp-oauth-client-metadata",
      address: { address: "160.79.104.10", family: 4 },
    });
    await load(CLAUDE_AI_CLIENT);
    expect(get).toHaveBeenCalledTimes(1);
    clock.advance(121_000);
    await load(CLAUDE_AI_CLIENT);
    expect(get).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("clamps max-age to at least 60 s and at most 24 h", async () => {
    const short = serving({
      headers: { "content-type": "application/json", "cache-control": "max-age=1" },
    });
    const a = fetcher(short);
    await a.load(CLAUDE_AI_CLIENT);
    a.clock.advance(59_000);
    await a.load(CLAUDE_AI_CLIENT);
    expect(short).toHaveBeenCalledTimes(1);
    a.clock.advance(2_000);
    await a.load(CLAUDE_AI_CLIENT);
    expect(short).toHaveBeenCalledTimes(2);

    const long = serving({
      headers: { "content-type": "application/json", "cache-control": "public, max-age=999999999" },
    });
    const b = fetcher(long);
    await b.load(CLAUDE_AI_CLIENT);
    b.clock.advance(86_399_000);
    await b.load(CLAUDE_AI_CLIENT);
    expect(long).toHaveBeenCalledTimes(1);
    b.clock.advance(2_000);
    await b.load(CLAUDE_AI_CLIENT);
    expect(long).toHaveBeenCalledTimes(2);
  });

  it("checks the allowlist before any network access", async () => {
    const get = serving({});
    const { load, resolve, log } = fetcher(get);
    expect(await reason(load("https://evil.example/oauth/client"))).toBe("client_not_allowed");
    expect(resolve).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(log.lines).toContainEqual({
      level: "warn",
      event: "cimd_blocked",
      fields: { reason: "client_not_allowed", host: "evil.example" },
    });
    expect(await reason(load("http://claude.ai/x"))).toBe("invalid_client_id");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("accepts any host with clients=any", async () => {
    const doc = { ...DOC, client_id: "https://tool.example/client" };
    const { load } = fetcher(serving({ json: doc }), { clients: "any" });
    await expect(load("https://tool.example/client")).resolves.toMatchObject({
      host: "tool.example",
    });
  });

  it.each([
    [[{ address: "10.0.0.1", family: 4 }]],
    [[{ address: "::ffff:127.0.0.1", family: 6 }]],
    [[{ address: "64:ff9b::a9fe:a9fe", family: 6 }]],
    [[{ address: "2002:c0a8:0101::1", family: 6 }]],
    [
      [
        { address: "160.79.104.10", family: 4 },
        { address: "192.168.0.1", family: 4 },
      ],
    ],
  ] as const)("refuses non-public addresses %j, resolving once", async (addresses) => {
    const get = serving({});
    const resolve = vi.fn(() => Promise.resolve(addresses));
    const log = captureLog();
    const { load } = createCimdFetcher({
      clients: ["claude.ai"],
      resolve,
      get,
      now: Date.now,
      log,
    });
    expect(await reason(load(CLAUDE_AI_CLIENT))).toBe("blocked_address");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("gives up on a resolver that does not answer", async () => {
    const { load } = createCimdFetcher({
      clients: "any",
      resolve: () => new Promise(() => undefined),
      resolveTimeoutMs: 20,
      get: serving({}),
      now: Date.now,
      log: captureLog(),
    });
    expect(await reason(load("https://slow.example/client"))).toBe("unresolvable");
  });

  it("refuses unresolvable hosts", async () => {
    const { load } = createCimdFetcher({
      clients: "any",
      resolve: () => Promise.reject(new Error("ENOTFOUND")),
      get: serving({}),
      now: Date.now,
      log: captureLog(),
    });
    expect(await reason(load("https://nx.example/client"))).toBe("unresolvable");
  });

  it.each([
    ["a redirect", { status: 302, headers: { location: "https://10.0.0.1/" } }, "redirect"],
    ["an error status", { status: 500 }, "bad_status"],
    ["a non-JSON type", { headers: { "content-type": "text/html" } }, "bad_content_type"],
    ["a missing type", { headers: {} }, "bad_content_type"],
    ["6 KiB", { body: Buffer.alloc(6 * 1024, 0x20) }, "too_large"],
    ["invalid JSON", { body: Buffer.from("{nope") }, "invalid_document"],
    [
      "an id mismatch",
      { json: { ...DOC, client_id: "https://claude.ai/other" } },
      "invalid_document",
    ],
    ["no redirect URIs", { json: { ...DOC, redirect_uris: [] } }, "invalid_document"],
    [
      "11 redirect URIs",
      { json: { ...DOC, redirect_uris: Array.from({ length: 11 }, () => CLAUDE_AI_REDIRECT) } },
      "invalid_document",
    ],
    ["a secret", { json: { ...DOC, client_secret: "s" } }, "invalid_document"],
    ["a secret expiry", { json: { ...DOC, client_secret_expires_at: 0 } }, "invalid_document"],
    [
      "client_secret_basic",
      { json: { ...DOC, token_endpoint_auth_method: "client_secret_basic" } },
      "invalid_document",
    ],
    [
      "no code grant",
      { json: { ...DOC, grant_types: ["client_credentials"] } },
      "invalid_document",
    ],
    ["no code response", { json: { ...DOC, response_types: ["token"] } }, "invalid_document"],
  ] as const)("refuses %s and never caches the failure", async (_label, response, expected) => {
    const get = serving(response);
    const { load } = fetcher(get);
    expect(await reason(load(CLAUDE_AI_CLIENT))).toBe(expected);
    expect(await reason(load(CLAUDE_AI_CLIENT))).toBe(expected);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("maps network failures to fetch_failed", async () => {
    const { load } = fetcher(() => Promise.reject(new Error("ECONNRESET")));
    expect(await reason(load(CLAUDE_AI_CLIENT))).toBe("fetch_failed");
  });

  it("sanitizes the self-declared name", async () => {
    const { load } = fetcher(
      serving({ json: { ...DOC, client_name: "  <script>alert(1)</script>‮\n Claude  " } }),
    );
    expect((await load(CLAUDE_AI_CLIENT)).name).toBe("<script>alert(1)</script> Claude");
    const blank = fetcher(serving({ json: { ...DOC, client_name: "​" } }));
    expect((await blank.load(CLAUDE_AI_CLIENT)).name).toBeUndefined();
  });

  it("shares one fetch between concurrent loads and evicts the oldest of 64 entries", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = vi.fn<HttpsGet>(async (request) => {
      await gate;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({ ...DOC, client_id: `https://${request.hostname}${request.path}` }),
        ),
      };
    });
    const { load } = fetcher(get, { clients: "any" });
    const both = Promise.all([load(CLAUDE_AI_CLIENT), load(CLAUDE_AI_CLIENT)]);
    release();
    await both;
    expect(get).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 64; index += 1) await load(`https://c${String(index)}.example/x`);
    expect(get).toHaveBeenCalledTimes(65);
    await load(CLAUDE_AI_CLIENT);
    expect(get).toHaveBeenCalledTimes(66);
  });
});

describe("createHttpsGet (real TLS on 127.0.0.1)", () => {
  const servers: (HttpsServer | NetServer)[] = [];
  const sockets = new Set<Socket>();
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            if ("closeAllConnections" in server) server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  const HOST = "client.example.test";
  const { key, cert } = selfSignedCertificate(HOST);

  async function tlsServer(
    handler: Parameters<typeof createHttpsServer>[1],
  ): Promise<{ port: number; hosts: string[] }> {
    const hosts: string[] = [];
    const server = createHttpsServer({ key, cert }, (request, response) => {
      hosts.push(request.headers.host ?? "");
      handler?.(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return { port: typeof address === "object" && address !== null ? address.port : 0, hosts };
  }

  const target = {
    hostname: HOST,
    path: "/oauth/client",
    address: { address: "127.0.0.1", family: 4 as const },
  };

  it("generates a certificate for the test host", () => {
    expect(new X509Certificate(cert).checkHost(HOST)).toBe(HOST);
  });

  it("connects to the pinned address with SNI and the Host header of the name", async () => {
    const { port, hosts } = await tlsServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "max-age=60",
      });
      response.end(JSON.stringify(DOC));
    });
    const response = await createHttpsGet({ port, ca: cert })(target);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.body.toString("utf8"))).toEqual(DOC);
    expect(hosts).toEqual([`${HOST}:${String(port)}`]);
  });

  it("verifies the certificate against the host name", async () => {
    const { port } = await tlsServer((_request, response) => response.end("{}"));
    await expect(
      createHttpsGet({ port, ca: cert })({ ...target, hostname: "other.example.test" }),
    ).rejects.toThrow();
    await expect(createHttpsGet({ port })(target)).rejects.toThrow();
  });

  it("does not follow redirects", async () => {
    const { port } = await tlsServer((_request, response) => {
      response.writeHead(302, { Location: "https://169.254.169.254/" });
      response.end();
    });
    const response = await createHttpsGet({ port, ca: cert })(target);
    expect(response.status).toBe(302);
    expect(response.body.length).toBe(0);
  });

  it("stops reading bodies over the cap, declared or streamed", async () => {
    const declared = await tlsServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "6144" });
      response.end(Buffer.alloc(6144, 0x20));
    });
    await expect(createHttpsGet({ port: declared.port, ca: cert })(target)).rejects.toMatchObject({
      reason: "too_large",
    });
    const streamed = await tlsServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write(Buffer.alloc(4096, 0x20));
      response.end(Buffer.alloc(2048, 0x20));
    });
    await expect(createHttpsGet({ port: streamed.port, ca: cert })(target)).rejects.toMatchObject({
      reason: "too_large",
    });
  });

  it("gives up on a slow server (total timeout)", async () => {
    const { port } = await tlsServer(() => undefined);
    await expect(createHttpsGet({ port, ca: cert, totalTimeoutMs: 150 })(target)).rejects.toThrow(
      "timeout",
    );
  });

  it("gives up when the TLS handshake never completes (connect timeout)", async () => {
    // Accepts the connection but never speaks TLS.
    const server = createNetServer((socket) => {
      sockets.add(socket);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await expect(createHttpsGet({ port, ca: cert, connectTimeoutMs: 100 })(target)).rejects.toThrow(
      "connect timeout",
    );
  });
});
