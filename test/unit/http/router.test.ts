import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse } from "../../../src/http/hardening.js";
import { createHttpLog } from "../../../src/http/log.js";
import type { IncomingRequest } from "../../../src/http/node-bridge.js";
import { createRateLimiter } from "../../../src/http/rate-limit.js";
import {
  annotateRequest,
  type AuthenticatedRoute,
  createRouter,
  HEALTHZ_PATH,
  requestAuth,
  type RouterOptions,
} from "../../../src/http/router.js";
import type { HttpAuthenticator, HttpRequestContext, HttpRoute } from "../../../src/http/types.js";

const ORIGIN = "https://mcp.example.com";
const HTTP = {
  allowedHosts: ["mcp.example.com"],
  allowedOrigins: [ORIGIN, "https://app.example.com"],
  trustProxy: 0,
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function route(overrides: Partial<HttpRoute> = {}): HttpRoute {
  return {
    path: "/echo",
    methods: ["GET", "POST"],
    maxBodyBytes: 64,
    origin: "none",
    handle: async (request) =>
      new Response(request.method === "POST" ? await request.text() : "ok", {
        headers: { "Content-Type": "text/plain" },
      }),
    ...overrides,
  };
}

function setup(routes: readonly HttpRoute[], options: Partial<RouterOptions> = {}) {
  const lines: Record<string, unknown>[] = [];
  const log = createHttpLog({
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    secrets: ["super-secret-value-that-must-not-leak"],
  });
  const router = createRouter({ http: HTTP, origin: ORIGIN, routes, log, ...options });
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "mcp.example.com");
    return router.fetch(new Request(`http://internal${path}`, { ...init, headers }));
  };
  return {
    router,
    call,
    lines,
    requests: () => lines.filter((line) => line["event"] === "request"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("router: health and matching", () => {
  it("answers /healthz without a Host check and does not log healthy probes", async () => {
    const { router, call, requests } = setup([]);
    const response = await call(HEALTHZ_PATH, { host: "10.0.0.7:8080" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(requests()).toEqual([]);

    router.drain();
    expect(router.draining).toBe(true);
    const draining = await call(HEALTHZ_PATH, { method: "HEAD" });
    expect(draining.status).toBe(503);
    expect(requests()).toEqual([expect.objectContaining({ route: HEALTHZ_PATH, status: 503 })]);
  });

  it("refuses an unknown Host before anything else, without echoing it", async () => {
    const { call } = setup([route()]);
    for (const path of ["/echo", "/nowhere"]) {
      const response = await call(path, { host: "evil.example" });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("SEVDESK_HTTP_ALLOWED_HOSTS");
      expect(text).not.toContain("evil.example");
    }
  });

  it("answers 404 for unknown paths and 405 with Allow for other methods", async () => {
    const { call, requests } = setup([route()]);
    const missing = await call("/echo/");
    expect(missing.status).toBe(404);
    const wrong = await call("/echo", { method: "PUT", body: "x" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET, POST");
    expect(requests().map((line) => [line["route"], line["status"]])).toEqual([
      ["-", 404],
      ["/echo", 405],
    ]);
  });

  it("prefers exact routes, then the longest prefix", async () => {
    const named =
      (name: string): HttpRoute["handle"] =>
      () =>
        Promise.resolve(new Response(name));
    const { call, requests } = setup([
      route({ path: "/approvals", methods: ["GET"], handle: named("inbox") }),
      route({ path: "/approvals/", match: "prefix", methods: ["GET"], handle: named("detail") }),
      route({ path: "/approvals/x/", match: "prefix", methods: ["GET"], handle: named("deep") }),
    ]);
    expect(await (await call("/approvals")).text()).toBe("inbox");
    expect(await (await call("/approvals/abc")).text()).toBe("detail");
    expect(await (await call("/approvals/x/1")).text()).toBe("deep");
    expect(requests().map((line) => line["route"])).toEqual([
      "/approvals",
      "/approvals/*",
      "/approvals/x/*",
    ]);
  });

  it("refuses targets that are not a path", async () => {
    const { router } = setup([route()]);
    for (const target of ["*", "http://evil.example/echo", ""]) {
      const response = await router.serve(incoming({ target }));
      expect(response.status).toBe(400);
    }
  });

  it("validates the route table", () => {
    const make = (routes: HttpRoute[]) => () => setup(routes);
    expect(make([route({ path: "echo" })])).toThrow(/must start with/);
    expect(make([route({ path: HEALTHZ_PATH })])).toThrow(/built in/);
    expect(make([route(), route()])).toThrow(/twice/);
    expect(
      make([route({ path: "/a/", match: "prefix" }), route({ path: "/a/", match: "prefix" })]),
    ).toThrow(/twice/);
    expect(make([route({ path: "/a", match: "prefix" })])).toThrow(/end with/);
    expect(make([route({ methods: [] })])).toThrow(/no methods/);
    expect(make([route({ methods: ["get"] })])).toThrow(/upper case/);
    expect(make([route({ maxBodyBytes: -1 })])).toThrow(/maxBodyBytes/);
  });
});

describe("router: request handling", () => {
  it("builds the request URL on the public origin and passes the context", async () => {
    let seen: { url: string; ctx: HttpRequestContext } | undefined;
    const { call } = setup([
      route({
        handle: (request, ctx) => {
          seen = { url: request.url, ctx };
          return Promise.resolve(new Response("ok"));
        },
      }),
    ]);
    await call("/echo?x=1", { headers: { "X-Forwarded-For": "198.51.100.1" } });
    expect(seen?.url).toBe(`${ORIGIN}/echo?x=1`);
    expect(seen?.ctx.origin).toBe(ORIGIN);
    // No trusted proxy: the socket address, not the header.
    expect(seen?.ctx.clientIp).toBe("127.0.0.1");
    expect(seen?.ctx.limit({ name: "t", perMinute: 1 }, "k")).toBe(true);
    expect(seen?.ctx.limit({ name: "t", perMinute: 1 }, "k")).toBe(false);
  });

  it("uses the trusted proxy's X-Forwarded-For entry as client IP", async () => {
    const { call, requests } = setup([route()], { http: { ...HTTP, trustProxy: 1 } });
    await call("/echo", { headers: { "X-Forwarded-For": "6.6.6.6, 198.51.100.1" } });
    expect(requests()[0]).toMatchObject({ ip: "198.51.100.1" });
  });

  it("reads the body within the limit and answers 413 beyond it", async () => {
    const { call } = setup([route()]);
    const ok = await call("/echo", { method: "POST", body: "hello" });
    expect(await ok.text()).toBe("hello");

    const declared = await call("/echo", { method: "POST", body: "x".repeat(65) });
    expect(declared.status).toBe(413);

    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 10; index += 1) controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    });
    const streamed = await call("/echo", { method: "POST", body: chunks, duplex: "half" });
    expect(streamed.status).toBe(413);
  });

  it("answers 400 when the body cannot be read", async () => {
    const { router } = setup([route()]);
    const response = await router.serve(
      incoming({ method: "POST", readBody: () => Promise.reject(new Error("reset")) }),
    );
    expect(response.status).toBe(400);
  });

  it("answers 404 when the handler declines and 500 when it throws, logging redacted", async () => {
    const { call, lines } = setup([
      route({ path: "/none", handle: () => Promise.resolve(undefined) }),
      route({
        path: "/boom",
        handle: () =>
          Promise.reject(new Error("failed with super-secret-value-that-must-not-leak")),
      }),
      route({
        path: "/sync",
        handle: () => {
          throw new TypeError("sync failure");
        },
      }),
      route({ path: "/error", handle: () => Promise.resolve(Response.error()) }),
    ]);
    expect((await call("/none")).status).toBe(404);
    expect((await call("/boom")).status).toBe(500);
    expect((await call("/sync")).status).toBe(500);
    expect((await call("/error")).status).toBe(500);
    const text = JSON.stringify(lines);
    expect(text).toContain("handler_failed");
    expect(text).toContain("TypeError: sync failure");
    expect(text).not.toContain("super-secret-value-that-must-not-leak");
  });

  it("logs the route template and annotations, never the query or raw path", async () => {
    const { call, requests } = setup([
      route({
        path: "/a/",
        match: "prefix",
        handle: (_request, ctx) => {
          annotateRequest(ctx, { grant: "AbCdEfGh", route: "/overwritten", status: 1 });
          return Promise.resolve(new Response("ok"));
        },
      }),
    ]);
    await call("/a/secret-path?code=sdmcp_ac_abc&token=0123456789abcdef0123456789abcdef");
    const [line] = requests();
    expect(line).toMatchObject({ method: "GET", route: "/a/*", status: 200, grant: "AbCdEfGh" });
    expect(typeof line?.["ms"]).toBe("number");
    expect(JSON.stringify(line)).not.toMatch(/secret-path|code=|token=/);
    // A context the router did not create is ignored.
    annotateRequest(
      {
        clientIp: "",
        origin: "",
        signal: new AbortController().signal,
        log: createHttpLog(),
        limit: () => true,
      },
      { grant: "x" },
    );
  });
});

describe("router: limits", () => {
  it("applies the route's rate limit per client IP with Retry-After", async () => {
    let time = 0;
    const limiter = createRateLimiter({ now: () => time });
    const { call } = setup([route({ rateLimit: { name: "echo", perMinute: 2 } })], { limiter });
    expect((await call("/echo")).status).toBe(200);
    expect((await call("/echo")).status).toBe(200);
    const limited = await call("/echo");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    time += 30_000;
    expect((await call("/echo")).status).toBe(200);
  });

  it("refuses requests beyond the in-flight limit until one completes", async () => {
    const gate = deferred();
    const { router, call } = setup(
      [
        route({
          handle: async () => {
            await gate.promise;
            return new Response("done");
          },
        }),
      ],
      { maxInFlight: 1 },
    );
    const first = call("/echo");
    await vi.waitFor(() => {
      expect(router.inFlight).toBe(1);
    });
    const busy = await call("/echo");
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("1");
    // Health checks are never counted or refused.
    expect((await call(HEALTHZ_PATH)).status).toBe(200);
    gate.resolve();
    expect(await (await first).text()).toBe("done");
    expect(router.inFlight).toBe(0);
  });

  it("counts a streaming response until its body is complete", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const { router, call } = setup([
      route({
        handle: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  controller = c;
                },
              }),
            ),
          ),
      }),
    ]);
    const response = await call("/echo");
    expect(router.inFlight).toBe(1);
    let idle = false;
    const waiting = router.idle().then(() => {
      idle = true;
    });
    controller.enqueue(new TextEncoder().encode("event: one\n\n"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: one\n\n");
    expect(idle).toBe(false);
    controller.close();
    expect((await reader.read()).done).toBe(true);
    await waiting;
    expect(router.inFlight).toBe(0);
    await expect(router.idle()).resolves.toBeUndefined();
  });

  it("releases the slot when the client cancels the body", async () => {
    const { router, call } = setup([
      route({ handle: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>())) }),
    ]);
    const response = await call("/echo");
    expect(router.inFlight).toBe(1);
    await response.body?.cancel();
    expect(router.inFlight).toBe(0);
  });

  it("stops a request at the deadline with 503 and aborts its signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const late = deferred<Response>();
    const { router, call } = setup(
      [
        route({
          handle: (_request, ctx) => {
            signal = ctx.signal;
            return late.promise;
          },
        }),
      ],
      { deadlineMs: 1_000 },
    );
    const pending = call("/echo");
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("longer than 1 s");
    expect(signal?.aborted).toBe(true);
    const cancelled = vi.fn(() => undefined);
    late.resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.waitFor(() => {
      expect(cancelled).toHaveBeenCalled();
    });
    expect(router.inFlight).toBe(0);
  });

  it("ends a streaming response at the deadline and on abortAll", async () => {
    vi.useFakeTimers();
    const { router, call } = setup(
      [route({ handle: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>())) })],
      { deadlineMs: 1_000 },
    );
    const first = await call("/echo");
    const reading = (first.body as ReadableStream<Uint8Array>).getReader().read();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await reading).done).toBe(true);

    const second = await call("/echo");
    const reader = (second.body as ReadableStream<Uint8Array>).getReader();
    router.abortAll();
    expect((await reader.read()).done).toBe(true);
    // Requests after abortAll start with an aborted signal; their body ends at once.
    const third = await call("/echo");
    expect((await (third.body as ReadableStream<Uint8Array>).getReader().read()).done).toBe(true);
    expect(router.inFlight).toBe(0);
  });

  it("refuses new requests while draining", async () => {
    const { router, call } = setup([route()]);
    router.drain();
    const response = await call("/echo");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("10");
  });
});

describe("router: origin policies", () => {
  const routes = [
    route({ path: "/mcp", methods: ["POST"], origin: "mcp" }),
    route({ path: "/form", methods: ["GET", "POST"], origin: "form" }),
    route({ path: "/open", methods: ["POST"], origin: "none" }),
  ];

  it("checks Origin on mcp routes by hostname, and lets requests without Origin pass", async () => {
    const { call } = setup(routes);
    const post = (origin?: string) =>
      call("/mcp", {
        method: "POST",
        body: "{}",
        headers: origin === undefined ? {} : { Origin: origin },
      });
    expect((await post()).status).toBe(200);
    expect((await post(ORIGIN)).status).toBe(200);
    expect((await post("https://app.example.com")).status).toBe(200);
    for (const origin of ["https://evil.example", "null", "not a url"]) {
      const response = await post(origin);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("evil.example");
    }
  });

  it("requires same-origin POSTs on form routes", async () => {
    const { call } = setup(routes);
    expect((await call("/form", { headers: { Origin: "https://evil.example" } })).status).toBe(200);
    const post = (headers: Record<string, string>) =>
      call("/form", { method: "POST", body: "a=1", headers });
    expect((await post({ Origin: ORIGIN })).status).toBe(200);
    expect((await post({ "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ Origin: "null" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ Origin: "https://app.example.com" })).status).toBe(403);
  });

  it("does not check Origin on routes with policy none", async () => {
    const { call } = setup(routes);
    const response = await call("/open", {
      method: "POST",
      body: "x",
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(200);
  });
});

describe("router: security headers", () => {
  it("sets nosniff, no-store, Referrer-Policy and HSTS on https", async () => {
    const { call } = setup([route()]);
    const response = await call("/echo");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    const missing = await call("/nowhere");
    expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps the route's own caching and referrer headers, and works on redirects", async () => {
    const { call } = setup([
      route({
        path: "/meta",
        handle: () =>
          Promise.resolve(
            new Response("{}", {
              headers: { "Cache-Control": "max-age=60", "Referrer-Policy": "same-origin" },
            }),
          ),
      }),
      route({
        path: "/redirect",
        handle: () => Promise.resolve(Response.redirect("https://claude.ai/callback", 303)),
      }),
    ]);
    const meta = await call("/meta");
    expect(meta.headers.get("cache-control")).toBe("max-age=60");
    expect(meta.headers.get("referrer-policy")).toBe("same-origin");
    const redirect = await call("/redirect");
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe("https://claude.ai/callback");
    expect(redirect.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sends no HSTS over plain http and resolves a late origin", async () => {
    let origin = "http://127.0.0.1:0";
    const { router } = setup([route()], {
      origin: () => origin,
      http: { ...HTTP, allowedHosts: ["127.0.0.1"] },
    });
    origin = "http://127.0.0.1:4321";
    const response = await router.fetch(new Request("http://127.0.0.1:4321/echo"));
    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("answers 500 when the origin cannot be resolved", async () => {
    const { router } = setup([route()], { origin: () => "not an origin" });
    expect((await router.fetch(new Request("http://127.0.0.1/echo"))).status).toBe(500);
  });
});

describe("router: slow and unauthenticated clients (review #2)", () => {
  const authenticator: HttpAuthenticator = {
    authenticate: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer good"
          ? { token: "bearer", clientId: "bearer", scopes: ["read"] }
          : jsonResponse(401, { error: "invalid_token" }),
      ),
  };
  const never = () => new Promise<Uint8Array>(() => undefined);

  it("authenticates on the headers and never reads an unauthenticated body", async () => {
    let seen: unknown;
    const mcp: AuthenticatedRoute = {
      ...route({
        path: "/mcp",
        methods: ["POST"],
        handle: async (request, ctx) => {
          seen = requestAuth(ctx);
          return new Response(await request.text());
        },
      }),
      authenticator,
    };
    const { router, call, requests } = setup([mcp]);
    const readBody = vi.fn(never);
    const refused = await router.serve(
      incoming({ method: "POST", target: "/mcp", readBody, bodyPending: true }),
    );
    expect(refused.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(router.inFlight).toBe(0);

    const ok = await call("/mcp", {
      method: "POST",
      body: "hello",
      headers: { Authorization: "Bearer good" },
    });
    expect(await ok.text()).toBe("hello");
    expect(seen).toMatchObject({ clientId: "bearer" });
    expect(requests().at(-1)).toMatchObject({ route: "/mcp", status: 200, grant: "bearer" });
  });

  it("caps the requests one client has in progress, per IP and IPv6 /64", async () => {
    const gate = deferred();
    const { router } = setup(
      [
        route({
          path: "/slow",
          handle: async () => {
            await gate.promise;
            return new Response("slow");
          },
        }),
        route(),
      ],
      { maxPerClient: 2, http: { ...HTTP, allowedHosts: ["mcp.example.com"] } },
    );
    const from = (path: string, ip: string) =>
      router.fetch(new Request(`https://mcp.example.com${path}`), ip);
    const held = [from("/slow", "2001:db8::1"), from("/slow", "2001:db8::2")];
    await vi.waitFor(() => {
      expect(router.inFlight).toBe(2);
    });
    const refused = await from("/echo", "2001:db8::3");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await refused.text()).toContain("at once");
    expect((await from("/echo", "2001:db8:0:1::1")).status).toBe(200);
    expect((await from("/echo", "192.0.2.1")).status).toBe(200);
    gate.resolve();
    for (const response of await Promise.all(held)) expect(await response.text()).toBe("slow");
    expect((await from("/echo", "2001:db8::3")).status).toBe(200);
  });

  it("answers 408 when a body does not arrive in time, and frees the slots", async () => {
    vi.useFakeTimers();
    const { router } = setup([route()], { bodyTimeoutMs: 1_000 });
    const pending = router.serve(incoming({ method: "POST", readBody: never, bodyPending: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: "request_timeout" });
    expect(router.inFlight).toBe(0);
  });

  it("counts only requests whose body arrived against the global cap", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const { router } = setup(
      [
        route({
          path: "/slow",
          handle: async () => {
            await gate.promise;
            return new Response("slow");
          },
        }),
        route(),
      ],
      { maxInFlight: 1, bodyTimeoutMs: 5_000 },
    );
    // One client uploads three bodies that never arrive: they hold its own slots only.
    const uploads = [1, 2, 3].map(() =>
      router.serve(
        incoming({ method: "POST", readBody: never, bodyPending: true, remoteAddress: "10.0.0.1" }),
      ),
    );
    await vi.waitFor(() => {
      expect(router.inFlight).toBe(3);
    });
    const echo = await router.fetch(new Request("https://mcp.example.com/echo"), "10.0.0.2");
    expect(echo.status).toBe(200);
    expect(await echo.text()).toBe("ok");
    // A request being handled does take the global slot.
    const slow = router.fetch(new Request("https://mcp.example.com/slow"), "10.0.0.3");
    await vi.waitFor(() => {
      expect(router.inFlight).toBe(4);
    });
    const busy = await router.fetch(new Request("https://mcp.example.com/echo"), "10.0.0.4");
    expect(busy.status).toBe(503);
    gate.resolve();
    expect(await (await slow).text()).toBe("slow");
    await vi.advanceTimersByTimeAsync(5_000);
    for (const response of await Promise.all(uploads)) expect(response.status).toBe(408);
    expect(router.inFlight).toBe(0);
  });
});

function incoming(overrides: Partial<IncomingRequest> & { target?: string }): IncomingRequest {
  return {
    method: "GET",
    target: "/echo",
    headers: new Headers({ host: "mcp.example.com" }),
    remoteAddress: "127.0.0.1",
    signal: new AbortController().signal,
    readBody: () => Promise.resolve(new Uint8Array()),
    bodyPending: false,
    ...overrides,
  };
}
