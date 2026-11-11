import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type AuthInfo, McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import { createBearerAuthenticator } from "../../../src/http/bearer.js";
import { createHttpLog } from "../../../src/http/log.js";
import {
  batchRefusal,
  createMcpRoute,
  DEFAULT_MCP_RATE_LIMIT,
  MCP_MAX_BATCH_MESSAGES,
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

  it("is authenticated by the router, and authenticates itself when called directly", async () => {
    const { mcp, seen } = setup();
    expect(mcp.route.authenticator).toBeDefined();
    const ctx = {
      clientIp: "127.0.0.1",
      origin: ORIGIN,
      signal: new AbortController().signal,
      log: createHttpLog({ write: () => undefined }),
      limit: () => true,
    };
    const refused = await mcp.route.handle(
      new Request(`${ORIGIN}${MCP_PATH}`, { method: "POST", body: "{}" }),
      ctx,
    );
    expect(refused?.status).toBe(401);
    const allowed = await mcp.route.handle(
      new Request(`${ORIGIN}${MCP_PATH}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
      }),
      ctx,
    );
    expect(allowed?.status).toBe(405);
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

describe("createMcpRoute: legacy batches (review 2026-11, round 3)", () => {
  /** A server whose `slow` tool runs until `release()`; counts starts and aborts. */
  function slowSetup() {
    const state = { started: 0, aborted: 0 };
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: McpServerFactory = () => {
      const server = new McpServer({ name: "batch-test", version: "0.0.0" });
      server.registerTool("slow", { description: "Slow." }, async (ctx) => {
        state.started += 1;
        ctx.mcpReq.signal.addEventListener("abort", () => {
          state.aborted += 1;
        });
        await released;
        return { content: [{ type: "text", text: "done" }] };
      });
      return server;
    };
    return { ...setup(factory), state, release };
  }
  const post = (router: ReturnType<typeof createRouter>, body: unknown) =>
    router.fetch(
      new Request(`${ORIGIN}${MCP_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const call = (id: number | string) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "slow", arguments: {} },
  });
  const ping = (id: number | string) => ({ jsonrpc: "2.0", id, method: "ping" });
  /** The JSON-RPC messages of an SSE (or JSON) response body. */
  const messages = (text: string): { id?: unknown; result?: unknown; error?: unknown }[] => {
    const parse = (json: string) => JSON.parse(json) as unknown;
    const found = text.startsWith("{") || text.startsWith("[") ? [parse(text)] : [];
    for (const line of text.split("\n")) {
      if (line.startsWith("data:") && line.slice(5).trim() !== "") found.push(parse(line.slice(5)));
    }
    return found.flat() as { id?: unknown; result?: unknown; error?: unknown }[];
  };

  it.each([
    ["the same number", 7, 7],
    ["a number and its text", 7, "7"],
  ])("refuses a batch whose requests share an id (%s): no tool starts", async (_, a, b) => {
    const { router, state, lines, release } = slowSetup();
    const response = await post(router, [call(a), ping(b)]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32_600, message: expect.stringContaining("same id") as string },
      id: null,
    });
    // Without the check the ping's answer ends the response while the tool call runs on,
    // unaborted and outside the router's slot.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state).toEqual({ started: 0, aborted: 0 });
    expect(router.inFlight).toBe(0);
    expect(lines.some((line) => line["event"] === "mcp_error")).toBe(true);
    release();
  });

  it("serves a small batch with distinct ids, and holds the slot until every answer is out", async () => {
    const { router, state, release } = slowSetup();
    const pending = post(router, [call(1), ping(2), { jsonrpc: "2.0", method: "notifications/x" }]);
    await vi.waitFor(() => {
      expect(state.started).toBe(1);
    });
    expect(router.inFlight).toBe(1);
    release();
    const response = await pending;
    expect(response.status).toBe(200);
    const answers = messages(await response.text());
    expect(answers.map((message) => message.id).sort()).toEqual([1, 2]);
    expect(answers.every((message) => message.error === undefined)).toBe(true);
    expect(router.inFlight).toBe(0);
  });

  it("refuses a batch of more than 8 messages, and serves one of 8", async () => {
    const { router, state, release } = slowSetup();
    expect(MCP_MAX_BATCH_MESSAGES).toBe(8);
    const nine = await post(
      router,
      Array.from({ length: 9 }, (_, index) => call(index)),
    );
    expect(nine.status).toBe(400);
    expect(await nine.json()).toMatchObject({
      error: { code: -32_600, message: expect.stringContaining("at most 8") as string },
      id: null,
    });
    expect(state.started).toBe(0);

    const eight = await post(
      router,
      Array.from({ length: 8 }, (_, index) => ping(index)),
    );
    expect(eight.status).toBe(200);
    expect(messages(await eight.text())).toHaveLength(8);
    release();
  });

  it("leaves single messages, notifications and bodies that are not JSON to the SDK", async () => {
    const { router, release } = slowSetup();
    release();
    const single = await post(router, ping(7));
    expect(single.status).toBe(200);
    expect(messages(await single.text())).toMatchObject([{ id: 7, result: {} }]);
    const notifications = await post(router, [
      { jsonrpc: "2.0", method: "notifications/x" },
      { jsonrpc: "2.0", method: "notifications/x" },
    ]);
    expect(notifications.status).toBe(202);
    const broken = await post(router, '[{"jsonrpc":"2.0","id":7,"method":"ping"},');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: -32_700 } });
  });

  it("counts only requests when it compares ids", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    // Answers to the server's own requests live in another id space.
    expect(
      batchRefusal(encode([ping(1), { jsonrpc: "2.0", id: 1, result: {} }, ping(2)])),
    ).toBeUndefined();
    expect(batchRefusal(encode([ping(1), ping(2), ping(1)]))?.message).toContain("same id");
    expect(batchRefusal(encode({ jsonrpc: "2.0", id: 1, method: "ping" }))).toBeUndefined();
    expect(batchRefusal(encode("[1, 1]"))).toBeUndefined();
    expect(batchRefusal(new TextEncoder().encode(" \n\t[1, 2"))).toBeUndefined();
    expect(batchRefusal(new Uint8Array())).toBeUndefined();
    // Leading white space and a byte order mark do not hide a batch.
    const padded = new TextEncoder().encode(`\uFEFF \n${JSON.stringify([ping("a"), ping("a")])}`);
    expect(batchRefusal(padded)?.message).toContain("same id");
  });
});
