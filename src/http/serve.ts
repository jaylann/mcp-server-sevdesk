/**
 * The HTTP server of `--http`: a plain `node:http` server whose requests go through the
 * {@link Router} (via the bridge in `node-bridge.ts`), with conservative socket limits and a
 * graceful shutdown.
 *
 * Shutdown ({@link HttpServerHandle.close}): the router starts draining (`/healthz` and new
 * requests answer 503), the listener closes and idle keep-alive connections are dropped, requests
 * in flight get {@link DEFAULT_DRAIN_MS} to finish (streaming responses included), then their
 * signals are aborted and the remaining connections closed. Stores and the account resolver are
 * the caller's to close afterwards.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { PACKAGE_NAME } from "../version.js";
import { normalizeIp, rateLimitKey } from "./client-ip.js";
import { loopbackOrigin } from "./config.js";
import { MCP_PATH } from "./mcp-route.js";
import { fromNodeRequest, writeNodeResponse } from "./node-bridge.js";
import type { RateLimiter } from "./rate-limit.js";
import { createRouter, type Router } from "./router.js";
import type { HttpConfig, HttpLog, HttpRoute } from "./types.js";

/** How long requests in flight may take to finish after shutdown starts. */
const DEFAULT_DRAIN_MS = 10_000;
/** How long closing the listener may take once every connection was destroyed. */
const CLOSE_GRACE_MS = 1_000;
/** Shutdown after a signal must end within the drain time plus this (container stop: 20 s). */
const SHUTDOWN_GRACE_MS = 5_000;
/** Socket limits (`node:http`). */
export const SERVER_LIMITS = {
  /** The request headers must arrive within this time. */
  headersTimeoutMs: 15_000,
  /** The whole request (headers and body) must arrive within this time. */
  requestTimeoutMs: 30_000,
  /** Idle keep-alive connections are closed after this (above common proxy defaults of 60 s). */
  keepAliveTimeoutMs: 65_000,
  maxConnections: 256,
  /**
   * Connections one client address (IPv6: its /64) may hold when no proxy is trusted, so one
   * peer keeping idle keep-alive connections cannot take all of `maxConnections`. Behind a
   * trusted proxy every connection comes from the proxy, which must limit its clients instead.
   */
  maxConnectionsPerClient: 64,
} as const;

export interface StartHttpServerOptions {
  readonly http: HttpConfig;
  /** Application routes; `/healthz` is built in. */
  readonly routes: readonly HttpRoute[];
  readonly log: HttpLog;
  readonly limiter?: RateLimiter;
  readonly drainMs?: number;
  readonly deadlineMs?: number;
  readonly maxInFlight?: number;
  readonly maxPerClient?: number;
  readonly bodyTimeoutMs?: number;
  /** Receives the `listening on <origin>/mcp` line (default: stderr). */
  readonly announce?: (line: string) => void;
}

export interface HttpServerHandle {
  /** The public origin, or `http://<loopback>:<port>` without one. */
  readonly origin: string;
  /** The bound port (the real one when 0 was configured). */
  readonly port: number;
  readonly router: Router;
  /** Graceful shutdown (see the module comment); idempotent. */
  close(): Promise<void>;
}

/** Starts listening; rejects when the address cannot be bound. */
export async function startHttpServer(options: StartHttpServerOptions): Promise<HttpServerHandle> {
  const { http, log } = options;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  let origin = http.publicOrigin ?? loopbackOrigin(http.host, http.port);
  const router = createRouter({
    http,
    origin: () => origin,
    routes: options.routes,
    log,
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
    ...(options.maxPerClient === undefined ? {} : { maxPerClient: options.maxPerClient }),
    ...(options.bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs: options.bodyTimeoutMs }),
  });

  const server = createServer((req, res) => {
    void handleNodeRequest(router, req, res);
  });
  server.headersTimeout = SERVER_LIMITS.headersTimeoutMs;
  server.requestTimeout = SERVER_LIMITS.requestTimeoutMs;
  server.keepAliveTimeout = SERVER_LIMITS.keepAliveTimeoutMs;
  server.maxConnections = SERVER_LIMITS.maxConnections;
  if (http.trustProxy === 0)
    limitConnectionsPerClient(server, SERVER_LIMITS.maxConnectionsPerClient);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(
        new Error(
          `Cannot listen on ${http.host}:${String(http.port)}` +
            (error.code === undefined ? "." : ` (${error.code}).`),
        ),
      );
    };
    server.once("error", onError);
    server.listen(http.port, http.host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (error) => {
    log.warn("server_error", { message: error.message });
  });

  const port = (server.address() as AddressInfo).port;
  origin = http.publicOrigin ?? loopbackOrigin(http.host, port);
  const announce =
    options.announce ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  announce(
    `${PACKAGE_NAME}: listening on ${origin}${MCP_PATH} (bound to ${bindLabel(http.host)}:${String(port)})`,
  );

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      router.drain();
      const closed = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      server.closeIdleConnections();
      await raceTimeout(router.idle(), drainMs);
      router.abortAll();
      server.closeAllConnections();
      // Every socket is destroyed by now; the cap only guards against a close event that never
      // comes, so shutdown always finishes within the drain window plus a moment.
      await raceTimeout(closed, CLOSE_GRACE_MS);
    })());

  return { origin, port, router, close };
}

export interface ExitOnSignalsOptions {
  /** Runs after the server closed: flush stores, close the account resolver. */
  readonly onClosed?: () => Promise<void>;
  readonly log?: HttpLog;
  /** Default `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Default `SIGTERM` and `SIGINT`. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Where the signals arrive (default `process`; tests pass an emitter). */
  readonly target?: Pick<NodeJS.Process, "on" | "off">;
  /** Hard limit for the whole shutdown (default drain time + 5 s); past it the process exits 1. */
  readonly timeoutMs?: number;
}

/**
 * Exits the process gracefully on SIGTERM/SIGINT: closes `handle` (drain), runs `onClosed`, then
 * exits 0 (1 when that fails or the hard limit passes). Works as PID 1 in a container, where
 * Node installs no default signal handlers. A second signal exits 1 at once. Returns a function
 * that removes the handlers.
 */
export function exitOnSignals(
  handle: Pick<HttpServerHandle, "close">,
  options: ExitOnSignalsOptions = {},
): () => void {
  const exit =
    options.exit ??
    ((code: number): void => {
      process.exit(code);
    });
  const target = options.target ?? process;
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  const timeoutMs = options.timeoutMs ?? DEFAULT_DRAIN_MS + SHUTDOWN_GRACE_MS;
  let shuttingDown = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      exit(1);
      return;
    }
    shuttingDown = true;
    options.log?.info("shutting_down", { signal });
    const timer = setTimeout(() => {
      options.log?.warn("shutdown_timeout", { ms: timeoutMs });
      exit(1);
    }, timeoutMs);
    timer.unref();
    handle
      .close()
      .then(() => options.onClosed?.())
      .then(
        () => {
          clearTimeout(timer);
          exit(0);
        },
        (error: unknown) => {
          clearTimeout(timer);
          options.log?.warn("shutdown_failed", {
            message: error instanceof Error ? error.message : "non-error thrown",
          });
          exit(1);
        },
      );
  };
  // `on`, not `once`: a second signal must still find the handler (and exit at once).
  const listeners = signals.map((signal) => {
    const listener = (): void => {
      onSignal(signal);
    };
    target.on(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of listeners) target.off(signal, listener);
  };
}

function raceTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

async function handleNodeRequest(
  router: Router,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const incoming = fromNodeRequest(req, res);
  const response = await router.serve(incoming);
  await writeNodeResponse(res, response, {
    head: incoming.method === "HEAD",
    closeConnection: router.draining || incoming.bodyPending,
  });
}

function bindLabel(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * Drops a new connection from a client address that already holds `max` (security review
 * 2026-11, wave 2: one unauthenticated peer could hold all `maxConnections` with idle keep-alive
 * connections, refusing everyone else). Counted per address (IPv6 by /64, like the rate limits).
 */
export function limitConnectionsPerClient(server: Server, max: number): void {
  const open = new Map<string, number>();
  server.on("connection", (socket: Socket) => {
    const ip = normalizeIp(socket.remoteAddress);
    if (ip === undefined) return;
    const key = rateLimitKey(ip);
    const count = (open.get(key) ?? 0) + 1;
    if (count > max) {
      socket.destroy();
      return;
    }
    open.set(key, count);
    socket.once("close", () => {
      const left = (open.get(key) ?? 1) - 1;
      if (left <= 0) open.delete(key);
      else open.set(key, left);
    });
  });
}
