import { afterEach, describe, expect, it } from "vitest";

import { runHealthcheck } from "../../../src/http/healthcheck.js";
import { createHttpLog } from "../../../src/http/log.js";
import { type HttpServerHandle, startHttpServer } from "../../../src/http/serve.js";

const handles: HttpServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function startServer(): Promise<HttpServerHandle> {
  const handle = await startHttpServer({
    http: {
      auth: "bearer",
      host: "127.0.0.1",
      port: 0,
      publicOrigin: undefined,
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
      trustProxy: 0,
      stateDir: undefined,
      bearerTokens: [],
      secret: undefined,
      previousSecret: undefined,
      oauth: undefined,
    },
    routes: [],
    log: createHttpLog({ write: () => undefined }),
    announce: () => undefined,
  });
  handles.push(handle);
  return handle;
}

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe("runHealthcheck", () => {
  it("passes without probing when the HTTP mode is off (--stdio containers)", async () => {
    const fetch = () => Promise.reject(new Error("must not be called"));
    const out = capture();
    expect(await runHealthcheck({ SEVDESK_HTTP_PORT: "9" }, { ...out, fetch })).toBe(0);
    expect(await runHealthcheck({ SEVDESK_HTTP_AUTH: " " }, { ...out, fetch })).toBe(0);
    expect(out.lines).toEqual([]);
  });

  it("exits 0 for a healthy server and 1 while it drains", async () => {
    const handle = await startServer();
    const env = { SEVDESK_HTTP_AUTH: "bearer", SEVDESK_HTTP_PORT: String(handle.port) };
    const out = capture();
    expect(await runHealthcheck(env, out)).toBe(0);
    expect(out.lines).toEqual([]);
    handle.router.drain();
    expect(await runHealthcheck(env, out)).toBe(1);
    expect(out.lines).toEqual([expect.stringContaining("/healthz answered 503.")]);
  });

  it("exits 1 when nothing answers", async () => {
    const out = capture();
    const code = await runHealthcheck(
      { SEVDESK_HTTP_AUTH: "bearer", SEVDESK_HTTP_PORT: "9" },
      { ...out, fetch: () => Promise.reject(new Error("ECONNREFUSED")) },
    );
    expect(code).toBe(1);
    expect(out.lines).toEqual([
      "mcp-server-sevdesk healthcheck: no answer from http://127.0.0.1:9/healthz.",
    ]);
  });

  it("asks 127.0.0.1 for a wildcard bind and the configured host otherwise", async () => {
    const urls: string[] = [];
    const fetch = (url: string | URL | Request): Promise<Response> => {
      urls.push(url instanceof Request ? url.url : url.toString());
      return Promise.resolve(Response.json({ status: "ok" }));
    };
    const http = { SEVDESK_HTTP_AUTH: "oauth" };
    expect(
      await runHealthcheck({ ...http, SEVDESK_HTTP_HOST: "0.0.0.0", PORT: "3000" }, { fetch }),
    ).toBe(0);
    expect(
      await runHealthcheck({ ...http, SEVDESK_HTTP_HOST: "::", PORT: "3000" }, { fetch }),
    ).toBe(0);
    expect(await runHealthcheck({ ...http, SEVDESK_HTTP_HOST: "::1" }, { fetch })).toBe(0);
    expect(urls).toEqual([
      "http://127.0.0.1:3000/healthz",
      "http://127.0.0.1:3000/healthz",
      "http://[::1]:8080/healthz",
    ]);
  });

  it("exits 1 for an unusable port and an unexpected body", async () => {
    const out = capture();
    const http = { SEVDESK_HTTP_AUTH: "bearer" };
    expect(await runHealthcheck({ ...http, SEVDESK_HTTP_PORT: "0" }, out)).toBe(1);
    expect(await runHealthcheck({ ...http, SEVDESK_HTTP_PORT: "port" }, out)).toBe(1);
    const fetch = () => Promise.resolve(new Response("<html>"));
    expect(await runHealthcheck(http, { ...out, fetch })).toBe(1);
    expect(out.lines).toEqual([
      expect.stringContaining("the port is 0"),
      expect.stringContaining(
        'SEVDESK_HTTP_PORT: expected a port number between 0 and 65535, got "port".',
      ),
      expect.stringContaining("answered 200."),
    ]);
  });
});
