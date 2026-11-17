/**
 * The reading POSTs (`src/sevdesk/read-posts.ts`): only `render` without reload of an invoice,
 * order or credit note counts as a read (D-113), in exactly the shape the server builds, and it
 * is still never retried.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../../src/safety/tiers.js";
import { createSevdeskClient } from "../../../src/sevdesk/client.js";
import { isReadingPost, RENDER_WITHOUT_RELOAD } from "../../../src/sevdesk/read-posts.js";
import {
  changesData,
  readOnlyClient,
  tierScopedClient,
} from "../../../src/sevdesk/scoped-client.js";
import type { SevdeskRequest } from "../../../src/sevdesk/types.js";
import { testConfig } from "../../helpers/config.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";
import {
  createFakeClock,
  createFakeFetch,
  envelope,
  type FakeReply,
  sevdeskErrorResponse,
} from "../../helpers/fake-fetch.js";

const render = (path: string, body: unknown = { forceReload: false }): SevdeskRequest => ({
  method: "POST",
  path,
  body,
});

describe("isReadingPost", () => {
  it.each(["/Invoice/1001/render", "/Order/3002/render", "/CreditNote/2001/render"])(
    "counts %s with {forceReload: false} as a read",
    (path) => {
      expect(isReadingPost(render(path))).toBe(true);
      expect(isReadingPost(render(path, RENDER_WITHOUT_RELOAD))).toBe(true);
      expect(changesData(render(path))).toBe(false);
    },
  );

  it.each([
    ["a forced re-render", render("/Invoice/1/render", { forceReload: true })],
    ["no body", { method: "POST", path: "/Invoice/1/render" }],
    ["a null body", render("/Invoice/1/render", null)],
    ["an empty body", render("/Invoice/1/render", {})],
    ["forceReload as 0", render("/Invoice/1/render", { forceReload: 0 })],
    ["forceReload as a string", render("/Invoice/1/render", { forceReload: "false" })],
    ["an extra key", render("/Invoice/1/render", { forceReload: false, key: "language" })],
    ["a list body", render("/Invoice/1/render", [{ forceReload: false }])],
    ["a query", { ...render("/Invoice/1/render"), query: { forceReload: 1 } }],
    ["a form", { method: "POST", path: "/Invoice/1/render", form: new FormData() }],
    ["a PUT", { ...render("/Invoice/1/render"), method: "PUT" }],
    ["changeParameter", render("/Invoice/1/changeParameter")],
    ["sendByWithRender", render("/CreditNote/1/sendByWithRender")],
    ["another casing", render("/invoice/1/render")],
    ["a voucher", render("/Voucher/1/render")],
    ["a letter", render("/Letter/1/render")],
    ["a factory path", render("/Invoice/Factory/render")],
    ["a trailing segment", render("/Invoice/1/render/2")],
    ["an id with a leading zero", render("/Invoice/01/render")],
  ] as const)("keeps %s a write", (_label, request) => {
    expect(isReadingPost(request as SevdeskRequest)).toBe(false);
    expect(changesData(request as SevdeskRequest)).toBe(true);
  });
});

describe("the client and the scoped clients", () => {
  function realClient(config: Parameters<typeof testConfig>[0], ...replies: FakeReply[]) {
    const fake = createFakeFetch(...replies);
    const clock = createFakeClock();
    const client = createSevdeskClient(testConfig(config), {
      fetch: fake.fetch,
      sleep: clock.sleep,
      now: clock.now,
      monotonicNow: clock.now,
      random: () => 0.5,
    });
    return { client, fake };
  }

  it("sends the render read in read-only mode without a tier, body as built", async () => {
    const { client, fake } = realClient(
      { readOnly: true, allowedTiers: new Set<Tier>(["read"]) },
      envelope({ docId: "d", pdf: "JVBERi0=", parameters: [] }),
    );

    await client.request(render("/Order/3002/render", RENDER_WITHOUT_RELOAD));

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe("POST");
    expect(fake.requests[0]?.body).toBe('{"forceReload":false}');
  });

  it("still blocks a forced re-render in read-only mode before sending", async () => {
    const { client, fake } = realClient({ readOnly: true, allowedTiers: new Set<Tier>(["read"]) });

    await expect(
      client.request(render("/Invoice/1001/render", { forceReload: true })),
    ).rejects.toMatchObject({ kind: "blocked" });
    expect(fake.requests).toHaveLength(0);
  });

  it("never retries the render read", async () => {
    const { client, fake } = realClient(
      { readOnly: true, allowedTiers: new Set<Tier>(["read"]) },
      sevdeskErrorResponse(503, "Service Unavailable"),
      envelope({ parameters: [] }),
    );

    await expect(client.request(render("/Invoice/1001/render"))).rejects.toMatchObject({
      kind: "server",
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.pending).toBe(1);
  });

  it("lets the render read through the read-only client of prepare, unstamped by execute's", async () => {
    const fake = new FakeSevdeskClient([
      { method: "POST", path: "/Invoice/1001/render", response: { body: { objects: {} } } },
    ]);

    await readOnlyClient(fake, "preparing a write").request(render("/Invoice/1001/render"));
    await tierScopedClient(fake, "commit").request(render("/Invoice/1001/render"));

    expect(fake.calls.map((call) => call.tier)).toEqual([undefined, undefined]);
    expect(fake.writes()).toEqual([]);
    await expect(
      readOnlyClient(fake, "preparing a write").request(
        render("/Invoice/1001/render", { forceReload: true }),
      ),
    ).rejects.toMatchObject({ kind: "blocked" });
  });
});
