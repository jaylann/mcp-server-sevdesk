import { describe, expect, it } from "vitest";

import { clientIp, normalizeIp, rateLimitKey, UNKNOWN_IP } from "../../../src/http/client-ip.js";

describe("clientIp", () => {
  it("uses the socket address and ignores X-Forwarded-For without trusted proxies", () => {
    expect(clientIp("203.0.113.9", "198.51.100.1", 0)).toBe("203.0.113.9");
    expect(clientIp("::ffff:127.0.0.1", null, 0)).toBe("127.0.0.1");
    expect(clientIp(undefined, undefined, 0)).toBe(UNKNOWN_IP);
  });

  it("takes the N-th entry from the right behind N proxies", () => {
    const header = "10.9.9.9, 198.51.100.7, 172.16.0.2";
    expect(clientIp("172.16.0.3", header, 1)).toBe("172.16.0.2");
    expect(clientIp("172.16.0.3", header, 2)).toBe("198.51.100.7");
    // A spoofed leftmost entry is only reached with more hops than entries.
    expect(clientIp("172.16.0.3", "198.51.100.7", 3)).toBe("198.51.100.7");
  });

  it("normalizes ports, brackets and mapped addresses in the header", () => {
    expect(clientIp("10.0.0.1", "198.51.100.7:5123", 1)).toBe("198.51.100.7");
    expect(clientIp("10.0.0.1", "[2001:DB8::1]:443", 1)).toBe("2001:db8::1");
    expect(clientIp("10.0.0.1", "::ffff:198.51.100.7", 1)).toBe("198.51.100.7");
  });

  it("falls back to the socket address for garbage or empty headers", () => {
    expect(clientIp("10.0.0.1", "not-an-ip", 1)).toBe("10.0.0.1");
    expect(clientIp("10.0.0.1", " , ", 1)).toBe("10.0.0.1");
  });
});

describe("normalizeIp", () => {
  it("accepts IPv4 and IPv6, refuses the rest", () => {
    expect(normalizeIp("192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeIp("[::1]")).toBe("::1");
    expect(normalizeIp("unknown")).toBeUndefined();
    expect(normalizeIp(undefined)).toBeUndefined();
  });
});

describe("rateLimitKey", () => {
  it("groups IPv6 by /64 and keeps IPv4 as is", () => {
    expect(rateLimitKey("192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(rateLimitKey(UNKNOWN_IP)).toBe(UNKNOWN_IP);
  });
});
