import { describe, expect, it } from "vitest";

import type { AccountSettings } from "../../../../src/domain/account-settings.js";
import { decimal } from "../../../../src/domain/money.js";
import type {
  DocumentHeader,
  DocumentPayment,
  PaymentsInPeriod,
} from "../../../../src/domain/reports/positions-scan.js";
import {
  lastDayOfMonth,
  resolvePeriod,
  taxPoint,
  VAT_CAVEAT,
  type VatSummary,
  vatSummary,
  vatSummarySentence,
} from "../../../../src/domain/reports/vat.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  byIdRoutes,
  creditNoteDoc,
  creditNotePositions,
  invoiceDoc,
  invoicePositions,
  type ScenarioDocument,
  scenarioRoutes,
  voucherDoc,
  voucherPositions,
} from "./builders.js";

const REGULAR: AccountSettings = { smallBusiness: false, chartOfAccounts: "skr04" };
const SMALL: AccountSettings = { smallBusiness: true };
const Q1 = resolvePeriod({ year: 2026, quarter: 1 });
const TODAY = "2026-11-08";

describe("resolvePeriod", () => {
  it("resolves months, quarters, years and ranges", () => {
    expect(resolvePeriod({ year: 2026, month: 2 })).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
      label: "2026-02",
    });
    expect(resolvePeriod({ year: 2028, month: 2 }).to).toBe("2028-02-29");
    expect(resolvePeriod({ year: 2026, quarter: 4 })).toEqual({
      from: "2026-10-01",
      to: "2026-12-31",
      label: "2026-Q4",
    });
    expect(resolvePeriod({ year: 2026 })).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
      label: "2026",
    });
    expect(resolvePeriod({ from: "2026-01-15", to: "2026-02-14" })).toEqual({
      from: "2026-01-15",
      to: "2026-02-14",
      label: "2026-01-15 to 2026-02-14",
    });
  });

  it.each([
    [{}, "either year"],
    [{ year: 2026, from: "2026-01-01" }, "either year"],
    [{ from: "2026-01-01" }, "both from and to"],
    [{ from: "2026-01-01", to: "2026-01-31", month: 1 }, "month and quarter go with year"],
    [{ from: "2026-02-01", to: "2026-01-31" }, "from is after to"],
    [{ year: 2026, month: 1, quarter: 1 }, "month or quarter, not both"],
  ])("refuses %j", (input, message) => {
    expect(() => resolvePeriod(input)).toThrow(message);
  });

  it("knows the last day of a month", () => {
    expect(lastDayOfMonth("2026-12-05")).toBe("2026-12-31");
    expect(lastDayOfMonth("2026-04-30")).toBe("2026-04-30");
  });
});

describe("taxPoint", () => {
  const header = (overrides: Partial<DocumentHeader>): DocumentHeader => ({
    kind: "invoice",
    id: 1,
    statusCode: 200,
    currency: "EUR",
    direction: "revenue",
    sign: 1,
    eur: { net: decimal(1), tax: decimal(0), gross: decimal(1) },
    gross: decimal(1),
    date: "2026-03-10",
    ...overrides,
  });

  it("supply: the end of the supply, else the document date", () => {
    expect(taxPoint(header({ deliveryDate: "2026-02-20" }), "supply")).toEqual({
      date: "2026-02-20",
      by: "delivery",
    });
    expect(
      taxPoint(header({ deliveryDate: "2026-02-01", deliveryDateUntil: "2026-04-30" }), "supply"),
    ).toEqual({ date: "2026-04-30", by: "delivery" });
    expect(taxPoint(header({}), "supply")).toEqual({ date: "2026-03-10", by: "document" });
    expect(taxPoint(header({ date: undefined, deliveryDate: "2026-02-20" }), "supply")).toEqual({
      date: "2026-02-20",
      by: "delivery",
    });
  });

  it("supply_and_invoice: the later of document and supply", () => {
    expect(taxPoint(header({ deliveryDate: "2026-04-02" }), "supply_and_invoice").date).toBe(
      "2026-04-02",
    );
    expect(taxPoint(header({ deliveryDate: "2026-02-02" }), "supply_and_invoice")).toEqual({
      date: "2026-03-10",
      by: "document",
    });
  });

  it("invoice_or_next_month: the document date, at the latest the month after the supply", () => {
    expect(taxPoint(header({ deliveryDate: "2026-03-01" }), "invoice_or_next_month")).toEqual({
      date: "2026-03-10",
      by: "document",
    });
    expect(taxPoint(header({ deliveryDate: "2026-01-05" }), "invoice_or_next_month")).toEqual({
      date: "2026-02-28",
      by: "delivery",
    });
    expect(
      taxPoint(header({ date: undefined, deliveryDate: "2026-01-05" }), "invoice_or_next_month"),
    ).toEqual({ date: "2026-02-28", by: "delivery" });
  });

  it("corrections count at their own document date", () => {
    expect(taxPoint(header({ invoiceType: "SR", deliveryDate: "2025-12-01" }), "supply")).toEqual({
      date: "2026-03-10",
      by: "document",
    });
    expect(
      taxPoint(header({ kind: "credit_note", sign: -1, deliveryDate: "2025-12-01" }), "supply"),
    ).toEqual({ date: "2026-03-10", by: "document" });
  });
});

function box(report: VatSummary, kz: string) {
  const found = report.boxes.find((entry) => entry.kz === kz);
  return found === undefined
    ? undefined
    : { base: found.base?.amount, tax: found.tax?.amount, documents: found.documents };
}

/** `GET /StaticCountry` as recorded on the trial account (Austria is id 3). */
const countries: FakeRoute = {
  path: "/StaticCountry",
  response: { fixture: "recorded/2026-11-07/meta/static-countries.json" },
};

const contact77: FakeRoute = {
  path: "/Contact/77",
  response: {
    body: {
      objects: [{ id: "77", objectName: "Contact", name: "Client SA", vatNumber: "FR 123" }],
    },
  },
};

const doc = (
  row: Record<string, unknown>,
  positions: readonly Record<string, unknown>[],
): ScenarioDocument => ({
  row,
  positions,
});

function quarterScenario(): Parameters<typeof scenarioRoutes>[0] {
  return {
    invoices: [
      doc(
        invoiceDoc({ id: 1, date: "2026-02-10", net: "1000", tax: "190" }),
        invoicePositions(1, [{ rate: "19", net: "1000", tax: "190" }]),
      ),
      doc(
        invoiceDoc({ id: 2, date: "2026-03-01", net: "300", tax: "33" }),
        invoicePositions(2, [
          { rate: "19", net: "100", tax: "19" },
          { rate: "7", net: "200", tax: "14" },
        ]),
      ),
      doc(
        invoiceDoc({ id: 3, date: "2026-01-15", net: "500", tax: "0" }),
        invoicePositions(3, [{ rate: "0", net: "500", tax: "0" }]),
      ),
      doc(
        invoiceDoc({ id: 4, date: "2026-01-20", net: "100", tax: "16" }),
        invoicePositions(4, [{ rate: "16", net: "100", tax: "16" }]),
      ),
      doc(
        invoiceDoc({
          id: 5,
          date: "2026-02-01",
          rule: 3,
          net: "2000",
          tax: "0",
          vatNumber: "ATU12345678",
        }),
        invoicePositions(5, [{ rate: "0", net: "2000", tax: "0" }]),
      ),
      doc(
        invoiceDoc({
          id: 6,
          date: "2026-02-03",
          rule: 21,
          net: "300",
          tax: "0",
          contactId: 77,
          embed: false,
        }),
        invoicePositions(6, [{ rate: "0", net: "300", tax: "0" }]),
      ),
      doc(
        invoiceDoc({ id: 7, date: "2026-02-05", rule: 18, net: "100", tax: "20", countryId: 3 }),
        invoicePositions(7, [{ rate: "20", net: "100", tax: "20" }]),
      ),
      doc(
        invoiceDoc({ id: 8, date: "2026-03-20", rule: 2, net: "400", tax: "0" }),
        invoicePositions(8, [{ rate: "0", net: "400", tax: "0" }]),
      ),
      // Delivered in December 2025, invoiced in January: belongs to Q4 2025.
      doc(
        invoiceDoc({ id: 9, date: "2026-01-08", delivery: "2025-12-20", net: "800", tax: "152" }),
        invoicePositions(9, [{ rate: "19", net: "800", tax: "152" }]),
      ),
      // Invoiced in April for a March delivery: belongs to Q1.
      doc(
        invoiceDoc({ id: 10, date: "2026-04-05", delivery: "2026-03-28", net: "50", tax: "9.5" }),
        invoicePositions(10, [{ rate: "19", net: "50", tax: "9.5" }]),
      ),
      // Cancellation of a December invoice: counts when it is issued.
      doc(
        invoiceDoc(
          { id: 11, date: "2026-03-15", delivery: "2025-12-01", net: "-1000", tax: "-190" },
          { invoiceType: "SR", origin: { id: "900", objectName: "Invoice" } },
        ),
        invoicePositions(11, [{ rate: "19", net: "-1000", tax: "-190" }]),
      ),
      doc(invoiceDoc({ id: 12, date: "2026-02-10", net: "70", tax: "13.3", status: "100" }), []),
    ],
    creditNotes: [
      doc(
        creditNoteDoc({ id: 21, date: "2026-03-02", net: "20", tax: "3.8" }),
        creditNotePositions(21, [{ rate: "19", net: "20", tax: "3.8" }]),
      ),
      doc(
        creditNoteDoc({
          id: 22,
          date: "2026-03-03",
          rule: 3,
          net: "100",
          tax: "0",
          vatNumber: "ATU12345678",
        }),
        creditNotePositions(22, [{ rate: "0", net: "100", tax: "0" }]),
      ),
    ],
    vouchers: [
      doc(
        voucherDoc({ id: 31, date: "2026-02-11", net: "100", tax: "19" }),
        voucherPositions(31, [{ rate: "19", net: "100", tax: "19" }]),
      ),
      doc(
        voucherDoc({ id: 32, date: "2026-02-12", rule: 14, net: "1000", tax: "0" }),
        voucherPositions(32, [{ rate: "0", net: "1000", tax: "0" }]),
      ),
      doc(
        voucherDoc({ id: 33, date: "2026-02-13", rule: 8, net: "500", tax: "0" }),
        voucherPositions(33, [{ rate: "0", net: "500", tax: "0" }]),
      ),
      doc(
        voucherDoc({ id: 34, date: "2026-02-14", rule: 13, net: "200", tax: "0" }),
        voucherPositions(34, [{ rate: "0", net: "200", tax: "0" }]),
      ),
      doc(
        voucherDoc({ id: 35, date: "2026-02-15", rule: 10, net: "50", tax: "0" }),
        voucherPositions(35, [{ rate: "0", net: "50", tax: "0" }]),
      ),
      doc(
        voucherDoc({ id: 36, date: "2026-02-16", rule: 16, net: "80", tax: "0" }),
        voucherPositions(36, [{ rate: "0", net: "80", tax: "0" }]),
      ),
      doc(
        voucherDoc({ id: 37, date: "2026-02-17", rule: 1, net: "10", tax: "1.9" }),
        voucherPositions(37, [{ rate: "19", net: "10", tax: "1.9" }]),
      ),
      doc(
        voucherDoc({ id: 38, date: "2026-02-18", rule: 1, kind: "D", net: "10", tax: "1.9" }),
        voucherPositions(38, [{ rate: "19", net: "10", tax: "1.9" }]),
      ),
      doc(voucherDoc({ id: 39, date: "2026-02-18", net: "10", tax: "1.9", status: "50" }), []),
    ],
  };
}

describe("vatSummary (accrual)", () => {
  it("fills every line from a mixed quarter and estimates Kz 83", async () => {
    const client = new FakeSevdeskClient([
      ...scenarioRoutes(quarterScenario()),
      countries,
      contact77,
    ]);
    const progress: number[] = [];

    const report = await vatSummary(
      client,
      { period: Q1, settings: REGULAR, today: TODAY },
      { onProgress: (done) => void progress.push(done) },
    );

    expect(report).toMatchObject({
      applicable: true,
      basis: "accrual",
      basisSource: "default",
      regime: "regular",
      caveat: VAT_CAVEAT,
      period: { from: "2026-01-01", to: "2026-03-31", label: "2026-Q1" },
    });
    expect(box(report, "81")).toEqual({ base: "140.00", tax: "26.60", documents: 6 });
    expect(box(report, "86")).toEqual({ base: "200.00", tax: "14.00", documents: 1 });
    // Rule 1 at 0 % is not placed in Kz 87 (solar only): it is listed as unmapped.
    expect(box(report, "87")).toBeUndefined();
    expect(box(report, "35")).toEqual({ base: "100.00", tax: "16.00", documents: 1 });
    expect(box(report, "41")).toEqual({ base: "1900.00", tax: undefined, documents: 2 });
    expect(box(report, "43")).toEqual({ base: "400.00", tax: undefined, documents: 1 });
    expect(box(report, "21")).toEqual({ base: "300.00", tax: undefined, documents: 1 });
    expect(box(report, "45")).toEqual({ base: "100.00", tax: undefined, documents: 1 });
    expect(box(report, "46")).toEqual({ base: "1000.00", tax: "190.00", documents: 1 });
    expect(box(report, "84")).toEqual({ base: "200.00", tax: "38.00", documents: 1 });
    expect(box(report, "89")).toEqual({ base: "500.00", tax: "95.00", documents: 1 });
    expect(box(report, "66")).toEqual({ base: undefined, tax: "19.00", documents: 1 });
    expect(box(report, "61")).toEqual({ base: undefined, tax: "95.00", documents: 1 });
    expect(box(report, "67")).toEqual({ base: undefined, tax: "190.00", documents: 1 });
    expect(report.boxes.find((entry) => entry.kz === "35")?.taxKz).toBe("36");
    expect(report.boxes.find((entry) => entry.kz === "81")?.taxComputedOnForm).toBe(true);
    expect(report.boxes.find((entry) => entry.kz === "46")?.recipientTaxAssumed).toBe(true);
    expect(report.estimate).toEqual({
      outputVat: { amount: "379.60", currency: "EUR" },
      inputVat: { amount: "304.00", currency: "EUR" },
      kz83: { amount: "75.60", currency: "EUR" },
    });

    expect(report.zm).toEqual({
      entries: [
        {
          vatId: "ATU12345678",
          country: "AT",
          kind: "L",
          amount: { amount: "1900.00", currency: "EUR" },
          documents: 2,
        },
        {
          vatId: "FR123",
          country: "FR",
          kind: "S",
          amount: { amount: "300.00", currency: "EUR" },
          documents: 1,
        },
      ],
    });
    expect(report.oss).toEqual([
      {
        country: "AT",
        lines: [
          {
            rate: "20",
            net: { amount: "100.00", currency: "EUR" },
            tax: { amount: "20.00", currency: "EUR" },
          },
        ],
        documents: 1,
      },
    ]);
    expect(
      report.notInUstva.map((entry) => [entry.taxRule.id, entry.net.amount, entry.documents]),
    ).toEqual([
      [10, "50.00", 1],
      [16, "80.00", 1],
    ]);
    expect(report.unmapped).toEqual([
      {
        taxRule: { id: 1, name: "Umsatzsteuerpflichtige Umsätze" },
        direction: "revenue",
        rate: "0",
        net: { amount: "500.00", currency: "EUR" },
        tax: { amount: "0.00", currency: "EUR" },
        documents: 1,
        reason: expect.stringContaining("only solar installations are taxed at 0 %") as unknown,
      },
      {
        taxRule: { id: 1, name: "Umsatzsteuerpflichtige Umsätze" },
        direction: "expense",
        rate: "19",
        net: { amount: "10.00", currency: "EUR" },
        tax: { amount: "1.90", currency: "EUR" },
        documents: 1,
        reason: "Tax rule 1 is a revenue rule but was used on an expense.",
      },
    ]);
    expect(report.coverage).toMatchObject({
      rowsRead: 23,
      documentsInPeriod: 20,
      documentsScanned: 20,
      truncated: false,
      excluded: { drafts: 2, recurringTemplates: 0, reminders: 0, unknownDirection: 0 },
      unconvertibleCount: 0,
      datedBy: { delivery: 12, document: 8 },
    });
    expect(report.notes.join(" ")).toContain("computed here at 19 %");
    expect(report.notes.join(" ")).toContain("Rule 13");
    expect(report.notes.join(" ")).toContain("Basis accrual (Sollversteuerung) by default");
    expect(client.callsTo("/Contact/77")).toHaveLength(1);
    expect(progress.length).toBeGreaterThan(0);
    expect(client.writes()).toEqual([]);
    // Documents are listed with a margin around the period.
    const invoiceQuery = client.callsTo("/Invoice")[0]?.query;
    expect(invoiceQuery?.["startDate"]).toBeLessThan(
      Date.parse("2026-01-01T00:00:00+01:00") / 1000 - 86_400 * 60,
    );
    expect(vatSummarySentence(report)).toBe(
      "VAT summary 2026-Q1 (accrual): 20 documents scanned, 13 form lines; Kz 83 estimate 75.60 EUR.",
    );
  });

  it("reports ZM documents without VAT id, German VAT ids and tax on tax-free lines", async () => {
    const client = new FakeSevdeskClient([
      ...scenarioRoutes({
        invoices: [
          doc(
            invoiceDoc({
              id: 1,
              date: "2026-02-01",
              rule: 3,
              net: "100",
              tax: "19",
              vatNumber: null,
            }),
            invoicePositions(1, [{ rate: "19", net: "100", tax: "19" }]),
          ),
          doc(
            invoiceDoc({
              id: 2,
              date: "2026-02-01",
              rule: 21,
              net: "50",
              tax: "0",
              vatNumber: "DE000000000",
            }),
            invoicePositions(2, [{ rate: "0", net: "50", tax: "0" }]),
          ),
        ],
      }),
    ]);

    const report = await vatSummary(client, { period: Q1, settings: REGULAR, today: TODAY });

    expect(report.zm.withoutVatId).toEqual({
      documents: 1,
      amount: { amount: "100.00", currency: "EUR" },
    });
    expect(report.zm.entries).toHaveLength(1);
    const notes = report.notes.join(" ");
    expect(notes).toContain("German VAT id");
    expect(notes).toContain("carried VAT in sevDesk");
  });

  it("lists unconvertible foreign documents, documents without rule and OSS without country", async () => {
    const client = new FakeSevdeskClient([
      ...scenarioRoutes({
        invoices: [
          doc(invoiceDoc({ id: 1, date: "2026-02-01", currency: "CHF", net: "100", tax: "0" }), []),
          doc(
            invoiceDoc({ id: 2, date: "2026-02-01", rule: null, net: "100", tax: "19" }),
            invoicePositions(2, [{ rate: "19", net: "100", tax: "19" }]),
          ),
          doc(
            invoiceDoc({ id: 3, date: "2026-02-01", rule: 19, net: "10", tax: "2" }),
            invoicePositions(3, [{ rate: "20", net: "10", tax: "2" }]),
          ),
          doc(
            invoiceDoc(
              { id: 4, date: "2026-02-01", rule: null, net: "70", tax: "0" },
              { taxType: "eu" },
            ),
            invoicePositions(4, [{ rate: "0", net: "70", tax: "0" }]),
          ),
        ],
      }),
      countries,
    ]);

    const report = await vatSummary(client, { period: Q1, settings: undefined, today: TODAY });

    expect(report.coverage.unconvertible).toEqual([
      { objectName: "Invoice", id: 1, number: "RE-1" },
    ]);
    const noRule = report.unmapped.find((entry) => entry.reason.startsWith("The document has no"));
    expect(noRule).toMatchObject({ net: { amount: "100.00", currency: "EUR" } });
    expect(noRule?.taxRule).toBeUndefined();
    expect(report.unmapped.find((entry) => entry.reason.startsWith("Update 1.0"))).toMatchObject({
      net: { amount: "70.00", currency: "EUR" },
      reason: expect.stringContaining("eu (intra-EU) does not tell goods from services") as unknown,
    });
    expect(report.coverage.legacyTaxTypes).toBe(1);
    expect(report.oss[0]?.country).toBe("unknown");
    expect(report.regime).toBeUndefined();
    const notes = report.notes.join(" ");
    // OSS sales carry the destination country's VAT: no "tax on a tax-free line" warning.
    expect(notes).not.toContain("carried VAT");
    expect(notes).toContain("could not be read");
    expect(notes).toContain("without EUR values");
  });

  it("says when a cap stopped reading", async () => {
    const invoices = Array.from({ length: 3 }, (_, index) =>
      doc(
        invoiceDoc({ id: index + 1, date: "2026-02-01", net: "10", tax: "1.9" }),
        invoicePositions(index + 1, [{ rate: "19", net: "10", tax: "1.9" }]),
      ),
    );
    const client = new FakeSevdeskClient(scenarioRoutes({ invoices }));

    const report = await vatSummary(client, {
      period: Q1,
      settings: REGULAR,
      maxDocuments: 2,
      today: TODAY,
    });

    expect(report.coverage.truncated).toBe(true);
    expect(report.coverage.documentsScanned).toBe(2);
    expect(report.estimate).toBeUndefined();
    expect(report.notes.join(" ")).toContain("Kz 83 is not estimated");
    expect(vatSummarySentence(report)).toContain("Incomplete: a cap stopped reading.");
  });

  it("requires no UStVA from a Kleinunternehmer whose period has only § 19 amounts", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        invoices: [
          doc(
            invoiceDoc({ id: 1, date: "2026-02-01", rule: 11, net: "300", tax: "0" }),
            invoicePositions(1, [{ rate: "0", net: "300", tax: "0" }]),
          ),
        ],
        vouchers: [
          doc(
            voucherDoc({ id: 31, date: "2026-02-11", rule: 10, net: "40", tax: "0" }),
            voucherPositions(31, [{ rate: "0", net: "40", tax: "0" }]),
          ),
        ],
      }),
    );

    const report = await vatSummary(client, { period: Q1, settings: SMALL, today: TODAY });

    expect(report).toMatchObject({ applicable: false, regime: "small_business" });
    expect(report.boxes.map((entry) => entry.kz)).toEqual(["48"]);
    expect(report.estimate).toBeUndefined();
    expect(report.notes[0]).toContain("no taxable or reverse-charge amounts");
    expect(vatSummarySentence(report)).toBe(
      "VAT summary 2026-Q1: Kleinunternehmer account without taxable amounts in the period, no " +
        "UStVA required.",
    );
  });

  it("does not confirm 'no UStVA' for a Kleinunternehmer when a cap stopped reading", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        invoices: [
          doc(
            invoiceDoc({ id: 1, date: "2026-02-01", rule: 11, net: "300", tax: "0" }),
            invoicePositions(1, [{ rate: "0", net: "300", tax: "0" }]),
          ),
          doc(
            invoiceDoc({ id: 2, date: "2026-02-02", rule: 11, net: "100", tax: "0" }),
            invoicePositions(2, [{ rate: "0", net: "100", tax: "0" }]),
          ),
        ],
      }),
    );

    const report = await vatSummary(client, {
      period: Q1,
      settings: SMALL,
      today: TODAY,
      maxDocuments: 1,
    });

    expect(report.coverage.truncated).toBe(true);
    expect(report.applicable).toBe(true);
    expect(report.notes[0]).toContain("could not be confirmed");
    expect(vatSummarySentence(report)).not.toContain("no UStVA required");
  });

  it("computes the UStVA of a Kleinunternehmer whose period has § 13b tax or taxable sales", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        vouchers: [
          doc(
            voucherDoc({ id: 31, date: "2026-02-11", rule: 13, net: "100", tax: "0" }),
            voucherPositions(31, [{ rate: "0", net: "100", tax: "0" }]),
          ),
        ],
      }),
    );

    const report = await vatSummary(client, { period: Q1, settings: SMALL, today: TODAY });

    expect(report.applicable).toBe(true);
    expect(box(report, "84")).toEqual({ base: "100.00", tax: "19.00", documents: 1 });
    expect(report.estimate?.kz83).toEqual({ amount: "19.00", currency: "EUR" });
    expect(report.notes[0]).toContain("Kleinunternehmerregelung today");
    expect(report.notes[0]).toContain("Kz 84");
  });
});

describe("vatSummary with the recorded VoucherPos shape", () => {
  it("reports a §13b service booked at 0 % under Kz 46/47 and 67", async () => {
    const client = new FakeSevdeskClient([
      ...scenarioRoutes({
        vouchers: [
          doc(voucherDoc({ id: 2101, date: "2026-02-12", rule: 14, net: "1000", tax: "0" }), []),
        ],
      }).filter((route) => route.path !== "/VoucherPos"),
      {
        path: "/VoucherPos",
        query: { "voucher[id]": "2101" },
        response: { fixture: "reports/voucher-positions-reverse-charge.json" },
      },
    ]);

    const report = await vatSummary(client, { period: Q1, settings: REGULAR, today: TODAY });

    expect(box(report, "46")).toEqual({ base: "1000.00", tax: "190.00", documents: 1 });
    expect(box(report, "67")).toEqual({ base: undefined, tax: "190.00", documents: 1 });
    expect(report.estimate?.kz83).toEqual({ amount: "0.00", currency: "EUR" });
  });
});

describe("vatSummary (cash)", () => {
  const payment = (
    objectName: DocumentPayment["document"]["objectName"],
    id: number,
    amount: string,
    signed = amount,
  ): DocumentPayment => ({
    date: "2026-02-20",
    document: { objectName, id },
    amount: { amount, currency: "EUR" },
    direction: signed.startsWith("-") ? "out" : "in",
    signedForDocument: { amount: signed, currency: "EUR" },
    transactionId: 700 + id,
    checkAccountId: undefined,
  });

  it("counts rule-1 revenue by payment and everything else by accrual", async () => {
    const listed = {
      invoices: [
        doc(
          invoiceDoc({ id: 1, date: "2026-02-10", net: "1000", tax: "190" }),
          invoicePositions(1, [{ rate: "19", net: "1000", tax: "190" }]),
        ),
        // Unpaid: no VAT under the cash basis.
        doc(
          invoiceDoc({ id: 2, date: "2026-02-11", net: "100", tax: "19" }),
          invoicePositions(2, [{ rate: "19", net: "100", tax: "19" }]),
        ),
        doc(
          invoiceDoc({
            id: 3,
            date: "2026-02-12",
            rule: 3,
            net: "500",
            tax: "0",
            vatNumber: "ATU1",
          }),
          invoicePositions(3, [{ rate: "0", net: "500", tax: "0" }]),
        ),
      ],
      vouchers: [
        doc(
          voucherDoc({ id: 31, date: "2026-02-11", net: "100", tax: "19" }),
          voucherPositions(31, [{ rate: "19", net: "100", tax: "19" }]),
        ),
      ],
    };
    // Invoiced in December, paid in February: fetched by id.
    const older = doc(
      invoiceDoc({ id: 50, date: "2025-11-01", net: "200", tax: "14" }),
      invoicePositions(50, [{ rate: "7", net: "200", tax: "14" }]),
    );
    const client = new FakeSevdeskClient([
      ...scenarioRoutes(listed),
      ...byIdRoutes({ invoices: [older] }),
      {
        path: "/InvoicePos",
        query: { "invoice[id]": "50" },
        response: { body: { objects: older.positions } },
      },
    ]);
    const ranges: unknown[] = [];
    let direction: ((id: number) => "in" | "out" | undefined) | undefined;
    const payments: PaymentsInPeriod = (_client, range, options) => {
      ranges.push(range);
      direction = options?.voucherDirection;
      return Promise.resolve({
        payments: [
          payment("Invoice", 1, "595"),
          // A bounced direct debit on invoice 1, and its replacement payment.
          payment("Invoice", 1, "119", "-119"),
          payment("Invoice", 1, "119"),
          payment("Invoice", 50, "214"),
          payment("Voucher", 31, "119"),
          payment("Invoice", 3, "500"),
        ],
        truncated: false,
        notes: ["1 booked transaction had no log entries."],
        transactionsScanned: 9,
        transactionsRead: 0,
      });
    };

    const report = await vatSummary(client, {
      period: Q1,
      basis: "cash",
      settings: REGULAR,
      payments,
      today: TODAY,
    });

    expect(ranges).toEqual([Q1]);
    expect(direction?.(31)).toBe("out");
    expect(box(report, "81")).toEqual({ base: "500.00", tax: "95.00", documents: 1 });
    expect(box(report, "86")).toEqual({ base: "200.00", tax: "14.00", documents: 1 });
    expect(box(report, "41")).toEqual({ base: "500.00", tax: undefined, documents: 1 });
    expect(box(report, "66")).toEqual({ base: undefined, tax: "19.00", documents: 1 });
    expect(report.coverage.payments).toEqual({
      read: 6,
      used: 4,
      documentsFetched: 1,
      truncated: false,
    });
    expect(report.basisSource).toBe("requested");
    const notes = report.notes.join(" ");
    expect(notes).toContain("1 booked transaction had no log entries.");
    expect(notes).toContain("Cash basis: taxable revenue (rule 1) counts on the payment day");
  });

  it("refuses the cash basis without a payment source", async () => {
    await expect(
      vatSummary(new FakeSevdeskClient([]), { period: Q1, basis: "cash", settings: REGULAR }),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});
