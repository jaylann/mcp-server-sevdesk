import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SETTINGS_TTL_MS,
  clearAccountSettingsCache,
  fetchAccountSettings,
  loadAccountCompany,
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

describe("loadAccountCompany (same GET /SevClient, same cache)", () => {
  it("reads the company fields of the recorded fixture", async () => {
    await expect(
      loadAccountCompany(new FakeSevdeskClient([regular]), { cacheOwner: {} }),
    ).resolves.toEqual({
      name: "Musterfirma GmbH",
      email: "buchhaltung@example.com",
      countryId: 1,
    });
  });

  it("maps every recorded company key, cleans text and compacts the IBAN", async () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const client = new FakeSevdeskClient([
      body([
        {
          ...recorded,
          name: ` Musterfirma${zeroWidth} GmbH `,
          vatNumber: "DE000000000",
          taxNumber: "00/000/00000",
          addressStreet: "Musterstraße 1",
          addressZip: 10115,
          addressCity: "Berlin",
          addressCountry: { id: "1", objectName: "StaticCountry" },
          bankIban: "de00 0000 0000 0000 0000 00",
          bankBic: "TESTDEFFXXX",
          contactEmail: "buchhaltung@example.com",
          contactPhone: "+49 30 0000000",
        },
      ]),
    ]);
    await expect(loadAccountCompany(client, { cacheOwner: {} })).resolves.toEqual({
      name: "Musterfirma GmbH",
      vatNumber: "DE000000000",
      taxNumber: "00/000/00000",
      street: "Musterstraße 1",
      zip: "10115",
      city: "Berlin",
      countryId: 1,
      iban: "DE00000000000000000000",
      bic: "TESTDEFFXXX",
      email: "buchhaltung@example.com",
      phone: "+49 30 0000000",
    });
  });

  it("drops unreadable company values instead of failing", async () => {
    const client = new FakeSevdeskClient([
      body([
        {
          smallSettlement: "0",
          name: { nested: true },
          vatNumber: ["DE000000000"],
          addressCountry: "1",
          bankIban: "   ",
          contactEmail: "",
        },
      ]),
    ]);
    await expect(loadAccountCompany(client, { cacheOwner: {} })).resolves.toEqual({});
    await expect(
      loadAccountSettings(new FakeSevdeskClient([body([{ smallSettlement: "0", name: 1 }])]), {
        cacheOwner: {},
      }),
    ).resolves.toEqual({ smallBusiness: false });
  });

  it("shares one read with loadAccountSettings", async () => {
    const client = new FakeSevdeskClient([regular]);
    const owner = {};
    await loadAccountSettings(client, { cacheOwner: owner });
    await expect(loadAccountCompany(client, { cacheOwner: owner })).resolves.toMatchObject({
      name: "Musterfirma GmbH",
    });
    expect(client.calls).toHaveLength(1);
  });

  it("returns undefined exactly when the settings are unreadable", async () => {
    await expect(
      loadAccountCompany(new FakeSevdeskClient([failing("not_found")]), { cacheOwner: {} }),
    ).resolves.toBeUndefined();
    await expect(
      loadAccountCompany(new FakeSevdeskClient([body([{ name: "Musterfirma GmbH" }])]), {
        cacheOwner: {},
      }),
    ).resolves.toBeUndefined();
  });
});

describe("taxRegimeOf", () => {
  it("maps settings to the regime names of the tax rules", () => {
    expect(taxRegimeOf({ smallBusiness: true })).toBe("small_business");
    expect(taxRegimeOf({ smallBusiness: false, chartOfAccounts: "skr04" })).toBe("regular");
    expect(taxRegimeOf(undefined)).toBeUndefined();
  });
});
