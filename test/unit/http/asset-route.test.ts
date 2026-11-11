import { describe, expect, it } from "vitest";

import { ASSET_RATE, assetRoute } from "../../../src/http/asset-route.js";
import { createHttpLog } from "../../../src/http/log.js";
import { createRouter } from "../../../src/http/router.js";
import { EMBEDDED_ASSETS } from "../../../src/pages/assets.generated.js";
import { assetPath } from "../../../src/pages/assets.js";

const ORIGIN = "https://mcp.example.com";

function setup() {
  const lines: Record<string, unknown>[] = [];
  const log = createHttpLog({
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    secrets: [],
  });
  const router = createRouter({
    http: { allowedHosts: ["mcp.example.com"], allowedOrigins: [ORIGIN], trustProxy: 0 },
    origin: ORIGIN,
    routes: [assetRoute()],
    log,
  });
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "mcp.example.com");
    return router.fetch(new Request(`http://internal${path}`, { ...init, headers }));
  };
  return { call, lines };
}

describe("GET /assets/<name>", () => {
  it("declares a public, body-less GET route with a rate limit", () => {
    const { handle: _handle, ...declared } = assetRoute();
    expect(declared).toEqual({
      path: "/assets/",
      match: "prefix",
      methods: ["GET"],
      maxBodyBytes: 0,
      origin: "none",
      rateLimit: { name: "assets", perMinute: 240 },
    });
    expect(ASSET_RATE.perMinute).toBe(240);
  });

  it("serves each font and the icon, cacheable forever, without a session", async () => {
    const { call } = setup();
    for (const key of Object.keys(EMBEDDED_ASSETS) as (keyof typeof EMBEDDED_ASSETS)[]) {
      const response = await call(assetPath(key));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(EMBEDDED_ASSETS[key].type);
      // The router's default (`no-store`) must not replace the asset's own caching.
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.toString("base64")).toBe(EMBEDDED_ASSETS[key].base64);
      expect(response.headers.get("content-length")).toBe(String(body.byteLength));
    }
  });

  it("answers 404 for unknown names and 405 for other methods", async () => {
    const { call } = setup();
    for (const path of ["/assets/", "/assets/icon.svg", "/assets/a/b", "/assets/%2e%2e/x"]) {
      const response = await call(path);
      expect(response.status, path).toBe(404);
      await response.text();
    }
    const post = await call(assetPath("icon"), { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  it("is served on the server's own host only", async () => {
    const { call } = setup();
    const response = await call(assetPath("icon"), { host: "evil.example" });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("<svg");
  });
});
