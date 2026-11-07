/**
 * Silent truncation at 100 rows.
 *
 * sevDesk returns at most 100 objects when `limit` is omitted, without any hint that more exist.
 * Other sevDesk MCP servers relied on the default and reported "all invoices" from the first 100,
 * or stopped paging at the first page shorter than requested, which sevDesk can return
 * mid-collection. The client therefore always sends an explicit `limit` (1–1000), asks for
 * `countAll`, and `listAll` pages until an empty page.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import {
  createFakeClock,
  createFakeFetch,
  envelope,
  type FakeReply,
} from "../helpers/fake-fetch.js";

function setup(replies: FakeReply[]) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const client = createSevdeskClient(
    {
      token: "0123456789abcdef0123456789abcdef",
      baseUrl: "https://my.sevdesk.de/api/v1",
      allowedTiers: new Set<Tier>(["read"]),
      readOnly: true,
      dryRun: false,
      requestsPerSecond: 1000,
      timeoutMs: 1000,
      userAgent: "test",
    },
    { fetch: fake.fetch, sleep: clock.sleep, now: clock.now, monotonicNow: clock.now },
  );
  return { client, fake };
}

function rows(count: number, start = 0): unknown[] {
  return Array.from({ length: count }, (_, index) => ({ id: String(start + index + 1) }));
}

describe("limit is always explicit", () => {
  it("list sends limit=100 and countAll when no limit is given", async () => {
    const { client, fake } = setup([envelope(rows(100), "250")]);
    const page = await client.list("/Invoice");
    const params = fake.requests[0]?.url.searchParams;
    expect(params?.get("limit")).toBe("100");
    expect(params?.get("countAll")).toBe("1");
    expect(page.total).toBe(250);
  });

  it.each([0, 1001, -5])("list refuses limit %i instead of letting sevDesk pick", async (limit) => {
    const { client, fake } = setup([]);
    await expect(client.list("/Invoice", undefined, { limit })).rejects.toMatchObject({
      kind: "validation",
    });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("listAll does not trust short pages", () => {
  it("keeps paging past a short page until an empty one", async () => {
    // pageSize 100, but sevDesk returns 100, then a short 37, then 100 more, then nothing.
    const { client, fake } = setup([
      envelope(rows(100), "237"),
      envelope(rows(37, 100), "237"),
      envelope(rows(100, 137), "237"),
      envelope([], "237"),
    ]);

    const result = await client.listAll("/Invoice", undefined, { max: 10_000, pageSize: 100 });

    expect(result.items).toHaveLength(237);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(237);
    expect(fake.requests.map((request) => request.url.searchParams.get("offset"))).toEqual([
      "0",
      "100",
      "137",
      "237",
    ]);
    expect(fake.requests.every((request) => request.url.searchParams.has("limit"))).toBe(true);
  });

  it("says when max cut the result short", async () => {
    const { client } = setup([envelope(rows(100), "500"), envelope(rows(51, 100), "500")]);
    const result = await client.listAll("/Invoice", undefined, { max: 150, pageSize: 100 });
    expect(result.items).toHaveLength(150);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
  });
});
