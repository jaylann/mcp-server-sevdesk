import { describe, expect, it } from "vitest";

import { type CashPosition, cashPosition } from "../../../../src/domain/reports/cash.js";
import { cashPositionTool as tool } from "../../../../src/tools/reports/cash-position.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { AS_OF, invoiceRoutes, pinToday, voucherRoutes } from "./open-items.js";
import { accountsRoute, failing, invoice, many, rows, runTool } from "./records.js";

const eur = (amount: string) => ({ amount, currency: "EUR" });
const usd = (amount: string) => ({ amount, currency: "USD" });

function balance(id: number, amount: string): FakeRoute {
  return { path: `/CheckAccount/${id}/getBalanceAtDate`, response: { body: { objects: amount } } };
}

const balanceRoutes: FakeRoute[] = [
  balance(4001, "1500.25"),
  balance(4002, "0.1"),
  balance(4003, "0.2"),
  balance(4005, "88.10"),
];

async function run(args: Record<string, unknown>, routes: readonly FakeRoute[]) {
  const { client, result, data } = await runTool(tool, args, routes);
  return { client, summary: result.summary, report: data as CashPosition };
}

pinToday();

describe("sevdesk_cash_position (community account shape, fake data)", () => {
  it("is a read tool of the reports toolset", () => {
    expect(tool.name).toBe("sevdesk_cash_position");
    expect(tool.toolset).toBe("reports");
    expect(tool.tier).toBe("read");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.description).toContain("Liquidität");
  });

  it("totals the booked balances per currency without reading open items", async () => {
    const { client, report, summary } = await run({ asOf: AS_OF }, [
      accountsRoute,
      ...balanceRoutes,
    ]);
    expect(client.callsTo("/Invoice")).toEqual([]);
    expect(
      client.calls
        .filter((call) => call.path.endsWith("getBalanceAtDate"))
        .map((call) => call.query),
    ).toEqual([{ date: AS_OF }, { date: AS_OF }, { date: AS_OF }, { date: AS_OF }]);
    expect(report.balances).toEqual([
      { currency: "EUR", balance: eur("1500.55"), accounts: 3 },
      { currency: "USD", balance: usd("88.10"), accounts: 1 },
    ]);
    expect(report.accounts.map((account) => account.id)).toEqual([4001, 4002, 4003, 4005]);
    expect(report).toMatchObject({
      asOf: AS_OF,
      accountsComplete: true,
      archivedHidden: 1,
      recordsScanned: 0,
      truncated: false,
    });
    expect(report.outlook).toBeUndefined();
    expect(report.notes).toEqual([
      "Balances are sevDesk's: the sum of the transactions it knows up to asOf, which differs " +
        "from the bank's balance if transactions are missing.",
    ]);
    expect(summary).toBe("Cash position as of 2026-11-07: 4 accounts in 2 currencies.");
  });

  it("adds an expected outlook from open items by due date, never mixing currencies", async () => {
    const { report, summary } = await run({ asOf: AS_OF, outlookDays: 30 }, [
      accountsRoute,
      ...balanceRoutes,
      ...invoiceRoutes,
      ...voucherRoutes,
    ]);
    expect(report.outlook).toEqual({
      label:
        "Expected, not booked: open items by due date, assuming each is paid in full on its due date.",
      days: 30,
      from: AS_OF,
      until: "2026-12-07",
      lines: [
        {
          currency: "EUR",
          receivablesDue: { count: 1, amount: eur("0.10") },
          payablesDue: { count: 0, amount: eur("0.00") },
          expectedNet: eur("0.10"),
          projectedBalance: eur("1500.65"),
          overdueReceivables: { count: 3, amount: eur("365.53") },
          overduePayables: { count: 1, amount: eur("298.10") },
          noDueDateCount: 1,
        },
        {
          currency: "USD",
          receivablesDue: { count: 0, amount: usd("0.00") },
          payablesDue: { count: 1, amount: usd("378.00"), approximateCount: 1 },
          expectedNet: usd("-378.00"),
          projectedBalance: usd("-289.90"),
          overdueReceivables: { count: 0, amount: usd("0.00") },
          overduePayables: { count: 0, amount: usd("0.00") },
          noDueDateCount: 1,
        },
      ],
    });
    expect(report.recordsScanned).toBe(20);
    expect(report.notes).toEqual([
      "The outlook uses today's open items in sevDesk; due date = invoice date + payment term " +
        "for invoices and the payment deadline for expense vouchers.",
      "2 open items with a negative gross (money owed to a customer or by a supplier) are not " +
        "in the outlook; see the aging tools.",
      "3 templates or reminders (WKR, RV, MA) were left out: they are not payments of their own.",
      "Balances are sevDesk's: the sum of the transactions it knows up to asOf, which differs " +
        "from the bank's balance if transactions are missing.",
    ]);
    expect(summary).toBe(
      "Cash position as of 2026-11-07: 4 accounts in 2 currencies. Outlook 30 days (expected, " +
        "not booked) from 20 open-item rows.",
    );
  });

  it("refuses a past asOf with an outlook before reading anything, but not for balances", async () => {
    const promise = run({ asOf: "2026-10-31", outlookDays: 7 }, [accountsRoute]);
    await expect(promise).rejects.toMatchObject({ kind: "validation" });
    await expect(promise).rejects.toThrow(/an outlook from open items for a past day/);
    const { report } = await run({ asOf: "2026-10-31" }, [accountsRoute, ...balanceRoutes]);
    expect(report.asOf).toBe("2026-10-31");
    expect(report.balances[0]?.balance).toEqual(eur("1500.55"));
  });

  it("starts the window today for a later asOf, so items due before asOf still count", async () => {
    const { report } = await run({ asOf: "2026-11-20", outlookDays: 10 }, [
      accountsRoute,
      ...balanceRoutes,
      rows(
        "/Invoice",
        [
          // Due 2026-11-10: after today, before asOf: expected, not overdue.
          invoice({
            id: "1",
            status: "200",
            invoiceDate: "2026-11-01T00:00:00+01:00",
            timeToPay: "9",
            paidAmount: "0",
          }),
          // Due 2026-11-06: overdue today.
          invoice({
            id: "2",
            status: "200",
            invoiceDate: "2026-11-01T00:00:00+01:00",
            timeToPay: "5",
            paidAmount: "0",
          }),
          // Due 2026-12-01: after the window (asOf + 10 days = 2026-11-30).
          invoice({
            id: "3",
            status: "200",
            invoiceDate: "2026-11-01T00:00:00+01:00",
            timeToPay: "30",
            paidAmount: "0",
          }),
        ],
        { status: 200 },
      ),
      rows("/Invoice", [], { status: 750 }),
      rows("/Voucher", [], { status: 100 }),
      rows("/Voucher", [], { status: 750 }),
    ]);
    expect(report.outlook).toMatchObject({ from: AS_OF, until: "2026-11-30" });
    expect(report.outlook?.lines[0]).toMatchObject({
      currency: "EUR",
      receivablesDue: { count: 1, amount: eur("177.33") },
      overdueReceivables: { count: 1, amount: eur("177.33") },
      projectedBalance: eur("1677.88"),
    });
    expect(report.notes).toContain(
      "The window starts today (2026-11-07), not at asOf, so items falling due before asOf " +
        "count as expected; the balances are sevDesk's for asOf.",
    );
  });

  it("projects no balance for a currency whose account balance is missing", async () => {
    const { report } = await run({ asOf: AS_OF, outlookDays: 7 }, [
      accountsRoute,
      balance(4001, "10"),
      failing("/CheckAccount/4002/getBalanceAtDate", "validation"),
      balance(4003, "0"),
      balance(4005, "1"),
      rows(
        "/Invoice",
        [
          invoice({
            id: "1",
            status: "200",
            invoiceDate: "2026-11-01T00:00:00+01:00",
            timeToPay: "10",
            paidAmount: "0",
          }),
        ],
        { status: 200 },
      ),
      rows("/Invoice", [], { status: 750 }),
      rows("/Voucher", [], { status: 100 }),
      rows("/Voucher", [], { status: 750 }),
    ]);
    expect(report.balances[0]).toEqual({
      currency: "EUR",
      balance: eur("10.00"),
      accounts: 2,
      accountsWithoutBalance: 1,
    });
    const line = report.outlook?.lines[0];
    expect(line).toMatchObject({
      currency: "EUR",
      receivablesDue: { count: 1, amount: eur("177.33") },
    });
    expect(line).not.toHaveProperty("projectedBalance");
    expect(report.notes).toContain(
      "1 account without a balance from sevDesk (see balanceMissing) are not in the balances.",
    );
  });

  it("counts items due in the window with an unknown amount, and ignores later ones", async () => {
    const client = new FakeSevdeskClient([
      accountsRoute,
      ...balanceRoutes,
      balance(4004, "0"),
      rows(
        "/Invoice",
        [
          invoice({
            id: "1",
            status: "750",
            invoiceDate: "2026-11-01T00:00:00+01:00",
            timeToPay: "10",
            currency: "USD",
            sumGrossForeignCurrency: "5",
            sumNetForeignCurrency: "5",
          }),
          invoice({
            id: "2",
            status: "750",
            invoiceDate: "2026-12-31T00:00:00+01:00",
            timeToPay: "10",
            paidAmount: "1",
          }),
        ],
        { status: 750 },
      ),
      rows("/Invoice", [], { status: 200 }),
      rows("/Voucher", [], { status: 100 }),
      rows("/Voucher", [], { status: 750 }),
    ]);
    const report = await cashPosition(client, {
      asOf: AS_OF,
      outlookDays: 14,
      includeArchived: true,
    });
    expect(report.archivedHidden).toBe(0);
    expect(report.outlook?.lines).toEqual([
      expect.objectContaining({
        currency: "EUR",
        receivablesDue: { count: 0, amount: eur("0.00") },
      }),
      expect.objectContaining({ currency: "USD", unknownCount: 1 }),
    ]);
  });

  it("says the outlook is incomplete when the row cap stops reading open items", async () => {
    const client = new FakeSevdeskClient([
      accountsRoute,
      ...balanceRoutes,
      rows(
        "/Invoice",
        many(4, (index) => invoice({ id: String(700 + index), status: "200" })),
        { status: 200 },
      ),
      rows("/Invoice", [], { status: 750 }),
      rows("/Voucher", [], { status: 100 }),
      rows("/Voucher", [], { status: 750 }),
    ]);
    const report = await cashPosition(client, {
      asOf: AS_OF,
      outlookDays: 30,
      includeArchived: false,
      maxRecords: 2,
    });
    expect(report).toMatchObject({ truncated: true, recordsScanned: 2 });
    expect(client.callsTo("/Voucher")).toEqual([]);
    expect(report.notes[0]).toBe(
      "Reading open items stopped at the cap of 2 rows: the outlook is incomplete.",
    );
  });

  it("reports when sevDesk has more accounts than one request returns", async () => {
    const accounts = { body: { total: "1500", objects: [] } };
    const { report } = await run({ asOf: AS_OF }, [{ path: "/CheckAccount", response: accounts }]);
    expect(report.accountsComplete).toBe(false);
    expect(report.notes).toContain(
      "sevDesk has more accounts than one request returns; balances are incomplete.",
    );
  });
});
