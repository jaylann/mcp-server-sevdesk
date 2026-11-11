import { describe, expect, it } from "vitest";

import type { ProfitAndLoss } from "../../../../src/domain/reports/pnl.js";
import type { VatSummary } from "../../../../src/domain/reports/vat.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import {
  profitAndLossTool,
  REPORT_TAX_TOOLS,
  taxReportRunOptions,
  vatSummaryTool,
} from "../../../../src/tools/reports/tax-tools.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { httpDeployment } from "../../../helpers/write-flow.js";
import {
  invoiceDoc,
  invoicePositions,
  regularAccount,
  scenarioRoutes,
  smallBusinessAccount,
  voucherDoc,
  voucherPositions,
} from "../../domain/reports/builders.js";
import { accountsRoute, progressContext, runTool } from "./records.js";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const documents = scenarioRoutes({
  invoices: [
    {
      row: invoiceDoc({ id: 1, date: "2026-02-10", net: "1000", tax: "190" }),
      positions: invoicePositions(1, [{ rate: "19", net: "1000", tax: "190" }]),
    },
  ],
  vouchers: [
    {
      row: voucherDoc({ id: 31, date: "2026-02-11", net: "100", tax: "19" }),
      positions: voucherPositions(31, [{ rate: "19", net: "100", tax: "19", account: 2185 }]),
    },
  ],
});

/** No booked transactions: the cash basis finds no payments. */
const noTransactions: FakeRoute[] = [
  accountsRoute,
  { path: "/CheckAccountTransaction", response: { body: { objects: [] } } },
];

const accountDatev: FakeRoute = {
  path: "/AccountDatev",
  response: { fixture: "recorded/2026-11-07/meta/account-datev.json" },
};

describe("tax tools: metadata", () => {
  it("are read tools of the reports toolset with German terms and bounded descriptions", () => {
    expect(REPORT_TAX_TOOLS.map((tool) => tool.name)).toEqual([
      "sevdesk_vat_summary",
      "sevdesk_profit_and_loss",
    ]);
    for (const tool of REPORT_TAX_TOOLS) {
      expect(tool).toMatchObject({ tier: "read", toolset: "reports", annotations: READ });
      expect(tool.localEffects).toBeUndefined();
      expect(tool.description.length).toBeLessThanOrEqual(900);
    }
    expect(vatSummaryTool.description).toContain("Umsatzsteuer-Voranmeldung (UStVA)");
    expect(vatSummaryTool.description).toContain("Zusammenfassende Meldung");
    expect(vatSummaryTool.description).toContain("not a filing");
    expect(profitAndLossTool.description).toContain("Einnahmenüberschussrechnung (EÜR)");
    expect(profitAndLossTool.description).toContain("Anlage EÜR");
  });

  it("take a period as year + month/quarter or from/to, and a basis", () => {
    expect(Object.keys(vatSummaryTool.input.shape)).toEqual([
      "year",
      "month",
      "quarter",
      "from",
      "to",
      "basis",
    ]);
    expect(profitAndLossTool.input.parse({ year: 2026 })).toMatchObject({ basis: "cash" });
    expect(() => vatSummaryTool.input.parse({ year: 2026, month: 13 })).toThrow();
    expect(() => vatSummaryTool.input.parse({ year: 2026, extra: 1 })).toThrow();
  });
});

describe("sevdesk_vat_summary", () => {
  it("estimates the UStVA of a quarter and reports progress", async () => {
    let calls: ReturnType<typeof progressContext>["calls"] = [];
    const { data, result } = await runTool(
      vatSummaryTool,
      { year: 2026, quarter: 1 },
      [regularAccount, accountDatev, ...documents],
      (client) => {
        const context = progressContext(client);
        calls = context.calls;
        return context.ctx;
      },
    );
    const report = data as VatSummary;

    expect(report.estimate?.kz83).toEqual({ amount: "171.00", currency: "EUR" });
    expect(report.basisSource).toBe("default");
    expect(result.summary).toBe(
      "VAT summary 2026-Q1 (accrual): 2 documents scanned, 2 form lines; Kz 83 estimate 171.00 EUR.",
    );
    expect(calls.length).toBeGreaterThan(0);
  });

  it("says that a Kleinunternehmer without taxable amounts needs no UStVA", async () => {
    const { data, result } = await runTool(vatSummaryTool, { year: 2026, month: 3 }, [
      smallBusinessAccount,
      accountDatev,
      ...scenarioRoutes({}),
    ]);

    expect((data as VatSummary).applicable).toBe(false);
    expect(result.summary).toContain("no UStVA required");
  });

  it("refuses a malformed period before sending anything", async () => {
    await expect(
      runTool(vatSummaryTool, { year: 2026, from: "2026-01-01" }, []),
    ).rejects.toMatchObject({
      kind: "validation",
    });
  });

  it("runs the cash basis on the bank reconciliation log", async () => {
    const { data } = await runTool(
      vatSummaryTool,
      { from: "2026-02-01", to: "2026-02-28", basis: "cash" },
      [regularAccount, accountDatev, ...documents, ...noTransactions],
    );
    const report = data as VatSummary;

    expect(report.basis).toBe("cash");
    expect(report.coverage.payments).toMatchObject({ read: 0, used: 0 });
    expect(report.boxes.map((box) => box.kz)).toEqual(["66"]);
  });

  // Review 2026-11, round 3: import VAT is booked as the amount on the import VAT account.
  const customs = scenarioRoutes({
    vouchers: [
      {
        row: voucherDoc({ id: 31, date: "2026-02-11", net: "190", tax: "0" }),
        positions: voucherPositions(31, [{ rate: "0", net: "190", tax: "0", account: 2624 }]),
      },
    ],
  });

  it("reports import VAT under Kz 62, also when the account list cannot be read", async () => {
    const { data } = await runTool(vatSummaryTool, { year: 2026, quarter: 1 }, [
      regularAccount,
      accountDatev,
      ...customs,
    ]);
    const report = data as VatSummary;
    expect(report.boxes.map((box) => [box.kz, box.tax?.amount])).toEqual([["62", "190.00"]]);
    expect(report.estimate?.kz83).toEqual({ amount: "-190.00", currency: "EUR" });

    const unreadable: FakeRoute = {
      path: "/AccountDatev",
      response: { error: new SevdeskError({ kind: "server", message: "Simulated." }) },
    };
    const fallback = await runTool(vatSummaryTool, { year: 2026, quarter: 1 }, [
      regularAccount,
      unreadable,
      ...customs,
    ]);
    expect((fallback.data as VatSummary).boxes.map((box) => box.kz)).toEqual(["62"]);
  });
});

describe("taxReportRunOptions", () => {
  it("gives no time budget over stdio and 90 s in an HTTP deployment", () => {
    const stdio = testContext(new FakeSevdeskClient([]));
    expect(taxReportRunOptions(stdio, () => 1_000).deadline).toBeUndefined();

    const http = { ...stdio, config: { ...stdio.config, deployment: httpDeployment("bearer") } };
    const options = taxReportRunOptions(http, () => 1_000);
    expect(options.deadline?.at).toBe(91_000);
    expect(options.deadline?.now()).toBe(1_000);
  });
});

describe("sevdesk_profit_and_loss", () => {
  it("defaults to the cash basis", async () => {
    const { data, result } = await runTool(profitAndLossTool, { year: 2026, month: 2 }, [
      accountDatev,
      regularAccount,
      ...noTransactions,
      ...scenarioRoutes({}),
    ]);
    const report = data as ProfitAndLoss;

    expect(report.basis).toBe("cash");
    expect(report.result).toEqual({ amount: "0.00", currency: "EUR" });
    expect(result.summary).toContain("Profit and loss 2026-02 (cash)");
  });

  it("names booking accounts from AccountDatev on the accrual basis", async () => {
    const { data } = await runTool(
      profitAndLossTool,
      { year: 2026, quarter: 1, basis: "accrual" },
      [accountDatev, regularAccount, ...documents],
    );
    const report = data as ProfitAndLoss;

    expect(report.expenses.byAccount).toEqual([
      {
        account: { id: 2185, number: "135", name: "EDV-Software" },
        net: { amount: "100.00", currency: "EUR" },
        documents: 1,
      },
    ]);
    expect(report.income.total).toEqual({ amount: "1000.00", currency: "EUR" });
  });

  it("falls back to account ids when AccountDatev cannot be read, but not on cancellation", async () => {
    const failing = (kind: SevdeskError["kind"]): FakeRoute => ({
      path: "/AccountDatev",
      response: { error: new SevdeskError({ kind, message: "Simulated." }) },
    });

    const { data } = await runTool(
      profitAndLossTool,
      { year: 2026, quarter: 1, basis: "accrual" },
      [failing("server"), regularAccount, ...documents],
    );
    expect((data as ProfitAndLoss).expenses.byAccount[0]?.account).toEqual({ id: 2185 });

    await expect(
      runTool(profitAndLossTool, { year: 2026, basis: "accrual" }, [
        failing("aborted"),
        ...documents,
      ]),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("still runs when the account settings (chart of accounts) cannot be read", async () => {
    const settings = (kind: SevdeskError["kind"]): FakeRoute => ({
      path: "/SevClient",
      response: { error: new SevdeskError({ kind, message: "Simulated." }) },
    });

    for (const kind of ["server", "network"] as const) {
      const { data } = await runTool(
        profitAndLossTool,
        { year: 2026, quarter: 1, basis: "accrual" },
        [accountDatev, settings(kind), ...documents],
      );
      expect((data as ProfitAndLoss).income.total).toEqual({ amount: "1000.00", currency: "EUR" });
    }

    await expect(
      runTool(profitAndLossTool, { year: 2026, basis: "accrual" }, [
        accountDatev,
        settings("aborted"),
        ...documents,
      ]),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
});
