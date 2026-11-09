import { EventEmitter } from "node:events";
import { Agent, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpLog } from "../../../src/http/log.js";
import { MCP_PATH } from "../../../src/http/mcp-route.js";
import {
  exitOnSignals,
  type HttpServerHandle,
  SERVER_LIMITS,
  startHttpServer,
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
) {
  const lines: string[] = [];
  const announced: string[] = [];
  const handle = await startHttpServer({
    http: { ...HTTP, ...overrides },
    routes,
    log: createHttpLog({ write: (line) => lines.push(line) }),
    announce: (line) => announced.push(line),
    drainMs,
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
      requestTimeoutMs: 30_000,
      keepAliveTimeoutMs: 65_000,
      maxConnections: 256,
    });
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
