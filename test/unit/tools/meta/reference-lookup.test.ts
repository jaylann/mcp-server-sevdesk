import { describe, expect, it } from "vitest";

import { TAX_RULES } from "../../../../src/domain/reference-data.js";
import { referenceLookupTool as tool } from "../../../../src/tools/meta/reference-lookup.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const upstreamRoutes: FakeRoute[] = [
  { path: "/SevUser", response: { fixture: "meta/sev-users.json" } },
  { path: "/StaticCountry", response: { fixture: "meta/static-countries.json" } },
  { path: "/Unity", response: { fixture: "meta/units.json" } },
  { path: "/PaymentMethod", response: { fixture: "meta/payment-methods.json" } },
];

async function lookup(
  args: Record<string, unknown>,
  routes: readonly FakeRoute[] = upstreamRoutes,
) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  expect(tool.output.parse(result.data)).toEqual(result.data);
  return { client, result };
}

describe("sevdesk_reference_lookup", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.name).toBe("sevdesk_reference_lookup");
    expect(tool.tier).toBe("read");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("returns all tax rules from reference data without calling sevDesk", async () => {
    const { client, result } = await lookup({ kind: "tax_rules" });
    expect(client.calls).toHaveLength(0);
    expect(result.data).toMatchObject({
      kind: "tax_rules",
      source: "reference",
      total: TAX_RULES.length,
      returned: TAX_RULES.length,
      truncated: false,
    });
    expect(result.data.taxRules?.find((rule) => rule.id === 1)).toEqual({
      id: 1,
      code: "USTPFL_UMS_EINN",
      nameDe: "Umsatzsteuerpflichtige Umsätze",
      nameEn: "Taxable domestic revenue",
      direction: "revenue",
      regimes: ["regular"],
      allowedTaxRates: [0, 7, 19],
      legacyTaxType: "default",
      documented: true,
    });
    expect(result.summary).toBe(`${TAX_RULES.length} of ${TAX_RULES.length} tax rules.`);
  });

  it("filters case-insensitively by substring", async () => {
    const reverse = await lookup({ kind: "tax_rules", query: "REVERSE charge" });
    expect(reverse.result.data.taxRules?.map((rule) => rule.id)).toEqual([5, 12, 13, 14, 21]);
    expect(reverse.result.summary).toBe(`5 of ${TAX_RULES.length} tax rules matching the query.`);

    const smallBusiness = await lookup({ kind: "tax_rules", query: "kleinunternehmer" });
    expect(smallBusiness.result.data.taxRules?.map((rule) => rule.id)).toEqual([11]);

    const byId = await lookup({ kind: "contact_categories", query: "28" });
    expect(byId.result.data.contactCategories).toEqual([
      { id: 28, key: "prospect", name: "Interessent", nameEn: "Prospect customer" },
    ]);
  });

  it("returns status codes and document types", async () => {
    const status = await lookup({ kind: "status_codes", query: "creditNote" });
    expect(status.result.data.statusCodes?.map((entry) => entry.code)).toEqual([
      100, 200, 750, 1000,
    ]);

    const types = await lookup({ kind: "document_types", query: "Angebot" });
    expect(types.result.data.documentTypes).toEqual([
      { objectType: "order", code: "AN", label: "Estimate / proposal", labelDe: "Angebot" },
    ]);
  });

  it("fetches users, countries, units and payment methods with limit 1000, GET only", async () => {
    const users = await lookup({ kind: "users" });
    expect(users.result.data).toMatchObject({ source: "sevdesk", total: 2, returned: 2 });
    expect(users.client.calls[0]).toMatchObject({ method: "GET", path: "/SevUser" });
    expect(users.client.calls[0]?.query).toMatchObject({ limit: 1000 });

    const countries = await lookup({ kind: "countries", query: "germany" });
    expect(countries.result.data.countries).toEqual([
      { id: 1, code: "de", name: "Deutschland", nameEn: "Germany" },
    ]);
    expect(countries.result.data).toMatchObject({ total: 2, returned: 1 });

    const units = await lookup({ kind: "units", query: "HUR" });
    expect(units.result.data.units).toEqual([{ id: 9, name: "Std", uneceCode: "HUR" }]);

    const methods = await lookup({ kind: "payment_methods" });
    expect(methods.result.data.paymentMethods?.map((method) => method.name)).toEqual([
      "Überweisung",
      "Bar",
    ]);
    for (const { client } of [users, countries, units, methods]) {
      expect(client.methods().every((method) => method === "GET")).toBe(true);
    }
  });

  it("flags lists sevDesk could not return completely", async () => {
    const { result } = await lookup({ kind: "units" }, [
      {
        path: "/Unity",
        response: { body: { total: "1500", objects: [{ id: "1", name: "Stk" }] } },
      },
    ]);
    expect(result.data).toMatchObject({ total: 1500, returned: 1, truncated: true });
    expect(result.summary).toBe("1 of 1500 units (sevDesk has more than could be fetched).");
  });

  it("fails with unexpected_response when a user row has no id", async () => {
    const client = new FakeSevdeskClient([
      { path: "/SevUser", response: { body: { objects: [{ fullname: "Erika Musterfrau" }] } } },
    ]);
    await expect(
      tool.handler(tool.input.parse({ kind: "users" }), testContext(client)),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
  });

  it("rejects unknown kinds and empty queries", () => {
    expect(tool.input.safeParse({ kind: "accounts" }).success).toBe(false);
    expect(tool.input.safeParse({ kind: "units", query: "" }).success).toBe(false);
    expect(tool.input.safeParse({ kind: "units", limit: 5 }).success).toBe(false);
  });
});
