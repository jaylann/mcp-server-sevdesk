import { describe, expect, it } from "vitest";

import {
  customerVatIdOf,
  loadPartyDirectory,
  locate,
  vatIdArea,
} from "../../../../../src/domain/reports/audit/parties.js";
import { SevdeskError } from "../../../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../../../helpers/fake-client.js";
import { CONTACTS, COUNTRY, directoryRoutes } from "./scenario.js";

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
    // Greek numbers start with EL; a GR prefix is in the wrong format, but still Greece.
    ["GR123456789", "eu"],
    // Where a party is established, the prefix decides, in its state's format or not.
    ["FR123", "eu"],
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

describe("customerVatIdOf", () => {
  it.each([
    [undefined, "none"],
    ["DE123456789", "germany"],
    ["FR12345678901", "eu"],
    ["EL123456789", "eu"],
    ["IE1234567T", "eu"],
    ["NL123456789B01", "eu"],
    ["XI123456789", "northern_ireland"],
    // The format of the issuing state decides, as in the tax-rule helper.
    ["FR123", "wrong_format"],
    ["ATU1", "wrong_format"],
    ["DE12345", "wrong_format"],
    ["GR123456789", "wrong_format"],
    ["FR123456789012345678", "wrong_format"],
    // The EX suffix of the EU small-business scheme is checked apart from the number.
    ["ATU12345678EX", "eu"],
    ["ATU1EX", "wrong_format"],
    ["CHE123456789MWST", "non_eu"],
    ["GB123456789", "non_eu"],
    ["EU372000041", "non_eu"],
    ["KEINE", "unreadable"],
    ["1234567890", "unreadable"],
  ])("reads %s as %s", (vatId, state) => {
    expect(customerVatIdOf(vatId)).toBe(state);
  });
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

  it("counts Monaco as France, inside the EU", () => {
    expect(locate({ vatId: undefined, countries: ["MC"] })).toMatchObject({
      germany: false,
      abroad: true,
      area: "eu",
    });
    expect(locate({ vatId: undefined, countries: ["MC", "FR"] }).area).toBe("eu");
    expect(locate({ vatId: undefined, countries: ["MC", "CH"] }).area).toBeUndefined();
  });

  it("places a supplier with a GR-prefixed VAT id in the EU, never outside it", () => {
    expect(locate({ vatId: "GR123456789", countries: [] })).toMatchObject({
      abroad: true,
      area: "eu",
    });
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

  it("reads the country table for the documents' own countries without any address", async () => {
    const client = new FakeSevdeskClient(
      directoryRoutes([{ id: 1, name: "Ohne Adresse", countries: [] }]),
    );
    const directory = await loadPartyDirectory(client, {
      cacheOwner: {},
      documentsHaveCountries: true,
    });

    expect(client.callsTo("/StaticCountry")).toHaveLength(1);
    expect(directory.countryCodes.get(COUNTRY.FR)).toBe("FR");
    expect(directory.countriesUnread).toBe(false);
  });
});
