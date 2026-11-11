import { EventEmitter } from "node:events";
import { Agent, createServer, request as httpRequest } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBearerAuthenticator } from "../../../src/http/bearer.js";
import { createHttpLog } from "../../../src/http/log.js";
import { createMcpRoute, MCP_PATH } from "../../../src/http/mcp-route.js";
import {
  exitOnSignals,
  type HttpServerHandle,
  limitConnectionsPerClient,
  requestTimeoutMs,
  SERVER_LIMITS,
  startHttpServer,
  type StartHttpServerOptions,
} from "../../../src/http/serve.js";
import type { HttpConfig, HttpRoute } from "../../../src/http/types.js";
import { openRequest, rawRequest } from "../../helpers/http-raw.js";

const HTTP: HttpConfig = {
  auth: "bearer",
  host: "127.0.0.1",
  port: 0,
  publicOrigin: undefined,
  allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
  allowedOrigins: ["http://localhost", "http://127.0.0.1", "http://[::1]"],
  trustProxy: 0,
  stateDir: undefined,
  bearerTokens: [],
  secret: undefined,
  previousSecret: undefined,
  oauth: undefined,
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const handles: HttpServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function start(
  routes: readonly HttpRoute[],
  overrides: Partial<HttpConfig> = {},
  drainMs = 5_000,
  limits: Pick<StartHttpServerOptions, "maxInFlight" | "maxPerClient" | "bodyTimeoutMs"> = {},
) {
  const lines: string[] = [];
  const announced: string[] = [];
  const handle = await startHttpServer({
    http: { ...HTTP, ...overrides },
    routes,
    log: createHttpLog({ write: (line) => lines.push(line) }),
    announce: (line) => announced.push(line),
    drainMs,
    ...limits,
  });
  handles.push(handle);
  return { handle, lines, announced };
}

const echo: HttpRoute = {
  path: "/echo",
  methods: ["GET", "POST"],
  maxBodyBytes: 16,
  origin: "none",
  handle: async (request) => new Response(request.method === "POST" ? await request.text() : "hi"),
};

describe("startHttpServer", () => {
  it("listens on a free port, announces the MCP URL and serves routes", async () => {
    const { handle, announced, lines } = await start([echo]);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.origin).toBe(`http://127.0.0.1:${String(handle.port)}`);
    expect(announced).toEqual([
      `mcp-server-sevdesk: listening on ${handle.origin}${MCP_PATH} (bound to 127.0.0.1:${String(handle.port)})`,
    ]);

    const health = await rawRequest(handle.port, {
      path: "/healthz",
      headers: { Host: "fly-check" },
    });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: "ok" });

    const posted = await rawRequest(handle.port, { method: "POST", path: "/echo", body: "hello" });
    expect(posted.body).toBe("hello");
    expect(posted.headers["x-content-type-options"]).toBe("nosniff");
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ event: "request", route: "/echo", status: 200, ip: "127.0.0.1" }),
    ]);
  });

  it("refuses a foreign Host and an oversized body over a real socket", async () => {
    const { handle } = await start([echo]);
    const foreign = await rawRequest(handle.port, {
      path: "/echo",
      headers: { Host: "evil.example" },
    });
    expect(foreign.status).toBe(403);
    const large = await rawRequest(handle.port, {
      method: "POST",
      path: "/echo",
      body: "x".repeat(256 * 1024),
    });
    expect(large.status).toBe(413);
  });

  it("uses the public origin when one is configured", async () => {
    const { handle, announced } = await start([echo], {
      publicOrigin: "https://mcp.example.com",
      allowedHosts: ["mcp.example.com"],
    });
    expect(handle.origin).toBe("https://mcp.example.com");
    expect(announced[0]).toContain("listening on https://mcp.example.com/mcp (bound to 127.0.0.1:");
    const response = await rawRequest(handle.port, {
      path: "/echo",
      headers: { Host: "mcp.example.com" },
    });
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
  });

  it("rejects when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(
        startHttpServer({
          http: { ...HTTP, port },
          routes: [],
          log: createHttpLog({ write: () => undefined }),
          announce: () => undefined,
        }),
      ).rejects.toThrow(`Cannot listen on 127.0.0.1:${String(port)} (EADDRINUSE).`);
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
    }
  });

  it("sets the socket limits", () => {
    expect(SERVER_LIMITS).toEqual({
      headersTimeoutMs: 15_000,
      requestMarginMs: 30_000,
      keepAliveTimeoutMs: 65_000,
      maxConnections: 256,
      maxConnectionsPerClient: 64,
    });
  });

  it("gives a whole request longer than the longest body window of any route (review 2026-11, round 3)", async () => {
    // Node cut uploads off at a fixed 30 s while their route still allowed them 90 s.
    const upload: HttpRoute = { ...echo, path: "/upload", bodyTimeoutMs: 90_000 };
    expect(requestTimeoutMs([echo])).toBe(45_000);
    expect(requestTimeoutMs([echo, upload])).toBe(120_000);
    expect(requestTimeoutMs([echo, upload], 200_000)).toBe(230_000);
    expect(requestTimeoutMs([])).toBe(45_000);

    const plain = await start([echo]);
    expect(plain.handle.requestTimeoutMs).toBe(45_000);
    const withUpload = await start([echo, upload]);
    expect(withUpload.handle.requestTimeoutMs).toBeGreaterThan(90_000);
    expect(withUpload.handle.requestTimeoutMs).toBe(120_000);
    const slowBodies = await start([echo], {}, 5_000, { bodyTimeoutMs: 60_000 });
    expect(slowBodies.handle.requestTimeoutMs).toBe(90_000);
  });
});

describe("streaming and disconnects", () => {
  it("flushes each SSE event as it is produced", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const { handle } = await start([
      {
        ...echo,
        handle: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  controller = c;
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            ),
          ),
      },
    ]);
    const exchange = openRequest(handle.port, { path: "/echo" });
    exchange.request.end();
    await exchange.response;
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode("event: message\ndata: 1\n\n"));
    expect(await exchange.next()).toBe("event: message\ndata: 1\n\n");
    expect(handle.router.inFlight).toBe(1);
    controller.enqueue(encoder.encode("data: 2\n\n"));
    expect(await exchange.next()).toBe("data: 2\n\n");
    controller.close();
    expect(await exchange.next()).toBeUndefined();
    await handle.router.idle();
  });

  it("aborts the handler's signal when the client disconnects", async () => {
    const aborted = deferred<unknown>();
    const { handle } = await start([
      {
        ...echo,
        handle: (_request, ctx) =>
          new Promise<Response>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              aborted.resolve(ctx.signal.reason);
              resolve(new Response("too late"));
            });
          }),
      },
    ]);
    const exchange = openRequest(handle.port, { path: "/echo" });
    exchange.request.end();
    await vi.waitFor(() => {
      expect(handle.router.inFlight).toBe(1);
    });
    exchange.request.destroy();
    expect(await aborted.promise).toBeInstanceOf(Error);
    await handle.router.idle();
  });
});

describe("graceful close", () => {
  it("lets requests in flight finish, then stops", async () => {
    const release = deferred();
    const started = deferred();
    const { handle } = await start([
      {
        ...echo,
        handle: async () => {
          started.resolve();
          await release.promise;
          return new Response("finished");
        },
      },
    ]);
    const pending = rawRequest(handle.port, { path: "/echo" });
    await started.promise;
    const closed = handle.close();
    expect(handle.close()).toBe(closed);
    expect(handle.router.draining).toBe(true);
    // The listener is gone: new connections are refused.
    await expect(rawRequest(handle.port, { path: "/healthz" })).rejects.toThrow();
    release.resolve();
    const response = await pending;
    expect(response.body).toBe("finished");
    expect(response.headers["connection"]).toBe("close");
    await closed;
  });

  it("aborts what is still running after the drain time", async () => {
    const aborted = deferred();
    const { handle } = await start(
      [
        {
          ...echo,
          handle: (_request, ctx) =>
            new Promise<Response>((resolve) => {
              ctx.signal.addEventListener("abort", () => {
                aborted.resolve();
                resolve(new Response("stopped"));
              });
            }),
        },
      ],
      {},
      20,
    );
    const pending = rawRequest(handle.port, { path: "/echo" }).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(handle.router.inFlight).toBe(1);
    });
    await handle.close();
    await aborted.promise;
    await pending;
  });
});

describe("exitOnSignals", () => {
  function signals() {
    const emitter = new EventEmitter();
    return {
      target: emitter as unknown as Pick<NodeJS.Process, "on" | "off">,
      emit: (signal: NodeJS.Signals) => emitter.emit(signal),
      count: (signal: NodeJS.Signals) => emitter.listenerCount(signal),
    };
  }

  it("closes the server, runs onClosed and exits 0 on SIGTERM", async () => {
    const { target, emit } = signals();
    const exited = deferred<number>();
    const order: string[] = [];
    exitOnSignals(
      {
        close: () => {
          order.push("close");
          return Promise.resolve();
        },
      },
      {
        target,
        onClosed: () => {
          order.push("onClosed");
          return Promise.resolve();
        },
        exit: (code) => {
          exited.resolve(code);
        },
      },
    );
    emit("SIGTERM");
    expect(await exited.promise).toBe(0);
    expect(order).toEqual(["close", "onClosed"]);
  });

  it("exits 1 when cleanup fails, on a second signal, and past the hard limit", async () => {
    const lines: string[] = [];
    const log = createHttpLog({ write: (line) => lines.push(line) });
    const failing = signals();
    const failed = deferred<number>();
    exitOnSignals(
      { close: () => Promise.reject(new Error("flush failed")) },
      {
        target: failing.target,
        log,
        exit: (code) => {
          failed.resolve(code);
        },
      },
    );
    failing.emit("SIGINT");
    expect(await failed.promise).toBe(1);
    expect(lines.join("\n")).toContain("shutdown_failed");

    const twice = signals();
    const codes: number[] = [];
    exitOnSignals(
      { close: () => new Promise<void>(() => undefined) },
      { target: twice.target, exit: (code) => codes.push(code), timeoutMs: 60_000 },
    );
    twice.emit("SIGTERM");
    twice.emit("SIGINT");
    expect(codes).toEqual([1]);

    vi.useFakeTimers();
    try {
      const stuck = signals();
      const timedOut: number[] = [];
      exitOnSignals(
        { close: () => new Promise<void>(() => undefined) },
        { target: stuck.target, log, exit: (code) => timedOut.push(code), timeoutMs: 1_000 },
      );
      stuck.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(timedOut).toEqual([1]);
      expect(lines.join("\n")).toContain("shutdown_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes its handlers", () => {
    const { target, count } = signals();
    const remove = exitOnSignals(
      { close: () => Promise.resolve() },
      { target, exit: () => undefined },
    );
    expect(count("SIGTERM")).toBe(1);
    expect(count("SIGINT")).toBe(1);
    remove();
    expect(count("SIGTERM")).toBe(0);
    expect(count("SIGINT")).toBe(0);
  });

  it("does not hang on idle keep-alive connections", async () => {
    const { handle } = await start([echo]);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: handle.port, path: "/echo", agent },
          (res) => {
            res.resume();
            res.on("end", () => {
              resolve(res.statusCode ?? 0);
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(200);
      // The socket now idles in the agent's pool.
      expect(Object.keys(agent.freeSockets)).toHaveLength(1);
      const { target, emit } = signals();
      const exited = deferred<number>();
      exitOnSignals(handle, {
        target,
        exit: (code) => {
          exited.resolve(code);
        },
      });
      const started = Date.now();
      emit("SIGTERM");
      expect(await exited.promise).toBe(0);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      agent.destroy();
    }
  });
});

/** A request whose headers arrive but whose body never does; `status` resolves with the answer. */
function stall(port: number, path: string, clientIp: string, headers = "") {
  const socket: Socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  const status = new Promise<number | undefined>((resolve) => {
    socket.once("data", (chunk: Buffer) => {
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString("latin1"))?.[1]));
    });
    socket.once("close", () => {
      resolve(undefined);
    });
  });
  socket.write(
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nX-Forwarded-For: ${clientIp}\r\n` +
      `Content-Type: application/json\r\nContent-Length: 1000\r\n${headers}\r\n{`,
  );
  return { socket, status };
}

describe("slow and unauthenticated clients over a real socket (review #2)", () => {
  const TOKEN = "Zq3xR7pL0vN2mK8sT4wY6bH1cJ5dF9gA-_mcp";
  const ATTACKER = "203.0.113.7";

  async function startProtected(limits: Parameters<typeof start>[3] = {}) {
    const mcp = createMcpRoute({
      authenticator: createBearerAuthenticator([TOKEN], { tiers: ["read"] }),
      factory: () => {
        const server = new McpServer({ name: "slow-test", version: "1.0.0" });
        server.registerTool("ping", { description: "Ping." }, () => ({
          content: [{ type: "text", text: "pong" }],
        }));
        return server;
      },
    });
    const upload: HttpRoute = { ...echo, path: "/upload", methods: ["POST"], maxBodyBytes: 4096 };
    // One trusted proxy hop: X-Forwarded-For names the client, so one test can play several IPs.
    return start([mcp.route, upload], { trustProxy: 1 }, 5_000, {
      maxInFlight: 4,
      maxPerClient: 8,
      ...limits,
    });
  }

  it("serves authenticated clients while one client holds 64 stalled requests", async () => {
    const { handle } = await startProtected();
    const stalls: ReturnType<typeof stall>[] = [];
    try {
      // Unauthenticated MCP requests are refused on their headers: no body, no slot.
      const mcp = Array.from({ length: 64 }, () => stall(handle.port, "/mcp", ATTACKER));
      stalls.push(...mcp);
      expect(new Set(await Promise.all(mcp.map((request) => request.status)))).toEqual(
        new Set([401]),
      );
      await vi.waitFor(() => {
        expect(handle.router.inFlight).toBe(0);
      });

      // Stalled uploads elsewhere: 8 held (the per-client cap), the rest refused with 429. The
      // held ones do not count against the global cap of 4.
      const uploads = Array.from({ length: 64 }, () => stall(handle.port, "/upload", ATTACKER));
      stalls.push(...uploads);
      let refused = 0;
      for (const upload of uploads) {
        void upload.status.then((status) => {
          if (status === 429) refused += 1;
        });
      }
      await vi.waitFor(() => {
        expect(refused).toBe(56);
        expect(handle.router.inFlight).toBe(8);
      });

      // Even an authenticated client on the same address gets 429 now…
      const sameClient = stall(handle.port, "/mcp", ATTACKER, `Authorization: Bearer ${TOKEN}\r\n`);
      stalls.push(sameClient);
      expect(await sameClient.status).toBe(429);

      // …while everyone else is served.
      const client = new Client({ name: "legit", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${handle.origin}${MCP_PATH}`), {
          requestInit: {
            headers: { Authorization: `Bearer ${TOKEN}`, "X-Forwarded-For": "198.51.100.1" },
          },
        }),
      );
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["ping"]);
      await client.close();
    } finally {
      for (const request of stalls) request.socket.destroy();
    }
    await vi.waitFor(() => {
      expect(handle.router.inFlight).toBe(0);
    });
  });

  it("answers 408 to a stalled body and closes the connection", async () => {
    const { handle } = await startProtected({ bodyTimeoutMs: 100 });
    const upload = stall(handle.port, "/upload", ATTACKER);
    const closed = new Promise<void>((resolve) => upload.socket.once("close", resolve));
    expect(await upload.status).toBe(408);
    await closed;
    expect(handle.router.inFlight).toBe(0);
  });
});

describe("connections per client (security review 2026-11, wave 2)", () => {
  it("drops a client's connection beyond its share, keeping the others", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    limitConnectionsPerClient(server, 2);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const sockets: Socket[] = [];
    const opened = (): Promise<Socket> =>
      new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          resolve(socket);
        });
        sockets.push(socket);
      });
    const closed = (socket: Socket): Promise<boolean> =>
      new Promise((resolve) => {
        socket.once("close", () => {
          resolve(true);
        });
        setTimeout(() => {
          resolve(false);
        }, 300);
      });
    try {
      const [a, b] = [await opened(), await opened()];
      const third = await opened();
      expect(await closed(third)).toBe(true);
      expect(a.destroyed || b.destroyed).toBe(false);
      // A closed connection frees its share again.
      a.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const fourth = await opened();
      expect(await closed(fourth)).toBe(false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
