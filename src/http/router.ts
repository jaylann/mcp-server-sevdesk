/**
 * The HTTP router: matches a request to one {@link HttpRoute} and runs the hardening pipeline in
 * front of its handler, in this order:
 *
 * 1. exact (or longest-prefix) path match; `/healthz` is built in;
 * 2. the Host allowlist (DNS-rebinding defence), except on routes with `hostCheck: false`;
 * 3. 404 for unknown paths, 405 with `Allow` for other methods;
 * 4. while draining, 503 for everything but `/healthz`;
 * 5. the route's token-bucket rate limit per client (429 with `Retry-After`);
 * 6. at most {@link DEFAULT_MAX_PER_CLIENT} requests at once per client (429);
 * 7. the route's Origin policy (403);
 * 8. on an {@link AuthenticatedRoute} (`/mcp`), authentication on the headers alone: a client
 *    without valid credentials never gets to send a body;
 * 8a. the route's `preflight` (e.g. the upload page's session and ticket checks), also on the
 *    headers alone;
 * 8b. for a request with a body, the route's `bodySlots` cap (requests with a body on this route
 *    at once, until their response is complete);
 * 9. the body, read up to the route's limit (413 beyond) within the route's `bodyTimeoutMs` or
 *    {@link DEFAULT_BODY_TIMEOUT_MS} (408 beyond);
 * 10. at most {@link DEFAULT_MAX_IN_FLIGHT} requests being handled (503 beyond). Only requests
 *    whose body has arrived count here, so slow uploads cannot starve the server; they are bounded
 *    per client by step 6 and in time by step 9;
 * 11. the handler, under a per-request deadline ({@link DEFAULT_DEADLINE_MS}) and the client's
 *    disconnect signal.
 *
 * A "client" is the IP after `SEVDESK_HTTP_TRUST_PROXY`, IPv6 grouped by /64 (`rateLimitKey`).
 * Every response leaves with the security headers of `hardening.ts`, and every request (but a
 * healthy `/healthz`) is logged once: method, route template (never the raw path or query),
 * status, duration, client IP and, once authenticated or annotated ({@link annotateRequest}), the
 * grant prefix. A request stays in progress until its response body is complete, so streaming
 * responses count.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";

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
  requestTimeout,
  serverError,
  serviceUnavailable,
  tooManyConcurrentRequests,
  tooManyRequests,
  withSecurityHeaders,
} from "./hardening.js";
import { principalLogFields } from "./log.js";
import { fromWebRequest, type IncomingRequest } from "./node-bridge.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import type {
  HttpAuthenticator,
  HttpConfig,
  HttpLog,
  HttpRequestContext,
  HttpRoute,
  LogFields,
} from "./types.js";

export const HEALTHZ_PATH = "/healthz";
/** Most requests handled at once, once their body has arrived (streaming responses included). */
const DEFAULT_MAX_IN_FLIGHT = 64;
/** Most requests of one client in progress at once, from admission to the end of the response. */
const DEFAULT_MAX_PER_CLIENT = 8;
/** Longest a request body may take to arrive (408 beyond); Node's own limit is 30 s. */
const DEFAULT_BODY_TIMEOUT_MS = 15_000;
/** Longest a request may take before its signal aborts and it is answered 503. */
const DEFAULT_DEADLINE_MS = 120_000;

/**
 * A route whose requests are authenticated on their headers before the body is read (`/mcp`).
 * The handler finds the verified `AuthInfo` with {@link requestAuth}. (A route option in
 * `HttpRoute` would say the same; this keeps the shared contract unchanged.)
 */
export interface AuthenticatedRoute extends HttpRoute {
  readonly authenticator: HttpAuthenticator;
}

/** The `AuthInfo` the router verified for the request of `ctx`, on an {@link AuthenticatedRoute}. */
export function requestAuth(ctx: HttpRequestContext): AuthInfo | undefined {
  return auths.get(ctx);
}

const auths = new WeakMap<HttpRequestContext, AuthInfo>();

function isAuthenticated(route: HttpRoute): route is AuthenticatedRoute {
  return "authenticator" in route && route.authenticator !== undefined;
}

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
  /** Global cap on requests being handled (default 64). */
  readonly maxInFlight?: number;
  /** Cap on one client's requests in progress (default 8). */
  readonly maxPerClient?: number;
  /** Time a request body may take to arrive (default 15 s). */
  readonly bodyTimeoutMs?: number;
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
  /** Admitted requests whose response is not complete yet (body uploads included). */
  readonly inFlight: number;
  /** Resolves once no request is in progress. */
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
  const maxPerClient = options.maxPerClient ?? DEFAULT_MAX_PER_CLIENT;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const { log } = options;
  const allowedOriginHostnames = originHostnames(options.http.allowedOrigins);
  const shutdown = new AbortController();
  let draining = false;
  /** Requests admitted and not finished (all stages). */
  let admitted = 0;
  /** Requests past their body, being handled: what the global cap limits. */
  let handling = 0;
  /** Requests in progress per client key. */
  const perClient = new Map<string, number>();
  /** Requests with a body in progress per route with `bodySlots`. */
  const bodies = new Map<HttpRoute, number>();
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

  const release = (clientKey: string): void => {
    const held = (perClient.get(clientKey) ?? 1) - 1;
    if (held <= 0) perClient.delete(clientKey);
    else perClient.set(clientKey, held);
    admitted -= 1;
    if (admitted === 0) {
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
    const clientKey = rateLimitKey(ip);
    if (route.rateLimit !== undefined) {
      const decision = limiter.take(route.rateLimit, clientKey);
      if (!decision.allowed) return early(tooManyRequests(decision.retryAfterSeconds));
    }
    const held = perClient.get(clientKey) ?? 0;
    if (held >= maxPerClient) return early(tooManyConcurrentRequests());

    // From here on the request holds its client's slot until its response body is done.
    perClient.set(clientKey, held + 1);
    admitted += 1;
    let handlingSlot = false;
    let bodySlot = false;
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
      if (handlingSlot) handling -= 1;
      if (bodySlot) bodies.set(route, (bodies.get(route) ?? 1) - 1);
      release(clientKey);
    };
    const signal = AbortSignal.any([incoming.signal, deadline.signal, shutdown.signal]);
    const served = (response: Response): Served => ({ response, finish, signal });
    // Answers of the router itself (and authentication challenges) are complete: they free the
    // slots at once, and the request's signal must not cut them short.
    const answered = (response: Response): Served => {
      finish();
      return early(response);
    };

    try {
      const head = new Request(url, { method: incoming.method, headers: incoming.headers, signal });
      const refusal = originRefusal(head, route.origin, { origin, allowedOriginHostnames });
      if (refusal !== undefined) return answered(refusal);
      const ctx: HttpRequestContext = {
        clientIp: ip,
        origin,
        signal,
        log,
        limit: (rule, key) => limiter.take(rule, key).allowed,
      };
      lines.set(ctx, line);

      if (isAuthenticated(route)) {
        const auth = await route.authenticator.authenticate(head, ctx);
        if (auth instanceof Response) return answered(auth);
        auths.set(ctx, auth);
        annotateRequest(ctx, principalLogFields(auth));
      }

      if (route.preflight !== undefined) {
        const refusal = await route.preflight(head, ctx);
        if (refusal !== undefined) return answered(refusal);
      }

      let body: Uint8Array | null = null;
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        if (route.bodySlots !== undefined) {
          const active = bodies.get(route) ?? 0;
          if (active >= route.bodySlots.max) {
            return answered(
              route.bodySlots.busy?.() ??
                serviceUnavailable("Too many uploads are in progress; retry shortly.", 5),
            );
          }
          bodies.set(route, active + 1);
          bodySlot = true;
        }
        const timeoutMs = route.bodyTimeoutMs ?? bodyTimeoutMs;
        let read: Uint8Array | "too_large" | "timeout";
        try {
          read = await readBodyWithin(incoming, route.maxBodyBytes, timeoutMs);
        } catch {
          return answered(badRequest("The request body could not be read."));
        }
        if (read === "timeout") return answered(requestTimeout(timeoutMs));
        if (read === "too_large") return answered(payloadTooLarge(route.maxBodyBytes));
        body = read.byteLength > 0 ? read : null;
      }
      if (handling >= maxInFlight) {
        return answered(serviceUnavailable("The server is busy; retry shortly."));
      }
      handling += 1;
      handlingSlot = true;

      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        body,
        signal,
      });

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
      return admitted;
    },
    idle: () =>
      admitted === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
    abortAll: () => {
      shutdown.abort(new Error("The server is shutting down."));
    },
  };
}

/**
 * Reads the body within `ms`: the bytes, `"too_large"`, or `"timeout"` (the read is then left to
 * fail with the connection, which the response closes). Rejects when the read fails.
 */
async function readBodyWithin(
  incoming: IncomingRequest,
  maxBytes: number,
  ms: number,
): Promise<Uint8Array | "too_large" | "timeout"> {
  const reading = incoming.readBody(maxBytes);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, ms);
  });
  try {
    return await Promise.race([reading, timeout]);
  } finally {
    clearTimeout(timer);
    // A read abandoned at the timeout rejects when the connection closes; nobody waits for it.
    reading.catch(() => undefined);
  }
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
    if (route.bodyTimeoutMs !== undefined && !(route.bodyTimeoutMs > 0)) {
      throw new RangeError(`${where}: invalid bodyTimeoutMs.`);
    }
    if (
      route.bodySlots !== undefined &&
      !(Number.isInteger(route.bodySlots.max) && route.bodySlots.max >= 1)
    ) {
      throw new RangeError(`${where}: bodySlots.max must be a positive integer.`);
    }
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
