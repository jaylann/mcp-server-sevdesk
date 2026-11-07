import { describe, expect, it } from "vitest";

import {
  collectPayables,
  type PayablesAging,
  payablesAging,
  type ReceivablesAging,
  receivablesAging,
} from "../../../../src/domain/reports/aging.js";
import { payablesAgingTool, receivablesAgingTool } from "../../../../src/tools/reports/aging.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { AS_OF, invoiceRoutes, pinToday, voucherRoutes } from "./open-items.js";
import { invoice, many, progressContext, rows, runTool, voucher } from "./records.js";

const eur = (amount: string) => ({ amount, currency: "EUR" });
const usd = (amount: string) => ({ amount, currency: "USD" });

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

pinToday();

describe("sevdesk_receivables_aging (community invoice shape, fake data)", () => {
  async function run(args: Record<string, unknown>, routes = invoiceRoutes) {
    const { client, result, data } = await runTool(receivablesAgingTool, args, routes);
    return { client, summary: result.summary, report: data as ReceivablesAging };
  }

  it("is a read tool of the reports toolset", () => {
    expect(receivablesAgingTool.toolset).toBe("reports");
    expect(receivablesAgingTool.tier).toBe("read");
    expect(receivablesAgingTool.annotations).toEqual(READ);
    expect(receivablesAgingTool.description).toContain("Forderungen");
  });

  it("reads open and partially paid invoices and buckets outstanding by days overdue", async () => {
    const { client, report, summary } = await run({ asOf: AS_OF });
    expect(client.callsTo("/Invoice").map((call) => call.query)).toEqual([
      { status: 200, embed: "contact", limit: 1000, offset: 0, countAll: true },
      { status: 750, embed: "contact", limit: 1000, offset: 0, countAll: true },
    ]);
    const buckets = Object.fromEntries(report.buckets.map((bucket) => [bucket.bucket, bucket]));
    expect(buckets["not_due"]).toMatchObject({
      count: 1,
      lines: [{ currency: "EUR", count: 1, outstanding: eur("0.10") }],
    });
    expect(buckets["days_1_30"]).toEqual({
      bucket: "days_1_30",
      label: "1–30 days overdue (überfällig)",
      count: 2,
      lines: [{ currency: "EUR", count: 2, outstanding: eur("177.53") }],
    });
    expect(buckets["days_31_60"]?.lines).toEqual([
      { currency: "EUR", count: 1, outstanding: eur("188.00") },
    ]);
    expect(buckets["days_61_90"]).toMatchObject({ count: 0, lines: [] });
    expect(buckets["days_over_90"]?.lines).toEqual([
      {
        currency: "USD",
        count: 1,
        outstanding: usd("0.00"),
        unknown: { count: 1, gross: usd("50.00") },
      },
    ]);
    expect(buckets["no_due_date"]?.lines).toEqual([
      {
        currency: "USD",
        count: 1,
        outstanding: usd("100.00"),
        approximate: { count: 1, outstanding: usd("100.00") },
      },
    ]);
    expect(report.totals).toEqual({
      count: 6,
      lines: [
        { currency: "EUR", count: 4, outstanding: eur("365.63") },
        {
          currency: "USD",
          count: 2,
          outstanding: usd("100.00"),
          approximate: { count: 1, outstanding: usd("100.00") },
          unknown: { count: 1, gross: usd("50.00") },
        },
      ],
      overdue: [
        { currency: "EUR", count: 3, outstanding: eur("365.53") },
        {
          currency: "USD",
          count: 1,
          outstanding: usd("0.00"),
          unknown: { count: 1, gross: usd("50.00") },
        },
      ],
    });
    expect(report.owedToCustomers).toEqual([{ currency: "EUR", count: 1, amount: eur("100.00") }]);
    expect(report.excluded).toEqual({
      cancellationInvoices: 1,
      recurringTemplates: 1,
      reminders: 1,
      nothingOutstanding: 1,
    });
    expect(report).toMatchObject({ asOf: AS_OF, recordsScanned: 12, truncated: false });
    expect(summary).toBe(
      "Receivables as of 2026-11-07: 6 open items (4 overdue) in 2 currencies; 12 sevDesk rows read.",
    );
  });

  it("ranks debtors by outstanding within each currency", async () => {
    const { report } = await run({ asOf: AS_OF, top: 1 });
    expect(report.topDebtors).toEqual([
      {
        contact: { id: 1001, name: "Musterfirma GmbH" },
        currency: "EUR",
        outstanding: eur("365.33"),
        count: 2,
        oldestDueDate: "2026-10-01",
        maxDaysOverdue: 37,
      },
      {
        contact: { id: 1003 },
        currency: "USD",
        outstanding: usd("100.00"),
        count: 2,
        approximate: true,
        unknownCount: 1,
        oldestDueDate: "2026-07-31",
        maxDaysOverdue: 99,
      },
    ]);
    const { report: all } = await run({});
    expect(all.asOf).toBe(AS_OF);
    expect(all.topDebtors.map((debtor) => [debtor.currency, debtor.contact?.id])).toEqual([
      ["EUR", 1001],
      ["EUR", 1002],
      ["USD", 1003],
    ]);
  });

  it("explains approximate, unknown and left-out rows in its notes", async () => {
    const { report } = await run({ asOf: AS_OF });
    expect(report.notes).toEqual([
      "Due date = invoice date + payment term (Zahlungsziel); outstanding = gross − paid " +
        "(sevDesk's paidAmount), in each invoice's currency.",
      "1 open invoice without a usable paid amount (sevDesk's paid amount is only reliable in " +
        "the account currency, EUR) count with their full gross, marked approximate.",
      "1 invoice with an unknown outstanding amount (partially paid without a usable paid " +
        "amount, or no gross from sevDesk) are listed under unknown and are not in outstanding.",
      "1 cancellation invoice (SR, Stornorechnung) were left out; a cancelled invoice keeps " +
        "status paid in sevDesk and is not open.",
      "1 invoice listed as open with nothing left to pay (paid ≥ gross) were left out.",
      "1 row sevDesk returned did not match the requested status or kind and were left out.",
      "1 recurring invoice template (WKR, Abo-Rechnung) were left out: the invoices they " +
        "generate are the receivables.",
      "1 reminder (MA, Mahnung) were left out: a reminder repeats the amount of the invoice it " +
        "reminds of, which is counted itself.",
      "1 open invoice with a negative gross mean money owed to the customer, not a receivable; " +
        "they are listed in owedToCustomers.",
    ]);
  });

  it("refuses a reference day in the past: sevDesk only knows today's open items", async () => {
    const promise = run({ asOf: "2026-11-06" });
    await expect(promise).rejects.toMatchObject({ kind: "validation" });
    await expect(promise).rejects.toThrow(
      "asOf 2026-11-06 is in the past (today is 2026-11-07). sevDesk only reports which items " +
        "are open now, not which were open on an earlier day",
    );
  });

  it("ages today's open items as of a later day: due before asOf counts as overdue", async () => {
    const { report } = await run({ asOf: "2026-11-20" }, [
      rows(
        "/Invoice",
        [
          invoice({
            id: "1",
            status: "200",
            invoiceDate: "2026-11-01T00:00:00+01:00",
            timeToPay: "9",
            paidAmount: "0",
          }),
        ],
        { status: 200 },
      ),
      rows("/Invoice", [], { status: 750 }),
    ]);
    expect(report.buckets.find((bucket) => bucket.bucket === "days_1_30")?.count).toBe(1);
    expect(report.topDebtors[0]?.maxDaysOverdue).toBe(10);
    expect(report.notes).toContain(
      "asOf 2026-11-20 is after today (2026-11-07): the items are those open in sevDesk " +
        "today, aged as of asOf on the assumption that nothing is paid until then.",
    );
  });

  it("counts calendar days across the daylight saving change", async () => {
    const client = new FakeSevdeskClient([
      rows(
        "/Invoice",
        [
          invoice({
            id: "1",
            status: "200",
            invoiceDate: "2026-03-29T00:00:00+01:00",
            timeToPay: "0",
            paidAmount: "0",
          }),
        ],
        { status: 200 },
      ),
      rows("/Invoice", [], { status: 750 }),
    ]);
    const report = await receivablesAging(client, {
      asOf: "2026-03-30",
      today: "2026-03-30",
      top: 5,
    });
    expect(report.buckets.find((bucket) => bucket.bucket === "days_1_30")?.count).toBe(1);
    expect(report.topDebtors[0]?.maxDaysOverdue).toBe(1);
  });

  it("handles an empty ledger", async () => {
    const { report, summary } = await run({}, [
      rows("/Invoice", [], { status: 200 }),
      rows("/Invoice", [], { status: 750 }),
    ]);
    expect(report.totals).toEqual({ count: 0, lines: [], overdue: [] });
    expect(report.topDebtors).toEqual([]);
    expect(report.owedToCustomers).toEqual([]);
    expect(report.buckets.every((bucket) => bucket.count === 0)).toBe(true);
    expect(summary).toContain("0 open items (0 overdue) in 0 currencies; 0 sevDesk rows read.");
  });

  it("treats a fully refunded negative invoice as settled", async () => {
    const { report } = await run({}, [
      rows(
        "/Invoice",
        [
          invoice({
            id: "1",
            status: "200",
            sumGross: "-10",
            sumNet: "-10",
            sumTax: "0",
            paidAmount: "-10",
          }),
        ],
        { status: 200 },
      ),
      rows("/Invoice", [], { status: 750 }),
    ]);
    expect(report.owedToCustomers).toEqual([]);
    expect(report.excluded.nothingOutstanding).toBe(1);
  });

  it("stops at the row cap across both statuses and says the aging is incomplete", async () => {
    const client = new FakeSevdeskClient([
      rows(
        "/Invoice",
        many(5, (index) => invoice({ id: String(500 + index), status: "200" })),
        {
          status: 200,
        },
      ),
      rows("/Invoice", [], { status: 750 }),
    ]);
    const report = await receivablesAging(client, { asOf: AS_OF, top: 5, maxRecords: 3 });
    expect(report).toMatchObject({ recordsScanned: 3, truncated: true });
    expect(client.callsTo("/Invoice")).toHaveLength(1);
    expect(report.notes[0]).toBe(
      "Reading stopped at the cap of 3 rows: the aging covers only the rows read.",
    );
  });

  it("stops when the call is cancelled mid-scan", async () => {
    const objects = many(1_500, (index) => invoice({ id: String(9_000 + index), status: "200" }));
    let fake: FakeSevdeskClient | undefined;
    const promise = runTool(
      receivablesAgingTool,
      { asOf: AS_OF },
      [rows("/Invoice", objects, { status: 200 }), rows("/Invoice", [], { status: 750 })],
      (client) => {
        fake = client;
        return progressContext(client, 1).ctx;
      },
    );
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
    expect(fake?.callsTo("/Invoice")).toHaveLength(1);
  });
});

describe("sevdesk_payables_aging (community voucher shape, fake data)", () => {
  async function run(args: Record<string, unknown>, routes = voucherRoutes) {
    const { client, result, data } = await runTool(payablesAgingTool, args, routes);
    return { client, summary: result.summary, report: data as PayablesAging };
  }

  it("is a read tool of the reports toolset", () => {
    expect(payablesAgingTool.toolset).toBe("reports");
    expect(payablesAgingTool.annotations).toEqual(READ);
    expect(payablesAgingTool.description).toContain("Verbindlichkeiten");
  });

  it("reads open and partially paid normal expense vouchers and buckets them by deadline", async () => {
    const { client, report, summary } = await run({ asOf: AS_OF });
    const queries = client.callsTo("/Voucher").map((call) => call.query);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ status: 100, creditDebit: "C", voucherType: "VOU" });
    expect(queries[1]).toMatchObject({ status: 750, creditDebit: "C", voucherType: "VOU" });
    const lines = Object.fromEntries(report.buckets.map((bucket) => [bucket.bucket, bucket.lines]));
    expect(lines["not_due"]).toEqual([
      {
        currency: "USD",
        count: 1,
        outstanding: usd("378.00"),
        approximate: { count: 1, outstanding: usd("378.00") },
      },
    ]);
    expect(lines["days_1_30"]).toEqual([{ currency: "EUR", count: 1, outstanding: eur("298.10") }]);
    expect(lines["days_over_90"]).toEqual([
      {
        currency: "EUR",
        count: 1,
        outstanding: eur("0.00"),
        unknown: { count: 1, gross: eur("119.00") },
      },
    ]);
    expect(lines["no_due_date"]).toEqual([
      { currency: "EUR", count: 1, outstanding: eur("69.00") },
    ]);
    expect(report.totals.lines).toEqual([
      {
        currency: "EUR",
        count: 3,
        outstanding: eur("367.10"),
        unknown: { count: 1, gross: eur("119.00") },
      },
      {
        currency: "USD",
        count: 1,
        outstanding: usd("378.00"),
        approximate: { count: 1, outstanding: usd("378.00") },
      },
    ]);
    expect(report.topCreditors).toEqual([
      {
        supplier: { id: 1003, name: "Beispiel Lieferant AG" },
        currency: "EUR",
        outstanding: eur("367.10"),
        count: 3,
        unknownCount: 1,
        oldestDueDate: "2026-08-01",
        maxDaysOverdue: 98,
      },
      {
        supplier: { name: "Example Cloud Inc." },
        currency: "USD",
        outstanding: usd("378.00"),
        count: 1,
        approximate: true,
        oldestDueDate: "2026-11-20",
      },
    ]);
    expect(report.owedBySuppliers).toEqual([{ currency: "EUR", count: 1, amount: eur("50.00") }]);
    expect(report.excluded).toEqual({ recurringTemplates: 1, nothingOutstanding: 1 });
    expect(report.recordsScanned).toBe(8);
    expect(summary).toBe(
      "Payables as of 2026-11-07: 4 open items (2 overdue) in 2 currencies; 8 sevDesk rows read.",
    );
  });

  it("flags wrong-signed payments, foreign paid amounts and left-out rows", async () => {
    const { report } = await run({ asOf: AS_OF });
    expect(report.notes).toEqual([
      "Due date = the voucher's payment deadline (Fälligkeit); outstanding = gross − paid " +
        "(sevDesk's paidAmount), in each voucher's currency. Only expense vouchers (Ausgaben) " +
        "with status open or partially paid count; transferred ones (Überwiesen) count as " +
        "paid, and recurring templates (RV) are not read (voucherType=VOU).",
      "1 open voucher without a usable paid amount (sevDesk's paid amount is only reliable in " +
        "the account currency, EUR) count with their full gross, marked approximate.",
      "1 voucher have a negative paid amount (a payment booked with the wrong sign); their " +
        "outstanding amount is unknown and not in outstanding.",
      "1 voucher listed as open with nothing left to pay (paid ≥ gross) were left out.",
      "1 row sevDesk returned did not match the requested status or kind and were left out.",
      "1 recurring voucher template (RV) were left out: the vouchers they generate are the " +
        "payables.",
      "1 open voucher with a negative gross mean money the supplier owes back, not a payable; " +
        "they are listed in owedBySuppliers.",
    ]);
  });

  it("refuses a past reference day", async () => {
    const client = new FakeSevdeskClient([]);
    await expect(
      payablesAging(client, { asOf: "2026-01-01", today: "2026-11-07", top: 3 }),
    ).rejects.toThrow(/asOf 2026-01-01 is in the past/);
    expect(client.calls).toEqual([]);
  });

  it("leaves a voucher without gross as unknown and lists a party-less item without a name", async () => {
    const client = new FakeSevdeskClient([
      rows(
        "/Voucher",
        [
          voucher({
            id: "1",
            status: "100",
            sumGross: null,
            supplier: null,
            supplierName: null,
            supplierNameAtSave: null,
          }),
        ],
        { status: 100 },
      ),
      rows("/Voucher", [], { status: 750 }),
    ]);
    const open = await collectPayables(client);
    expect(open.items).toEqual([
      {
        id: 1,
        party: undefined,
        currency: "EUR",
        gross: undefined,
        outstanding: undefined,
        quality: "unknown",
        dueDate: "2026-01-26",
      },
    ]);
    const { report } = await run({ asOf: AS_OF }, [
      rows(
        "/Voucher",
        [
          voucher({
            id: "1",
            status: "100",
            supplier: null,
            supplierName: null,
            supplierNameAtSave: null,
            paidAmount: "0",
          }),
        ],
        { status: 100 },
      ),
      rows("/Voucher", [], { status: 750 }),
    ]);
    expect(report.topCreditors).toEqual([
      expect.not.objectContaining({ supplier: expect.anything() as unknown }),
    ]);
    expect(report.notes.some((note) => note.includes("listed under unknown"))).toBe(false);
  });
});
