import { describe, expect, it } from "vitest";

import {
  contactKind,
  getNextCustomerNumber,
  parseContactRecord,
  toContactDto,
} from "../../../src/domain/contacts.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { FakeSevdeskClient, loadFixture } from "../../helpers/fake-client.js";

/** The first object of a fixture's `objects` array. */
function firstObject(fixture: string): unknown {
  const body = loadFixture(fixture).body as { objects: unknown[] };
  return body.objects[0];
}

function dtoOf(raw: unknown) {
  return toContactDto(parseContactRecord(raw));
}

describe("contact mapping (community: recorded Contact shape, fake data)", () => {
  it("maps an organisation with string scalars", () => {
    expect(dtoOf(firstObject("contacts/contact-1001.json"))).toEqual({
      id: 1001,
      kind: "organisation",
      displayName: "Musterfirma GmbH",
      customerNumber: "K-1001",
      category: { id: 3, key: "customer", name: "Kunde" },
      vatNumber: "DE000000000",
      taxNumber: "000/000/00000",
      governmentAgency: false,
      createdAt: "2026-01-05",
      // 2026-03-01T23:30:00+00:00 is already 2 March in Berlin (UTC+1).
      updatedAt: "2026-03-02",
    });
  });

  it("maps a person: surename is the first name, parent is the organisation", () => {
    const dto = dtoOf(firstObject("contacts/contact-1002.json"));
    expect(dto.kind).toBe("person");
    expect(dto.displayName).toBe("Dr. Max Mustermann");
    expect(dto.parentOrganisationId).toBe(1001);
  });

  it("decides the kind by name vs surename/familyname", () => {
    expect(contactKind(parseContactRecord({ id: "1", name: "Musterfirma GmbH" }))).toBe(
      "organisation",
    );
    expect(contactKind(parseContactRecord({ id: "1", name: null, familyname: "Muster" }))).toBe(
      "person",
    );
    expect(contactKind(parseContactRecord({ id: "1", name: "  ", surename: "Erika" }))).toBe(
      "person",
    );
  });

  it("leaves missing fields out instead of sending nulls", () => {
    const dto = dtoOf({ id: 7, name: "Musterfirma GmbH", customerNumber: "", category: null });
    expect(dto).toEqual({ id: 7, kind: "organisation", displayName: "Musterfirma GmbH" });
  });

  it("names a contact without any name by its id", () => {
    expect(dtoOf({ id: "8" }).displayName).toBe("(unnamed contact 8)");
  });

  it("keeps account-specific categories by id only", () => {
    expect(
      dtoOf({ id: "9", name: "X", category: { id: "355842", objectName: "Category" } }),
    ).toMatchObject({ category: { id: 355842 } });
  });

  it("accepts numbers where sevDesk usually sends strings", () => {
    const dto = dtoOf({
      id: 10,
      name: "Musterfirma GmbH",
      customerNumber: 1001,
      governmentAgency: 1,
    });
    expect(dto).toMatchObject({ id: 10, customerNumber: "1001", governmentAgency: true });
  });

  it("drops an unreadable timestamp instead of failing the contact", () => {
    expect(dtoOf({ id: "11", name: "X", create: "gestern" }).createdAt).toBeUndefined();
  });

  it("strips bidi and zero-width characters from names (prompt-injection hardening)", () => {
    const dto = dtoOf({
      id: "12",
      name: "Muster​firma‮ GmbH⁦",
      vatNumber: "DE‍000000000",
    });
    expect(dto.displayName).toBe("Musterfirma GmbH");
    expect(dto.vatNumber).toBe("DE000000000");
  });

  it("caps very long names with a visible marker", () => {
    const dto = dtoOf({ id: "13", name: "A".repeat(5_000) });
    expect(dto.displayName).toMatch(/^A{300}… \[truncated 4700 chars\]$/);
  });

  it("rejects a record without id as an unexpected response", () => {
    expect(() => parseContactRecord({ name: "Musterfirma GmbH" })).toThrow(SevdeskError);
    let caught: unknown;
    try {
      parseContactRecord({ id: "abc" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SevdeskError);
    expect((caught as SevdeskError).kind).toBe("unexpected_response");
  });
});

describe("getNextCustomerNumber (spec: objects is a string)", () => {
  const path = "/Contact/Factory/getNextCustomerNumber";

  it("returns the string payload", async () => {
    const client = new FakeSevdeskClient([
      { path, response: { fixture: "contacts/next-customer-number.json" } },
    ]);
    await expect(getNextCustomerNumber(client)).resolves.toBe("K-1004");
    expect(client.methods()).toEqual(["GET"]);
  });

  it("accepts a numeric payload", async () => {
    const client = new FakeSevdeskClient([{ path, response: { body: { objects: 1005 } } }]);
    await expect(getNextCustomerNumber(client)).resolves.toBe("1005");
  });

  it("fails with unexpected_response on an empty payload", async () => {
    const client = new FakeSevdeskClient([{ path, response: { body: { objects: "" } } }]);
    await expect(getNextCustomerNumber(client)).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });
});
