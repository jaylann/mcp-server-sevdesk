import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SETTINGS_TTL_MS,
  clearAccountSettingsCache,
  fetchAccountSettings,
  loadAccountSettings,
  taxRegimeOf,
} from "../../../src/domain/account-settings.js";
import { SevdeskError, type SevdeskErrorKind } from "../../../src/sevdesk/errors.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../helpers/fake-client.js";

const regular: FakeRoute = { path: "/SevClient", response: { fixture: "drafts/sev-client.json" } };
const smallBusiness: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client-small-business.json" },
};

function body(objects: unknown): FakeRoute {
  return { path: "/SevClient", response: { body: { objects } } };
}

function failing(kind: SevdeskErrorKind, status?: number): FakeRoute {
  return {
    path: "/SevClient",
    response: {
      error: new SevdeskError({
        kind,
        message: "sevDesk failed.",
        ...(status === undefined ? {} : { status }),
      }),
    },
  };
}

const recorded = (
  loadFixture("drafts/sev-client.json").body as { objects: Record<string, unknown>[] }
).objects[0];

describe("fetchAccountSettings (GET /SevClient, undocumented)", () => {
  it("reads the regime and the chart of accounts of a regular VAT account", async () => {
    const client = new FakeSevdeskClient([regular]);
    await expect(fetchAccountSettings(client)).resolves.toEqual({
      smallBusiness: false,
      chartOfAccounts: "skr04",
    });
    expect(client.calls).toMatchObject([{ method: "GET", path: "/SevClient", sideEffect: false }]);
  });

  it("recognizes a Kleinunternehmer account (smallSettlement 1)", async () => {
    await expect(
      fetchAccountSettings(new FakeSevdeskClient([smallBusiness])),
    ).resolves.toMatchObject({ smallBusiness: true });
  });

  it("takes a single object as well as the first row of a list, and lenient scalars", async () => {
    await expect(
      fetchAccountSettings(
        new FakeSevdeskClient([body({ smallSettlement: 1, chartOfAccounts: " SKR03 " })]),
      ),
    ).resolves.toEqual({ smallBusiness: true, chartOfAccounts: "skr03" });
    await expect(
      fetchAccountSettings(
        new FakeSevdeskClient([body([{ ...recorded, smallSettlement: false }, { x: 1 }])]),
      ),
    ).resolves.toMatchObject({ smallBusiness: false });
  });

  it("leaves out a missing or odd chart of accounts", async () => {
    await expect(
      fetchAccountSettings(
        new FakeSevdeskClient([body([{ smallSettlement: "0", chartOfAccounts: null }])]),
      ),
    ).resolves.toEqual({ smallBusiness: false });
    await expect(
      fetchAccountSettings(
        new FakeSevdeskClient([body([{ smallSettlement: "0", chartOfAccounts: "<b>skr</b>" }])]),
      ),
    ).resolves.toEqual({ smallBusiness: false });
  });

  it.each([
    ["no object", []],
    ["a scalar", "1"],
    ["no smallSettlement", [{ chartOfAccounts: "skr04" }]],
    ["an unreadable smallSettlement", [{ smallSettlement: "2" }]],
  ])("refuses %s as unexpected_response", async (_label, objects) => {
    const error: unknown = await fetchAccountSettings(new FakeSevdeskClient([body(objects)])).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("unexpected_response");
  });
});

describe("loadAccountSettings (cached per owner)", () => {
  it("reads once per owner within the TTL and again after it", async () => {
    const client = new FakeSevdeskClient([regular]);
    const owner = {};
    let now = 1_000;
    const options = { cacheOwner: owner, now: () => now };

    await loadAccountSettings(client, options);
    await loadAccountSettings(client, options);
    expect(client.calls).toHaveLength(1);

    now += ACCOUNT_SETTINGS_TTL_MS;
    await loadAccountSettings(client, options);
    expect(client.calls).toHaveLength(2);

    await loadAccountSettings(client, { cacheOwner: {}, now: () => now });
    expect(client.calls).toHaveLength(3);
  });

  it("reads again with fresh and caches the new value", async () => {
    const owner = {};
    await loadAccountSettings(new FakeSevdeskClient([regular]), { cacheOwner: owner });
    const switched = new FakeSevdeskClient([smallBusiness]);
    await expect(
      loadAccountSettings(switched, { cacheOwner: owner, fresh: true }),
    ).resolves.toMatchObject({ smallBusiness: true });
    await expect(loadAccountSettings(switched, { cacheOwner: owner })).resolves.toMatchObject({
      smallBusiness: true,
    });
    expect(switched.calls).toHaveLength(1);
  });

  it("forgets an owner's settings when cleared", async () => {
    const client = new FakeSevdeskClient([regular]);
    const owner = {};
    await loadAccountSettings(client, { cacheOwner: owner });
    clearAccountSettingsCache(owner);
    await loadAccountSettings(client, { cacheOwner: owner });
    expect(client.calls).toHaveLength(2);
  });

  it.each(["not_found", "validation", "server", "unexpected_response"] as const)(
    "returns undefined (and caches nothing) when sevDesk answers %s",
    async (kind) => {
      const client = new FakeSevdeskClient([failing(kind)]);
      const owner = {};
      await expect(loadAccountSettings(client, { cacheOwner: owner })).resolves.toBeUndefined();
      await loadAccountSettings(client, { cacheOwner: owner });
      expect(client.calls).toHaveLength(2);
    },
  );

  it("falls back on a 403: a restricted user may be refused the account settings", async () => {
    const client = new FakeSevdeskClient([failing("auth", 403)]);
    await expect(loadAccountSettings(client, { cacheOwner: {} })).resolves.toBeUndefined();
  });

  it("rethrows a 401: the token itself is wrong", async () => {
    await expect(
      loadAccountSettings(new FakeSevdeskClient([failing("auth", 401)]), { cacheOwner: {} }),
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it.each(["auth", "rate_limited", "network", "timeout", "aborted"] as const)(
    "rethrows %s, which would break any other read too",
    async (kind) => {
      await expect(
        loadAccountSettings(new FakeSevdeskClient([failing(kind)]), { cacheOwner: {} }),
      ).rejects.toMatchObject({ kind });
    },
  );

  it("rethrows errors that are not sevDesk errors", async () => {
    await expect(
      loadAccountSettings(new FakeSevdeskClient([]), { cacheOwner: {} }),
    ).rejects.toThrow(/no route/);
  });
});

describe("taxRegimeOf", () => {
  it("maps settings to the regime names of the tax rules", () => {
    expect(taxRegimeOf({ smallBusiness: true })).toBe("small_business");
    expect(taxRegimeOf({ smallBusiness: false, chartOfAccounts: "skr04" })).toBe("regular");
    expect(taxRegimeOf(undefined)).toBeUndefined();
  });
});
