import { describe, expect, it } from "vitest";

import {
  checkTaxRuleUseCase,
  documentTaxFields,
  resolveTaxRates,
  ruleForLegacyTaxType,
  SALES_TAX_RULE_IDS,
  taxRuleFor,
  taxRuleWarnings,
} from "../../../../src/domain/drafts/tax.js";
import { TAX_RULES, taxRuleById } from "../../../../src/domain/reference-data.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";

const scope = { allowedRuleIds: SALES_TAX_RULE_IDS, documents: "invoices" };

function rule(id: number) {
  const found = taxRuleById(id);
  if (found === undefined) throw new Error(`no rule ${id}`);
  return found;
}

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    return (error as SevdeskError).message;
  }
  throw new Error("expected a validation error");
}

describe("draft tax: rule × rate table (reference data TAX_RULES)", () => {
  const sales = TAX_RULES.filter((entry) => SALES_TAX_RULE_IDS.includes(entry.id));

  it("covers exactly the spec's sales-document rule enum", () => {
    expect(sales.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 11, 17, 18, 19, 20, 21]);
    expect(sales.every((entry) => entry.direction === "revenue")).toBe(true);
  });

  it.each(
    sales.flatMap((entry) => ["0", "7", "19", "16", "20"].map((rate) => [entry.id, rate] as const)),
  )("rule %i with %s %%", (id, rate) => {
    const entry = rule(id);
    const allowed = entry.allowedTaxRates?.map(String);
    const run = () => resolveTaxRates(entry, [{ taxRate: rate }]);
    if (allowed === undefined || allowed.includes(rate)) {
      expect(run()).toEqual([rate]);
    } else {
      expect(message(run)).toMatch(
        new RegExp(`^Position 1 has a tax rate of ${rate} %, which tax rule ${id} `),
      );
    }
  });

  it("fills in the only allowed rate and asks when there are several", () => {
    expect(resolveTaxRates(rule(11), [{}, { taxRate: "0" }])).toEqual(["0", "0"]);
    expect(resolveTaxRates(rule(21), [{}])).toEqual(["0"]);
    expect(message(() => resolveTaxRates(rule(3), [{}]))).toBe(
      "Position 1 has no taxRate. Tax rule 3 allows 0, 7, 19 %. Say which one applies.",
    );
    expect(message(() => resolveTaxRates(rule(19), [{ taxRate: "20" }, {}]))).toBe(
      "Position 2 has no taxRate. With tax rule 19 (One-Stop-Shop - elektronische " +
        "Dienstleistungen in die EU) the rate depends on the destination country, so give it per position.",
    );
  });

  it("points at rule 1 when a zero-rate rule gets VAT", () => {
    expect(message(() => resolveTaxRates(rule(5), [{ taxRate: "19" }]))).toBe(
      "Position 1 has a tax rate of 19 %, which tax rule 5 (Reverse Charge gem. §13b UStG) does " +
        "not allow. Tax rule 5 allows 0 %. To charge VAT on domestic sales use tax rule 1.",
    );
  });

  it("applies an extra rate limit (credit notes on an invoice)", () => {
    const limit = { rates: ["7", "19"], owner: "the source invoice 1001" };
    expect(resolveTaxRates(rule(1), [{ taxRate: "7.00" }], limit)).toEqual(["7"]);
    expect(message(() => resolveTaxRates(rule(1), [{ taxRate: "0" }], limit))).toBe(
      "Position 1 has a tax rate of 0 %, but the source invoice 1001 only has 7, 19 %; sevDesk " +
        "only accepts those rates here.",
    );
    expect(message(() => resolveTaxRates(rule(1), [{}], limit))).toBe(
      "Position 1 has no taxRate. Tax rule 1 allows 7, 19 %. Say which one applies.",
    );
    expect(resolveTaxRates(rule(1), [{}], { rates: ["19.00"], owner: "x" })).toEqual(["19"]);
  });
});

describe("draft tax: rules, use cases and fields", () => {
  it("refuses rules outside the scope, naming expense rules", () => {
    expect(taxRuleFor(17, scope).id).toBe(17);
    expect(message(() => taxRuleFor(22, scope))).toBe(
      "Tax rule 22 (Nicht Steuerbar (Einnahme)) cannot be used for invoices. Use tax rule 1, 2, " +
        "3, 4, 5, 11, 17, 18, 19, 20, 21; sevdesk_reference_lookup kind=tax_rules explains them.",
    );
  });

  it("refuses a rule for a use case sevDesk rejects", () => {
    expect(() => {
      checkTaxRuleUseCase(rule(1), "e-invoices", "invoice");
    }).not.toThrow();
    expect(
      message(() => {
        checkTaxRuleUseCase(rule(21), "partial invoices (TR)", "invoice");
      }),
    ).toBe(
      "Tax rule 21 (Reverse Charge gem. §13b Abs. 1 USTG EU Umsätze) is not supported for " +
        "partial invoices (TR), and this invoice is one. Choose another tax rule.",
    );
  });

  it("warns for small business and One-Stop-Shop rules only", () => {
    expect(taxRuleWarnings(rule(1))).toEqual([]);
    expect(taxRuleWarnings(rule(11))).toEqual([
      "Tax rule 11 is for small businesses (Kleinunternehmer, §19 UStG) only: the document shows no VAT.",
    ]);
    expect(taxRuleWarnings(rule(20))[0]).toMatch(/^Tax rule 20 is a One-Stop-Shop rule/);
  });

  it("writes taxRule on Update 2.0 and the legacy taxType on 1.0", () => {
    expect(documentTaxFields(rule(11), "2.0", undefined)).toEqual({
      taxRule: { id: 11, objectName: "TaxRule" },
      taxRate: 0,
      taxText: "Steuer nicht erhoben nach §19UStG",
      smallSettlement: true,
    });
    expect(documentTaxFields(rule(1), "1.0", "zzgl. USt")).toEqual({
      taxType: "default",
      taxRate: 0,
      taxText: "zzgl. USt",
      smallSettlement: false,
    });
    expect(documentTaxFields(rule(3), "1.0", undefined)).toMatchObject({ taxType: "eu" });
    expect(documentTaxFields(rule(11), "1.0", undefined)).toMatchObject({
      taxType: "ss",
      smallSettlement: true,
    });
    expect(documentTaxFields(rule(17), "1.0", undefined)).toMatchObject({ taxType: "noteu" });
    expect(message(() => documentTaxFields(rule(2), "1.0", undefined))).toBe(
      "This sevDesk account still uses bookkeeping system 1.0, where tax rule 2 (Ausfuhren) has " +
        "no equivalent tax type. Use tax rule 1 (default), 3 (eu), 11 (ss) or 17 (noteu), or move " +
        "the account to sevDesk Update 2.0.",
    );
  });

  it("maps stored legacy tax types back to rules", () => {
    expect(ruleForLegacyTaxType(" Default ")?.id).toBe(1);
    expect(ruleForLegacyTaxType("eu")?.id).toBe(3);
    expect(ruleForLegacyTaxType("noteu")?.id).toBe(17);
    expect(ruleForLegacyTaxType("ss")?.id).toBe(11);
    expect(ruleForLegacyTaxType("custom")).toBeUndefined();
    expect(ruleForLegacyTaxType(undefined)).toBeUndefined();
  });
});
