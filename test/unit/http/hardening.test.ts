import { describe, expect, it } from "vitest";

import {
  errorResponse,
  hostRefusal,
  methodNotAllowed,
  originHostnames,
  originRefusal,
  payloadTooLarge,
  serviceUnavailable,
  tooManyRequests,
  withSecurityHeaders,
} from "../../../src/http/hardening.js";

describe("responses", () => {
  it("builds the small JSON error answers", async () => {
    const limited = tooManyRequests(7);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
    expect(await limited.json()).toEqual({
      error: "rate_limited",
      error_description: "Too many requests; retry in 7 s.",
    });
    expect(methodNotAllowed(["POST"]).headers.get("allow")).toBe("POST");
    expect(await payloadTooLarge(1024).json()).toMatchObject({ error: "payload_too_large" });
    expect(serviceUnavailable("busy").headers.get("retry-after")).toBe("1");
    expect(errorResponse(400, "invalid_request", "x").headers.get("content-type")).toBe(
      "application/json",
    );
  });
});

describe("hostRefusal", () => {
  it("compares hostnames without port and refuses missing or malformed Host", () => {
    const allowed = ["mcp.example.com", "[::1]"];
    expect(hostRefusal(new Headers({ host: "mcp.example.com:443" }), allowed)).toBeUndefined();
    expect(hostRefusal(new Headers({ host: "[::1]:8080" }), allowed)).toBeUndefined();
    expect(hostRefusal(new Headers(), allowed)?.status).toBe(403);
    expect(hostRefusal(new Headers({ host: "a, b" }), allowed)?.status).toBe(403);
    expect(
      hostRefusal(new Headers({ host: "mcp.example.com.evil.example" }), allowed)?.status,
    ).toBe(403);
  });
});

describe("originRefusal", () => {
  const context = {
    origin: "https://mcp.example.com",
    allowedOriginHostnames: ["mcp.example.com"],
  };
  const request = (method: string, headers: Record<string, string>) =>
    new Request("https://mcp.example.com/x", { method, headers });

  it("answers MCP refusals as JSON-RPC errors", async () => {
    const refusal = originRefusal(
      request("POST", { Origin: "https://evil.example" }),
      "mcp",
      context,
    );
    expect(refusal?.status).toBe(403);
    expect(await refusal?.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
      id: null,
    });
  });

  it("lets form GETs through and checks form POSTs exactly", () => {
    expect(
      originRefusal(request("GET", { Origin: "https://evil.example" }), "form", context),
    ).toBeUndefined();
    expect(
      originRefusal(request("POST", { Origin: "https://mcp.example.com:8443" }), "form", context)
        ?.status,
    ).toBe(403);
    expect(
      originRefusal(request("POST", { Origin: "https://evil.example" }), "none", context),
    ).toBeUndefined();
  });
});

describe("originHostnames", () => {
  it("extracts hostnames and skips invalid entries", () => {
    expect(
      originHostnames(["https://a.example", "http://localhost:6274", "http://[::1]", "not-a-url"]),
    ).toEqual(["a.example", "localhost", "[::1]"]);
  });
});

describe("withSecurityHeaders", () => {
  it("keeps status, body and cookies", async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "a=1");
    headers.append("Set-Cookie", "b=2");
    const response = withSecurityHeaders(new Response("body", { status: 201, headers }), {
      https: false,
    });
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(await response.text()).toBe("body");
  });
});
