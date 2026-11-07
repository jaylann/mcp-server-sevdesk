import { describe, expect, it, vi } from "vitest";

import type { Tier } from "../../../src/safety/tiers.js";
import { createSevdeskClient } from "../../../src/sevdesk/client.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  detectGeneration,
  detectPositionGeneration,
  getBookkeepingSystemVersion,
  parseSystemVersion,
} from "../../../src/sevdesk/system-version.js";
import type { SevdeskClient, SevdeskRequest } from "../../../src/sevdesk/types.js";
import { createFakeClock, createFakeFetch, envelope } from "../../helpers/fake-fetch.js";

function fakeClient(request: (request: SevdeskRequest) => Promise<unknown>): SevdeskClient {
  const unused = () => Promise.reject(new Error("not used in this test"));
  return { request, list: unused, listAll: unused, download: unused };
}

describe("getBookkeepingSystemVersion", () => {
  it("reads the version through the real client and envelope", async () => {
    const fake = createFakeFetch(envelope({ version: "2.0" }));
    const clock = createFakeClock();
    const client = createSevdeskClient(
      {
        token: "0123456789abcdef0123456789abcdef",
        baseUrl: "https://my.sevdesk.de/api/v1",
        allowedTiers: new Set<Tier>(["read"]),
        readOnly: true,
        dryRun: false,
        requestsPerSecond: 4,
        timeoutMs: 1000,
        userAgent: "test",
      },
      { fetch: fake.fetch, sleep: clock.sleep, now: clock.now, monotonicNow: clock.now },
    );

    await expect(getBookkeepingSystemVersion(client)).resolves.toBe("2.0");
    expect(fake.requests[0]?.url.pathname).toBe("/api/v1/Tools/bookkeepingSystemVersion");
  });

  it("memoizes per client instance", async () => {
    const firstRequest = vi.fn(() => Promise.resolve({ version: "1.0" }));
    const secondRequest = vi.fn(() => Promise.resolve([{ version: "2.0" }]));
    const first = fakeClient(firstRequest);
    const second = fakeClient(secondRequest);

    expect(await getBookkeepingSystemVersion(first)).toBe("1.0");
    expect(await getBookkeepingSystemVersion(first)).toBe("1.0");
    expect(await getBookkeepingSystemVersion(second)).toBe("2.0");
    expect(firstRequest).toHaveBeenCalledTimes(1);
    expect(secondRequest).toHaveBeenCalledTimes(1);
  });

  it("passes the signal and does not cache failures", async () => {
    const signal = new AbortController().signal;
    let calls = 0;
    const client = fakeClient((request) => {
      calls += 1;
      expect(request).toMatchObject({
        method: "GET",
        path: "/Tools/bookkeepingSystemVersion",
        signal,
      });
      return calls === 1
        ? Promise.reject(new SevdeskError({ kind: "server", message: "down" }))
        : Promise.resolve({ version: "2.0" });
    });

    await expect(getBookkeepingSystemVersion(client, signal)).rejects.toThrow("down");
    await expect(getBookkeepingSystemVersion(client, signal)).resolves.toBe("2.0");
    expect(calls).toBe(2);
  });

  it("fails loudly on an unknown version", async () => {
    const client = fakeClient(() => Promise.resolve({ version: "3.0" }));
    const error: unknown = await getBookkeepingSystemVersion(client).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("unexpected_response");
  });

  it("reports an empty payload as not_found", async () => {
    const client = fakeClient(() => Promise.resolve([]));
    await expect(getBookkeepingSystemVersion(client)).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("parseSystemVersion", () => {
  it.each([
    ["1.0", "1.0"],
    ["1", "1.0"],
    [1, "1.0"],
    ["2.0", "2.0"],
    ["2", "2.0"],
    [2, "2.0"],
  ])("normalizes %j to %s", (input, expected) => {
    expect(parseSystemVersion(input)).toBe(expected);
  });

  it.each(["3.0", "", null, undefined, 2.5, "2.0 "])("rejects %j", (input) => {
    expect(() => parseSystemVersion(input)).toThrow(SevdeskError);
  });
});

describe("detectGeneration", () => {
  it.each([
    [{ taxRule: { id: "1", objectName: "TaxRule" }, taxType: "default" }, "2.0"],
    [{ taxRule: { id: "1", objectName: "TaxRule" } }, "2.0"],
    [{ taxType: "default", taxRule: null }, "1.0"],
    [{ taxType: "default" }, "1.0"],
    [{ taxType: null, taxRule: null }, undefined],
    [{ taxType: "", taxRule: "" }, undefined],
    [{}, undefined],
    [null, undefined],
    ["x", undefined],
  ])("detects %j as %s", (record, expected) => {
    expect(detectGeneration(record)).toBe(expected);
  });
});

describe("detectPositionGeneration", () => {
  it.each([
    [{ accountDatev: { id: "9", objectName: "AccountDatev" }, accountingType: null }, "2.0"],
    [{ accountDatev: { id: "9", objectName: "AccountDatev" }, accountingType: { id: "1" } }, "2.0"],
    [{ accountingType: { id: "1", objectName: "AccountingType" } }, "1.0"],
    [{ accountingType: { id: "1" }, accountDatev: null }, "1.0"],
    [{ accountDatev: null, accountingType: null }, undefined],
    [undefined, undefined],
  ])("detects %j as %s", (position, expected) => {
    expect(detectPositionGeneration(position)).toBe(expected);
  });

  it("handles accounts that mix generations", () => {
    const positions = [{ accountDatev: { id: "1" } }, { accountingType: { id: "2" } }];
    expect(positions.map(detectPositionGeneration)).toEqual(["2.0", "1.0"]);
  });
});
