/**
 * `sevdesk_records_summarize` with tags and cost centres (Kostenstellen, issue #87): the `tag` and
 * `costCentre` filters, the `tag` and `cost_centre` groupings, overlapping tag groups, the "none"
 * group, cut reads, and unknown or ambiguous names (spec/deviations.md D-088–D-092).
 */
import { describe, expect, it } from "vitest";

import { summarizeRecords, type SummaryReport } from "../../../../src/domain/reports/summarize.js";
import { recordsSummarizeTool as tool } from "../../../../src/tools/reports/summarize.js";
import {
  costCentreRow,
  costCentresRoute,
  costCentresRouteOf,
  RECORDED_CENTRES,
  storedCostCentre,
} from "../../../helpers/cost-centres.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { creditNoteDoc, invoiceDoc, voucherDoc } from "../../domain/reports/builders.js";
import { relationRow, tagRow, tagsRoute, tagUsesRoute } from "../documents/tag-support.js";
import { many, rows, runTool } from "./records.js";

const { first, second, third } = RECORDED_CENTRES;
const eur = (amount: string) => ({ amount, currency: "EUR" });

async function summarize(args: Record<string, unknown>, routes: readonly FakeRoute[]) {
  const { client, result, data } = await runTool(tool, args, routes);
  return { client, summary: result.summary, report: data as SummaryReport };
}

/** All relations of the account (`GET /TagRelation` without a filter). */
function allRelations(relations: readonly Record<string, unknown>[]): FakeRoute {
  return { path: "/TagRelation", response: { body: { objects: relations } } };
}

const TAGS = tagsRoute([tagRow(7001, "Projekt Y"), tagRow(7002, "Filiale München")]);

describe("sevdesk_records_summarize: cost centres", () => {
  it("answers this month's expenses for one cost centre (issue #87 acceptance)", async () => {
    const { client, report, summary } = await summarize(
      {
        subject: "vouchers",
        kind: "expense",
        costCentre: "MCP1",
        from: "2026-11-01",
        to: "2026-11-30",
      },
      [
        costCentresRoute,
        rows("/Voucher", [
          voucherDoc(
            { id: 31, date: "2026-11-03", net: "100", tax: "19" },
            {
              costCentre: storedCostCentre(third.id),
            },
          ),
          voucherDoc(
            { id: 32, date: "2026-11-04", net: "50", tax: "9.5" },
            {
              costCentre: storedCostCentre(third.id),
            },
          ),
          // sevDesk ignoring the filter: another cost centre and none come back too.
          voucherDoc(
            { id: 33, date: "2026-11-05", net: "70", tax: "13.3" },
            {
              costCentre: storedCostCentre(first.id),
            },
          ),
          voucherDoc({ id: 34, date: "2026-11-06", net: "10", tax: "1.9" }),
        ]),
      ],
    );

    expect(client.callsTo("/Voucher")[0]?.query).toMatchObject({
      creditDebit: "C",
      "costCentre[id]": third.id,
      "costCentre[objectName]": "CostCentre",
    });
    expect(report.recordsCounted).toBe(2);
    expect(report.totals.lines).toHaveLength(1);
    expect(report.totals.lines[0]).toMatchObject({
      currency: "EUR",
      net: eur("150.00"),
      tax: eur("28.50"),
      gross: eur("178.50"),
    });
    expect(report.costCentreFilter).toEqual(third);
    expect(report.recordsScanned).toBe(4);
    expect(summary).toBe("Vouchers: 2 counted in 1 currency; 4 sevDesk rows read.");
  });

  it("groups by cost centre with a none group, and the groups add up to the totals", async () => {
    const { report, summary } = await summarize({ subject: "invoices", groupBy: "cost_centre" }, [
      costCentresRoute,
      rows("/Invoice", [
        invoiceDoc(
          { id: 1, date: "2026-10-01", net: "100", tax: "19" },
          {
            costCentre: storedCostCentre(first.id),
          },
        ),
        invoiceDoc(
          { id: 2, date: "2026-10-02", net: "300", tax: "57" },
          {
            costCentre: storedCostCentre(second.id),
          },
        ),
        invoiceDoc(
          { id: 3, date: "2026-10-03", net: "50", tax: "9.5" },
          {
            costCentre: storedCostCentre(first.id),
          },
        ),
        invoiceDoc({ id: 4, date: "2026-10-04", net: "20", tax: "3.8" }),
        // A cost centre the account's list no longer has: shown by id.
        invoiceDoc(
          { id: 5, date: "2026-10-05", net: "10", tax: "1.9" },
          {
            costCentre: storedCostCentre(999),
          },
        ),
      ]),
    ]);

    expect(
      report.groups.map((group) => [group.key, group.costCentre, group.count, group.lines[0]?.net]),
    ).toEqual([
      ["cost_centre:344962", second, 1, eur("300.00")],
      ["cost_centre:344964", first, 2, eur("150.00")],
      ["cost_centre:999", { id: 999 }, 1, eur("10.00")],
      ["none", undefined, 1, eur("20.00")],
    ]);
    expect(report.totals.lines[0]?.net).toEqual(eur("480.00"));
    expect(report.groupsOverlap).toBe(false);
    expect(report.groupsComplete).toBe(true);
    expect(report.notes).toContain(
      "Grouped by the cost centre (Kostenstelle) of the whole document: sevDesk keeps one per " +
        "document, so the groups add up to the totals; documents without one are in the group " +
        "none. Cost centres on single voucher positions are not read.",
    );
    expect(summary).toBe(
      "Invoices: 5 counted in 1 currency, 4 groups by cost_centre; 5 sevDesk rows read.",
    );
  });

  it("filters credit notes by each row's own cost centre and sends no list filter", async () => {
    const { client, report } = await summarize({ subject: "credit_notes", costCentre: third.id }, [
      costCentresRoute,
      rows("/CreditNote", [
        creditNoteDoc(
          { id: 21, date: "2026-10-01", net: "20", tax: "3.8" },
          {
            costCentre: storedCostCentre(third.id),
          },
        ),
        creditNoteDoc({ id: 22, date: "2026-10-02", net: "40", tax: "7.6" }),
      ]),
    ]);

    const query = client.callsTo("/CreditNote")[0]?.query;
    expect(query).not.toHaveProperty("costCentre[id]");
    expect(report.recordsCounted).toBe(1);
    expect(report.totals.lines[0]?.net).toEqual(eur("20.00"));
    expect(report.notes).toContain(
      "sevDesk's cost-centre filter for credit notes is not measured, so every credit note of " +
        "the range was read and kept only when it carries the cost centre.",
    );
  });

  it("says the breakdown is incomplete when the row cap stopped reading", async () => {
    const client = new FakeSevdeskClient([
      costCentresRoute,
      rows(
        "/Voucher",
        many(3, (index) =>
          voucherDoc(
            { id: 40 + index, date: "2026-10-01", net: "1", tax: "0" },
            {
              costCentre: storedCostCentre(first.id),
            },
          ),
        ),
      ),
    ]);

    const report = await summarizeRecords(client, {
      subject: "vouchers",
      groupBy: "cost_centre",
      maxGroups: 50,
      maxRecords: 2,
    });

    expect(report.truncated).toBe(true);
    expect(report.groupsComplete).toBe(false);
    expect(report.groups.map((group) => group.count)).toEqual([2]);
  });
});

describe("sevdesk_records_summarize: tags", () => {
  const invoices = rows("/Invoice", [
    invoiceDoc({ id: 501, date: "2026-10-01", net: "100", tax: "19" }),
    invoiceDoc({ id: 502, date: "2026-10-02", net: "200", tax: "38" }),
    invoiceDoc({ id: 503, date: "2026-10-03", net: "40", tax: "7.6" }),
  ]);
  const relations = allRelations([
    // 501 carries both tags, 502 one, 503 none; a voucher with the same id must not count.
    relationRow(8101, 7001, "Invoice", 501),
    relationRow(8102, 7002, "Invoice", 501),
    relationRow(8103, 7001, "Invoice", 502),
    relationRow(8104, 7002, "Voucher", 503),
  ]);

  it("counts a document with several tags in each tag group and says the groups overlap", async () => {
    const { report, summary } = await summarize({ subject: "invoices", groupBy: "tag" }, [
      TAGS,
      relations,
      invoices,
    ]);

    expect(
      report.groups.map((group) => [group.key, group.tag, group.count, group.lines[0]?.net]),
    ).toEqual([
      ["tag:7001", { id: 7001, name: "Projekt Y" }, 2, eur("300.00")],
      ["tag:7002", { id: 7002, name: "Filiale München" }, 1, eur("100.00")],
      ["none", undefined, 1, eur("40.00")],
    ]);
    // 300 + 100 + 40 = 440, more than the 340 counted once.
    expect(report.totals).toMatchObject({ count: 3 });
    expect(report.totals.lines[0]?.net).toEqual(eur("340.00"));
    expect(report.groupsOverlap).toBe(true);
    expect(report.groupsComplete).toBe(true);
    expect(report.notes).toContain(
      "Grouped by tag: a document with several tags counts in each of its tag groups, so the " +
        "groups add up to more than the totals (groupsOverlap). Documents without a tag are in " +
        "the group none.",
    );
    expect(summary).toBe(
      "Invoices: 3 counted in 1 currency, 3 groups by tag; 3 sevDesk rows read. Groups overlap " +
        "(a document with several tags counts in each): they do not add up to the totals.",
    );
  });

  it("says when no document has several tags, so the groups split the totals", async () => {
    const { report } = await summarize({ subject: "invoices", groupBy: "tag" }, [
      TAGS,
      allRelations([relationRow(8103, 7001, "Invoice", 502)]),
      invoices,
    ]);

    expect(report.groups.map((group) => [group.key, group.count])).toEqual([
      ["tag:7001", 1],
      ["none", 2],
    ]);
    expect(report.groupsOverlap).toBe(false);
  });

  it("marks the breakdown incomplete when the account has more relations than were read", async () => {
    const relationsBeyondCap = many(10_001, (index) =>
      relationRow(100_000 + index, 7001, "Order", 900_000 + index),
    );
    const { report, summary } = await summarize({ subject: "invoices", groupBy: "tag" }, [
      TAGS,
      allRelations(relationsBeyondCap),
      invoices,
    ]);

    expect(report.groupsComplete).toBe(false);
    expect(report.truncated).toBe(false);
    expect(report.notes).toContain(
      "The account has more than 10,000 tag relations; only the first ones were read, so some " +
        "documents may be missing from their tag groups or sit in none: the breakdown is " +
        "incomplete (groupsComplete false).",
    );
    expect(summary).toContain("The breakdown is incomplete.");
  }, 20_000); // 10,001 relation rows.

  it("filters by tag with the measured list filter and checks every row", async () => {
    const { client, report } = await summarize({ subject: "invoices", tag: "projekt y" }, [
      TAGS,
      tagUsesRoute(7001, [
        relationRow(8101, 7001, "Invoice", 501),
        relationRow(8103, 7001, "Invoice", 502),
      ]),
      invoices,
    ]);

    expect(client.callsTo("/Invoice")[0]?.query).toMatchObject({
      "tags[0][id]": 7001,
      "tags[0][objectName]": "Tag",
    });
    expect(report.recordsCounted).toBe(2);
    expect(report.totals.lines[0]?.net).toEqual(eur("300.00"));
    expect(report.tagFilter).toEqual({ tagId: 7001, rowsChecked: true });
  });
});

describe("sevdesk_records_summarize: unknown and ambiguous filters", () => {
  it("refuses an unknown tag before any list request", async () => {
    const client = new FakeSevdeskClient([
      TAGS,
      rows("/Voucher", [voucherDoc({ id: 31, date: "2026-10-01", net: "1", tax: "0" })]),
    ]);
    await expect(
      summarizeRecords(client, {
        subject: "vouchers",
        groupBy: "none",
        tag: "Projekt Z",
        maxGroups: 50,
      }),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "No tag has this name (compared ignoring case and accents), so no document carries it. " +
        "sevdesk_tags_list lists the tags.",
    });
    expect(client.callsTo("/Voucher")).toEqual([]);
  });

  it("refuses a tag name two tags share in other spellings", async () => {
    const promise = summarize({ subject: "invoices", tag: "projekt y" }, [
      tagsRoute([tagRow(7001, "Projekt Y"), tagRow(7003, "PROJEKT Y")]),
      rows("/Invoice", []),
    ]);
    await expect(promise).rejects.toMatchObject({ kind: "validation" });
    await expect(promise).rejects.toThrow(/Several tags have this name/);
  });

  it("refuses an ambiguous cost centre name before any list request", async () => {
    const client = new FakeSevdeskClient([
      costCentresRouteOf([
        costCentreRow(1, "A1", "Werkstatt"),
        costCentreRow(2, "A2", "WERKSTATT"),
      ]),
      rows("/Invoice", []),
    ]);
    await expect(
      summarizeRecords(client, {
        subject: "invoices",
        groupBy: "none",
        costCentre: "werkstatt",
        maxGroups: 50,
      }),
    ).rejects.toThrow(/Several cost centres have this number or name/);
    expect(client.callsTo("/Invoice")).toEqual([]);
  });

  it.each([
    [{ subject: "transactions", tag: "Projekt Y" }, /transactions carry no tags/],
    [{ subject: "transactions", groupBy: "tag" }, /transactions carry no tags/],
    [{ subject: "transactions", costCentre: "MCP1" }, /transactions have no cost centre/],
    [{ subject: "transactions", groupBy: "cost_centre" }, /transactions have no cost centre/],
  ])("%j is refused", async (args, message) => {
    const promise = summarize(args, [TAGS, costCentresRoute]);
    await expect(promise).rejects.toMatchObject({ kind: "validation" });
    await expect(promise).rejects.toThrow(message);
  });
});
