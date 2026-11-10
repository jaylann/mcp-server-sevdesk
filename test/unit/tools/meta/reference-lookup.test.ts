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
      allowedTaxRates: ["0", "7", "19"],
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
    expect(tool.input.safeParse({ kind: "units", unknown: 5 }).success).toBe(false);
    expect(tool.input.safeParse({ kind: "receipt_guidance", accountNumber: "44a" }).success).toBe(
      false,
    );
    expect(tool.input.safeParse({ kind: "receipt_guidance", limit: 101 }).success).toBe(false);
  });

  it("refuses receipt_guidance arguments for other kinds before calling sevDesk", async () => {
    const client = new FakeSevdeskClient(upstreamRoutes);
    await expect(
      tool.handler(
        tool.input.parse({ kind: "units", limit: 5, taxRuleId: 1 }),
        testContext(client),
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "taxRuleId, limit only apply to kind=receipt_guidance; leave them out for kind=units.",
    });
    expect(client.calls).toHaveLength(0);
  });
});

describe("sevdesk_reference_lookup kind=receipt_guidance", () => {
  const guidanceRoutes: FakeRoute[] = [
    {
      path: "/ReceiptGuidance/forAllAccounts",
      response: { fixture: "masterdata/receipt-guidance-all.json" },
    },
  ];

  it("returns a compact first page of the account's guidance", async () => {
    const { client, result } = await lookup({ kind: "receipt_guidance", limit: 2 }, guidanceRoutes);
    expect(result.data).toMatchObject({
      kind: "receipt_guidance",
      source: "sevdesk",
      total: 4,
      matched: 4,
      returned: 2,
      offset: 0,
      nextOffset: 2,
      truncated: false,
    });
    expect(result.data.receiptGuidance?.[1]).toEqual({
      accountDatevId: 2571,
      accountNumber: "1525",
      accountName: "Kautionen",
      description: "Gezahlte Kautionen z. B. für Büroräume",
      receiptTypes: ["expense"],
      taxRules: [{ id: 16, code: "NICHT_STEUERBAR_EXPENSE", taxRates: ["0"] }],
    });
    expect(result.summary).toBe(
      "2 of 4 matching receipt guidance accounts (4 in total). More: call again with offset 2.",
    );
    expect(client.calls).toEqual([
      expect.objectContaining({ method: "GET", path: "/ReceiptGuidance/forAllAccounts" }),
    ]);
  });

  it("filters by account number, tax rule, receipt type and query, and pages", async () => {
    const byNumber = await lookup(
      { kind: "receipt_guidance", accountNumber: "4400" },
      guidanceRoutes,
    );
    expect(byNumber.result.data.receiptGuidance?.map((guide) => guide.accountDatevId)).toEqual([
      3631,
    ]);
    expect(byNumber.result.data.nextOffset).toBeUndefined();

    const byRule = await lookup({ kind: "receipt_guidance", taxRuleId: 16 }, guidanceRoutes);
    expect(byRule.result.data.receiptGuidance?.map((guide) => guide.accountNumber)).toEqual([
      "1525",
      "1590",
    ]);

    const revenue = await lookup(
      { kind: "receipt_guidance", receiptType: "revenue", offset: 1 },
      guidanceRoutes,
    );
    expect(revenue.result.data).toMatchObject({ matched: 2, returned: 1, offset: 1 });
    expect(revenue.result.data.receiptGuidance?.[0]?.accountNumber).toBe("4400");

    const query = await lookup({ kind: "receipt_guidance", query: "kreditkarten" }, guidanceRoutes);
    expect(query.result.data.receiptGuidance?.map((guide) => guide.accountNumber)).toEqual([
      "4970",
    ]);
    const byCode = await lookup(
      { kind: "receipt_guidance", query: "rev_charge_13b_eu" },
      guidanceRoutes,
    );
    expect(byCode.result.data.matched).toBe(1);
  });

  it("caches the guidance per server configuration", async () => {
    const client = new FakeSevdeskClient(guidanceRoutes);
    const ctx = testContext(client);
    await tool.handler(tool.input.parse({ kind: "receipt_guidance" }), ctx);
    await tool.handler(tool.input.parse({ kind: "receipt_guidance", taxRuleId: 9 }), ctx);
    expect(client.calls).toHaveLength(1);
  });

  it("keeps unknown rate words and reports truncation", async () => {
    const { result } = await lookup({ kind: "receipt_guidance" }, [
      {
        path: "/ReceiptGuidance/forAllAccounts",
        response: {
          body: {
            total: "1200",
            objects: [
              {
                accountDatevId: 1,
                accountNumber: "4400",
                allowedTaxRules: [{ id: 1, name: "USTPFL_UMS_EINN", taxRates: ["TWELVE"] }],
                allowedReceiptTypes: ["REVENUE"],
              },
            ],
          },
        },
      },
    ]);
    expect(result.data.receiptGuidance?.[0]?.taxRules).toEqual([
      { id: 1, code: "USTPFL_UMS_EINN", taxRates: [], unknownTaxRates: ["TWELVE"] },
    ]);
    expect(result.data.truncated).toBe(true);
    expect(result.summary).toBe(
      "1 of 1 matching receipt guidance accounts (1 in total). sevDesk has more accounts than " +
        "could be fetched.",
    );
  });
});
