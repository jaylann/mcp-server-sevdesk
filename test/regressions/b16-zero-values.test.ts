/**
 * B16: `0` and `false` are values, not "missing".
 *
 * Other sevDesk MCP servers built query strings with `if (value)` checks, so `status=0`,
 * `offset=0`, a zero amount or `isBooked=false` were silently dropped, and the request returned
 * something else than asked for (all invoices instead of the filtered ones). sevDesk also ignores
 * a literal `false`, so booleans go out as `1`/`0`. Zero money amounts must likewise survive
 * parsing, formatting and summing.
 */
import { describe, expect, it } from "vitest";

import { add, format, isZero, money, sumMoney, toDecimalString } from "../../src/domain/money.js";
import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { zDecimalString, zIntish, zNumberish } from "../../src/sevdesk/schema.js";
import { createFakeClock, createFakeFetch, envelope } from "../helpers/fake-fetch.js";

function setup() {
  const fake = createFakeFetch(envelope([], "0"));
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

describe("B16: zero values are sent and kept", () => {
  it("sends 0 and false query values as 0", async () => {
    const { client, fake } = setup();

    await client.request({
      method: "GET",
      path: "/Invoice",
      query: { status: 0, sumGross: 0, isBooked: false, startDate: 0, name: "" },
    });

    const params = fake.requests[0]?.url.searchParams;
    expect(params?.get("status")).toBe("0");
    expect(params?.get("sumGross")).toBe("0");
    expect(params?.get("isBooked")).toBe("0");
    expect(params?.get("startDate")).toBe("0");
    expect(params?.get("name")).toBe("");
  });

  it('sends offset=0 explicitly and reads total "0" as 0', async () => {
    const { client, fake } = setup();
    const page = await client.list("/Invoice", { status: 0 }, { offset: 0 });
    expect(fake.requests[0]?.url.searchParams.get("offset")).toBe("0");
    expect(page.total).toBe(0);
  });

  it("parses zero from sevDesk responses", () => {
    expect(zNumberish.parse("0")).toBe(0);
    expect(zNumberish.parse(0)).toBe(0);
    expect(zIntish.parse("0")).toBe(0);
    expect(zDecimalString.parse("0.00")).toBe("0.00");
    expect(zDecimalString.parse(0)).toBe("0");
  });

  it("handles zero money amounts", () => {
    expect(money(0)).toEqual({ amount: "0.00", currency: "EUR" });
    expect(money("0.00", "EUR").amount).toBe("0.00");
    expect(isZero("0.00")).toBe(true);
    expect(format(0, 2)).toBe("0.00");
    expect(toDecimalString(add(0, "0.00"))).toBe("0");
    expect(sumMoney([money(0), money("12.5"), money(0)])).toEqual({
      amount: "12.50",
      currency: "EUR",
    });
  });
});
