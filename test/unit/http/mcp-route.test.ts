import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type AuthInfo, McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import { createBearerAuthenticator } from "../../../src/http/bearer.js";
import { createHttpLog } from "../../../src/http/log.js";
import {
  createMcpRoute,
  DEFAULT_MCP_RATE_LIMIT,
  MCP_MAX_BODY_BYTES,
  MCP_PATH,
} from "../../../src/http/mcp-route.js";
import { createRouter } from "../../../src/http/router.js";

const TOKEN = "Zq3xR7pL0vN2mK8sT4wY6bH1cJ5dF9gA-_mcp";
const ORIGIN = "http://127.0.0.1:8080";

function setup(factory?: McpServerFactory, onerror?: (error: Error) => void) {
  const seen: (AuthInfo | undefined)[] = [];
  const lines: Record<string, unknown>[] = [];
  const log = createHttpLog({
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    secrets: [TOKEN],
  });
  const defaultFactory: McpServerFactory = (ctx) => {
    seen.push(ctx.authInfo);
    const server = new McpServer({ name: "route-test", version: "1.2.3" });
    server.registerTool("ping", { description: "Ping." }, () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return server;
  };
  const mcp = createMcpRoute({
    authenticator: createBearerAuthenticator([TOKEN], { tiers: ["read"] }),
    factory: factory ?? defaultFactory,
    log,
    ...(onerror === undefined ? {} : { onerror }),
  });
  const router = createRouter({
    http: { allowedHosts: ["127.0.0.1"], allowedOrigins: [ORIGIN], trustProxy: 0 },
    origin: ORIGIN,
    routes: [mcp.route],
    log,
  });
  return { mcp, router, seen, lines };
}

async function connect(router: ReturnType<typeof createRouter>, era: "modern" | "legacy") {
  const client = new Client(
    { name: "route-client", version: "0.0.0" },
    era === "legacy" ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      fetch: (url, init) => router.fetch(new Request(url, init)),
    }),
  );
  return client;
}

describe("createMcpRoute", () => {
  it("declares the MCP route with its limits", () => {
    const { mcp } = setup();
    expect(mcp.route).toMatchObject({
      path: "/mcp",
      methods: ["POST", "GET", "DELETE"],
      maxBodyBytes: MCP_MAX_BODY_BYTES,
      origin: "mcp",
      rateLimit: DEFAULT_MCP_RATE_LIMIT,
    });
    expect(MCP_MAX_BODY_BYTES).toBe(1_048_576);
  });

  it.each(["modern", "legacy"] as const)(
    "serves an authenticated %s client and hands AuthInfo to the factory",
    async (era) => {
      const { router, seen, lines } = setup();
      const client = await connect(router, era);
      expect(client.getServerVersion()).toMatchObject({ name: "route-test", version: "1.2.3" });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["ping"]);
      await client.close();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((auth) => auth?.clientId === "bearer" && auth.token === "bearer")).toBe(
        true,
      );
      const requests = lines.filter((line) => line["event"] === "request");
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((line) => line["route"] === "/mcp")).toBe(true);
      expect(requests.some((line) => line["grant"] === "bearer")).toBe(true);
      expect(JSON.stringify(lines)).not.toContain(TOKEN);
    },
  );

  it("answers 401 before the SDK sees the request", async () => {
    const { router, seen } = setup();
    for (const method of ["POST", "GET"]) {
      const response = await router.fetch(
        new Request(`${ORIGIN}${MCP_PATH}`, {
          method,
          ...(method === "POST"
            ? { body: "{}", headers: { "Content-Type": "application/json" } }
            : {}),
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="mcp-server-sevdesk"');
    }
    expect(seen).toEqual([]);
  });

  it("lets the SDK answer GET with 405 once authenticated", async () => {
    const { router } = setup();
    const response = await router.fetch(
      new Request(`${ORIGIN}${MCP_PATH}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
      }),
    );
    expect(response.status).toBe(405);
  });

  it("reports SDK errors through the log, or a custom onerror", async () => {
    const failing: McpServerFactory = () => {
      throw new Error(`factory failed near ${TOKEN}`);
    };
    const initialize = () =>
      new Request(`${ORIGIN}${MCP_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      });

    const logged = setup(failing);
    expect((await logged.router.fetch(initialize())).status).toBe(500);
    const warning = logged.lines.find((line) => line["event"] === "mcp_error");
    expect(warning?.["message"]).toContain("factory failed");
    expect(JSON.stringify(logged.lines)).not.toContain(TOKEN);

    const onerror = vi.fn();
    const custom = setup(failing, onerror);
    await custom.router.fetch(initialize());
    expect(onerror).toHaveBeenCalledWith(expect.any(Error));
    await custom.mcp.close();
  });
});
