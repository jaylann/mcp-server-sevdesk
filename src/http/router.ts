/**
 * The HTTP router: matches a request to one {@link HttpRoute} and runs the hardening pipeline in
 * front of its handler, in this order:
 *
 * 1. exact (or longest-prefix) path match; `/healthz` is built in;
 * 2. the Host allowlist (DNS-rebinding defence), except on routes with `hostCheck: false`;
 * 3. 404 for unknown paths, 405 with `Allow` for other methods;
 * 4. while draining, 503 for everything but `/healthz`;
 * 5. the route's token-bucket rate limit per client IP (429 with `Retry-After`);
 * 6. at most {@link DEFAULT_MAX_IN_FLIGHT} requests in flight (503 beyond);
 * 7. the route's Origin policy (403);
 * 8. the body, read up to the route's limit (413 beyond);
 * 9. the handler, under a per-request deadline ({@link DEFAULT_DEADLINE_MS}) and the client's
 *    disconnect signal. Authentication is the handler's first step (`mcp-route.ts`).
 *
 * Every response leaves with the security headers of `hardening.ts`, and every request (but a
 * healthy `/healthz`) is logged once: method, route template (never the raw path or query),
 * status, duration, client IP and, once a handler called {@link annotateRequest}, the grant prefix.
 * A request stays "in flight" until its response body is complete, so streaming responses count.
 */
import { clientIp, rateLimitKey } from "./client-ip.js";
import {
  badRequest,
  hostRefusal,
  jsonResponse,
  methodNotAllowed,
  notFound,
  originHostnames,
  originRefusal,
  payloadTooLarge,
  serverError,
  serviceUnavailable,
  tooManyRequests,
  withSecurityHeaders,
} from "./hardening.js";
import { fromWebRequest, type IncomingRequest } from "./node-bridge.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import type { HttpConfig, HttpLog, HttpRequestContext, HttpRoute, LogFields } from "./types.js";

export const HEALTHZ_PATH = "/healthz";
/** Most requests handled at once (streaming responses included). */
const DEFAULT_MAX_IN_FLIGHT = 64;
/** Longest a request may take before its signal aborts and it is answered 503. */
const DEFAULT_DEADLINE_MS = 120_000;

export interface RouterOptions {
  readonly http: Pick<HttpConfig, "allowedHosts" | "allowedOrigins" | "trustProxy">;
  /**
   * The public origin, e.g. `https://mcp.example.com`; a function while it is not known yet (a
   * loopback bind on port 0 learns its port when listening).
   */
  readonly origin: string | (() => string);
  readonly routes: readonly HttpRoute[];
  readonly log: HttpLog;
  /** Shared with route handlers through `ctx.limit` (default: a fresh limiter). */
  readonly limiter?: RateLimiter;
  readonly maxInFlight?: number;
  readonly deadlineMs?: number;
  /** Epoch ms, for durations in log lines. */
  readonly now?: () => number;
}

export interface Router {
  /** Answers one request. Never rejects. */
  serve(incoming: IncomingRequest): Promise<Response>;
  /**
   * The same pipeline for an in-process Web `Request` (tests; the OAuth E2E routes its client's
   * `fetch` here). `remoteAddress` defaults to 127.0.0.1.
   */
  fetch(request: Request, remoteAddress?: string): Promise<Response>;
  /** Starts draining: `/healthz` answers 503, every other new request too. */
  drain(): void;
  readonly draining: boolean;
  /** Requests whose response is not complete yet. */
  readonly inFlight: number;
  /** Resolves once no request is in flight. */
  idle(): Promise<void>;
  /** Aborts the signal of every request in flight (the end of a graceful shutdown). */
  abortAll(): void;
}

/** Fields of the request line that annotations cannot overwrite. */
const LINE_FIELDS: ReadonlySet<string> = new Set(["method", "route", "ip", "status", "ms"]);

/** The request line of each context, so handlers can add to it (see {@link annotateRequest}). */
const lines = new WeakMap<HttpRequestContext, Record<string, string | number | boolean>>();

/**
 * Adds fields to the log line of the request `ctx` belongs to, e.g. the 8-character grant prefix
 * once authenticated (`principalLogFields`). The router's own fields cannot be overwritten; a
 * context the router did not create is ignored.
 */
export function annotateRequest(ctx: HttpRequestContext, fields: LogFields): void {
  const line = lines.get(ctx);
  if (line === undefined) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && !LINE_FIELDS.has(key)) line[key] = value;
  }
}

interface Served {
  readonly response: Response;
  /** Releases the request's slot; called once its body is complete or cancelled. */
  readonly finish: () => void;
  readonly signal: AbortSignal | undefined;
}

const NOTHING_TO_FINISH = (): void => undefined;

export function createRouter(options: RouterOptions): Router {
  const now = options.now ?? Date.now;
  const limiter = options.limiter ?? createRateLimiter({ now });
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const { log } = options;
  const allowedOriginHostnames = originHostnames(options.http.allowedOrigins);
  const shutdown = new AbortController();
  let draining = false;
  let inFlight = 0;
  let idleWaiters: (() => void)[] = [];

  const healthResponse = (): Response =>
    draining
      ? jsonResponse(503, { status: "draining" }, { "Retry-After": "10" })
      : jsonResponse(200, { status: "ok" });
  const health: HttpRoute = {
    path: HEALTHZ_PATH,
    methods: ["GET", "HEAD"],
    maxBodyBytes: 0,
    origin: "none",
    hostCheck: false,
    handle: () => Promise.resolve(healthResponse()),
  };
  const table = compileRoutes(options.routes);

  const currentOrigin = (): string =>
    new URL(typeof options.origin === "function" ? options.origin() : options.origin).origin;

  const release = (): void => {
    inFlight -= 1;
    if (inFlight === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  async function dispatch(
    incoming: IncomingRequest,
    origin: string,
    ip: string,
    line: Record<string, string | number | boolean>,
  ): Promise<Served> {
    const early = (response: Response): Served => ({
      response,
      finish: NOTHING_TO_FINISH,
      signal: undefined,
    });
    const url = targetUrl(origin, incoming.target);
    if (url === undefined) return early(badRequest("The request target must be a path."));
    const route = url.pathname === HEALTHZ_PATH ? health : table.match(url.pathname);
    if (route !== undefined) line["route"] = template(route);

    if (route?.hostCheck !== false) {
      const refusal = hostRefusal(incoming.headers, options.http.allowedHosts);
      if (refusal !== undefined) return early(refusal);
    }
    if (route === undefined) return early(notFound());
    if (!route.methods.includes(incoming.method)) return early(methodNotAllowed(route.methods));

    // Health checks never queue behind other requests and never count against the limits.
    if (route === health) return early(healthResponse());
    if (draining) {
      return early(serviceUnavailable("The server is shutting down; retry shortly.", 10));
    }
    if (route.rateLimit !== undefined) {
      const decision = limiter.take(route.rateLimit, rateLimitKey(ip));
      if (!decision.allowed) return early(tooManyRequests(decision.retryAfterSeconds));
    }
    if (inFlight >= maxInFlight) {
      return early(serviceUnavailable("The server is busy; retry shortly."));
    }

    // From here on the request holds a slot until its response body is done.
    inFlight += 1;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new Error(`The request exceeded ${String(deadlineMs / 1000)} s.`));
    }, deadlineMs);
    timer.unref();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      release();
    };
    const signal = AbortSignal.any([incoming.signal, deadline.signal, shutdown.signal]);
    const served = (response: Response): Served => ({ response, finish, signal });
    // Answers of the router itself are complete: the request's signal must not cut them short.
    const answered = (response: Response): Served => ({ response, finish, signal: undefined });

    try {
      const head = new Request(url, { method: incoming.method, headers: incoming.headers });
      const refusal = originRefusal(head, route.origin, { origin, allowedOriginHostnames });
      if (refusal !== undefined) return answered(refusal);

      let body: Uint8Array | null = null;
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        let read: Uint8Array | "too_large";
        try {
          read = await incoming.readBody(route.maxBodyBytes);
        } catch {
          return answered(badRequest("The request body could not be read."));
        }
        if (read === "too_large") return answered(payloadTooLarge(route.maxBodyBytes));
        body = read.byteLength > 0 ? read : null;
      }
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        body,
        signal,
      });
      const ctx: HttpRequestContext = {
        clientIp: ip,
        origin,
        signal,
        log,
        limit: (rule, key) => limiter.take(rule, key).allowed,
      };
      lines.set(ctx, line);

      const handled = route.handle(request, ctx);
      const timedOut = new Promise<"deadline">((resolve) => {
        if (deadline.signal.aborted) resolve("deadline");
        deadline.signal.addEventListener("abort", () => {
          resolve("deadline");
        });
      });
      const outcome = await Promise.race([handled, timedOut]);
      if (outcome === "deadline") {
        void handled.then(
          (late) => late?.body?.cancel().catch(() => undefined),
          () => undefined,
        );
        return answered(
          serviceUnavailable(
            `The request took longer than ${String(deadlineMs / 1000)} s and was stopped.`,
          ),
        );
      }
      return outcome === undefined ? answered(notFound()) : served(outcome);
    } catch (error) {
      log.warn("handler_failed", { route: line["route"], message: errorMessage(error) });
      return answered(serverError());
    }
  }

  async function serve(incoming: IncomingRequest): Promise<Response> {
    const started = now();
    let origin: string;
    try {
      origin = currentOrigin();
    } catch {
      return withSecurityHeaders(serverError(), { https: false });
    }
    const ip = clientIp(
      incoming.remoteAddress,
      incoming.headers.get("x-forwarded-for"),
      options.http.trustProxy,
    );
    const line: Record<string, string | number | boolean> = {
      method: incoming.method.slice(0, 16),
      route: "-",
      ip,
    };
    let served: Served;
    try {
      served = await dispatch(incoming, origin, ip, line);
    } catch (error) {
      log.warn("handler_failed", { route: line["route"], message: errorMessage(error) });
      served = { response: serverError(), finish: NOTHING_TO_FINISH, signal: undefined };
    }
    let { response } = served;
    if (response.type === "error" || response.status < 200 || response.status > 599) {
      await response.body?.cancel().catch(() => undefined);
      response = serverError();
    }
    line["status"] = response.status;
    line["ms"] = Math.max(0, now() - started);
    if (!(line["route"] === HEALTHZ_PATH && response.status === 200)) log.info("request", line);
    const https = origin.startsWith("https:");
    if (response.body === null) {
      served.finish();
      return withSecurityHeaders(response, { https });
    }
    return withSecurityHeaders(response, {
      https,
      body: trackBody(response.body, served.finish, served.signal),
    });
  }

  return {
    serve,
    fetch: (request, remoteAddress) => serve(fromWebRequest(request, remoteAddress)),
    drain: () => {
      draining = true;
    },
    get draining() {
      return draining;
    },
    get inFlight() {
      return inFlight;
    },
    idle: () =>
      inFlight === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
    abortAll: () => {
      shutdown.abort(new Error("The server is shutting down."));
    },
  };
}

interface RouteTable {
  match(pathname: string): HttpRoute | undefined;
}

/** Validates the routes and indexes them: exact paths first, then the longest matching prefix. */
function compileRoutes(routes: readonly HttpRoute[]): RouteTable {
  const exact = new Map<string, HttpRoute>();
  const prefixes: HttpRoute[] = [];
  for (const route of routes) {
    const where = `Route ${route.path}`;
    if (!route.path.startsWith("/")) throw new RangeError(`${where}: the path must start with /.`);
    if (route.path === HEALTHZ_PATH) throw new RangeError(`${where} is built in.`);
    if (route.methods.length === 0) throw new RangeError(`${where}: no methods.`);
    if (route.methods.some((method) => method !== method.toUpperCase())) {
      throw new RangeError(`${where}: methods must be upper case.`);
    }
    if (!(route.maxBodyBytes >= 0)) throw new RangeError(`${where}: invalid maxBodyBytes.`);
    if (route.match === "prefix") {
      if (!route.path.endsWith("/")) throw new RangeError(`${where}: a prefix must end with /.`);
      if (prefixes.some((other) => other.path === route.path)) {
        throw new RangeError(`${where} is defined twice.`);
      }
      prefixes.push(route);
    } else {
      if (exact.has(route.path)) throw new RangeError(`${where} is defined twice.`);
      exact.set(route.path, route);
    }
  }
  prefixes.sort((a, b) => b.path.length - a.path.length);
  return {
    match: (pathname) =>
      exact.get(pathname) ?? prefixes.find((route) => pathname.startsWith(route.path)),
  };
}

/** The route as logged: its path, with `*` for prefix routes (never the raw path). */
function template(route: HttpRoute): string {
  return route.match === "prefix" ? `${route.path}*` : route.path;
}

/**
 * The request URL on the public origin. Only origin-form targets (`/path?query`) are accepted;
 * the result is built from the configured origin, never from `Host`.
 */
function targetUrl(origin: string, target: string): URL | undefined {
  if (!target.startsWith("/")) return undefined;
  try {
    const url = new URL(`${origin}${target}`);
    return url.origin === origin ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps a response body so `finish` runs once it is fully read or cancelled, and so an aborted
 * `signal` (disconnect, deadline, shutdown) ends it. Reads only on demand (high-water mark 0): a
 * streamed event is passed on as soon as the consumer asks, never held back.
 */
function trackBody(
  body: ReadableStream<Uint8Array>,
  finish: () => void,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let ended = false;
  const onAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", onAbort);
    finish();
  };
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            end();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          end();
          controller.error(error);
        }
      },
      async cancel(reason) {
        end();
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : "non-error thrown";
}
