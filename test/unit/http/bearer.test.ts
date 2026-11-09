import { describe, expect, it } from "vitest";

import { BEARER_REALM, createBearerAuthenticator } from "../../../src/http/bearer.js";
import { createHttpLog } from "../../../src/http/log.js";
import type { HttpRequestContext } from "../../../src/http/types.js";

const CURRENT = "Zq3xR7pL0vN2mK8sT4wY6bH1cJ5dF9gA-_mcp";
const PREVIOUS = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY-next";

const ctx: HttpRequestContext = {
  clientIp: "127.0.0.1",
  origin: "http://127.0.0.1:8080",
  signal: new AbortController().signal,
  log: createHttpLog({ write: () => undefined }),
  limit: () => true,
};

function request(authorization?: string): Request {
  return new Request("http://127.0.0.1:8080/mcp", {
    method: "POST",
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

describe("createBearerAuthenticator", () => {
  const authenticator = createBearerAuthenticator([CURRENT, PREVIOUS], {
    tiers: ["read", "write", "read"],
    now: () => 1_000_000,
  });

  it("accepts every configured value and never puts the secret into AuthInfo", async () => {
    for (const token of [CURRENT, PREVIOUS]) {
      const auth = await authenticator.authenticate(request(`Bearer ${token}`), ctx);
      expect(auth).toEqual({
        token: "bearer",
        clientId: "bearer",
        scopes: ["read", "write"],
        expiresAt: 1_000 + 300,
      });
      expect(JSON.stringify(auth)).not.toContain(token);
    }
    expect(
      await authenticator.authenticate(request(`bearer   ${CURRENT}  `), ctx),
    ).not.toBeInstanceOf(Response);
  });

  it("answers 401 with a realm challenge, without resource metadata", async () => {
    const missing = await authenticator.authenticate(request(), ctx);
    expect(missing).toBeInstanceOf(Response);
    const response = missing as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Bearer realm="${BEARER_REALM}"`);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
  });

  it.each([
    ["a wrong token", `Bearer ${CURRENT.slice(0, -1)}x`],
    ["a prefix of the token", `Bearer ${CURRENT.slice(0, 10)}`],
    ["another scheme", `Basic ${CURRENT}`],
    ["two values", `Bearer ${CURRENT} ${PREVIOUS}`],
    ["an oversized header", `Bearer ${"x".repeat(5_000)}`],
  ])("refuses %s", async (_label, header) => {
    const result = await authenticator.authenticate(request(header), ctx);
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain(CURRENT);
    expect(text).not.toContain(PREVIOUS);
  });

  it("names the error when a token was presented", async () => {
    const response = (await authenticator.authenticate(request("Bearer nope"), ctx)) as Response;
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="${BEARER_REALM}", error="invalid_token"`,
    );
  });

  it("needs at least one token", () => {
    expect(() => createBearerAuthenticator([], { tiers: ["read"] })).toThrow(RangeError);
  });
});
