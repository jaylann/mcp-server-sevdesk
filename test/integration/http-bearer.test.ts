/**
 * Bearer mode end to end over a real socket: configuration from the environment, the router and
 * its hardening, the bearer authenticator, the SDK's stateless MCP handler and the real server
 * factory, reached by the real SDK client in both protocol eras.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBearerAuthenticator } from "../../src/http/bearer.js";
import { httpDeployment, loadHttpConfig } from "../../src/http/config.js";
import { createHttpLog } from "../../src/http/log.js";
import { createMcpRoute, MCP_PATH } from "../../src/http/mcp-route.js";
import { type HttpServerHandle, startHttpServer } from "../../src/http/serve.js";
import { createServerFactory, type ServerFactory } from "../../src/server.js";
import { PACKAGE_NAME, VERSION } from "../../src/version.js";
import { TEST_TOKEN } from "../helpers/config.js";
import { stubClient } from "../helpers/dummy-tools.js";
import { rawRequest } from "../helpers/http-raw.js";

const BEARER = "Zq3xR7pL0vN2mK8sT4wY6bH1cJ5dF9gA-_mcp";
const NEXT_BEARER = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY-next";

let handle: HttpServerHandle;
let factory: ServerFactory | undefined;
const logLines: string[] = [];
const bodies: string[] = [];

beforeAll(async () => {
  const loaded = loadHttpConfig({
    SEVDESK_HTTP_AUTH: "bearer",
    SEVDESK_HTTP_PORT: "0",
    SEVDESK_HTTP_BEARER_TOKEN: `${BEARER},${NEXT_BEARER}`,
    SEVDESK_API_TOKEN: TEST_TOKEN,
    SEVDESK_BASE_URL: "https://127.0.0.1:9/api/v1",
  });
  const log = createHttpLog({ write: (line) => logLines.push(line), secrets: loaded.secrets });
  const fixed = loaded.fixed;
  if (fixed === undefined) throw new Error("bearer mode must yield a fixed config");
  // The factory needs the origin, which a port-0 server only knows once it listens.
  const lateFactory: McpServerFactory = (ctx) => {
    if (factory === undefined) throw new Error("not listening yet");
    return factory(ctx);
  };
  const mcp = createMcpRoute({
    authenticator: createBearerAuthenticator(loaded.http.bearerTokens, {
      tiers: loaded.settings.allowedTiers,
    }),
    factory: lateFactory,
    log,
  });
  handle = await startHttpServer({
    http: loaded.http,
    routes: [mcp.route],
    log,
    announce: () => undefined,
  });
  factory = createServerFactory({
    config: {
      ...fixed,
      deployment: httpDeployment("bearer", handle.origin, loaded.settings.confirm),
    },
    client: stubClient(),
  });
});

afterAll(async () => {
  await handle.close();
  await factory?.close();
});

async function connect(era: "modern" | "legacy", token: string | undefined): Promise<Client> {
  const client = new Client(
    { name: "bearer-e2e", version: "0.0.0" },
    era === "legacy" ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${handle.origin}${MCP_PATH}`), {
      ...(token === undefined
        ? {}
        : { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    }),
  );
  return client;
}

async function raw(options: Parameters<typeof rawRequest>[1]) {
  const response = await rawRequest(handle.port, options);
  bodies.push(response.body);
  return response;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("bearer mode over HTTP", () => {
  it("listens on loopback with a free port", () => {
    expect(handle.origin).toBe(`http://127.0.0.1:${String(handle.port)}`);
  });

  it.each([
    ["modern", BEARER],
    ["legacy", BEARER],
    ["modern", NEXT_BEARER],
  ] as const)("serves the %s SDK client with a valid bearer token", async (era, token) => {
    const client = await connect(era, token);
    expect(client.getServerVersion()).toMatchObject({ name: PACKAGE_NAME, version: VERSION });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });

  it("refuses the SDK client without a token", async () => {
    await expect(connect("legacy", undefined)).rejects.toThrow();
  });

  it("answers 401 with a bearer challenge for a missing or wrong token", async () => {
    for (const authorization of [undefined, `Bearer ${BEARER.slice(0, -1)}X`, `Basic ${BEARER}`]) {
      const response = await raw({
        method: "POST",
        path: MCP_PATH,
        headers: {
          ...MCP_HEADERS,
          ...(authorization === undefined ? {} : { Authorization: authorization }),
        },
        body: INITIALIZE,
      });
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toMatch(/^Bearer realm="mcp-server-sevdesk"/);
      expect(response.headers["www-authenticate"]).not.toContain("resource_metadata");
    }
  });

  it("refuses a foreign Host and a foreign Origin, even with a valid token", async () => {
    const host = await raw({
      method: "POST",
      path: MCP_PATH,
      headers: { ...MCP_HEADERS, Host: "attacker.example", Authorization: `Bearer ${BEARER}` },
      body: INITIALIZE,
    });
    expect(host.status).toBe(403);
    const origin = await raw({
      method: "POST",
      path: MCP_PATH,
      headers: {
        ...MCP_HEADERS,
        Origin: "https://attacker.example",
        Authorization: `Bearer ${BEARER}`,
      },
      body: INITIALIZE,
    });
    expect(origin.status).toBe(403);
    const nullOrigin = await raw({
      method: "POST",
      path: MCP_PATH,
      headers: { ...MCP_HEADERS, Origin: "null", Authorization: `Bearer ${BEARER}` },
      body: INITIALIZE,
    });
    expect(nullOrigin.status).toBe(403);
  });

  it("accepts a loopback browser Origin on a loopback bind", async () => {
    const response = await raw({
      method: "POST",
      path: MCP_PATH,
      headers: {
        ...MCP_HEADERS,
        Origin: "http://localhost:6274",
        Authorization: `Bearer ${BEARER}`,
      },
      body: INITIALIZE,
    });
    expect(response.status).toBe(200);
  });

  it("answers 413 for a body over 1 MiB, 405 for other methods, 404 elsewhere", async () => {
    const large = await raw({
      method: "POST",
      path: MCP_PATH,
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${BEARER}` },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(large.status).toBe(413);
    const put = await raw({ method: "PUT", path: MCP_PATH, body: "{}" });
    expect(put.status).toBe(405);
    expect(put.headers["allow"]).toBe("POST, GET, DELETE");
    expect((await raw({ path: "/.well-known/oauth-protected-resource" })).status).toBe(404);
  });

  it("serves /healthz to any Host", async () => {
    const response = await raw({ path: "/healthz", headers: { Host: "internal-check" } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  it("logs every request without secrets", () => {
    const records = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const requests = records.filter((record) => record["event"] === "request");
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.some((record) => record["status"] === 401)).toBe(true);
    expect(requests.some((record) => record["grant"] === "bearer")).toBe(true);
    const everything = [...logLines, ...bodies].join("\n");
    for (const secret of [BEARER, NEXT_BEARER, TEST_TOKEN]) {
      expect(everything).not.toContain(secret);
    }
  });
});
