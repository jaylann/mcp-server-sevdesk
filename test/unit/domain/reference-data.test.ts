import { describe, expect, it } from "vitest";

import {
  addressCategoryById,
  communicationWayKeyById,
  CONTACT_CATEGORIES,
  CONTACT_CATEGORY_KEYS,
  contactCategoryById,
  contactCategoryIdByKey,
  documentTypeByCode,
  listCountries,
  listPaymentMethods,
  listUnits,
  STATUS_CODES,
  statusByCode,
  TAX_RULES,
  taxRuleById,
} from "../../../src/domain/reference-data.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";

describe("static reference data", () => {
  it("has unique ids and codes", () => {
    const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
    expect(unique(TAX_RULES.map((rule) => rule.id))).toBe(true);
    expect(unique(TAX_RULES.map((rule) => rule.code))).toBe(true);
    expect(unique(CONTACT_CATEGORIES.map((category) => category.id))).toBe(true);
    expect(unique(STATUS_CODES.map((status) => `${status.objectType}:${status.code}`))).toBe(true);
  });

  it("covers every contact category key", () => {
    expect(CONTACT_CATEGORIES.map((category) => category.key)).toEqual([...CONTACT_CATEGORY_KEYS]);
  });

  it("looks up entries by id, key and code", () => {
    expect(contactCategoryById(3)?.name).toBe("Kunde");
    expect(contactCategoryById(355842)).toBeUndefined();
    expect(contactCategoryIdByKey("supplier")).toBe(2);
    expect(contactCategoryIdByKey("prospect")).toBe(28);
    expect(addressCategoryById(47)?.name).toBe("Rechnungsanschrift");
    expect(communicationWayKeyById(8)?.name).toBe("Rechnungsadresse");
    expect(communicationWayKeyById(99)).toBeUndefined();
    expect(statusByCode("invoice", 1000)?.labelDe).toBe("Bezahlt");
    expect(statusByCode("voucher", 200)).toBeUndefined();
    expect(documentTypeByCode("order", "AN")?.labelDe).toBe("Angebot");
    expect(taxRuleById(11)?.code).toBe("KLEINUNTERNEHMER_P19");
    expect(taxRuleById(6)).toBeUndefined();
  });

  it("documents allowed tax rates except where they depend on the country", () => {
    for (const rule of TAX_RULES) {
      if (rule.code.startsWith("OSS_") || !rule.documented) {
        expect(rule.allowedTaxRates, `tax rule ${rule.id}`).toBeUndefined();
      } else {
        expect(rule.allowedTaxRates, `tax rule ${rule.id}`).toBeDefined();
      }
    }
  });
});

describe("reference list loaders (community: sevDesk.NET recording)", () => {
  it("lists countries with limit 1000 and maps them", async () => {
    const client = new FakeSevdeskClient([
      { path: "/StaticCountry", response: { fixture: "meta/static-countries.json" } },
    ]);
    const countries = await listCountries(client);
    expect(countries.total).toBe(2);
    expect(countries.items[0]).toEqual({
      id: 1,
      code: "de",
      name: "Deutschland",
      nameEn: "Germany",
    });
    expect(client.calls[0]?.query).toMatchObject({ limit: 1000, offset: 0, countAll: true });
  });

  it("lists units and names unnamed ones by id", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Unity", response: { fixture: "meta/units.json" } },
    ]);
    const units = await listUnits(client);
    expect(units.items.map((unit) => unit.name)).toEqual([
      "Stk",
      "pauschal",
      "Std",
      "(unnamed 37)",
      "kg",
    ]);
    expect(units.items[2]).toEqual({ id: 9, name: "Std", uneceCode: "HUR" });
  });

  it("lists payment methods and sanitizes user-defined text", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/PaymentMethod",
        response: {
          body: {
            objects: [{ id: "5", objectName: "PaymentMethod", name: "Bar‮​", text: null }],
          },
        },
      },
    ]);
    const methods = await listPaymentMethods(client);
    expect(methods.items).toEqual([{ id: 5, name: "Bar" }]);
  });

  it("reports sevDesk's total when it is larger than the page", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/PaymentMethod",
        response: { body: { total: "1200", objects: [{ id: "1", name: "Überweisung" }] } },
      },
    ]);
    const methods = await listPaymentMethods(client);
    expect(methods.total).toBe(1200);
    expect(methods.items).toHaveLength(1);
  });

  it("fails with unexpected_response on an unreadable row", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Unity", response: { body: { objects: [{ name: "no id" }] } } },
    ]);
    const error: unknown = await listUnits(client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("unexpected_response");
  });
});
