import { describe, expect, it } from "vitest";

import { isLoopbackRedirect, matchRedirectUri } from "../../../../src/http/oauth/redirect-uri.js";

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const CODE = ["http://localhost/callback", "http://127.0.0.1/callback"];

describe("matchRedirectUri", () => {
  it("matches https redirects exactly", () => {
    expect(matchRedirectUri(CLAUDE, [CLAUDE])).toBe(CLAUDE);
    for (const near of [
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback?x=1",
      "https://claude.ai/api/mcp/Auth_callback",
      "https://claude.ai:443/api/mcp/auth_callback",
      "https://CLAUDE.ai/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback#frag",
      "https://evil.example/api/mcp/auth_callback",
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://user@claude.ai/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/../mcp/auth_callback",
      "http://claude.ai/api/mcp/auth_callback",
      " https://claude.ai/api/mcp/auth_callback",
    ]) {
      expect(matchRedirectUri(near, [CLAUDE]), near).toBeUndefined();
    }
  });

  it("matches loopback redirects on any port, each loopback name only itself", () => {
    expect(matchRedirectUri("http://localhost:53111/callback", CODE)).toBe(
      "http://localhost:53111/callback",
    );
    expect(matchRedirectUri("http://127.0.0.1:9/callback", CODE)).toBe(
      "http://127.0.0.1:9/callback",
    );
    expect(matchRedirectUri("http://127.0.0.1/callback", CODE)).toBe("http://127.0.0.1/callback");
    expect(matchRedirectUri("http://[::1]:8080/callback", CODE)).toBeUndefined();
    expect(matchRedirectUri("http://[::1]:8080/callback", ["http://[::1]/callback"])).toBe(
      "http://[::1]:8080/callback",
    );
    expect(
      matchRedirectUri("http://localhost:1/callback", ["http://127.0.0.1/callback"]),
    ).toBeUndefined();
    expect(matchRedirectUri("http://localhost:1/other", CODE)).toBeUndefined();
    expect(matchRedirectUri("http://localhost:1/callback?x=1", CODE)).toBeUndefined();
    expect(matchRedirectUri("https://localhost:1/callback", CODE)).toBeUndefined();
    expect(matchRedirectUri("http://localhost.evil.example:1/callback", CODE)).toBeUndefined();
    expect(
      matchRedirectUri("http://127.0.0.2:1/callback", ["http://127.0.0.2/callback"]),
    ).toBeUndefined();
  });

  it("never matches custom schemes, garbage or registered garbage", () => {
    expect(matchRedirectUri("cursor://callback", ["cursor://callback"])).toBeUndefined();
    expect(matchRedirectUri("javascript:alert(1)", ["javascript:alert(1)"])).toBeUndefined();
    expect(matchRedirectUri("not a url", ["not a url"])).toBeUndefined();
    expect(matchRedirectUri(CLAUDE, ["not a url", "cursor://x"])).toBeUndefined();
    expect(matchRedirectUri(`https://claude.ai/${"a".repeat(2100)}`, [CLAUDE])).toBeUndefined();
  });

  it("tells loopback redirects apart", () => {
    expect(isLoopbackRedirect("http://127.0.0.1:5/callback")).toBe(true);
    expect(isLoopbackRedirect(CLAUDE)).toBe(false);
    expect(isLoopbackRedirect("cursor://x")).toBe(false);
  });
});
