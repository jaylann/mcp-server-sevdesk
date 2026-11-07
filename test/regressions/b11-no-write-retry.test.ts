/**
 * B11: writes are never retried.
 *
 * Other sevDesk MCP servers wrapped every request in a generic retry loop. When sevDesk answered
 * a `POST /Invoice/Factory/saveInvoice` with a 500 or 429 (or the connection dropped) *after* it
 * had already stored the invoice, the retry created a second invoice; with numbering that also
 * burned an invoice number, a GoBD problem. sevDesk has no idempotency keys, so the only safe rule
 * is: POST/PUT/DELETE and state-changing GETs are attempted exactly once.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import type { HttpMethod } from "../../src/sevdesk/types.js";
import {
  createFakeClock,
  createFakeFetch,
  envelope,
  type FakeReply,
  networkError,
  sevdeskErrorResponse,
} from "../helpers/fake-fetch.js";

function setup(replies: FakeReply[]) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const client = createSevdeskClient(
    {
      token: "0123456789abcdef0123456789abcdef",
      baseUrl: "https://my.sevdesk.de/api/v1",
      allowedTiers: new Set<Tier>(["read", "write", "commit", "external"]),
      readOnly: false,
      dryRun: false,
      requestsPerSecond: 1000,
      timeoutMs: 1000,
      userAgent: "test",
    },
    {
      fetch: fake.fetch,
      sleep: clock.sleep,
      now: clock.now,
      monotonicNow: clock.now,
      random: () => 0.5,
    },
  );
  return { client, fake, clock };
}

const failures: [string, () => FakeReply][] = [
  ["HTTP 500", () => sevdeskErrorResponse(500, "Internal Server Error")],
  ["HTTP 503", () => sevdeskErrorResponse(503, "Service Unavailable")],
  ["HTTP 429", () => sevdeskErrorResponse(429, "Too Many Requests", { "Retry-After": "1" })],
  ["a network error", () => ({ throws: networkError("ECONNRESET") })],
];

const writes: [HttpMethod, string][] = [
  ["POST", "/Invoice/Factory/saveInvoice"],
  ["PUT", "/Invoice/12/sendBy"],
  ["DELETE", "/Voucher/12"],
];

describe("B11: writes are attempted exactly once", () => {
  for (const [method, path] of writes) {
    it.each(failures)(`${method} ${path} is not retried after %s`, async (_label, failure) => {
      // A success is queued behind the failure: a retry would consume it and "succeed".
      const { client, fake, clock } = setup([failure(), envelope({ id: "1" })]);

      const error: unknown = await client
        .request({
          method,
          path,
          tier: "commit",
          ...(method === "DELETE" ? {} : { body: { a: 1 } }),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SevdeskError);
      expect((error as SevdeskError).kind).not.toBe("blocked");
      expect(fake.requests).toHaveLength(1);
      expect(fake.pending).toBe(1);
      expect(clock.sleeps).toEqual([]);
    });
  }

  it.each(failures)(
    "a flagged side-effect GET is not retried after %s",
    async (_label, failure) => {
      const { client, fake } = setup([failure(), envelope({ content: "JVBERi0=" })]);

      const error: unknown = await client
        .request({ method: "GET", path: "/Invoice/12/getPdf", sideEffect: true, tier: "external" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SevdeskError);
      expect(fake.requests).toHaveLength(1);
    },
  );

  it.each(failures)(
    "an unflagged sendByWithRender is not retried after %s",
    async (_label, failure) => {
      const { client, fake } = setup([failure(), envelope({ id: "12" })]);

      const error: unknown = await client
        .request({ method: "GET", path: "/CreditNote/12/sendByWithRender", tier: "external" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SevdeskError);
      expect(fake.requests).toHaveLength(1);
    },
  );

  it("a write that times out is not retried", async () => {
    const fake = createFakeFetch("hang", envelope({ id: "1" }));
    const client = createSevdeskClient(
      {
        token: "0123456789abcdef0123456789abcdef",
        baseUrl: "https://my.sevdesk.de/api/v1",
        allowedTiers: new Set<Tier>(["read", "write"]),
        readOnly: false,
        dryRun: false,
        requestsPerSecond: 1000,
        timeoutMs: 20,
        userAgent: "test",
      },
      { fetch: fake.fetch },
    );

    await expect(
      client.request({ method: "POST", tier: "write", path: "/Contact", body: {} }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(fake.requests).toHaveLength(1);
  });

  it("plain GETs are still retried (control)", async () => {
    const { client, fake } = setup([sevdeskErrorResponse(500, "x"), envelope([])]);
    await client.request({ method: "GET", path: "/Invoice" });
    expect(fake.requests).toHaveLength(2);
  });
});
