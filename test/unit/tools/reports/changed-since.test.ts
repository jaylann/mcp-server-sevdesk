import { describe, expect, it } from "vitest";

import { changedSince, type ChangesReport } from "../../../../src/domain/reports/changes.js";
import { changedSinceTool as tool } from "../../../../src/tools/reports/changed-since.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  contactRow,
  creditNoteRow,
  invoice,
  many,
  orderRow,
  progressContext,
  rows,
  runTool,
  transaction,
  voucher,
} from "./records.js";

const SINCE = "2026-11-01T08:00:00+01:00";
const SINCE_UNIX = Date.parse("2026-11-01T07:00:00Z") / 1000;

async function run(args: Record<string, unknown>, routes: readonly FakeRoute[]) {
  const { client, result, data } = await runTool(tool, args, routes);
  return { client, summary: result.summary, report: data as ChangesReport };
}

const fixtureRoutes: FakeRoute[] = [
  { path: "/Contact", response: { fixture: "contacts/contacts-list.json" } },
  { path: "/Invoice", response: { fixture: "invoices/invoices-list.json" } },
  { path: "/CreditNote", response: { fixture: "credit-notes/credit-notes-list.json" } },
  { path: "/Order", response: { fixture: "orders/orders-list.json" } },
  { path: "/Voucher", response: { fixture: "vouchers/vouchers-list.json" } },
  { path: "/CheckAccountTransaction", response: { fixture: "banking/transactions-list.json" } },
];

describe("sevdesk_changed_since (community row shapes, fake data)", () => {
  it("is a read tool of the reports toolset", () => {
    expect(tool.name).toBe("sevdesk_changed_since");
    expect(tool.toolset).toBe("reports");
    expect(tool.tier).toBe("read");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("checks every subject by default, sending updateAfter only where the spec documents it", async () => {
    const { client, report } = await run({ since: "2026-02-19" }, fixtureRoutes);
    const updateAfter = Date.parse("2026-02-18T23:00:00Z") / 1000 - 1;
    expect(client.calls.map((call) => [call.path, call.query])).toEqual([
      ["/Contact", { depth: "1", updateAfter, limit: 20, offset: 0, countAll: true }],
      // showAll: sevDesk's default invoice list leaves reminders out (D-049).
      ["/Invoice", { showAll: "true", updateAfter, limit: 20, offset: 0, countAll: true }],
      ["/CreditNote", { limit: 1000, offset: 0, countAll: true }],
      ["/Order", { updateAfter, limit: 20, offset: 0, countAll: true }],
      ["/Voucher", { updateAfter, limit: 20, offset: 0, countAll: true }],
      ["/CheckAccountTransaction", { limit: 1000, offset: 0, countAll: true }],
    ]);
    expect(report.subjects.map((subject) => [subject.subject, subject.filteredBy])).toEqual([
      ["contacts", "sevdesk"],
      ["invoices", "sevdesk"],
      ["credit_notes", "this_server"],
      ["orders", "sevdesk"],
      ["vouchers", "sevdesk"],
      ["transactions", "this_server"],
    ]);
    expect(report.since).toBe("2026-02-19T00:00:00+01:00");
    expect(report.notes).toEqual([
      "A record counts as changed when its last update (or its creation, if sevDesk has no " +
        "update time) is at or after since. Deleted records do not appear: sevDesk only lists " +
        "records that still exist.",
      "sevDesk filtered contacts, invoices, orders, vouchers with its documented updateAfter " +
        "filter; every row was checked here again.",
      "Credit notes and transactions have no documented change filter in sevDesk: their rows " +
        "were read and checked here, up to 5000 rows per call; continue with nextOffset while " +
        "hasMore.",
    ]);
    const transactions = report.subjects.find((subject) => subject.subject === "transactions");
    expect(transactions).toMatchObject({ total: 7, rowsScanned: 7, hasMore: false });
    expect(transactions?.items[0]).toEqual({
      id: 5001,
      name: "Beispiel Lieferant AG",
      status: { code: 100, label: "Created", key: "created" },
      date: "2026-01-05",
      updatedAt: "2026-02-19T14:14:21+01:00",
    });
  });

  it("keeps rows updated at or after since (creation time as fallback), newest first", async () => {
    const { client, report, summary } = await run({ since: SINCE, subjects: ["invoices"] }, [
      rows("/Invoice", [
        invoice({ id: "1", update: "2026-11-01T08:00:00+01:00" }),
        invoice({ id: "2", update: "2026-11-01T07:59:59+01:00" }),
        invoice({ id: "3", update: null, create: "2026-11-02T10:00:00+01:00" }),
        invoice({ id: "4", update: null, create: null }),
        invoice({ id: "5", update: "2026-11-05T11:00:00Z" }),
      ]),
    ]);
    expect(client.callsTo("/Invoice")[0]?.query).toEqual({
      showAll: "true",
      updateAfter: SINCE_UNIX - 1,
      limit: 20,
      offset: 0,
      countAll: true,
    });
    const [result] = report.subjects;
    expect(result).toEqual({
      subject: "invoices",
      filteredBy: "sevdesk",
      items: [
        {
          id: 5,
          type: "RE",
          number: "RE-1001",
          status: { code: 200, label: "Open / due", key: "open" },
          date: "2026-10-01",
          updatedAt: "2026-11-05T12:00:00+01:00",
          link: "https://my.sevdesk.de/fi/detail/type/RE/id/5",
        },
        expect.objectContaining({ id: 3, updatedAt: "2026-11-02T10:00:00+01:00" }),
        expect.objectContaining({ id: 1, updatedAt: "2026-11-01T08:00:00+01:00" }),
      ],
      total: 3,
      rowsScanned: 5,
      hasMore: false,
      withoutTimestamp: 1,
    });
    expect(report.recordsScanned).toBe(5);
    expect(summary).toBe(
      "Changed since 2026-11-01T08:00:00+01:00: 3 invoices; 5 sevDesk rows examined.",
    );
  });

  it("reports a reminder that sevDesk's default invoice list hides", async () => {
    const reminder = invoice({
      id: "77",
      invoiceType: "MA",
      invoiceNumber: "MA-1001",
      update: "2026-11-02T09:00:00+01:00",
    });
    // As recorded (D-049): reminders come only with showAll=true, never in the default list.
    const routes: FakeRoute[] = [
      rows("/Invoice", [reminder], { showAll: "true" }),
      rows("/Invoice", []),
    ];

    const { report } = await run({ since: SINCE, subjects: ["invoices"] }, routes);

    expect(report.subjects[0]).toMatchObject({ total: 1, rowsScanned: 1, hasMore: false });
    expect(report.subjects[0]?.items).toEqual([
      expect.objectContaining({ id: 77, type: "MA", number: "MA-1001" }),
    ]);
  });

  it("gives sevDesk's count only as an upper bound while rows are unchecked", async () => {
    // sevDesk's filter starts one second before since (D-048): it counts both invoices, but the
    // second one was updated at 07:59:59 and is not a change since 08:00:00.
    const objects = [
      invoice({ id: "1", update: "2026-11-01T08:00:00+01:00" }),
      invoice({ id: "2", update: "2026-11-01T07:59:59+01:00" }),
    ];
    const first = await run({ since: SINCE, subjects: ["invoices"], limit: 1 }, [
      rows("/Invoice", objects),
    ]);
    const [page] = first.report.subjects;
    expect(page?.items.map((row) => row.id)).toEqual([1]);
    // Before the fix this page said total: 2.
    expect(page).not.toHaveProperty("total");
    expect(page).toMatchObject({ totalAtMost: 2, rowsScanned: 1, hasMore: true, nextOffset: 1 });

    // Checked in one call from the start, the exact count is known: 1.
    const whole = await run({ since: SINCE, subjects: ["invoices"], limit: 5 }, [
      rows("/Invoice", objects),
    ]);
    expect(whole.report.subjects[0]).toMatchObject({ total: 1, rowsScanned: 2, hasMore: false });
    expect(whole.report.subjects[0]).not.toHaveProperty("totalAtMost");
  });

  it("pages with nextOffset, with sevDesk's count as an upper bound", async () => {
    const objects = many(5, (index) =>
      voucher({ id: String(10 + index), update: "2026-11-03T10:00:00+01:00" }),
    );
    const { client, report, summary } = await run(
      { since: SINCE, subjects: ["vouchers"], limit: 2 },
      [rows("/Voucher", objects)],
    );
    expect(client.callsTo("/Voucher")).toHaveLength(1);
    expect(report.subjects[0]).toMatchObject({
      totalAtMost: 5,
      rowsScanned: 2,
      hasMore: true,
      nextOffset: 2,
    });
    expect(report.subjects[0]).not.toHaveProperty("total");
    expect(report.subjects[0]?.items[0]).toEqual({
      id: 10,
      type: "expense",
      number: "RE-2026-0042",
      name: "Beispiel Lieferant AG",
      status: { code: 100, label: "Unpaid / due", key: "open" },
      date: "2026-01-12",
      updatedAt: "2026-11-03T10:00:00+01:00",
      link: "https://my.sevdesk.de/ex/detail/id/10",
    });
    expect(summary).toBe(
      "Changed since 2026-11-01T08:00:00+01:00: 2+ vouchers; 2 sevDesk rows examined. '+' " +
        "means more may follow: page with nextOffset.",
    );

    const next = await run({ since: SINCE, subjects: ["vouchers"], limit: 2, offset: 4 }, [
      rows("/Voucher", objects),
    ]);
    expect(next.client.callsTo("/Voucher")[0]?.query).toMatchObject({ offset: 4, limit: 2 });
    // A later page did not check the rows before its offset: still an upper bound.
    expect(next.report.subjects[0]).toMatchObject({
      totalAtMost: 5,
      rowsScanned: 1,
      hasMore: false,
    });
    expect(next.report.subjects[0]).not.toHaveProperty("total");
  });

  it("switches to full pages when sevDesk evidently ignored the filter", async () => {
    const old = "2026-10-01T10:00:00+02:00";
    const fresh = "2026-11-02T10:00:00+01:00";
    const { client, report } = await run({ since: SINCE, subjects: ["orders"], limit: 2 }, [
      rows("/Order", [
        orderRow({ id: "1", update: old }),
        orderRow({ id: "2", update: fresh }),
        orderRow({ id: "3", update: old }),
        orderRow({ id: "4", update: fresh }),
        orderRow({ id: "5", update: fresh }),
      ]),
    ]);
    expect(
      client.callsTo("/Order").map((call) => [call.query["offset"], call.query["limit"]]),
    ).toEqual([
      [0, 2],
      [2, 1000],
    ]);
    const [result] = report.subjects;
    expect(result?.items.map((row) => row.id)).toEqual([2, 4]);
    expect(result).toMatchObject({ rowsScanned: 4, hasMore: true, nextOffset: 4 });
    expect(result).not.toHaveProperty("total");
    expect(result?.items[0]).toMatchObject({
      type: "AB",
      number: "AB-1002",
      status: { code: 500, label: "Accepted", key: "accepted" },
      link: "https://my.sevdesk.de/om/detail/type/AB/id/2",
    });
  });

  it("names contacts by the contacts module's rule and sanitizes untrusted text", async () => {
    const bidi = String.fromCodePoint(0x202e);
    const { client, report } = await run({ since: SINCE, subjects: ["contacts", "credit_notes"] }, [
      rows("/Contact", [
        contactRow({
          id: "7",
          name: `Muster${bidi}firma GmbH`,
          update: "2026-11-02T09:00:00+01:00",
        }),
      ]),
      rows("/CreditNote", [creditNoteRow({ id: "8", update: "2026-11-02T09:00:00+01:00" })]),
    ]);
    expect(client.callsTo("/Contact")[0]?.query).toMatchObject({ depth: "1" });
    expect(report.subjects[0]?.items).toEqual([
      {
        id: 7,
        number: "K-1001",
        name: "Musterfirma GmbH",
        status: { code: 1000, label: "Active" },
        updatedAt: "2026-11-02T09:00:00+01:00",
        link: "https://my.sevdesk.de/crm/detail/id/7",
      },
    ]);
    expect(report.subjects[1]?.items).toEqual([
      {
        id: 8,
        number: "GU-1001",
        status: { code: 200, label: "Open / delivered", key: "open" },
        date: "2026-10-22",
        updatedAt: "2026-11-02T09:00:00+01:00",
        link: "https://my.sevdesk.de/cn/detail/type/CN/id/8",
      },
    ]);
  });

  it("caps the scan of subjects sevDesk cannot filter and continues with nextOffset", async () => {
    const client = new FakeSevdeskClient([
      rows(
        "/CheckAccountTransaction",
        many(5, (index) => transaction({ id: String(100 + index) })),
      ),
    ]);
    const report = await changedSince(client, {
      since: SINCE,
      subjects: ["transactions", "transactions"],
      limit: 10,
      offset: 0,
      maxRowsPerSubject: 3,
    });
    expect(report.subjects).toHaveLength(1);
    expect(report.subjects[0]).toEqual({
      subject: "transactions",
      filteredBy: "this_server",
      items: [],
      rowsScanned: 3,
      hasMore: true,
      nextOffset: 3,
      scanCapped: true,
    });
    expect(report.notes[1]).toContain("up to 3 rows per call");
  });

  it("refuses offset with several subjects, unreadable since values and broken timestamps", async () => {
    await expect(
      run({ since: SINCE, subjects: ["invoices", "orders"], offset: 20 }, []),
    ).rejects.toThrow(/exactly one subject together with offset/);
    await expect(run({ since: "yesterday!", subjects: ["invoices"] }, [])).rejects.toMatchObject({
      kind: "validation",
    });
    await expect(
      run({ since: SINCE, subjects: ["invoices"] }, [
        rows("/Invoice", [invoice({ id: "1", update: "soon" })]),
      ]),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
    await expect(
      changedSince(new FakeSevdeskClient([]), { since: SINCE, subjects: [], limit: 1, offset: 0 }),
    ).rejects.toThrow(/at least one subject/);
  });

  it("returns an empty page for subjects without changes", async () => {
    const { report, summary } = await run({ since: SINCE, subjects: ["invoices"] }, [
      rows("/Invoice", []),
    ]);
    expect(report.subjects[0]).toEqual({
      subject: "invoices",
      filteredBy: "sevdesk",
      items: [],
      total: 0,
      rowsScanned: 0,
      hasMore: false,
    });
    expect(summary).toBe(
      "Changed since 2026-11-01T08:00:00+01:00: 0 invoices; 0 sevDesk rows examined.",
    );
  });

  it("reports progress across subjects and stops when cancelled", async () => {
    let fake: FakeSevdeskClient | undefined;
    const promise = runTool(
      tool,
      { since: SINCE, subjects: ["invoices", "orders"] },
      [rows("/Invoice", [invoice({ id: "1" })]), rows("/Order", [orderRow({ id: "2" })])],
      (client) => {
        fake = client;
        return progressContext(client, 1).ctx;
      },
    );
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
    expect(fake?.callsTo("/Order")).toEqual([]);
  });
});
