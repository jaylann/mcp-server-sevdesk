import { describe, expect, it, vi } from "vitest";

import { loadCountryCodes, withDocumentCountry } from "../../../src/domain/country-codes.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { readOnlyClient, tierScopedClient } from "../../../src/sevdesk/scoped-client.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";

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
  it("reuses successful reads with the client as the default owner", async () => {
    const client = countriesClient();
    const first = await loadCountryCodes(client);
    expect(await loadCountryCodes(client)).toBe(first);
    expect(first.get(42)).toBe("AT");
    expect(client.callsTo("/StaticCountry")).toHaveLength(1);
  });

  it("shares the owner's cached table across prepare and execute client wrappers", async () => {
    const client = countriesClient();
    const cacheOwner = {};
    const first = await loadCountryCodes(readOnlyClient(client, "preparing a write"), undefined, {
      cacheOwner,
    });
    expect(
      await loadCountryCodes(tierScopedClient(client, "commit"), undefined, { cacheOwner }),
    ).toBe(first);
    expect(client.callsTo("/StaticCountry")).toHaveLength(1);
  });

  it("expires at 15 minutes without extending the TTL on a hit", async () => {
    const client = countriesClient();
    let time = 100;
    const options = { now: () => time };
    const first = await loadCountryCodes(client, undefined, options);
    time += 15 * 60_000 - 1;
    expect(await loadCountryCodes(client, undefined, options)).toBe(first);
    time += 1;
    expect(await loadCountryCodes(client, undefined, options)).toEqual(first);
    expect(client.callsTo("/StaticCountry")).toHaveLength(2);
  });

  it("keeps separate owners isolated even on the same client", async () => {
    const client = countriesClient();
    const firstOwner = {};
    const secondOwner = {};
    await loadCountryCodes(client, undefined, { cacheOwner: firstOwner });
    await loadCountryCodes(client, undefined, { cacheOwner: secondOwner });
    await loadCountryCodes(client, undefined, { cacheOwner: firstOwner });
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
    expect(await loadCountryCodes(client)).toEqual(new Map());
    expect(await loadCountryCodes(client)).toEqual(new Map());
    expect(client.callsTo("/StaticCountry")).toHaveLength(2);
    const healthy = countriesClient();
    const recovered = await loadCountryCodes(healthy, undefined, { cacheOwner: client });
    expect(recovered.get(42)).toBe("AT");
    expect(await loadCountryCodes(client)).toBe(recovered);
    expect(client.callsTo("/StaticCountry")).toHaveLength(2);
  });

  it("caches a successful empty table", async () => {
    const client = new FakeSevdeskClient([
      { path: "/StaticCountry", response: { body: { objects: [] } } },
    ]);
    expect(await loadCountryCodes(client)).toEqual(new Map());
    expect(await loadCountryCodes(client)).toEqual(new Map());
    expect(client.callsTo("/StaticCountry")).toHaveLength(1);
  });

  it("resolves the id from the actual table, normalizes case and preserves the address", async () => {
    const client = countriesClient();
    expect(
      await withDocumentCountry({ address: { text: "Address", countryId: 42 } }, client),
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
      expect(await withDocumentCountry(doc, client)).toEqual(doc);
      expect(client.calls).toHaveLength(1);
    },
  );

  it("does not load countries for absent country references or create an address", async () => {
    const client = new FakeSevdeskClient([]);
    expect(await withDocumentCountry({ address: undefined }, client)).toEqual({
      address: undefined,
    });
    expect(
      await withDocumentCountry({ address: { text: "Address", countryId: undefined } }, client),
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
    expect(await withDocumentCountry({ address: { countryId: 42 } }, client)).toEqual({
      address: { countryId: 42 },
    });
  });

  it("propagates cancellation and programming errors", async () => {
    const client = countriesClient();
    const controller = new AbortController();
    controller.abort();
    await expect(loadCountryCodes(client, controller.signal)).rejects.toMatchObject({
      kind: "aborted",
    });
    const error = new Error("Programming error");
    vi.spyOn(client, "list").mockRejectedValue(error);
    await expect(loadCountryCodes(client)).rejects.toBe(error);
  });
});
