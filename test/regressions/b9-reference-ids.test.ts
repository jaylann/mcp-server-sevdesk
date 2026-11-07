/**
 * B9: wrong hard-coded ids (tax rules, contact categories, status codes) in tool descriptions and
 * code were the most common bug class across other sevDesk MCP servers. This test pins every id
 * in `src/domain/reference-data.ts` to the values verified against the spec, and cross-checks them
 * against recorded sevDesk responses (`test/fixtures/meta/*.json`). Changing an id here needs a
 * source, not a guess.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ADDRESS_CATEGORIES,
  COMMUNICATION_WAY_KEYS,
  CONTACT_CATEGORIES,
  DOCUMENT_TYPES,
  STATUS_CODES,
  type StatusObjectType,
  TAX_RULES,
} from "../../src/domain/reference-data.js";
import { loadFixture } from "../helpers/fake-client.js";

const recordedRow = z.object({ id: z.string(), name: z.string() });

function recordedRows(fixture: string) {
  const body = z.object({ objects: z.array(z.looseObject(recordedRow.shape)) });
  return body.parse(loadFixture(fixture).body).objects;
}

function codesOf(objectType: StatusObjectType): number[] {
  return STATUS_CODES.filter((status) => status.objectType === objectType).map((s) => s.code);
}

describe("B9 reference ids (community: sevDesk.NET recording; spec)", () => {
  it("pins the contact categories (spec tag Contact)", () => {
    expect(CONTACT_CATEGORIES.map(({ id, key, name }) => [id, key, name])).toEqual([
      [2, "supplier", "Lieferant"],
      [3, "customer", "Kunde"],
      [4, "partner", "Partner"],
      [28, "prospect", "Interessent"],
    ]);
  });

  it("matches the recorded GET /Category for contacts and addresses", () => {
    const recorded = loadFixture("meta/categories.json").body as {
      objects: { id: string; name: string; objectType: string }[];
    };
    const byType = (type: string) =>
      new Map(recorded.objects.filter((row) => row.objectType === type).map((r) => [r.id, r.name]));
    const contactCategories = byType("Contact");
    for (const category of CONTACT_CATEGORIES) {
      expect(contactCategories.get(String(category.id))).toBe(category.name);
    }
    const addressCategories = byType("ContactAddress");
    for (const category of ADDRESS_CATEGORIES) {
      expect(addressCategories.get(String(category.id))).toBe(category.name);
    }
  });

  it("pins the communication way keys 1–8 (spec tag CommunicationWay)", () => {
    expect(COMMUNICATION_WAY_KEYS.map(({ id, nameEn }) => [id, nameEn])).toEqual([
      [1, "Private"],
      [2, "Work"],
      [3, "Fax"],
      [4, "Mobile"],
      [5, "Empty"],
      [6, "Autobox"],
      [7, "Newsletter"],
      [8, "Invoicing"],
    ]);
    const recorded = new Map(
      recordedRows("meta/communication-way-keys.json").map((row) => [row.id, row.name]),
    );
    for (const key of COMMUNICATION_WAY_KEYS) {
      expect(recorded.get(String(key.id))?.trim()).toBe(key.name);
    }
  });

  it("pins the status codes per object type (spec)", () => {
    expect(codesOf("invoice")).toEqual([50, 100, 200, 750, 1000]);
    expect(codesOf("creditNote")).toEqual([100, 200, 750, 1000]);
    expect(codesOf("order")).toEqual([100, 200, 300, 500, 750, 1000]);
    expect(codesOf("voucher")).toEqual([50, 100, 150, 750, 1000]);
    expect(codesOf("transaction")).toEqual([100, 200, 300, 350, 400]);
    expect(codesOf("contact")).toEqual([100, 500, 1000]);
  });

  it("pins the document types (spec)", () => {
    const codes = (objectType: string) =>
      DOCUMENT_TYPES.filter((type) => type.objectType === objectType).map((type) => type.code);
    expect(codes("invoice")).toEqual(["RE", "WKR", "SR", "MA", "TR", "AR", "ER"]);
    expect(codes("order")).toEqual(["AN", "AB", "LI"]);
    expect(codes("voucher")).toEqual(["VOU", "RV"]);
  });

  it("pins the Update 2.0 tax rules (spec 'Tax Rules' tables)", () => {
    const pinned = TAX_RULES.map((rule) => [rule.id, rule.direction, rule.documented]);
    expect(pinned).toEqual([
      [1, "revenue", true],
      [2, "revenue", true],
      [3, "revenue", true],
      [4, "revenue", true],
      [5, "revenue", true],
      [8, "expense", true],
      [9, "expense", true],
      [10, "expense", true],
      [11, "revenue", true],
      [12, "expense", true],
      [13, "expense", true],
      [14, "expense", true],
      [15, "either", false],
      [16, "expense", false],
      [17, "revenue", true],
      [18, "revenue", true],
      [19, "revenue", true],
      [20, "revenue", true],
      [21, "revenue", true],
      [22, "revenue", false],
    ]);
    const smallBusiness = TAX_RULES.filter((rule) => rule.regimes.includes("small_business"));
    expect(smallBusiness.filter((rule) => rule.documented).map((rule) => rule.id)).toEqual([
      10, 11, 13,
    ]);
    expect(TAX_RULES.find((rule) => rule.id === 11)?.regimes).toEqual(["small_business"]);
  });

  it("matches every tax rule's code and name with the recorded GET /TaxRule", () => {
    const body = z
      .object({ objects: z.array(z.looseObject({ ...recordedRow.shape, code: z.string() })) })
      .parse(loadFixture("meta/tax-rules.json").body);
    const recorded = new Map(body.objects.map((row) => [Number(row.id), row]));
    expect([...recorded.keys()].sort((a, b) => a - b)).toEqual(TAX_RULES.map((rule) => rule.id));
    for (const rule of TAX_RULES) {
      const row = recorded.get(rule.id);
      expect(row?.code, `tax rule ${rule.id}`).toBe(rule.code);
      expect(row?.name.startsWith(rule.nameDe), `tax rule ${rule.id} name`).toBe(true);
    }
  });
});
