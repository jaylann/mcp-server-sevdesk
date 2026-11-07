import { describe, expect, it } from "vitest";

import type { ContactDetails } from "../../../../src/domain/contacts.js";
import { resolveCurrency, resolveDeliveryPeriod } from "../../../../src/domain/drafts/fields.js";
import {
  addressLines,
  addressPreview,
  loadContact,
  mergeAddress,
  resolveAddress,
  resolveContactPerson,
} from "../../../../src/domain/drafts/recipient.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";

const countries = [
  { id: 1, code: "de", name: "Deutschland" },
  { id: 2, code: "at", name: "Österreich" },
];

function contact(addresses: ContactDetails["addresses"]): ContactDetails {
  return {
    contact: { id: 1001, kind: "organisation", displayName: "Musterfirma GmbH" },
    addresses,
    addressesComplete: true,
    communicationWays: [],
    communicationWaysComplete: true,
  };
}

describe("draft recipient: address", () => {
  it("prefers the invoice address (category 47) over the first one", () => {
    const address = resolveAddress(
      contact([
        { id: 3002, street: "Lagerweg 5", city: "Musterstadt", countryId: 2, category: { id: 48 } },
        {
          id: 3001,
          recipient: "Musterfirma GmbH\nBuchhaltung",
          street: "Musterstraße 1",
          zip: "12345",
          city: "Musterstadt",
          countryId: 1,
          category: { id: 47 },
        },
      ]),
      {},
      countries,
    );
    expect(address).toEqual({
      name: "Musterfirma GmbH, Buchhaltung",
      street: "Musterstraße 1",
      zip: "12345",
      city: "Musterstadt",
      countryId: 1,
      countryCode: "de",
      countryName: "Deutschland",
    });
    expect(addressLines(address)).toEqual([
      "Musterfirma GmbH, Buchhaltung",
      "Musterstraße 1",
      "12345 Musterstadt",
    ]);
  });

  it("falls back to the first address, the contact's name and Germany", () => {
    const address = resolveAddress(contact([{ id: 3002, city: "Wien" }]), {}, countries);
    expect(address).toMatchObject({ name: "Musterfirma GmbH", city: "Wien", countryId: 1 });
    expect(addressLines(address)).toEqual(["Musterfirma GmbH", "Wien"]);
  });

  it("shows a foreign or unknown country as the last line", () => {
    const abroad = resolveAddress(
      contact([{ id: 1, street: "Ring 1", zip: "1010", city: "Wien", countryId: 2 }]),
      {},
      countries,
    );
    expect(addressLines(abroad)).toEqual(["Musterfirma GmbH", "Ring 1", "1010 Wien", "Österreich"]);
    const unknown = resolveAddress(contact([{ id: 1, countryId: 99 }]), {}, countries);
    expect(addressLines(unknown)).toEqual(["Musterfirma GmbH", "StaticCountry 99"]);
  });

  it("merges given parts over the contact's address and keeps the rest", () => {
    const base = contact([
      {
        id: 1,
        recipient: "Musterfirma GmbH",
        street: "Ring 1",
        zip: "1010",
        city: "Wien",
        countryId: 2,
      },
    ]);
    expect(resolveAddress(base, { addressStreet: "Ring 2" }, countries)).toEqual({
      name: "Musterfirma GmbH",
      street: "Ring 2",
      zip: "1010",
      city: "Wien",
      countryId: 2,
      countryCode: "at",
      countryName: "Österreich",
    });
    expect(resolveAddress(base, { addressCountry: "DE" }, countries)).toMatchObject({
      street: "Ring 1",
      countryId: 1,
    });
  });

  it("builds an address from the call when the contact has none", () => {
    expect(
      resolveAddress(contact([]), { addressCity: "Bern", addressCountry: "AT" }, countries),
    ).toMatchObject({ name: "Musterfirma GmbH", city: "Bern", countryId: 2 });
    expect(() => resolveAddress(contact([]), { addressStreet: "Ring 1" }, countries)).toThrow(
      "Contact 1001 has no address to complete. Give at least addressCity, with addressStreet " +
        "and addressZip.",
    );
  });

  it("replaces a free-text address only as a whole and keeps its country", () => {
    const base = { kind: "text", countryId: 2 } as const;
    expect(() => mergeAddress(base, { addressZip: "1020" }, contact([]), countries)).toThrow(
      "The stored address of this draft is free text, so single parts of it cannot be changed.",
    );
    expect(
      mergeAddress(
        base,
        { addressName: "A", addressStreet: "B", addressZip: "1", addressCity: "C" },
        contact([]),
        countries,
      ),
    ).toMatchObject({ name: "A", street: "B", zip: "1", city: "C", countryId: 2 });
  });

  it("always names the country in previews", () => {
    const address = resolveAddress(
      contact([{ id: 1, city: "Berlin", countryId: 1 }]),
      {},
      countries,
    );
    expect(addressLines(address)).toEqual(["Musterfirma GmbH", "Berlin"]);
    expect(addressPreview(address)).toBe("Musterfirma GmbH, Berlin, Deutschland");
  });
});

describe("draft recipient: contact and contact person (B3)", () => {
  it("passes on errors other than not found", async () => {
    const failing = new FakeSevdeskClient([
      {
        path: "/Contact/1001",
        response: { error: new SevdeskError({ kind: "server", message: "sevDesk failed." }) },
      },
    ]);
    await expect(loadContact(failing, 1001)).rejects.toMatchObject({ kind: "server" });
  });

  it("explains an account without users", async () => {
    const client = new FakeSevdeskClient([
      { path: "/SevUser", response: { body: { objects: [] } } },
    ]);
    await expect(resolveContactPerson(client, undefined)).rejects.toMatchObject({
      kind: "validation",
      message:
        "sevDesk returned no users, but a document needs a contact person (Ansprechpartner, a " +
        "sevDesk user). Check the account's users in sevDesk.",
    });
  });

  it("uses the requested user among several", async () => {
    const client = new FakeSevdeskClient([
      { path: "/SevUser", response: { fixture: "meta/sev-users.json" } },
    ]);
    await expect(resolveContactPerson(client, 2002)).resolves.toEqual({
      id: 2002,
      name: "Max Mustermann",
    });
  });
});

describe("draft fields", () => {
  it("normalizes currencies and allows late delivery dates where sevDesk does", () => {
    expect(resolveCurrency("chf")).toBe("CHF");
    expect(resolveCurrency(undefined)).toBe("EUR");
    expect(resolveDeliveryPeriod("2026-11-07", "2026-11-30", undefined, false)).toEqual({
      from: "2026-11-30",
    });
    expect(resolveDeliveryPeriod("2026-11-07", undefined, "2026-11-30", true)).toEqual({
      from: "2026-11-07",
      until: "2026-11-30",
    });
  });
});
