import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  changesData,
  readOnlyClient,
  tierScopedClient,
} from "../../../src/sevdesk/scoped-client.js";
import { type FakeRoute, FakeSevdeskClient } from "../../helpers/fake-client.js";

const ok = { body: { objects: { id: "1" } } };
const routes: FakeRoute[] = [
  { path: "/Invoice/1", response: { body: { objects: [{ id: "1" }] } } },
  { method: "PUT", path: "/Invoice/1/sendBy", response: ok },
  { method: "POST", path: "/Invoice/1/sendViaEmail", response: ok },
  { method: "POST", path: "/Contact", response: ok },
  { path: "/Invoice/1/getPdf", response: ok },
];

async function blocked(run: () => Promise<unknown>): Promise<SevdeskError> {
  const caught: unknown = await run().catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(SevdeskError);
  expect((caught as SevdeskError).kind).toBe("blocked");
  return caught as SevdeskError;
}

describe("changesData", () => {
  it("counts non-GETs and side-effect GETs", () => {
    expect(changesData({ method: "POST", path: "/Contact" })).toBe(true);
    expect(changesData({ method: "GET", path: "/Contact" })).toBe(false);
    expect(changesData({ method: "GET", path: "/Invoice/1/getPdf" })).toBe(false);
    expect(
      changesData({ method: "GET", path: "/Invoice/1/getPdf", query: { preventSendBy: false } }),
    ).toBe(true);
    expect(changesData({ method: "GET", path: "/Invoice/1/sendByWithRender" })).toBe(true);
  });
});

describe("readOnlyClient", () => {
  it("passes list calls through", async () => {
    const fake = new FakeSevdeskClient([{ path: "/Contact", response: { body: { objects: [] } } }]);
    const client = readOnlyClient(fake, "running a dry run");

    await client.list("/Contact");
    await client.listAll("/Contact", undefined, { max: 5 });

    expect(fake.calls.map((call) => call.operation)).toEqual(["list", "list"]);
  });

  it("passes reads through and refuses writes before they reach the client", async () => {
    const fake = new FakeSevdeskClient(routes);
    const client = readOnlyClient(fake, "preparing a write");

    await client.request({ method: "GET", path: "/Invoice/1" });
    const error = await blocked(() =>
      client.request({ method: "POST", path: "/Contact", body: {} }),
    );
    await blocked(() => client.download({ method: "GET", path: "/Invoice/1/sendByWithRender" }));

    expect(error.message).toContain("not allowed while preparing a write. Nothing was sent.");
    expect(fake.writes()).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("tierScopedClient", () => {
  it("stamps the tool's tier on writes only", async () => {
    const fake = new FakeSevdeskClient(routes);
    const client = tierScopedClient(fake, "commit");

    await client.request({ method: "GET", path: "/Invoice/1" });
    await client.request({ method: "PUT", path: "/Invoice/1/sendBy", body: {} });

    expect(fake.calls.map((call) => call.tier)).toEqual([undefined, "commit"]);
  });

  it("refuses a request that declares another tier", async () => {
    const fake = new FakeSevdeskClient(routes);

    const error = await blocked(() =>
      tierScopedClient(fake, "write").request({
        method: "POST",
        path: "/Contact",
        body: {},
        tier: "commit",
      }),
    );

    expect(error.message).toContain("declared the commit tier inside a write tool");
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ["write", "PUT", "/Invoice/1/sendBy", "commit"],
    ["write", "POST", "/Invoice/1/sendViaEmail", "external"],
    ["commit", "POST", "/Invoice/1/sendViaEmail", "external"],
  ] as const)(
    "refuses a %s tool calling %s %s (needs %s)",
    async (tier, method, path, required) => {
      const fake = new FakeSevdeskClient(routes);

      const error = await blocked(() =>
        tierScopedClient(fake, tier).request({ method, path, body: {} }),
      );

      expect(error.message).toBe(
        `Blocked before sending: ${method} ${path} needs at least the ${required} tier, but it ` +
          `was called from a ${tier} tool. Nothing was sent.`,
      );
      expect(fake.calls).toEqual([]);
    },
  );

  it("lets higher tiers reach lower endpoints", async () => {
    const fake = new FakeSevdeskClient(routes);

    await tierScopedClient(fake, "external").request({
      method: "PUT",
      path: "/Invoice/1/sendBy",
      body: {},
    });
    await tierScopedClient(fake, "commit").request({ method: "POST", path: "/Contact", body: {} });

    expect(fake.writes().map((call) => call.tier)).toEqual(["external", "commit"]);
  });

  it("checks downloads the same way and passes list calls through", async () => {
    const fake = new FakeSevdeskClient([
      ...routes,
      { path: "/Contact", response: { body: { objects: [] } } },
    ]);
    const client = tierScopedClient(fake, "write");

    await blocked(() =>
      client.download({ method: "GET", path: "/Invoice/1/getPdf", sideEffect: true }),
    );
    await client.list("/Contact");
    await client.listAll("/Contact", undefined, { max: 10 });

    expect(fake.writes()).toEqual([]);
  });
});
