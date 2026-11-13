import { describe, expect, it, vi } from "vitest";

import { loadCountryCodes, withDocumentCountry } from "../../../src/domain/country-codes.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { readOnlyClient, tierScopedClient } from "../../../src/sevdesk/scoped-client.js";
import { type FakeRoute, FakeSevdeskClient } from "../../helpers/fake-client.js";

function countriesClient() {
  return new FakeSevdeskClient([
    {
      path: "/StaticCountry",
      response: {
        body: {
          objects: [
            { id: 42, code: " at ", name: "Austria" },
            { id: 43, code: "", name: "Missing" },
            { id: 44, code: "invalid", name: "Invalid" },
            { id: 45, name: "Unset" },
          ],
        },
      },
    },
  ]);
}

describe("country codes from the input country table", () => {
  it("reuses successful reads for an explicit owner", async () => {
    const client = countriesClient();
    const first = await loadCountryCodes(client, { cacheOwner: client });
    expect(await loadCountryCodes(client, { cacheOwner: client })).toBe(first);
    expect(first.get(42)).toBe("AT");
    expect(client.callsTo("/StaticCountry")).toHaveLength(1);
  });

  it("shares the owner's cached table across prepare and execute client wrappers", async () => {
    const client = countriesClient();
    const cacheOwner = {};
    const first = await loadCountryCodes(readOnlyClient(client, "preparing a write"), {
      cacheOwner,
    });
    expect(await loadCountryCodes(tierScopedClient(client, "commit"), { cacheOwner })).toBe(first);
    expect(client.callsTo("/StaticCountry")).toHaveLength(1);
  });

  it("expires at 15 minutes without extending the TTL on a hit", async () => {
    const client = countriesClient();
    let time = 100;
    const options = { now: () => time };
    const first = await loadCountryCodes(client, { ...options, cacheOwner: client });
    time += 15 * 60_000 - 1;
    expect(await loadCountryCodes(client, { ...options, cacheOwner: client })).toBe(first);
    time += 1;
    expect(await loadCountryCodes(client, { ...options, cacheOwner: client })).toEqual(first);
    expect(client.callsTo("/StaticCountry")).toHaveLength(2);
  });

  it("keeps separate owners isolated even on the same client", async () => {
    const client = countriesClient();
    const firstOwner = {};
    const secondOwner = {};
    await loadCountryCodes(client, { cacheOwner: firstOwner });
    await loadCountryCodes(client, { cacheOwner: secondOwner });
    await loadCountryCodes(client, { cacheOwner: firstOwner });
    expect(client.callsTo("/StaticCountry")).toHaveLength(2);
  });

  it("retries failed lookups instead of caching the empty fallback", async () => {
    const routes = [
      {
        path: "/StaticCountry",
        response: { error: new SevdeskError({ kind: "server", message: "Unavailable" }) },
      },
    ];
    const client = new FakeSevdeskClient(routes);
    expect(await loadCountryCodes(client, { cacheOwner: client })).toEqual(new Map());
    expect(await loadCountryCodes(client, { cacheOwner: client })).toEqual(new Map());
    expect(client.callsTo("/StaticCountry")).toHaveLength(2);
    const healthy = countriesClient();
    const recovered = await loadCountryCodes(healthy, { cacheOwner: client });
    expect(recovered.get(42)).toBe("AT");
    expect(await loadCountryCodes(client, { cacheOwner: client })).toBe(recovered);
    expect(client.callsTo("/StaticCountry")).toHaveLength(2);
  });

  it.each([
    { name: "empty", rows: [] },
    {
      name: "unusable",
      rows: [{ id: 42, code: "" }, { id: 43, code: "invalid" }, { id: 44 }],
    },
  ])("retries a successful $name table and caches its recovery", async ({ rows }) => {
    const routes: FakeRoute[] = [{ path: "/StaticCountry", response: { body: { objects: rows } } }];
    const client = new FakeSevdeskClient(routes);
    const options = { cacheOwner: {} };
    expect(await loadCountryCodes(client, options)).toEqual(new Map());
    expect(await loadCountryCodes(client, options)).toEqual(new Map());
    expect(client.callsTo("/StaticCountry")).toHaveLength(2);
    routes[0] = {
      path: "/StaticCountry",
      response: { body: { objects: [{ id: 42, code: "at" }] } },
    };
    const recovered = await loadCountryCodes(client, options);
    expect(recovered.get(42)).toBe("AT");
    expect(await loadCountryCodes(client, options)).toBe(recovered);
    expect(client.callsTo("/StaticCountry")).toHaveLength(3);
  });

  it("resolves the id from the actual table, normalizes case and preserves the address", async () => {
    const client = countriesClient();
    expect(
      await withDocumentCountry({ address: { text: "Address", countryId: 42 } }, client, {
        cacheOwner: client,
      }),
    ).toEqual({ address: { text: "Address", countryId: 42, country: "AT" } });
    expect(client.calls[0]).toMatchObject({
      method: "GET",
      path: "/StaticCountry",
      query: { limit: 1000 },
    });
    expect(client.writes()).toEqual([]);
  });

  it.each([0, 1, 43, 44, 45, 9999])(
    "does not guess an unresolved country for id %s",
    async (countryId) => {
      const client = countriesClient();
      const doc = { address: { countryId } };
      expect(await withDocumentCountry(doc, client, { cacheOwner: client })).toEqual(doc);
      expect(client.calls).toHaveLength(1);
    },
  );

  it("does not load countries for absent country references or create an address", async () => {
    const client = new FakeSevdeskClient([]);
    expect(
      await withDocumentCountry({ address: undefined }, client, { cacheOwner: client }),
    ).toEqual({
      address: undefined,
    });
    expect(
      await withDocumentCountry({ address: { text: "Address", countryId: undefined } }, client, {
        cacheOwner: client,
      }),
    ).toEqual({ address: { text: "Address" } });
    expect(client.calls).toEqual([]);
  });

  it("keeps the id when the optional lookup fails", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/StaticCountry",
        response: { error: new SevdeskError({ kind: "server", message: "Unavailable" }) },
      },
    ]);
    expect(
      await withDocumentCountry({ address: { countryId: 42 } }, client, { cacheOwner: client }),
    ).toEqual({
      address: { countryId: 42 },
    });
  });

  it("propagates cancellation and programming errors", async () => {
    const client = countriesClient();
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadCountryCodes(client, { cacheOwner: client, signal: controller.signal }),
    ).rejects.toMatchObject({
      kind: "aborted",
    });
    const error = new Error("Programming error");
    vi.spyOn(client, "list").mockRejectedValue(error);
    await expect(loadCountryCodes(client, { cacheOwner: client })).rejects.toBe(error);
  });
});
