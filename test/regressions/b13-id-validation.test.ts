/**
 * B13: ids and paths are validated before any request.
 *
 * Other sevDesk MCP servers interpolated model-supplied ids straight into URLs. A negative id,
 * `12.5`, `NaN` (from `Number("abc")`), `"12abc"` or `"../SevUser"` then reached a different
 * endpoint than intended, or a collection endpoint instead of one object (`/Invoice/` lists
 * every invoice, and a DELETE there is worse). Ids beyond 2^53 silently lose precision in JS and
 * address a different object. The client rejects all of these locally, before any network call.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { sevdeskPath } from "../../src/sevdesk/paths.js";
import { createFakeClock, createFakeFetch } from "../helpers/fake-fetch.js";

function setup() {
  const fake = createFakeFetch();
  const clock = createFakeClock();
  const client = createSevdeskClient(
    {
      token: "0123456789abcdef0123456789abcdef",
      baseUrl: "https://my.sevdesk.de/api/v1",
      allowedTiers: new Set<Tier>(["read", "write", "commit"]),
      readOnly: false,
      dryRun: false,
      requestsPerSecond: 1000,
      timeoutMs: 1000,
      userAgent: "test",
    },
    { fetch: fake.fetch, sleep: clock.sleep, now: clock.now, monotonicNow: clock.now },
  );
  return { client, fake };
}

const badIds: (string | number)[] = [
  -1,
  0,
  12.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  2 ** 53,
  1e21,
  "12abc",
  "-1",
  "1.5",
  "1e3",
  " 12",
  "9007199254740993",
];

describe("B13: invalid ids never reach sevDesk", () => {
  it.each(badIds)("sevdeskPath rejects the id %j", (id) => {
    expect(() => sevdeskPath("Invoice", id)).toThrow(SevdeskError);
  });

  it.each(badIds)("the client rejects /Invoice/%s before any request", async (id) => {
    const { client, fake } = setup();
    for (const method of ["GET", "DELETE"] as const) {
      await expect(
        client.request({ method, path: `/Invoice/${String(id)}`, tier: "commit" }),
      ).rejects.toMatchObject({ kind: "validation" });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    "/Invoice/../SevUser",
    "/Invoice/1/../../SevUser",
    "/Invoice/",
    "/Invoice//1",
    "/Invoice/1?x=1",
    "/Invoice/1#frag",
    "/Invoice/%2e%2e",
    "Invoice/1",
    "/Invoice/undefined",
  ])("the client rejects the path %j before any request", async (path) => {
    const { client, fake } = setup();
    await expect(
      client.request({ method: "PUT", tier: "write", path, body: {} }),
    ).rejects.toMatchObject({
      kind: "validation",
    });
    await expect(client.list(path)).rejects.toMatchObject({ kind: "validation" });
    expect(fake.requests).toHaveLength(0);
  });

  it("valid ids pass", () => {
    expect(sevdeskPath("Invoice", 12, "getPdf")).toBe("/Invoice/12/getPdf");
    expect(sevdeskPath("Invoice", Number.MAX_SAFE_INTEGER)).toBe("/Invoice/9007199254740991");
  });
});
