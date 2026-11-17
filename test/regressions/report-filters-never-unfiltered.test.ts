/**
 * Regression (spec/deviations.md D-090, D-092): a tag or cost-centre filter that is left out, or
 * spelled in a way sevDesk ignores, answers the whole list as if it were the filtered documents.
 * In a report that would be the account's totals presented as one project's or one cost centre's.
 * `sevdesk_records_summarize` and `sevdesk_profit_and_loss` must (a) refuse a tag or cost centre
 * the account does not have before any document is listed, and (b) count only the documents that
 * carry it, even when sevDesk answers every row.
 */
import { describe, expect, it } from "vitest";

import { recordsSummarizeTool } from "../../src/tools/reports/summarize.js";
import { profitAndLossTool } from "../../src/tools/reports/tax-tools.js";
import type { ToolContext } from "../../src/tools/types.js";
import { costCentresRoute, RECORDED_CENTRES, storedCostCentre } from "../helpers/cost-centres.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../helpers/fake-client.js";
import {
  invoiceDoc,
  invoicePositions,
  regularAccount,
  scenarioRoutes,
} from "../unit/domain/reports/builders.js";
import {
  relationRow,
  tagRow,
  tagsRoute,
  tagUsesRoute,
} from "../unit/tools/documents/tag-support.js";

const { third } = RECORDED_CENTRES;
const DOCUMENT_LISTS = ["/Invoice", "/CreditNote", "/Voucher"];

/** Two February invoices: 501 on MCP1 with tag 7001, 502 on no cost centre without a tag. */
const documents = scenarioRoutes({
  invoices: [
    {
      row: invoiceDoc(
        { id: 501, date: "2026-02-10", net: "100", tax: "19" },
        { costCentre: storedCostCentre(third.id) },
      ),
      positions: invoicePositions(501, [{ rate: "19", net: "100", tax: "19" }]),
    },
    {
      row: invoiceDoc({ id: 502, date: "2026-02-11", net: "9000", tax: "1710" }),
      positions: invoicePositions(502, [{ rate: "19", net: "9000", tax: "1710" }]),
    },
  ],
});

const support: FakeRoute[] = [
  { path: "/AccountDatev", response: { body: { objects: [] } } },
  regularAccount,
  costCentresRoute,
  tagsRoute([tagRow(7001, "Projekt Y")]),
  tagUsesRoute(7001, [relationRow(8101, 7001, "Invoice", 501)]),
];

interface ReportCase {
  readonly name: string;
  /** Runs the tool with a filter; returns the net revenue it counted. */
  readonly run: (ctx: ToolContext, filter: Record<string, unknown>) => Promise<string | undefined>;
}

const CASES: readonly ReportCase[] = [
  {
    name: "sevdesk_records_summarize",
    run: async (ctx, filter) => {
      const args = recordsSummarizeTool.input.parse({ subject: "invoices", ...filter });
      const { data } = await recordsSummarizeTool.handler(args, ctx);
      return data.totals.lines[0]?.net?.amount;
    },
  },
  {
    name: "sevdesk_profit_and_loss",
    run: async (ctx, filter) => {
      const args = profitAndLossTool.input.parse({
        year: 2026,
        month: 2,
        basis: "accrual",
        ...filter,
      });
      const { data } = await profitAndLossTool.handler(args, ctx);
      return data.income.total.amount;
    },
  },
];

describe.each(CASES)(
  "$name: tag and cost-centre filters never give unfiltered totals",
  (report) => {
    it.each([
      [{ tag: "Projekt Z" }, /No tag has this name/],
      [{ costCentre: "Werkstatt" }, /No cost centre \(Kostenstelle\) has this id, number or name/],
      [{ costCentre: 4711 }, /No cost centre \(Kostenstelle\) has this id, number or name/],
    ])("refuses %j before listing a single document", async (filter, message) => {
      const client = new FakeSevdeskClient([...support, ...documents]);
      const run = report.run(testContext(client), filter);
      await expect(run).rejects.toMatchObject({ kind: "validation" });
      await expect(run).rejects.toThrow(message);
      for (const path of DOCUMENT_LISTS) expect(client.callsTo(path)).toEqual([]);
    });

    it.each([[{ tag: "projekt y" }], [{ costCentre: "MCP1" }], [{ costCentre: third.id }]])(
      "counts only the documents with %j although sevDesk answers every row",
      async (filter) => {
        const client = new FakeSevdeskClient([...support, ...documents]);
        // 9000 would be the unfiltered revenue of invoice 502.
        expect(await report.run(testContext(client), filter)).toBe("100.00");
      },
    );
  },
);
