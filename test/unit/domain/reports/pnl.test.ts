import { describe, expect, it } from "vitest";

import type { AccountDatevList } from "../../../../src/domain/accounts-datev.js";
import {
  PNL_CAVEAT,
  profitAndLoss,
  profitAndLossSentence,
} from "../../../../src/domain/reports/pnl.js";
import type {
  DocumentPayment,
  PaymentsInPeriod,
} from "../../../../src/domain/reports/positions-scan.js";
import { resolvePeriod } from "../../../../src/domain/reports/vat.js";
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

const Q1 = resolvePeriod({ year: 2026, quarter: 1 });
const TODAY = "2026-11-08";
const EUR = (amount: string) => ({ amount, currency: "EUR" });

const accounts: AccountDatevList = {
  accounts: [
    { id: 4930, number: "6815", name: "Bürobedarf", kind: "expense", active: true },
    { id: 135, number: "135", name: "EDV-Software", kind: "asset", active: true },
  ],
  truncated: false,
};

const doc = (
  row: Record<string, unknown>,
  positions: readonly Record<string, unknown>[],
): ScenarioDocument => ({ row, positions });

function scenario() {
  return {
    invoices: [
      doc(
        invoiceDoc({ id: 1, date: "2026-02-10", net: "1000", tax: "190" }),
        invoicePositions(1, [{ rate: "19", net: "1000", tax: "190" }]),
      ),
      doc(
        invoiceDoc({ id: 2, date: "2026-02-11", rule: 3, net: "500", tax: "0" }),
        invoicePositions(2, [{ rate: "0", net: "500", tax: "0" }]),
      ),
    ],
    creditNotes: [
      doc(
        creditNoteDoc({ id: 21, date: "2026-03-02", net: "20", tax: "3.8" }),
        creditNotePositions(21, [{ rate: "19", net: "20", tax: "3.8" }]),
      ),
      doc(
        creditNoteDoc({ id: 22, date: "2026-03-03", rule: 9, net: "40", tax: "7.6" }),
        creditNotePositions(22, [{ rate: "19", net: "40", tax: "7.6" }]),
      ),
    ],
    vouchers: [
      doc(
        voucherDoc({ id: 31, date: "2026-02-11", net: "100", tax: "19" }),
        voucherPositions(31, [{ rate: "19", net: "100", tax: "19", account: 4930 }]),
      ),
      doc(
        voucherDoc({ id: 32, date: "2026-02-12", net: "1050", tax: "199.5" }),
        voucherPositions(32, [
          { rate: "19", net: "50", tax: "9.5", account: 4930 },
          { rate: "19", net: "1000", tax: "190", account: 135, asset: true },
        ]),
      ),
      doc(
        voucherDoc({ id: 33, date: "2026-02-13", rule: 10, net: "10", tax: "1.9" }),
        voucherPositions(33, [{ rate: "19", net: "10", tax: "1.9", account: 4900 }]),
      ),
      doc(
        voucherDoc({ id: 34, date: "2026-02-14", rule: 15, net: "500", tax: "0" }),
        voucherPositions(34, [{ rate: "0", net: "500", tax: "0", account: 3820 }]),
      ),
      doc(
        voucherDoc({ id: 35, date: "2026-02-15", rule: 15, kind: "D", net: "80", tax: "0" }),
        voucherPositions(35, [{ rate: "0", net: "80", tax: "0", account: 3820 }]),
      ),
      doc(
        voucherDoc({ id: 36, date: "2026-02-16", rule: 16, net: "300", tax: "0" }),
        voucherPositions(36, [{ rate: "0", net: "300", tax: "0", account: 2100 }]),
      ),
      doc(
        voucherDoc({ id: 37, date: "2026-02-17", rule: 1, kind: "D", net: "10", tax: "1.9" }),
        voucherPositions(37, [{ rate: "19", net: "10", tax: "1.9", account: 4400 }]),
      ),
      doc(
        voucherDoc({ id: 38, date: "2026-02-18", rule: 22, kind: "D", net: "5", tax: "0" }),
        voucherPositions(38, [{ rate: "0", net: "5", tax: "0", account: 1371 }]),
      ),
    ],
  };
}

describe("profitAndLoss (accrual)", () => {
  it("groups income by tax rule and expenses by booking account, assets and VAT apart", async () => {
    const client = new FakeSevdeskClient(scenarioRoutes(scenario()));

    const report = await profitAndLoss(client, {
      period: Q1,
      basis: "accrual",
      accounts,
      today: TODAY,
    });

    expect(report.caveat).toBe(PNL_CAVEAT);
    expect(report.income).toEqual({
      total: EUR("1490.00"),
      byTaxRule: [
        {
          taxRule: { id: 1, name: "Umsatzsteuerpflichtige Umsätze" },
          net: EUR("990.00"),
          documents: 3,
        },
        {
          taxRule: { id: 3, name: "Innergemeinschaftliche Lieferungen" },
          net: EUR("500.00"),
          documents: 1,
        },
      ],
    });
    expect(report.expenses).toEqual({
      total: EUR("201.90"),
      byAccount: [
        {
          account: { id: 4930, number: "6815", name: "Bürobedarf" },
          net: EUR("150.00"),
          documents: 2,
        },
        { account: {}, net: EUR("40.00"), documents: 1 },
        { account: { id: 4900 }, net: EUR("11.90"), documents: 1 },
      ],
    });
    expect(report.result).toEqual(EUR("1288.10"));
    expect(report.assets).toEqual([
      {
        account: { id: 135, number: "135", name: "EDV-Software" },
        net: EUR("1000.00"),
        documents: 1,
      },
    ]);
    expect(report.vatFlows).toEqual({
      collected: EUR("188.10"),
      inputVat: EUR("226.10"),
      paidToTaxOffice: EUR("500.00"),
      refundedByTaxOffice: EUR("80.00"),
    });
    expect(report.notOperating.map((entry) => [entry.taxRule.id, entry.net.amount])).toEqual([
      [16, "300.00"],
      [22, "5.00"],
    ]);
    expect(report.coverage).toMatchObject({ documentsScanned: 12, truncated: false, rowsRead: 12 });
    expect(report.coverage.payments).toBeUndefined();
    const notes = report.notes.join(" ");
    expect(notes).toContain("not expensed; depreciation (AfA) is not computed");
    expect(notes).toContain("Expenses without a booking account");
    expect(notes).toContain("Accrual basis");
    expect(profitAndLossSentence(report)).toBe(
      "Profit and loss 2026-Q1 (accrual): income 1490.00, expenses 201.90, result 1288.10 EUR " +
        "(net, before AfA); 12 documents scanned.",
    );
    expect(client.writes()).toEqual([]);
  });

  it("leaves accounts as ids without the account list and says when a cap stopped reading", async () => {
    const client = new FakeSevdeskClient(scenarioRoutes(scenario()));

    const report = await profitAndLoss(client, {
      period: Q1,
      basis: "accrual",
      maxDocuments: 2,
      today: TODAY,
    });

    expect(report.coverage.truncated).toBe(true);
    const notes = report.notes.join(" ");
    expect(notes).toContain("Booking accounts could not be read");
    expect(notes).toContain("Reading stopped at a cap");
    expect(profitAndLossSentence(report)).toContain("Incomplete");
  });

  it("lists foreign-currency documents without EUR values", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        invoices: [
          doc(invoiceDoc({ id: 1, date: "2026-02-10", currency: "USD", net: "10", tax: "0" }), []),
        ],
      }),
    );

    const report = await profitAndLoss(client, {
      period: Q1,
      basis: "accrual",
      accounts,
      today: TODAY,
    });

    expect(report.coverage.unconvertibleCount).toBe(1);
    expect(report.notes.join(" ")).toContain("without EUR values");
  });
});

describe("profitAndLoss (cash)", () => {
  const payment = (
    objectName: DocumentPayment["document"]["objectName"],
    id: number,
    amount: string,
    currency = "EUR",
    signed = amount,
  ): DocumentPayment => ({
    date: "2026-02-20",
    document: { objectName, id },
    amount: { amount, currency },
    direction: (objectName === "Invoice") === !signed.startsWith("-") ? "in" : "out",
    signedForDocument: { amount: signed, currency },
    transactionId: 800 + id,
    checkAccountId: undefined,
  });

  it("counts payments on their value date, split over the paid document's positions", async () => {
    const all = scenario();
    // Paid in the period but dated long before: read by id.
    const older = doc(
      invoiceDoc({ id: 70, date: "2025-06-01", net: "100", tax: "19" }),
      invoicePositions(70, [{ rate: "19", net: "100", tax: "19" }]),
    );
    const draft = doc(
      voucherDoc({ id: 60, date: "2026-02-01", net: "1", tax: "0.19", status: "50" }),
      [],
    );
    const client = new FakeSevdeskClient([
      ...scenarioRoutes(all),
      ...byIdRoutes({ invoices: [older], vouchers: [draft] }),
      {
        path: "/InvoicePos",
        query: { "invoice[id]": "70" },
        response: { body: { objects: older.positions } },
      },
    ]);
    let direction: ((id: number) => "in" | "out" | undefined) | undefined;
    const payments: PaymentsInPeriod = (_client, _range, options) => {
      direction = options?.voucherDirection;
      return Promise.resolve({
        payments: [
          payment("Invoice", 1, "595"),
          // A direct debit on invoice 2 that bounced: nets to nothing.
          payment("Invoice", 2, "500"),
          payment("Invoice", 2, "500", "EUR", "-500"),
          payment("Invoice", 70, "119"),
          payment("Voucher", 31, "119"),
          // The supplier refunded half of voucher 31.
          payment("Voucher", 31, "59.5", "EUR", "-59.5"),
          payment("CreditNote", 21, "23.8"),
          payment("Voucher", 60, "1.19"),
          payment("Voucher", 32, "10", "USD"),
        ],
        truncated: false,
        notes: [],
        transactionsScanned: 9,
        transactionsRead: 9,
      });
    };

    const report = await profitAndLoss(client, {
      period: Q1,
      basis: "cash",
      payments,
      accounts,
      today: TODAY,
    });

    expect(direction?.(31)).toBe("out");
    expect(direction?.(37)).toBe("in");
    expect(report.income.total).toEqual(EUR("580.00"));
    expect(report.expenses.total).toEqual(EUR("50.00"));
    expect(report.vatFlows.collected).toEqual(EUR("110.20"));
    expect(report.vatFlows.inputVat).toEqual(EUR("9.50"));
    expect(report.coverage.payments).toEqual({
      read: 9,
      used: 7,
      documentsFetched: 2,
      truncated: false,
    });
    expect(report.coverage.excluded.drafts).toBe(1);
    expect(report.coverage.rowsRead).toBe(12);
    const notes = report.notes.join(" ");
    expect(notes).toContain("1 payment in another currency");
    expect(notes).toContain("Cash basis: only payments sevDesk links to documents");
    // Listed from 62 days before the period on.
    expect(client.callsTo("/Invoice")[0]?.query["startDate"]).toBeLessThan(
      Date.parse("2025-11-01T00:00:00+01:00") / 1000,
    );
  });

  it("refuses the cash basis without a payment source", async () => {
    await expect(
      profitAndLoss(new FakeSevdeskClient([]), { period: Q1, basis: "cash" }),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("profitAndLoss: § 13b without deduction", () => {
  it("adds the VAT owed as recipient to the cost (19 % where sevDesk booked 0 %)", async () => {
    const client = new FakeSevdeskClient(
      scenarioRoutes({
        vouchers: [
          doc(
            voucherDoc({ id: 41, date: "2026-02-11", rule: 13, net: "100", tax: "0" }),
            voucherPositions(41, [{ rate: "0", net: "100", tax: "0", account: 4930 }]),
          ),
          doc(
            voucherDoc({ id: 42, date: "2026-02-12", rule: 13, net: "200", tax: "0" }),
            voucherPositions(42, [{ rate: "7", net: "200", tax: "0", account: 4930 }]),
          ),
        ],
      }),
    );

    const report = await profitAndLoss(client, {
      period: Q1,
      basis: "accrual",
      accounts,
      today: TODAY,
    });

    expect(report.expenses.total).toEqual(EUR("333.00"));
    expect(report.vatFlows.inputVat).toEqual(EUR("0.00"));
    expect(report.notes.join(" ")).toContain("tax rule 13");
  });
});
