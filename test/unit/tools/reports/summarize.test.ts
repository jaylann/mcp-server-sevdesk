import { describe, expect, it } from "vitest";

import {
  STATUS_KEYS_BY_SUBJECT,
  SUMMARY_STATUS_KEYS,
  type SummaryReport,
} from "../../../../src/domain/reports/summarize.js";
import { toUnixSeconds } from "../../../../src/sevdesk/dates.js";
import { recordsSummarizeTool as tool } from "../../../../src/tools/reports/summarize.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import {
  accountsRoute,
  embeddedContact,
  invoice,
  many,
  progressContext,
  rows,
  runTool,
  transaction,
  voucher,
} from "./records.js";

const invoicesRoute: FakeRoute = {
  path: "/Invoice",
  response: { fixture: "invoices/invoices-list.json" },
};
const vouchersRoute: FakeRoute = {
  path: "/Voucher",
  response: { fixture: "vouchers/vouchers-list.json" },
};
const transactionsRoute: FakeRoute = {
  path: "/CheckAccountTransaction",
  response: { fixture: "banking/transactions-list.json" },
};

async function summarize(args: Record<string, unknown>, routes: readonly FakeRoute[]) {
  const { client, result, data } = await runTool(tool, args, routes);
  return { client, summary: result.summary, report: data as SummaryReport };
}

const eur = (amount: string) => ({ amount, currency: "EUR" });

describe("sevdesk_records_summarize (community fixtures, fake data)", () => {
  it("is a read tool of the reports toolset with explicit annotations", () => {
    expect(tool.name).toBe("sevdesk_records_summarize");
    expect(tool.toolset).toBe("reports");
    expect(tool.tier).toBe("read");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.description).toContain("not a sevDesk report");
    expect(tool.description).toContain("Auswertung");
  });

  it("offers exactly the status keys the subjects' list functions understand", () => {
    const union = new Set(Object.values(STATUS_KEYS_BY_SUBJECT).flat());
    expect(union).toEqual(new Set(SUMMARY_STATUS_KEYS));
  });

  it("totals invoices per currency exactly, with EUR values of foreign ones", async () => {
    const { client, report, summary } = await summarize({ subject: "invoices" }, [invoicesRoute]);
    expect(client.methods().every((method) => method === "GET")).toBe(true);
    expect(client.callsTo("/Invoice").map((call) => call.query)).toEqual([
      { embed: "contact", limit: 1000, offset: 0, countAll: true },
    ]);
    expect(report.totals).toEqual({
      count: 9,
      lines: [
        {
          currency: "EUR",
          count: 8,
          net: eur("1682.06"),
          tax: eur("319.58"),
          gross: eur("2001.64"),
        },
        {
          currency: "USD",
          count: 1,
          net: { amount: "100.00", currency: "USD" },
          tax: { amount: "0.00", currency: "USD" },
          gross: { amount: "100.00", currency: "USD" },
          eur: { records: 1, net: eur("92.59"), tax: eur("0.00"), gross: eur("92.59") },
        },
      ],
    });
    expect(report).toMatchObject({
      source: expect.stringContaining("not one of sevDesk's own reports") as string,
      subject: "invoices",
      groupBy: "none",
      filters: {},
      dateField: "invoice date (Rechnungsdatum)",
      period: { earliest: "2026-09-01", latest: "2026-11-07" },
      recordsScanned: 9,
      recordsCounted: 9,
      truncated: false,
      groups: [],
    });
    expect(report.notes).toEqual([
      "1 draft (Entwurf) are included; pass a status to leave drafts out.",
      "1 cancellation invoice (SR, Stornorechnung) is included with negative sums. Of these, 1 " +
        "cancels an invoice that is also counted here; each such pair nets to zero.",
      "Foreign-currency records are totalled in their own currency; eur holds sevDesk's EUR " +
        "values where sevDesk provides them.",
    ]);
    expect(summary).toBe("Invoices: 9 counted in 2 currencies; 9 sevDesk rows read.");
  });

  it("passes the date range to sevDesk and totals only the rows the list keeps", async () => {
    const { client, report } = await summarize(
      {
        subject: "invoices",
        groupBy: "month",
        from: "2026-10-01",
        to: "2026-10-31",
        status: "paid",
      },
      [invoicesRoute],
    );
    // The documents module sends the range (start − 1 s, D-046) and re-checks every row's date.
    expect(client.callsTo("/Invoice")[0]?.query).toMatchObject({
      status: 1000,
      startDate: toUnixSeconds("2026-10-01", "start") - 1,
      endDate: toUnixSeconds("2026-10-31", "end"),
    });
    // The fake returns every invoice; only the three dated in October count.
    expect(report.recordsScanned).toBe(9);
    expect(report.recordsCounted).toBe(3);
    expect(report.period).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      earliest: "2026-10-01",
      latest: "2026-10-12",
    });
    expect(report.groups).toEqual([
      {
        key: "2026-10",
        count: 3,
        lines: [
          {
            currency: "EUR",
            count: 3,
            net: eur("149.02"),
            tax: eur("28.31"),
            gross: eur("177.33"),
          },
        ],
      },
    ]);
    expect(report.filters).toEqual({ status: "paid", from: "2026-10-01", to: "2026-10-31" });
    expect(report.notes).toContain(
      "6 rows sevDesk returned did not pass the filters re-checked after reading (date range, " +
        "voucher type, transaction status) and were left out; recordsScanned counts them.",
    );
    expect(report.notes.some((note) => note.includes("draft"))).toBe(false);
  });

  it("orders contact groups by EUR gross, foreign documents by their EUR value", async () => {
    const { report } = await summarize({ subject: "invoices", groupBy: "contact" }, [
      invoicesRoute,
    ]);
    expect(report.groups.map((group) => [group.key, group.contact, group.count])).toEqual([
      ["contact:1001", { id: 1001, name: "Musterfirma GmbH" }, 7],
      ["contact:1002", { id: 1002, name: "Max Mustermann" }, 1],
      ["contact:1003", { id: 1003 }, 1],
    ]);
    expect(report.groups[0]?.lines[0]?.gross).toEqual(eur("1901.66"));
  });

  it("groups by status in code order and counts groups beyond maxGroups", async () => {
    const { report, summary } = await summarize(
      { subject: "invoices", groupBy: "status", maxGroups: 2 },
      [invoicesRoute],
    );
    expect(report.groups.map((group) => [group.key, group.status, group.count])).toEqual([
      ["100", { code: 100, label: "Draft" }, 1],
      ["200", { code: 200, label: "Open / due" }, 4],
    ]);
    expect(report.groupsOmitted).toBe(2);
    expect(report.totals.count).toBe(9);
    expect(summary).toBe(
      "Invoices: 9 counted in 2 currencies, 4 groups by status (2 shown); 9 sevDesk rows read.",
    );
  });

  it("groups by quarter and puts undated records last", async () => {
    const { report } = await summarize({ subject: "invoices", groupBy: "quarter" }, [
      rows("/Invoice", [
        invoice({ id: "1", invoiceDate: "2026-11-02T00:00:00+01:00" }),
        invoice({ id: "2", invoiceDate: null }),
        invoice({ id: "3", invoiceDate: "2026-03-31T00:00:00+02:00" }),
        invoice({ id: "4", invoiceDate: "2026-04-01T00:00:00+02:00" }),
      ]),
    ]);
    expect(report.groups.map((group) => [group.key, group.count])).toEqual([
      ["2026-Q1", 1],
      ["2026-Q2", 1],
      ["2026-Q4", 1],
      ["no_date", 1],
    ]);
  });

  it("counts rows the list drops (undated with a range) as scanned, not as totals", async () => {
    const { report } = await summarize({ subject: "invoices", from: "2026-01-01" }, [
      rows("/Invoice", [
        invoice({ id: "1", invoiceDate: "2026-11-02T00:00:00+01:00" }),
        invoice({ id: "2", invoiceDate: null }),
      ]),
    ]);
    expect(report.recordsScanned).toBe(2);
    expect(report.recordsCounted).toBe(1);
    expect(report.notes).toContain(
      "1 row sevDesk returned did not pass the filters re-checked after reading (date range, " +
        "voucher type, transaction status) and were left out; recordsScanned counts them.",
    );
  });

  it("adds 0.1 + 0.2 exactly and keeps negative sums", async () => {
    const { report } = await summarize({ subject: "invoices" }, [
      rows("/Invoice", [
        invoice({ id: "1", sumNet: "0.1", sumTax: "0", sumGross: "0.1" }),
        invoice({ id: "2", sumNet: 0.2, sumTax: "0", sumGross: 0.2 }),
        invoice({ id: "3", sumNet: "-0.05", sumTax: "0", sumGross: "-0.05", invoiceType: "SR" }),
      ]),
    ]);
    expect(report.totals.lines).toEqual([
      { currency: "EUR", count: 3, net: eur("0.25"), tax: eur("0.00"), gross: eur("0.25") },
    ]);
  });

  it("returns empty totals when nothing matches", async () => {
    const { report, summary } = await summarize({ subject: "credit_notes", groupBy: "month" }, [
      rows("/CreditNote", []),
    ]);
    expect(report).toMatchObject({
      recordsScanned: 0,
      recordsCounted: 0,
      truncated: false,
      totals: { count: 0, lines: [] },
      groups: [],
      notes: [],
    });
    expect(report.period).toEqual({});
    expect(summary).toBe(
      "Credit notes: 0 counted in 0 currencies, 0 groups by month; 0 sevDesk rows read.",
    );
  });

  it("summarizes credit notes with their filters", async () => {
    const { client, report } = await summarize(
      { subject: "credit_notes", contactId: 1001, status: "open" },
      [{ path: "/CreditNote", response: { fixture: "credit-notes/credit-notes-list.json" } }],
    );
    expect(client.callsTo("/CreditNote")[0]?.query).toMatchObject({
      embed: "contact",
      status: 200,
      "contact[id]": 1001,
      "contact[objectName]": "Contact",
    });
    expect(report.totals.lines[0]).toMatchObject({
      currency: "EUR",
      count: 3,
      gross: eur("107.10"),
    });
    expect(report.dateField).toBe("credit note date (Gutschriftsdatum)");
  });

  describe("vouchers", () => {
    it("totals expense and revenue in separate lines, foreign ones with their EUR base", async () => {
      const { report } = await summarize({ subject: "vouchers" }, [vouchersRoute]);
      expect(report.totals.lines).toEqual([
        {
          currency: "EUR",
          kind: "expense",
          count: 3,
          net: eur("400.50"),
          tax: eur("76.10"),
          gross: eur("476.60"),
        },
        {
          currency: "EUR",
          kind: "revenue",
          count: 1,
          net: eur("100.00"),
          tax: eur("19.00"),
          gross: eur("119.00"),
        },
        {
          currency: "USD",
          kind: "expense",
          count: 1,
          net: { amount: "378.00", currency: "USD" },
          tax: { amount: "0.00", currency: "USD" },
          gross: { amount: "378.00", currency: "USD" },
          eur: { records: 1, net: eur("324.59"), tax: eur("0.00"), gross: eur("324.59") },
        },
      ]);
      expect(report.notes).toContain(
        "Expense (Ausgabe) and revenue (Einnahme) vouchers are totalled in separate lines (kind); " +
          "voucher sums are positive for both.",
      );
      expect(report.notes).toContain(
        "Only normal vouchers are counted: recurring voucher templates (RV) are not read " +
          "(voucherType=VOU), because the vouchers they generate are the records.",
      );
      // Voucher 2006 is a recurring template the fake returned anyway: dropped by the re-check.
      expect(report.recordsScanned).toBe(6);
      expect(report.recordsCounted).toBe(5);
      expect(report.notes).toContain(
        "1 draft (Entwurf) are included; pass a status to leave drafts out.",
      );
    });

    it("sends kind and supplier filters and groups suppliers without a contact by name", async () => {
      const { client, report } = await summarize(
        { subject: "vouchers", kind: "expense", groupBy: "contact", from: "2023-01-01" },
        [vouchersRoute],
      );
      expect(client.callsTo("/Voucher")[0]?.query).toMatchObject({
        creditDebit: "C",
        voucherType: "VOU",
        startDate: toUnixSeconds("2023-01-01", "start") - 1,
      });
      expect(report.groups.map((group) => [group.key, group.contact])).toEqual([
        ["contact:1003", { id: 1003, name: "Beispiel Lieferant AG" }],
        ["name:example cloud inc.", { name: "Example Cloud Inc." }],
        ["contact:1002", { id: 1002, name: "Max Mustermann" }],
        ["name:bürobedarf muster kg", { name: "Bürobedarf Muster KG" }],
      ]);
      expect(report.notes.some((note) => note.includes("separate lines"))).toBe(false);
    });

    it("passes supplierId and status to sevDesk", async () => {
      const { client } = await summarize(
        { subject: "vouchers", contactId: 1003, status: "transferred" },
        [rows("/Voucher", [])],
      );
      expect(client.callsTo("/Voucher")[0]?.query).toMatchObject({
        status: 150,
        "contact[id]": 1003,
      });
    });
  });

  describe("transactions", () => {
    it("sums incoming and outgoing per currency and groups by account", async () => {
      const { report, summary } = await summarize({ subject: "transactions", groupBy: "account" }, [
        accountsRoute,
        transactionsRoute,
      ]);
      expect(report.totals.lines).toEqual([
        {
          currency: "EUR",
          count: 6,
          incoming: eur("1690.00"),
          outgoing: eur("-606.59"),
          netFlow: eur("1083.41"),
        },
        {
          currency: "USD",
          count: 1,
          incoming: { amount: "0.00", currency: "USD" },
          outgoing: { amount: "-378.00", currency: "USD" },
          netFlow: { amount: "-378.00", currency: "USD" },
        },
      ]);
      expect(report.groups.map((group) => [group.key, group.account, group.count])).toEqual([
        ["account:4001", { id: 4001, name: "Basiskonto" }, 2],
        ["account:4002", { id: 4002, name: "Geschäftskonto Musterbank" }, 4],
        ["account:4005", { id: 4005, name: "PayPal USD" }, 1],
      ]);
      expect(report.notes).toContain(
        "outgoing is negative, as on the account; netFlow = incoming + outgoing.",
      );
      expect(summary).toBe(
        "Transactions: 7 counted in 2 currencies, 3 groups by account; 7 sevDesk rows read.",
      );
    });

    it("filters value dates and status here (sevDesk's date filter cuts by entry date)", async () => {
      const { client, report } = await summarize(
        {
          subject: "transactions",
          status: "created",
          checkAccountId: 4002,
          from: "2026-01-06",
          to: "2026-01-31",
        },
        [
          accountsRoute,
          rows("/CheckAccountTransaction", [
            transaction({ id: "1", valueDate: "2026-01-05T00:00:00+01:00", amount: "-1" }),
            transaction({ id: "2", valueDate: "2026-01-06T00:00:00+01:00", amount: "0.1" }),
            transaction({ id: "3", valueDate: "2026-01-31T00:00:00+01:00", amount: "0.2" }),
            transaction({
              id: "4",
              valueDate: "2026-01-31T00:00:00+01:00",
              amount: "5",
              status: "400",
            }),
          ]),
        ],
      );
      const query = client.callsTo("/CheckAccountTransaction")[0]?.query;
      expect(query).toMatchObject({ "checkAccount[id]": 4002, status: 100 });
      expect(query).not.toHaveProperty("startDate");
      expect(query).not.toHaveProperty("endDate");
      expect(report.recordsScanned).toBe(4);
      expect(report.recordsCounted).toBe(2);
      expect(report.totals.lines[0]).toMatchObject({ incoming: eur("0.30"), count: 2 });
      expect(report.notes).toContain(
        "The date range is checked here by value date (sevDesk's own date filter cuts by entry " +
          "date), so all rows of the account(s) are read; the row cap applies to them.",
      );
    });
  });

  describe("templates, reminders and cancellations", () => {
    const rowsOf = (...objects: Record<string, unknown>[]) => [rows("/Invoice", objects)];

    it("leaves recurring templates (WKR) and reminders (MA) out unless asked for", async () => {
      const { report } = await summarize(
        { subject: "invoices" },
        rowsOf(
          invoice({ id: "1" }),
          invoice({ id: "2", invoiceType: "WKR" }),
          invoice({ id: "3", invoiceType: "MA" }),
        ),
      );
      expect(report).toMatchObject({ recordsScanned: 3, recordsCounted: 1 });
      expect(report.notes).toEqual([
        "1 recurring invoice template (WKR, Abo-Rechnung) were left out: the invoices they " +
          "generate are the records. Pass invoiceType recurring to see them.",
        "1 reminder (MA, Mahnung) were left out: they repeat the amount of the invoice they " +
          "remind of. Pass invoiceType reminder to see them.",
      ]);
    });

    it("counts reminders when invoiceType asks for them", async () => {
      const { client, report } = await summarize(
        { subject: "invoices", invoiceType: "reminder" },
        rowsOf(invoice({ id: "3", invoiceType: "MA" }), invoice({ id: "2", invoiceType: "WKR" })),
      );
      expect(client.callsTo("/Invoice")[0]?.query).toMatchObject({ invoiceType: "MA" });
      expect(report.recordsCounted).toBe(1);
      expect(report.filters).toEqual({ invoiceType: "reminder" });
      const recurring = await summarize(
        { subject: "invoices", invoiceType: "recurring" },
        rowsOf(invoice({ id: "2", invoiceType: "WKR" })),
      );
      expect(recurring.report.recordsCounted).toBe(1);
    });

    it("says when a cancellation invoice's original is not in the summary", async () => {
      const { report } = await summarize(
        { subject: "invoices" },
        rowsOf(
          invoice({
            id: "9",
            invoiceType: "SR",
            status: "1000",
            sumNet: "-10",
            sumTax: "0",
            sumGross: "-10",
            origin: { id: "8", objectName: "Invoice" },
          }),
          invoice({
            id: "10",
            invoiceType: "SR",
            status: "1000",
            sumNet: "-5",
            sumTax: "0",
            sumGross: "-5",
            origin: { id: "7", objectName: "Invoice" },
          }),
        ),
      );
      expect(report.notes).toEqual([
        "2 cancellation invoices (SR, Stornorechnung) are included with negative sums. 2 cancel " +
          "invoices that are not in this summary (another period or filter, or no link in " +
          "sevDesk), so their negative sums are not offset here.",
      ]);
    });

    it("flags paid invoices with nothing paid as cancelled originals whose SR is missing", async () => {
      const { report } = await summarize(
        { subject: "invoices" },
        rowsOf(
          invoice({ id: "8", status: "1000", paidAmount: "0" }),
          invoice({ id: "6", status: "1000", paidAmount: "177.33" }),
          invoice({
            id: "9",
            invoiceType: "SR",
            status: "1000",
            sumNet: "-1",
            sumTax: "0",
            sumGross: "-1",
            origin: { id: "5", objectName: "Invoice" },
          }),
        ),
      );
      expect(report.notes).toEqual([
        "1 cancellation invoice (SR, Stornorechnung) is included with negative sums. 1 cancels " +
          "an invoice that is not in this summary (another period or filter, or no link in " +
          "sevDesk), so its negative sums are not offset here.",
        "1 counted invoice have status paid with a paid amount of 0, which is how sevDesk shows " +
          "a cancelled invoice; their cancellation invoices are not in this summary, so these " +
          "sums are not offset here.",
      ]);
    });
  });

  describe("refuses filters a subject does not have", () => {
    it.each([
      [
        { subject: "invoices", status: "transferred" },
        /status 'transferred' does not apply to invoices/,
      ],
      [{ subject: "transactions", status: "paid" }, /use one of created, linked/],
      [{ subject: "invoices", kind: "expense" }, /kind applies to vouchers only/],
      [{ subject: "vouchers", invoiceType: "reminder" }, /invoiceType applies to invoices only/],
      [
        { subject: "vouchers", checkAccountId: 4002 },
        /checkAccountId applies to transactions only/,
      ],
      [{ subject: "transactions", contactId: 1 }, /transactions have no contact/],
      [{ subject: "transactions", groupBy: "contact" }, /group them by account/],
      [{ subject: "credit_notes", groupBy: "account" }, /groupBy account applies to transactions/],
      [{ subject: "invoices", from: "2026-02-01", to: "2026-01-01" }, /'from' is after 'to'/],
    ])("%j", async (args, message) => {
      const promise = summarize(args, [invoicesRoute]);
      await expect(promise).rejects.toMatchObject({ kind: "validation" });
      await expect(promise).rejects.toThrow(message);
    });
  });

  it(`stops at 10,000 rows and reports the totals as truncated`, async () => {
    const objects = many(10_001, (index) =>
      voucher({ id: String(100_000 + index), sumNet: "1", sumTax: "0", sumGross: "1" }),
    );
    const { client, report, summary } = await summarize({ subject: "vouchers", kind: "expense" }, [
      rows("/Voucher", objects),
    ]);
    expect(client.callsTo("/Voucher")).toHaveLength(10);
    expect(report.recordsScanned).toBe(10_000);
    expect(report.truncated).toBe(true);
    expect(report.totals.lines[0]?.gross).toEqual(eur("10000.00"));
    expect(report.notes[0]).toBe(
      "Reading stopped at the cap of 10000 rows: the totals cover only the rows read. Narrow " +
        "the date range or filters for complete numbers.",
    );
    expect(summary).toContain("Stopped at the cap of 10000 rows read: totals are incomplete.");
  }, 20_000); // 10,001 rows: about 1.5 s alone, several seconds under full-suite coverage load.

  it("reports progress per page and stops when the call is cancelled mid-scan", async () => {
    const objects = many(2_500, (index) => voucher({ id: String(200_000 + index) }));
    let progressCalls: [number, number | undefined, string | undefined][] = [];
    let fakeClient: { callsTo: (path: string) => unknown[] } | undefined;
    const promise = runTool(
      tool,
      { subject: "vouchers" },
      [rows("/Voucher", objects)],
      (client) => {
        const { ctx, calls } = progressContext(client, 1);
        progressCalls = calls;
        fakeClient = client;
        return ctx;
      },
    );
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
    expect(progressCalls).toEqual([[1000, undefined, "Read 1000 vouchers."]]);
    expect(fakeClient?.callsTo("/Voucher")).toHaveLength(1);
  });

  it("names an embedded contact without a name only by id", async () => {
    const { report } = await summarize({ subject: "invoices", groupBy: "contact" }, [
      rows("/Invoice", [invoice({ id: "1", contact: embeddedContact("1005", null) })]),
    ]);
    expect(report.groups[0]?.contact).toEqual({ id: 1005 });
  });
});
