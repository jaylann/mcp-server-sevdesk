import { describe, expect, it, vi } from "vitest";

import {
  isPublicAddress,
  resolvePublicAddress,
  SsrfError,
  systemResolver,
} from "../../../../src/http/oauth/ssrf.js";

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
  ])("refuses the IPv4 address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "::",
    "::1",
    "fe80::1",
    "fe80::1%en0",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "3fff::1",
    "100::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::10.0.0.1",
    "::8.8.8.8",
    "64:ff9b::10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::8.8.8.8",
    "2002:0a00:0001::1",
    "2002:7f00:1::",
    "2002:c0a8:0101::1",
  ])("refuses the IPv6 address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "160.79.104.10",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2002:0808:0808::1",
    "2a01:4f8:1:2:3:4:5:6",
  ])("accepts the public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("refuses non-addresses", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
    expect(isPublicAddress("1.2.3")).toBe(false);
  });
});

describe("resolvePublicAddress", () => {
  it("resolves once and returns the first address when all are public", async () => {
    const resolve = vi.fn(() =>
      Promise.resolve([
        { address: "160.79.104.10", family: 4 as const },
        { address: "2607:6bc0::10", family: 6 as const },
      ]),
    );
    await expect(resolvePublicAddress("claude.ai", resolve)).resolves.toEqual({
      address: "160.79.104.10",
      family: 4,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("prefers IPv4, and connects over IPv6 only without an IPv4 address", async () => {
    const both = () =>
      Promise.resolve([
        { address: "2607:6bc0::10", family: 6 as const },
        { address: "160.79.104.10", family: 4 as const },
      ]);
    await expect(resolvePublicAddress("claude.ai", both)).resolves.toMatchObject({ family: 4 });
    const v6 = () => Promise.resolve([{ address: "2607:6bc0::10", family: 6 as const }]);
    await expect(resolvePublicAddress("claude.ai", v6)).resolves.toEqual({
      address: "2607:6bc0::10",
      family: 6,
    });
  });

  it("refuses a host when any of its addresses is not public", async () => {
    const resolve = vi.fn(() =>
      Promise.resolve([
        { address: "8.8.8.8", family: 4 as const },
        { address: "10.0.0.5", family: 4 as const },
      ]),
    );
    const error = await resolvePublicAddress("rebind.example", resolve).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SsrfError);
    expect((error as SsrfError).reason).toBe("blocked_address");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("refuses unresolvable hosts and empty answers", async () => {
    await expect(
      resolvePublicAddress("nx.example", () => Promise.reject(new Error("ENOTFOUND"))),
    ).rejects.toMatchObject({ reason: "unresolvable" });
    await expect(
      resolvePublicAddress("empty.example", () => Promise.resolve([])),
    ).rejects.toMatchObject({
      reason: "unresolvable",
    });
  });
});

describe("systemResolver", () => {
  it("resolves through the operating system, so localhost is refused", async () => {
    const addresses = await systemResolver("localhost");
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.some((entry) => ["127.0.0.1", "::1"].includes(entry.address))).toBe(true);
    await expect(resolvePublicAddress("localhost", systemResolver)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });
});
