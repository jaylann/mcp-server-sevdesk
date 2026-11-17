/**
 * `sevdesk_profit_and_loss` with cost centres (Kostenstellen) and tags (issue #87): the
 * `costCentre` and `tag` filters on both bases, the breakdowns per cost centre (a split of the
 * totals, with "none") and per tag (overlapping), cut reads, and unknown names
 * (spec/deviations.md D-088–D-092).
 */
import { describe, expect, it } from "vitest";

import {
  type ProfitAndLoss,
  profitAndLoss,
  profitAndLossSentence,
} from "../../../../src/domain/reports/pnl.js";
import type {
  DocumentPayment,
  PaymentsInPeriod,
} from "../../../../src/domain/reports/positions-scan.js";
import { resolvePeriod } from "../../../../src/domain/reports/vat.js";
import { profitAndLossTool } from "../../../../src/tools/reports/tax-tools.js";
import {
  costCentresRoute,
  RECORDED_CENTRES,
  storedCostCentre,
} from "../../../helpers/cost-centres.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { relationRow, tagRow, tagsRoute, tagUsesRoute } from "../../tools/documents/tag-support.js";
import { many, runTool } from "../../tools/reports/records.js";
import {
  byIdRoutes,
  creditNoteDoc,
  creditNotePositions,
  invoiceDoc,
  invoicePositions,
  regularAccount,
  type ScenarioDocument,
  scenarioRoutes,
  voucherDoc,
  voucherPositions,
} from "./builders.js";

const Q1 = resolvePeriod({ year: 2026, quarter: 1 });
const TODAY = "2026-11-08";
const EUR = (amount: string) => ({ amount, currency: "EUR" });
const { first, third } = RECORDED_CENTRES;
const on = (id: number) => ({ costCentre: storedCostCentre(id) });

/**
 * Three invoices, a credit note and three vouchers in February 2026: on MCP1 (third), on
 * M62573C (first) and on none.
 */
function scenario(): {
  invoices: ScenarioDocument[];
  creditNotes: ScenarioDocument[];
  vouchers: ScenarioDocument[];
} {
  return {
    invoices: [
      {
        row: invoiceDoc({ id: 1, date: "2026-02-10", net: "1000", tax: "190" }, on(third.id)),
        positions: invoicePositions(1, [{ rate: "19", net: "1000", tax: "190" }]),
      },
      {
        row: invoiceDoc({ id: 2, date: "2026-02-11", net: "500", tax: "95" }, on(first.id)),
        positions: invoicePositions(2, [{ rate: "19", net: "500", tax: "95" }]),
      },
      {
        row: invoiceDoc({ id: 3, date: "2026-02-12", net: "200", tax: "38" }),
        positions: invoicePositions(3, [{ rate: "19", net: "200", tax: "38" }]),
      },
    ],
    creditNotes: [
      {
        row: creditNoteDoc({ id: 21, date: "2026-02-13", net: "20", tax: "3.8" }, on(third.id)),
        positions: creditNotePositions(21, [{ rate: "19", net: "20", tax: "3.8" }]),
      },
    ],
    vouchers: [
      {
        row: voucherDoc({ id: 31, date: "2026-02-14", net: "100", tax: "19" }, on(third.id)),
        positions: voucherPositions(31, [{ rate: "19", net: "100", tax: "19", account: 4930 }]),
      },
      {
        row: voucherDoc({ id: 32, date: "2026-02-15", net: "300", tax: "57" }, on(first.id)),
        positions: voucherPositions(32, [{ rate: "19", net: "300", tax: "57", account: 4930 }]),
      },
      {
        row: voucherDoc({ id: 33, date: "2026-02-16", net: "50", tax: "9.5" }),
        positions: voucherPositions(33, [{ rate: "19", net: "50", tax: "9.5", account: 4930 }]),
      },
    ],
  };
}

const TAGS = tagsRoute([tagRow(7001, "Projekt Y"), tagRow(7002, "Filiale München")]);

/** All relations of the account (`GET /TagRelation` without a filter). */
function allRelations(relations: readonly Record<string, unknown>[]): FakeRoute {
  return { path: "/TagRelation", response: { body: { objects: relations } } };
}

function accrual(
  routes: readonly FakeRoute[],
  extra: Partial<Parameters<typeof profitAndLoss>[1]>,
) {
  const client = new FakeSevdeskClient(routes);
  const run = profitAndLoss(client, { period: Q1, basis: "accrual", today: TODAY, ...extra });
  return { client, run };
}

/** income + expenses + result of the groups, to compare with the report's totals. */
function sums(report: ProfitAndLoss): { income: number; expenses: number; result: number } {
  const groups = report.breakdown?.groups ?? [];
  const add = (pick: (group: (typeof groups)[number]) => string) =>
    groups.reduce((sum, group) => sum + Math.round(Number(pick(group)) * 100), 0) / 100;
  return {
    income: add((group) => group.income.amount),
    expenses: add((group) => group.expenses.amount),
    result: add((group) => group.result.amount),
  };
}

describe("profitAndLoss: cost centres", () => {
  it("limits the figures to one cost centre and reads positions of its documents only", async () => {
    const { client, run } = accrual([costCentresRoute, ...scenarioRoutes(scenario())], {
      costCentre: "mcp1",
    });
    const report = await run;

    expect(report.filters).toEqual({ costCentre: third });
    // 1000 income, minus the 20 credit note; 100 expenses.
    expect(report.income.total).toEqual(EUR("980.00"));
    expect(report.expenses.total).toEqual(EUR("100.00"));
    expect(report.result).toEqual(EUR("880.00"));
    expect(report.coverage).toMatchObject({ rowsRead: 7, documentsScanned: 3, truncated: false });
    expect(client.callsTo("/InvoicePos")).toHaveLength(1);
    expect(client.callsTo("/CreditNotePos")).toHaveLength(1);
    expect(client.callsTo("/VoucherPos")).toHaveLength(1);
    // No list filter of sevDesk is relied on: every row is checked here.
    expect(client.callsTo("/Voucher")[0]?.query).not.toHaveProperty("costCentre[id]");
    expect(report.notes).toContain(
      "Only documents on the cost centre in filters.costCentre count: the cost centre of the " +
        "whole document (sevDesk keeps one per invoice, credit note or voucher); cost centres on " +
        "single voucher positions are not read.",
    );
    expect(profitAndLossSentence(report)).toBe(
      "Profit and loss 2026-Q1 (accrual, only cost centre id 344959): income 980.00, expenses " +
        "100.00, result 880.00 EUR (net, before AfA); 3 documents scanned.",
    );
  });

  it("breaks the result down per cost centre; the groups, none included, add up", async () => {
    const { run } = accrual([costCentresRoute, ...scenarioRoutes(scenario())], {
      groupBy: "cost_centre",
    });
    const report = await run;

    expect(report.breakdown).toEqual({
      by: "cost_centre",
      overlap: false,
      complete: true,
      groups: [
        {
          key: "cost_centre:344964",
          costCentre: first,
          income: EUR("500.00"),
          expenses: EUR("300.00"),
          result: EUR("200.00"),
          documents: 2,
        },
        {
          key: "cost_centre:344959",
          costCentre: third,
          income: EUR("980.00"),
          expenses: EUR("100.00"),
          result: EUR("880.00"),
          documents: 3,
        },
        {
          key: "none",
          income: EUR("200.00"),
          expenses: EUR("50.00"),
          result: EUR("150.00"),
          documents: 2,
        },
      ],
    });
    expect(sums(report)).toEqual({
      income: Number(report.income.total.amount),
      expenses: Number(report.expenses.total.amount),
      result: Number(report.result.amount),
    });
    expect(report.notes).toContain(
      "Breakdown by the cost centre (Kostenstelle) of the whole document: one per document, so " +
        "the groups add up to income, expenses and result; documents without one are in the " +
        "group none.",
    );
    expect(profitAndLossSentence(report)).toContain("Breakdown by cost centre: 3 groups.");
  });

  it("counts only the payments on the cost centre's documents on the cash basis", async () => {
    const all = scenario();
    // Paid in the period, dated long before and on another cost centre: read by id, not counted.
    const older: ScenarioDocument = {
      row: invoiceDoc({ id: 70, date: "2025-06-01", net: "100", tax: "19" }, on(first.id)),
      positions: invoicePositions(70, [{ rate: "19", net: "100", tax: "19" }]),
    };
    const client = new FakeSevdeskClient([
      costCentresRoute,
      ...scenarioRoutes(all),
      ...byIdRoutes({ invoices: [older] }),
    ]);
    const payment = (id: number, amount: string): DocumentPayment => ({
      date: "2026-02-20",
      document: { objectName: "Invoice", id },
      amount: { amount, currency: "EUR" },
      direction: "in",
      signedForDocument: { amount, currency: "EUR" },
      transactionId: 800 + id,
      checkAccountId: undefined,
    });
    const payments: PaymentsInPeriod = () =>
      Promise.resolve({
        payments: [payment(1, "1190"), payment(2, "595"), payment(70, "119")],
        truncated: false,
        notes: [],
        transactionsScanned: 3,
        transactionsRead: 3,
      });

    const report = await profitAndLoss(client, {
      period: Q1,
      basis: "cash",
      payments,
      costCentre: third.id,
      today: TODAY,
    });

    expect(report.income.total).toEqual(EUR("1000.00"));
    expect(report.expenses.total).toEqual(EUR("0.00"));
    expect(report.coverage.payments).toMatchObject({ read: 3, used: 1, documentsFetched: 1 });
    // Invoice 2 was listed: its cost centre is known without a read by id.
    expect(client.callsTo("/Invoice/2")).toEqual([]);
    expect(client.callsTo("/InvoicePos")).toHaveLength(1);
  });
});

describe("profitAndLoss: tags", () => {
  const relations = [
    relationRow(8101, 7001, "Invoice", 1),
    relationRow(8102, 7001, "Voucher", 31),
    relationRow(8103, 7002, "Invoice", 1),
    relationRow(8104, 7002, "Invoice", 2),
    // An order with a tag: no part of the profit and loss.
    relationRow(8105, 7002, "Order", 33),
  ];

  it("limits the figures to the documents of every kind that carry the tag", async () => {
    const { client, run } = accrual(
      [TAGS, tagUsesRoute(7001, relations.slice(0, 2)), ...scenarioRoutes(scenario())],
      { tag: "PROJEKT Y" },
    );
    const report = await run;

    expect(report.filters).toEqual({ tag: { id: 7001, name: "Projekt Y" } });
    expect(report.income.total).toEqual(EUR("1000.00"));
    expect(report.expenses.total).toEqual(EUR("100.00"));
    expect(report.coverage.documentsScanned).toBe(2);
    expect(client.callsTo("/VoucherPos")).toHaveLength(1);
    expect(profitAndLossSentence(report)).toContain("(accrual, only tag id 7001)");
  });

  it("counts a document with several tags in each tag group and says the groups overlap", async () => {
    const { run } = accrual([TAGS, allRelations(relations), ...scenarioRoutes(scenario())], {
      groupBy: "tag",
    });
    const report = await run;

    expect(report.breakdown).toEqual({
      by: "tag",
      overlap: true,
      complete: true,
      groups: [
        {
          key: "tag:7001",
          tag: { id: 7001, name: "Projekt Y" },
          income: EUR("1000.00"),
          expenses: EUR("100.00"),
          result: EUR("900.00"),
          documents: 2,
        },
        {
          key: "tag:7002",
          tag: { id: 7002, name: "Filiale München" },
          income: EUR("1500.00"),
          expenses: EUR("0.00"),
          result: EUR("1500.00"),
          documents: 2,
        },
        {
          key: "none",
          income: EUR("180.00"),
          expenses: EUR("350.00"),
          result: EUR("-170.00"),
          documents: 4,
        },
      ],
    });
    // Invoice 1 counts twice: the groups add up to more than the totals.
    expect(report.income.total).toEqual(EUR("1680.00"));
    expect(sums(report).income).toBe(2680);
    expect(report.notes).toContain(
      "Breakdown by tag: a document with several tags counts in each of its tag groups, so the " +
        "groups add up to more than income, expenses and result (breakdown.overlap). Documents " +
        "without a tag are in the group none.",
    );
    expect(profitAndLossSentence(report)).toContain(
      "Breakdown by tag: 3 groups (overlapping: they do not add up to the totals).",
    );
  });

  it("marks the breakdown incomplete when the account has more relations than were read", async () => {
    const beyondCap = many(10_001, (index) =>
      relationRow(100_000 + index, 7002, "Order", 900_000 + index),
    );
    const { run } = accrual([TAGS, allRelations(beyondCap), ...scenarioRoutes(scenario())], {
      groupBy: "tag",
    });
    const report = await run;

    expect(report.breakdown?.complete).toBe(false);
    expect(report.notes).toContain(
      "The account has more than 10,000 tag relations; only the first ones were read, so some " +
        "documents may be missing from their tag groups or sit in none: the breakdown is " +
        "incomplete.",
    );
    expect(profitAndLossSentence(report)).toContain(", incomplete.");
  }, 20_000); // 10,001 relation rows.

  it("says so when the account has more tags than were read for the group names", async () => {
    // 10,001 tags: the last one (id 30000) is beyond the cap, and invoice 1 carries it.
    const tagsBeyondCap = many(10_001, (index) => tagRow(20_000 + index, `Tag ${String(index)}`));
    const { run } = accrual(
      [
        tagsRoute(tagsBeyondCap),
        allRelations([relationRow(8101, 30_000, "Invoice", 1)]),
        ...scenarioRoutes(scenario()),
      ],
      { groupBy: "tag" },
    );
    const report = await run;

    expect(report.breakdown?.groups[0]).toMatchObject({
      key: "tag:30000",
      tag: { id: 30_000 },
      income: EUR("1000.00"),
    });
    expect(report.breakdown?.groups[0]?.tag).not.toHaveProperty("name");
    // Only the label suffers: the grouping comes from the relations, which were all read.
    expect(report.breakdown?.complete).toBe(true);
    expect(report.notes).toContain(
      "The account has more than 10,000 tags; only the first ones were read for the names, so " +
        "the groups of the others show only their tag id. The figures are not affected.",
    );
  }, 20_000); // 10,001 tag rows.

  it("reports the figures as truncated when the tag has more uses than were read", async () => {
    const uses = many(10_001, (index) =>
      relationRow(100_000 + index, 7001, "Order", 900_000 + index),
    );
    const { run } = accrual([TAGS, tagUsesRoute(7001, uses), ...scenarioRoutes(scenario())], {
      tag: "Projekt Y",
    });
    const report = await run;

    expect(report.coverage.truncated).toBe(true);
    expect(report.notes).toContain(
      "The tag has more than 10,000 uses: documents beyond the first ones are not known here " +
        "and were left out, so the figures are incomplete.",
    );
  }, 20_000); // 10,001 relation rows.
});

describe("sevdesk_profit_and_loss: this month's expenses for a cost centre (issue #87)", () => {
  it("answers through the tool with costCentre by name", async () => {
    const { data, result } = await runTool(
      profitAndLossTool,
      { year: 2026, month: 2, basis: "accrual", costCentre: "Mustername 3" },
      [
        { path: "/AccountDatev", response: { body: { objects: [] } } },
        regularAccount,
        costCentresRoute,
        ...scenarioRoutes(scenario()),
      ],
    );
    const report = data as ProfitAndLoss;

    expect(report.filters?.costCentre).toEqual(third);
    expect(report.expenses).toEqual({
      total: EUR("100.00"),
      byAccount: [{ account: { id: 4930 }, net: EUR("100.00"), documents: 1 }],
    });
    expect(result.summary).toContain("Profit and loss 2026-02 (accrual, only cost centre id");
  });
});
