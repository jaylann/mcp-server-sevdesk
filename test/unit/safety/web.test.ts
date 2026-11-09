import { describe, expect, it } from "vitest";

import {
  clearCookie,
  FormError,
  htmlResponse,
  randomId,
  readCookie,
  readForm,
  safeEqual,
  sameOriginPost,
  serializeCookie,
} from "../../../src/safety/web.js";

const ORIGIN = "https://mcp.example.com";

function post(headers: Record<string, string>, body?: string): Request {
  return new Request(`${ORIGIN}/approvals/x`, { method: "POST", headers, body: body ?? null });
}

describe("safeEqual", () => {
  it("compares strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("cookies", () => {
  it("reads one cookie from a header", () => {
    expect(readCookie("a=1; __Host-s=xy=z; b=2", "__Host-s")).toBe("xy=z");
    expect(readCookie("a=1", "b")).toBeUndefined();
    expect(readCookie(null, "a")).toBeUndefined();
  });

  it("serializes HttpOnly cookies and refuses unsafe names and values", () => {
    expect(
      serializeCookie("__Host-s", "abc_-", { maxAgeSeconds: 60, secure: true, sameSite: "Lax" }),
    ).toBe("__Host-s=abc_-; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure");
    expect(clearCookie("s", { secure: false, sameSite: "Strict" })).toBe(
      "s=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
    );
    expect(() =>
      serializeCookie("a;b", "x", { maxAgeSeconds: 1, secure: true, sameSite: "Lax" }),
    ).toThrow();
    expect(() =>
      serializeCookie("a", "x;y", { maxAgeSeconds: 1, secure: true, sameSite: "Lax" }),
    ).toThrow();
  });

  it("makes random ids of the requested size", () => {
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomId(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("sameOriginPost", () => {
  it("accepts the own origin or Sec-Fetch-Site without Origin", () => {
    expect(sameOriginPost(post({ origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(sameOriginPost(post({ "sec-fetch-site": "same-origin" }), ORIGIN)).toBe(true);
  });

  it("refuses other origins, null and missing evidence", () => {
    expect(sameOriginPost(post({ origin: "https://evil.example" }), ORIGIN)).toBe(false);
    expect(sameOriginPost(post({ origin: "null" }), ORIGIN)).toBe(false);
    expect(sameOriginPost(post({ origin: "null", "sec-fetch-site": "same-origin" }), ORIGIN)).toBe(
      false,
    );
    expect(sameOriginPost(post({ "sec-fetch-site": "cross-site" }), ORIGIN)).toBe(false);
    expect(sameOriginPost(post({}), ORIGIN)).toBe(false);
  });
});

describe("readForm", () => {
  const form = { "content-type": "application/x-www-form-urlencoded" };

  it("reads a form", async () => {
    const params = await readForm(post(form, "a=1&b=x%20y"), 100);
    expect(params.get("a")).toBe("1");
    expect(params.get("b")).toBe("x y");
  });

  it("refuses other content types, oversized bodies and NUL bytes", async () => {
    await expect(readForm(post({ "content-type": "application/json" }, "{}"), 100)).rejects.toThrow(
      FormError,
    );
    await expect(readForm(post(form, `a=${"x".repeat(200)}`), 100)).rejects.toMatchObject({
      reason: "too_large",
    });
    await expect(readForm(post(form, "a=%00"), 100)).resolves.toBeInstanceOf(URLSearchParams);
    await expect(readForm(post(form, "a=\u0000"), 100)).rejects.toMatchObject({
      reason: "malformed",
    });
  });
});

describe("htmlResponse", () => {
  it("sets the page security headers", () => {
    const response = htmlResponse("<p>x</p>", { status: 200, nonce: "n1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'nonce-n1'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("adds form-action origins and can leave the opener alone", () => {
    const response = htmlResponse("", {
      status: 200,
      nonce: "n",
      formActions: ["https://claude.ai"],
      isolateOpener: false,
      headers: { "Set-Cookie": "a=b" },
    });
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://claude.ai;",
    );
    expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(response.headers.get("set-cookie")).toBe("a=b");
  });
});
