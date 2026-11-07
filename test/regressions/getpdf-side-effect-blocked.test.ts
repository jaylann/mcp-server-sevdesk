/**
 * B1: `getPdf` without `preventSendBy=true` marks an invoice as sent.
 *
 * `GET /Invoice/{id}/getPdf` looks like a read, but unless `preventSendBy=true` is passed sevDesk
 * records the invoice as sent (status and send date change, and a draft can become open). Other
 * sevDesk MCP servers exposed it as a harmless "download PDF" read tool, so a read-only session
 * could change bookkeeping data. `GET /CreditNote/{id}/sendByWithRender` always marks the credit
 * note as sent. The client therefore recognizes these endpoints itself, not only via the
 * `sideEffect` flag: a getPdf read always goes out with `preventSendBy=true`, and anything that would
 * mark a document as sent is a write: blocked in read-only and dry-run mode, never retried.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient, type SevdeskClientConfig } from "../../src/sevdesk/client.js";
import {
  createFakeClock,
  createFakeFetch,
  envelope,
  type FakeReply,
  sevdeskErrorResponse,
} from "../helpers/fake-fetch.js";

const base: SevdeskClientConfig = {
  token: "0123456789abcdef0123456789abcdef",
  baseUrl: "https://my.sevdesk.de/api/v1",
  allowedTiers: new Set<Tier>(["read", "write", "commit", "external"]),
  readOnly: false,
  dryRun: false,
  requestsPerSecond: 1000,
  timeoutMs: 1000,
  userAgent: "test",
};

function setup(config: Partial<SevdeskClientConfig>, replies: FakeReply[] = []) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const client = createSevdeskClient(
    { ...base, ...config },
    {
      fetch: fake.fetch,
      sleep: clock.sleep,
      now: clock.now,
      monotonicNow: clock.now,
      random: () => 0.5,
    },
  );
  return { client, fake };
}

const noWrites: [string, Partial<SevdeskClientConfig>][] = [
  ["read-only mode", { readOnly: true, allowedTiers: new Set<Tier>(["read"]) }],
  ["dry-run mode", { dryRun: true }],
  ["the read tier only", { allowedTiers: new Set<Tier>(["read"]) }],
];

const sendingPdf = {
  method: "GET",
  path: "/Invoice/12/getPdf",
  sideEffect: true,
  tier: "external",
} as const;

describe("B1: state-changing GETs count as writes", () => {
  it.each(noWrites)("a sideEffect GET is blocked in %s", async (_label, config) => {
    const { client, fake } = setup(config);

    await expect(client.request(sendingPdf)).rejects.toMatchObject({ kind: "blocked" });
    await expect(client.download(sendingPdf)).rejects.toMatchObject({ kind: "blocked" });
    expect(fake.requests).toHaveLength(0);
  });

  it("the preview form (preventSendBy=true, no sideEffect) is allowed in read-only mode", async () => {
    const { client, fake } = setup({ readOnly: true, allowedTiers: new Set<Tier>(["read"]) }, [
      envelope({ filename: "RE-1.pdf", content: "JVBERi0=" }),
    ]);

    await client.request({
      method: "GET",
      path: "/Invoice/12/getPdf",
      query: { preventSendBy: true },
    });

    expect(fake.requests[0]?.url.searchParams.get("preventSendBy")).toBe("true");
  });

  it("a sideEffect GET is never retried when writes are enabled", async () => {
    const { client, fake } = setup({}, [
      sevdeskErrorResponse(500, "Internal Server Error"),
      envelope({ content: "JVBERi0=" }),
    ]);

    await expect(client.request(sendingPdf)).rejects.toMatchObject({ kind: "server" });
    expect(fake.requests).toHaveLength(1);
  });
});

describe("B1: unflagged state-changing GETs are recognized by endpoint", () => {
  it("an unflagged getPdf in read-only mode goes out with preventSendBy=true", async () => {
    const { client, fake } = setup({ readOnly: true, allowedTiers: new Set<Tier>(["read"]) }, [
      envelope({ filename: "RE-1.pdf", content: "JVBERi0=" }),
      envelope({ filename: "RE-1.pdf", content: "JVBERi0=" }),
    ]);

    await client.request({ method: "GET", path: "/Invoice/12/getPdf" });
    await client.download({ method: "GET", path: "/Invoice/12/getPdf", query: { download: true } });

    for (const request of fake.requests) {
      expect(request.url.searchParams.get("preventSendBy")).toBe("true");
    }
  });

  it.each(noWrites)(
    "an unflagged getPdf with preventSendBy=false is blocked in %s",
    async (_label, config) => {
      const { client, fake } = setup(config);
      await expect(
        client.request({
          method: "GET",
          path: "/Invoice/12/getPdf",
          query: { preventSendBy: false },
          tier: "external",
        }),
      ).rejects.toMatchObject({ kind: "blocked" });
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each(noWrites)("an unflagged sendByWithRender is blocked in %s", async (_label, config) => {
    const { client, fake } = setup(config);
    const request = {
      method: "GET",
      path: "/CreditNote/12/sendByWithRender",
      query: { sendType: "PRN" },
      tier: "external",
    } as const;

    await expect(client.request(request)).rejects.toMatchObject({ kind: "blocked" });
    await expect(client.download(request)).rejects.toMatchObject({ kind: "blocked" });
    expect(fake.requests).toHaveLength(0);
  });

  it("an unflagged sendByWithRender is never retried when writes are enabled", async () => {
    const { client, fake } = setup({}, [
      sevdeskErrorResponse(503, "Service Unavailable"),
      envelope({ id: "12" }),
    ]);

    await expect(
      client.request({
        method: "GET",
        path: "/CreditNote/12/sendByWithRender",
        query: { sendType: "PRN" },
        tier: "external",
      }),
    ).rejects.toMatchObject({ kind: "server" });
    expect(fake.requests).toHaveLength(1);
  });

  it("an unflagged sendByWithRender without a declared tier is refused", async () => {
    const { client, fake } = setup({});
    await expect(
      client.request({ method: "GET", path: "/CreditNote/12/sendByWithRender" }),
    ).rejects.toMatchObject({ kind: "blocked" });
    expect(fake.requests).toHaveLength(0);
  });
});
