import { describe, expect, it } from "vitest";

import {
  loadPartyDirectory,
  locate,
  vatIdArea,
} from "../../../../../src/domain/reports/audit/parties.js";
import { SevdeskError } from "../../../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../../../helpers/fake-client.js";
import { CONTACTS, directoryRoutes } from "./scenario.js";

describe("vatIdArea", () => {
  it.each([
    ["DE123456789", "germany"],
    ["ATU12345678", "eu"],
    ["EL123456789", "eu"],
    ["IE1234567T", "eu"],
    ["XI123456789", "northern_ireland"],
    ["EU372000041", "non_eu"],
    ["CHE123456789MWST", "non_eu"],
    ["GB123456789", "non_eu"],
  ])("places %s in %s", (vatId, area) => {
    expect(vatIdArea(vatId)).toBe(area);
  });

  it.each([undefined, "KEINE", "1234567890", "N/A", "DE"])(
    "does not read %s as a VAT id",
    (vatId) => {
      expect(vatIdArea(vatId)).toBeUndefined();
    },
  );
});

describe("locate", () => {
  it("tells Germany, abroad and the area apart", () => {
    expect(locate({ vatId: "DE123456789", countries: [] })).toMatchObject({
      germany: true,
      abroad: false,
    });
    expect(locate({ vatId: undefined, countries: ["DE"] })).toMatchObject({
      germany: true,
      abroad: false,
    });
    expect(locate({ vatId: "IE1234567T", countries: [] })).toMatchObject({
      germany: false,
      abroad: true,
      area: "eu",
    });
    expect(locate({ vatId: undefined, countries: ["US"] })).toMatchObject({
      abroad: true,
      area: "non_eu",
    });
    expect(locate({ vatId: undefined, countries: [] })).toMatchObject({
      germany: false,
      abroad: false,
      area: undefined,
    });
  });

  it("prefers the VAT id's area over the addresses and leaves mixed addresses open", () => {
    expect(locate({ vatId: "EU372000041", countries: ["IE"] }).area).toBe("non_eu");
    expect(locate({ vatId: undefined, countries: ["AT", "CH"] }).area).toBeUndefined();
  });

  it("sees German and foreign data at once", () => {
    expect(locate({ vatId: "NL123456789B01", countries: ["NL", "DE"] })).toMatchObject({
      germany: true,
      abroad: true,
    });
    expect(locate({ vatId: "DE999999999", countries: ["LU"] })).toMatchObject({
      germany: true,
      abroad: true,
    });
  });

  it("recognizes the EU small-business scheme by the EX suffix", () => {
    expect(locate({ vatId: "ATU12345678EX", countries: [] }).smallBusinessScheme).toBe(true);
    expect(locate({ vatId: "ATU12345678", countries: [] }).smallBusinessScheme).toBe(false);
  });
});

describe("loadPartyDirectory", () => {
  it("reads the contact and address lists once and resolves the countries", async () => {
    const client = new FakeSevdeskClient(directoryRoutes());
    const directory = await loadPartyDirectory(client, { cacheOwner: {} });

    expect(directory.parties.get(CONTACTS.germanBranch.id)).toEqual({
      id: CONTACTS.germanBranch.id,
      name: "Logistics B.V.",
      vatId: "NL123456789B01",
      countries: ["DE", "NL"],
    });
    expect(directory.parties.get(CONTACTS.swiss.id)?.vatId).toBe("CHE123456789MWST");
    expect(directory.parties.get(CONTACTS.unknown.id)?.countries).toEqual([]);
    expect(directory.coverage).toEqual({ read: 11, addressesRead: 11, truncated: false });
    expect(directory.countriesUnread).toBe(false);
    expect(client.callsTo("/Contact")[0]?.query).toMatchObject({ depth: "1", limit: 1000 });
    expect(client.callsTo("/ContactAddress")[0]?.query).toEqual({
      limit: 1000,
      offset: 0,
      countAll: true,
    });
    expect(client.writes()).toEqual([]);
  });

  it("pages the lists up to its cap and says when it stopped", async () => {
    const client = new FakeSevdeskClient(directoryRoutes());
    const directory = await loadPartyDirectory(client, { cacheOwner: {}, maxRows: 4 });

    expect(directory.coverage.truncated).toBe(true);
    expect(directory.parties.size).toBe(4);
  });

  it("marks contacts whose address countries cannot be resolved", async () => {
    const routes = directoryRoutes().filter((route) => route.path !== "/StaticCountry");
    const client = new FakeSevdeskClient([
      ...routes,
      {
        path: "/StaticCountry",
        response: { error: new SevdeskError({ kind: "server", message: "Simulated." }) },
      },
    ]);
    const directory = await loadPartyDirectory(client, { cacheOwner: {} });

    expect(directory.countriesUnread).toBe(true);
    expect(directory.parties.get(CONTACTS.austrianHotel.id)).toMatchObject({
      countries: [],
      countriesUnknown: true,
    });
    expect(directory.parties.get(CONTACTS.unknown.id)?.countriesUnknown).toBeUndefined();
  });

  it("does not read the country table when no address has a country", async () => {
    const client = new FakeSevdeskClient(
      directoryRoutes([{ id: 1, name: "Ohne Adresse", countries: [] }]),
    );
    await loadPartyDirectory(client, { cacheOwner: {} });
    expect(client.callsTo("/StaticCountry")).toEqual([]);
  });
});
