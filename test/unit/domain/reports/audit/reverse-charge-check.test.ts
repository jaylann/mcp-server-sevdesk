import { describe, expect, it } from "vitest";

import type { AccountSettings } from "../../../../../src/domain/account-settings.js";
import { type AuditResult, runAudit } from "../../../../../src/domain/reports/audit/registry.js";
import {
  kennzahlenOf,
  REVERSE_CHARGE_FINDING_CODES,
} from "../../../../../src/domain/reports/audit/reverse-charge-check.js";
import { resolvePeriod, vatSummary } from "../../../../../src/domain/reports/vat.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../../helpers/fake-client.js";
import {
  creditNoteDoc,
  creditNotePositions,
  invoiceDoc,
  invoicePositions,
  regularAccount,
  type ScenarioDocument,
  scenarioRoutes,
  smallBusinessAccount,
  voucherDoc,
  voucherPositions,
} from "../builders.js";
import { CONTACTS } from "./scenario.js";

const Q1 = resolvePeriod({ year: 2026, quarter: 1 });
const TODAY = "2026-11-16";
const REGULAR: AccountSettings = { smallBusiness: false, chartOfAccounts: "skr04" };

/** A purchase at 0 % as sevDesk books reverse charge. */
function purchase(
  id: number,
  rule: number,
  date: string,
  net: string,
  contactId: number,
  delivery?: string,
): ScenarioDocument {
  return {
    row: voucherDoc({ id, date, delivery: delivery ?? date, rule, net, tax: "0", contactId }),
    positions: voucherPositions(id, [{ rate: "0", net, tax: "0" }]),
  };
}

const VOUCHERS: readonly ScenarioDocument[] = [
  // § 13b Abs. 1: an Irish service in February.
  purchase(5101, 14, "2026-02-10", "1000", CONTACTS.irishSaas.id),
  // § 13b Abs. 2: invoiced in April for a supply in February, so due at the end of March.
  purchase(5102, 12, "2026-04-10", "500", CONTACTS.usSaas.id, "2026-02-15"),
  // Rule 13 on a regular account.
  purchase(5103, 13, "2026-03-01", "200", CONTACTS.german.id),
  // December: another period.
  purchase(5104, 12, "2025-12-20", "999", CONTACTS.usSaas.id),
  // § 13b Abs. 1 counts when the service is performed (March), not with the April invoice.
  purchase(5106, 14, "2026-04-05", "300", CONTACTS.irishSaas.id, "2026-03-20"),
  {
    row: voucherDoc({ id: 5105, date: "2026-02-10", rule: 9, net: "100", tax: "19" }),
    positions: voucherPositions(5105, [{ rate: "19", net: "100", tax: "19" }]),
  },
];

const INVOICES: readonly ScenarioDocument[] = [
  {
    row: invoiceDoc({
      id: 5201,
      date: "2026-03-05",
      rule: 21,
      net: "800",
      tax: "0",
      contactId: 4001,
      vatNumber: "FR12345678901",
    }),
    positions: invoicePositions(5201, [{ rate: "0", net: "800", tax: "0" }]),
  },
  {
    row: invoiceDoc({ id: 5202, date: "2026-02-01", rule: 5, net: "300", tax: "0" }),
    positions: invoicePositions(5202, [{ rate: "0", net: "300", tax: "0" }]),
  },
];

const CREDIT_NOTES: readonly ScenarioDocument[] = [
  {
    row: creditNoteDoc({
      id: 5301,
      date: "2026-03-10",
      rule: 21,
      net: "100",
      tax: "0",
      contactId: 4001,
      vatNumber: "FR12345678901",
    }),
    positions: creditNotePositions(5301, [{ rate: "0", net: "100", tax: "0" }]),
  },
];

function routes(): FakeRoute[] {
  return scenarioRoutes({ vouchers: VOUCHERS, invoices: INVOICES, creditNotes: CREDIT_NOTES });
}

async function audit(
  all: readonly FakeRoute[],
  limits?: { readonly maxDocuments?: number },
  options: Parameters<typeof runAudit>[3] = {},
): Promise<{ client: FakeSevdeskClient; result: AuditResult }> {
  const client = new FakeSevdeskClient(all);
  const result = await runAudit(
    client,
    "reverse_charge",
    { period: Q1, cacheOwner: {}, today: TODAY, limits },
    options,
  );
  return { client, result };
}

const euro = (amount: string) => ({ amount, currency: "EUR" });

describe("check reverse_charge", () => {
  it("sums the § 13b base of the period by tax rule, with tax owed and input VAT", async () => {
    const { client, result } = await audit([regularAccount, ...routes()]);
    const section = result.reverseCharge;

    expect(
      section?.received.map((rule) => ({
        id: rule.taxRule.id,
        ustva: rule.ustva,
        base: rule.base,
        tax: rule.tax,
        inputTax: rule.inputTax,
        documents: rule.documents,
      })),
    ).toEqual([
      {
        id: 12,
        ustva: { baseKz: "84", taxKz: "85", inputTaxKz: "67" },
        base: euro("500.00"),
        tax: euro("95.00"),
        inputTax: euro("95.00"),
        documents: 1,
      },
      {
        id: 13,
        ustva: { baseKz: "84", taxKz: "85" },
        base: euro("200.00"),
        tax: euro("38.00"),
        inputTax: euro("0.00"),
        documents: 1,
      },
      {
        id: 14,
        ustva: { baseKz: "46", taxKz: "47", inputTaxKz: "67" },
        base: euro("1300.00"),
        tax: euro("247.00"),
        inputTax: euro("247.00"),
        documents: 2,
      },
    ]);
    expect(section?.totals).toEqual({
      base: euro("2000.00"),
      tax: euro("380.00"),
      inputTax: euro("342.00"),
    });
    expect(
      section?.issued.map((rule) => [rule.taxRule.id, rule.ustva.baseKz, rule.base.amount]),
    ).toEqual([
      [5, "60", "300.00"],
      [21, "21", "700.00"],
    ]);
    expect(section?.received.every((rule) => rule.recipientTaxAssumed === true)).toBe(true);
    // The rule 9 purchase and the December one are not read at all.
    const read = client.callsTo("/VoucherPos").map((call) => Number(call.query["voucher[id]"]));
    expect(read.sort((a, b) => a - b)).toEqual([5101, 5102, 5103, 5106]);
    expect(client.writes()).toEqual([]);
  });

  it("matches the Kennzahlen of sevdesk_vat_summary for the same period", async () => {
    const { result } = await audit([regularAccount, ...routes()]);
    const summary = await vatSummary(new FakeSevdeskClient(routes()), {
      period: Q1,
      settings: REGULAR,
      today: TODAY,
    });
    const box = (kz: string) => summary.boxes.find((entry) => entry.kz === kz);
    const section = result.reverseCharge;
    const received = (id: number) => section?.received.find((rule) => rule.taxRule.id === id);
    const issued = (id: number) => section?.issued.find((rule) => rule.taxRule.id === id);

    expect(box("84")?.base?.amount).toBe("700.00");
    expect(box("84")?.tax?.amount).toBe("133.00");
    expect(received(12)?.base.amount).toBe("500.00");
    expect(received(13)?.base.amount).toBe("200.00");
    expect(box("46")?.base).toEqual(received(14)?.base);
    expect(box("46")?.tax).toEqual(received(14)?.tax);
    expect(box("67")?.tax).toEqual(section?.totals.inputTax);
    expect(box("60")?.base).toEqual(issued(5)?.base);
    expect(box("21")?.base).toEqual(issued(21)?.base);
  });

  it("lists the documents behind each sum with tax point, contact, amounts and link", async () => {
    const { result } = await audit([regularAccount, ...routes()]);
    const rule12 = result.reverseCharge?.received.find((rule) => rule.taxRule.id === 12);
    const rule14 = result.reverseCharge?.received.find((rule) => rule.taxRule.id === 14);
    const rule21 = result.reverseCharge?.issued.find((rule) => rule.taxRule.id === 21);

    expect(rule12?.records).toEqual([
      {
        objectName: "Voucher",
        id: 5102,
        number: "B-5102",
        date: "2026-04-10",
        taxPoint: "2026-03-31",
        taxRule: {
          id: 12,
          name: "Reverse Charge gem. §13b Abs. 2 UStG mit Vorsteuerabzug 0% (19%)",
        },
        contact: { id: CONTACTS.usSaas.id, name: "Beispiel Lieferant AG" },
        net: euro("500.00"),
        tax: euro("95.00"),
        link: "https://my.sevdesk.de/ex/detail/id/5102",
      },
    ]);
    expect(rule14?.records.map((record) => [record.id, record.taxPoint])).toEqual([
      [5101, "2026-02-10"],
      [5106, "2026-03-20"],
    ]);
    // The credit note reduces the base it belongs to.
    expect(rule21?.records.map((record) => [record.id, record.net?.amount])).toEqual([
      [5201, "800.00"],
      [5301, "-100.00"],
    ]);
    expect(rule21?.records[0]?.link).toBe("https://my.sevdesk.de/fi/detail/type/RE/id/5201");
  });

  it("flags rule 13 on a regular account and explains when it is right", async () => {
    const { result } = await audit([regularAccount, ...routes()]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      check: "reverse_charge",
      code: "reverse_charge_without_deduction",
      severity: "check",
      contact: { id: CONTACTS.german.id },
      documents: 1,
      records: [{ id: 5103 }],
    });
    expect(result.findings[0]?.reason).toContain("§ 15 Abs. 1 Satz 1 Nr. 4 UStG");
    expect(result.findings[0]?.reason).toContain("§ 15 Abs. 2 UStG");
    expect(REVERSE_CHARGE_FINDING_CODES).toContain(result.findings[0]?.code);
  });

  it("does not flag rule 13 on a Kleinunternehmer account", async () => {
    const { result } = await audit([smallBusinessAccount, ...routes()]);
    expect(result.findings).toEqual([]);
    expect(result.regime).toBe("small_business");
  });

  it("counts what it read and explains the tax point", async () => {
    const { result } = await audit([regularAccount, ...routes()]);

    expect(result.coverage).toMatchObject({
      documentsInScope: 7,
      documentsChecked: 7,
      documentsLeftOut: 0,
      truncated: false,
    });
    expect(result.coverage.notJudged).toBeUndefined();
    const notes = result.notes.join(" ");
    expect(notes).toContain("§ 13b Abs. 1 UStG");
    expect(notes).toContain("computed here at 19 %");
    expect(notes).toContain("Rule 13 is reported under Kz 84/85");
  });

  it("returns an empty section when the period has no reverse charge", async () => {
    const { result } = await audit([regularAccount, ...scenarioRoutes({})]);
    expect(result.reverseCharge).toEqual({
      received: [],
      issued: [],
      totals: { base: euro("0.00"), tax: euro("0.00"), inputTax: euro("0.00") },
    });
    expect(result.findings).toEqual([]);
  });

  it("lists at most 50 documents per rule and counts the rest", async () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      purchase(6000 + index, 14, "2026-02-10", "10", CONTACTS.irishSaas.id),
    );
    const { result } = await audit([regularAccount, ...scenarioRoutes({ vouchers: many })]);
    const rule14 = result.reverseCharge?.received[0];

    expect(rule14).toMatchObject({ documents: 51, recordsOmitted: 1, base: euro("510.00") });
    expect(rule14?.records).toHaveLength(50);
  });

  it("names Update 1.0 documents of tax type eu it cannot place", async () => {
    const legacy = {
      row: voucherDoc(
        { id: 7001, date: "2026-02-01", rule: null, net: "50", tax: "0" },
        {
          taxType: "eu",
        },
      ),
      positions: [],
    };
    const { result } = await audit([regularAccount, ...scenarioRoutes({ vouchers: [legacy] })]);
    expect(result.notes.join(" ")).toContain("1 Update 1.0 document dated in the period");
  });

  it("says how much a cap or the time budget left out", async () => {
    const capped = await audit([regularAccount, ...routes()], { maxDocuments: 2 });
    expect(capped.result.coverage).toMatchObject({ documentsLeftOut: 5, truncated: true });
    expect(capped.result.notes.join(" ")).toContain("(cap of 2 documents per request)");

    const late = await audit([regularAccount, ...routes()], undefined, {
      deadline: { at: 0, now: () => 1 },
    });
    expect(late.result.coverage).toMatchObject({ truncated: true, timeBudgetReached: true });
    expect(late.result.reverseCharge?.received).toEqual([]);
  });
});

describe("kennzahlenOf", () => {
  it("knows the form lines of every § 13b rule", () => {
    expect(kennzahlenOf(12, "expense")).toEqual({ baseKz: "84", taxKz: "85", inputTaxKz: "67" });
    expect(kennzahlenOf(13, "expense")).toEqual({ baseKz: "84", taxKz: "85" });
    expect(kennzahlenOf(14, "expense")).toEqual({ baseKz: "46", taxKz: "47", inputTaxKz: "67" });
    expect(kennzahlenOf(5, "revenue")).toEqual({ baseKz: "60" });
    expect(kennzahlenOf(21, "revenue")).toEqual({ baseKz: "21" });
    expect(() => kennzahlenOf(9, "expense")).toThrow("has no line");
  });
});
