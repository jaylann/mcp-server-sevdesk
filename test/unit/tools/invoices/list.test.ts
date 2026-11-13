import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoiceRowSchema } from "../../../../src/domain/invoices.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoicesListTool as tool } from "../../../../src/tools/invoices/list.js";
import {
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  testContext,
} from "../../../helpers/fake-client.js";

const listRoute: FakeRoute = {
  path: "/Invoice",
  query: { embed: "contact" },
  response: { fixture: "invoices/invoices-list.json" },
};

async function list(args: Record<string, unknown>, routes: readonly FakeRoute[] = [listRoute]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  // These existing assertions exercise the unchanged full/default contract.
  return {
    client,
    result: {
      ...result,
      data: { ...result.data, items: result.data.items.map((row) => invoiceRowSchema.parse(row)) },
    },
  };
}

beforeEach(() => {
  // "Today" in Berlin is 2026-11-07 for the overdue checks.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sevdesk_invoices_list (community: recorded Invoice shape, fake data)", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("invoices");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("embeds the contact, sends an explicit limit and only GETs", async () => {
    const { client } = await list({});
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      operation: "list",
      method: "GET",
      path: "/Invoice",
      query: { embed: "contact", limit: 25, offset: 0, countAll: true },
    });
    expect(client.methods().every((method) => method === "GET")).toBe(true);
  });

  it("maps readable filters to sevDesk's codes and parameter names", async () => {
    const { client } = await list({
      status: "partially_paid",
      type: "advance",
      contactId: 1001,
      number: "RE-1001",
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(client.calls[0]?.query).toMatchObject({
      status: 750,
      invoiceType: "AR",
      "contact[id]": 1001,
      "contact[objectName]": "Contact",
      invoiceNumber: "RE-1001",
      // One second before 2026-01-01 00:00 CET (D-046), and 2026-03-31 23:59:59 CEST (DST since
      // 29 March).
      startDate: 1767222000 - 1,
      endDate: 1774994399,
    });
  });

  it("maps each status filter to its documented code", async () => {
    for (const [status, code] of [
      ["draft", 100],
      ["open", 200],
      ["paid", 1000],
    ] as const) {
      const { client } = await list({ status });
      expect(client.calls[0]?.query["status"]).toBe(code);
    }
  });

  it("returns compact rows that satisfy the output schema", async () => {
    const { result } = await list({});
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.items[0]).toEqual({
      id: 1001,
      number: "RE-1001",
      type: { key: "invoice", code: "RE", label: "Normal invoice", labelDe: "Rechnung" },
      status: { code: 200, label: "Open / due", key: "open" },
      contact: { id: 1001, name: "Musterfirma GmbH" },
      date: "2026-10-01",
      dueDate: "2026-10-15",
      overdue: true,
      currency: "EUR",
      totals: {
        net: { amount: "149.02", currency: "EUR" },
        tax: { amount: "28.31", currency: "EUR" },
        gross: { amount: "177.33", currency: "EUR" },
      },
      paid: { amount: "0.00", currency: "EUR" },
      header: "Rechnung RE-1001",
      sent: { date: "2026-10-01", via: "email" },
      link: "https://my.sevdesk.de/fi/detail/type/RE/id/1001",
    });
  });

  it("handles drafts, persons, paid/enshrined, advance and legacy invoices", async () => {
    const { result } = await list({});
    const byId = new Map(result.data.items.map((item) => [item.id, item]));

    const draft = byId.get(1002);
    expect(draft).toMatchObject({ status: { code: 100, label: "Draft", key: "draft" } });
    expect(draft).not.toHaveProperty("overdue");
    expect(draft?.contact).toEqual({ id: 1002, name: "Max Mustermann" });
    expect(draft?.sent).toBeUndefined(); // sendType "0" means not sent (D-009)
    // Drafts open in the editor, like the web app's own links.
    expect(draft?.link).toBe("https://my.sevdesk.de/fi/edit/type/RE/id/1002");

    expect(byId.get(1003)).toMatchObject({
      status: { code: 750, label: "Partially paid" },
      dueDate: "2026-10-01",
      overdue: true,
      paid: { amount: "50.00", currency: "EUR" },
    });

    const paid = byId.get(1004);
    expect(paid).toMatchObject({
      enshrined: true,
      sent: { date: "2026-10-01", via: "pdf_download" },
    });
    expect(paid?.overdue).toBeUndefined();

    const advance = byId.get(1005);
    expect(advance).toMatchObject({
      type: { code: "AR", labelDe: "Abschlagsrechnung" },
      overdue: false,
      link: "https://my.sevdesk.de/fi/detail/type/AR/id/1005",
    });
    // The recorded GET /Invoice has no propertyIsEInvoice (D-034): nothing is claimed either way.
    expect(advance).not.toHaveProperty("eInvoice");

    const legacy = byId.get(1007);
    expect(legacy).toMatchObject({ dueDate: "2026-11-07", overdue: false });
    expect(legacy?.sent).toBeUndefined();
  });

  it("reports foreign-currency invoices in their currency and EUR", async () => {
    const { result } = await list({});
    const usd = result.data.items.find((item) => item.id === 1006);
    expect(usd).toMatchObject({
      currency: "USD",
      contact: { id: 1003 },
      totals: {
        net: { amount: "100.00", currency: "USD" },
        gross: { amount: "100.00", currency: "USD" },
      },
      totalsEur: {
        net: { amount: "92.59", currency: "EUR" },
        gross: { amount: "92.59", currency: "EUR" },
      },
    });
    expect(usd?.contact?.name).toBeUndefined();
    expect(usd?.dueDate).toBeUndefined();
    // paidAmount's currency is not documented for foreign-currency invoices.
    expect(usd?.paid).toBeUndefined();
  });

  it("links a cancellation invoice (SR) to the invoice it cancels", async () => {
    const { result } = await list({});
    const byId = new Map(result.data.items.map((item) => [item.id, item]));
    // The cancelled original keeps status 1000 with nothing paid (recorded by sevdesk-rs).
    expect(byId.get(1008)).toMatchObject({
      status: { code: 1000, label: "Paid", key: "paid" },
      paid: { amount: "0.00", currency: "EUR" },
    });
    expect(byId.get(1008)?.cancelsInvoiceId).toBeUndefined();
    expect(byId.get(1009)).toMatchObject({
      type: { code: "SR", labelDe: "Stornorechnung" },
      cancelsInvoiceId: 1008,
      totals: { gross: { amount: "-46.65", currency: "EUR" } },
      link: "https://my.sevdesk.de/fi/detail/type/SR/id/1009",
    });
  });

  it("pages with total, hasMore and nextOffset", async () => {
    const first = await list({ limit: 4 });
    expect(first.result.data).toMatchObject({ total: 9, offset: 0, limit: 4, hasMore: true });
    expect(first.result.data.nextOffset).toBe(4);
    expect(first.result.data.filteredLocally).toBeUndefined();
    expect(first.result.summary).toBe("Invoices 1–4 of 9; more may follow (nextOffset 4).");

    const last = await list({ limit: 5, offset: 4 });
    expect(last.result.data.items.map((item) => item.id)).toEqual([1005, 1006, 1007, 1008, 1009]);
    expect(last.result.data).toMatchObject({ hasMore: false });
    expect(last.result.summary).toBe("Invoices 5–9 of 9.");
  });

  it("filters overdue invoices here and says so", async () => {
    const { client, result } = await list({ overdueOnly: true });
    expect(result.data.items.map((item) => item.id)).toEqual([1001, 1003]);
    expect(result.data).toMatchObject({ filteredLocally: true, hasMore: false });
    expect(result.data.total).toBeUndefined();
    expect(result.summary).toBe(
      "2 overdue invoices in rows 1–9 (filtered by this server, not sevDesk); end of list.",
    );
    // No server-side overdue parameter is sent (its web-app form excludes partially paid ones).
    expect(client.calls[0]?.query).not.toHaveProperty("delinquent");
  });

  it("re-checks the invoice number on every row, so an ignored filter cannot leak", async () => {
    // The fake client returns the whole fixture regardless of invoiceNumber, like sevDesk does
    // with a filter it ignores.
    const { client, result } = await list({ number: " re-1003 " });
    expect(client.calls[0]?.query).toMatchObject({ invoiceNumber: "re-1003" });
    expect(result.data.items.map((item) => item.id)).toEqual([1003]);
    expect(result.data).toMatchObject({ filteredLocally: true, hasMore: false });
    expect(result.summary).toBe(
      "1 matching invoices in rows 1–9 (filtered by this server, not sevDesk); end of list.",
    );
  });

  it("asks sevDesk to show recurring templates and reminders when that type is requested", async () => {
    // showWkr=all / showMa=all from the Invoice tag's filter table; whether sevDesk hides them
    // by default is unverified, the local type re-check keeps the result exact either way.
    const recurring = await list({ type: "recurring" });
    expect(recurring.client.calls[0]?.query).toMatchObject({ invoiceType: "WKR", showWkr: "all" });
    expect(recurring.client.calls[0]?.query).not.toHaveProperty("showMa");

    const reminder = await list({ type: "reminder" });
    expect(reminder.client.calls[0]?.query).toMatchObject({ invoiceType: "MA", showMa: "all" });
    expect(reminder.client.calls[0]?.query).not.toHaveProperty("showWkr");

    const plain = await list({ type: "invoice" });
    expect(plain.client.calls[0]?.query).not.toHaveProperty("showWkr");
    expect(plain.client.calls[0]?.query).not.toHaveProperty("showMa");
  });

  it("re-checks the invoice type on every row, so an ignored filter cannot leak (D-015)", async () => {
    // The fake returns the whole fixture regardless of invoiceType, as sevDesk would if it
    // ignored the filter (D-035).
    const { client, result } = await list({ type: "advance" });
    expect(client.calls[0]?.query).toMatchObject({ invoiceType: "AR" });
    expect(result.data.items.map((item) => item.id)).toEqual([1005]);
    expect(result.data).toMatchObject({ filteredLocally: true, hasMore: false });
    expect(result.data.total).toBeUndefined();
  });

  it("re-checks the date range on every row without a local scan (D-046)", async () => {
    // The fake ignores startDate/endDate, so rows outside the range come back as they could at
    // the edges: the re-check drops them while sevDesk's paging and total stay.
    const { client, result } = await list({ from: "2026-10-01", to: "2026-10-31" });
    expect(client.calls).toHaveLength(1);
    expect(result.data.items.map((item) => [item.id, item.date])).toEqual([
      [1001, "2026-10-01"],
      [1008, "2026-10-10"],
      [1009, "2026-10-12"],
    ]);
    expect(result.data).toMatchObject({ total: 9, hasMore: false });
    expect(result.data.filteredLocally).toBeUndefined();
  });

  it("shows eInvoice only when sevDesk sends propertyIsEInvoice (D-034)", async () => {
    // Illustrative: the recorded GET /Invoice row has no such key; the spec's request model and
    // the recorded POST /Invoice response (as null) do.
    const recorded = (loadFixture("invoices/invoices-list.json").body as { objects: object[] })
      .objects[0];
    const objects = [
      { ...recorded, id: "1", propertyIsEInvoice: "1" },
      { ...recorded, id: "2", propertyIsEInvoice: "0" },
      { ...recorded, id: "3", propertyIsEInvoice: null },
      { ...recorded, id: "4" },
    ];
    const { result } = await list({}, [{ ...listRoute, response: { body: { objects } } }]);
    expect(result.data.items.map((item) => item.eInvoice)).toEqual([
      true,
      false,
      undefined,
      undefined,
    ]);
    expect(result.data.items[2]).not.toHaveProperty("eInvoice");
    expect(result.data.items[3]).not.toHaveProperty("eInvoice");
  });

  it("stops scanning at the limit and continues right after the last row scanned", async () => {
    const first = await list({ overdueOnly: true, limit: 1 });
    expect(first.result.data.items.map((item) => item.id)).toEqual([1001]);
    expect(first.result.data).toMatchObject({ hasMore: true, nextOffset: 1 });

    const second = await list({ overdueOnly: true, limit: 1, offset: 1 });
    expect(second.result.data.items.map((item) => item.id)).toEqual([1003]);
    expect(second.result.data).toMatchObject({ hasMore: true, nextOffset: 3 });
    expect(second.result.summary).toBe(
      "1 overdue invoices in rows 2–3 (filtered by this server, not sevDesk); more may follow " +
        "(nextOffset 3).",
    );
  });

  it("rejects an empty date range locally without calling sevDesk", async () => {
    const client = new FakeSevdeskClient([listRoute]);
    await expect(
      tool.handler(tool.input.parse({ from: "2026-02-01", to: "2026-01-01" }), testContext(client)),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(client.calls).toHaveLength(0);
  });

  it("rejects unknown filters and invalid values", () => {
    expect(() => tool.input.parse({ status: "cancelled" })).toThrow();
    expect(() => tool.input.parse({ type: "RE" })).toThrow();
    expect(() => tool.input.parse({ contactId: 0 })).toThrow();
    expect(() => tool.input.parse({ limit: 101 })).toThrow();
    expect(() => tool.input.parse({ from: "01.01.2026" })).toThrow();
    expect(() => tool.input.parse({ customerId: 1 })).toThrow();
  });

  it("keeps undocumented status and type codes with the label 'unknown'", async () => {
    const { result } = await list({}, [
      {
        ...listRoute,
        response: {
          body: {
            objects: [{ id: "9", invoiceType: "XX", status: "300", currency: null, sumNet: "1" }],
          },
        },
      },
    ]);
    expect(result.data.items).toEqual([
      {
        id: 9,
        type: { code: "XX", label: "unknown" },
        status: { code: 300, label: "unknown" },
        currency: "EUR",
        totals: { net: { amount: "1.00", currency: "EUR" } },
      },
    ]);
  });

  it("fails loudly on a row it cannot read instead of skipping it", async () => {
    const client = new FakeSevdeskClient([
      { ...listRoute, response: { body: { objects: [{ id: "1", status: "open" }] } } },
    ]);
    await expect(tool.handler(tool.input.parse({}), testContext(client))).rejects.toMatchObject({
      kind: "unexpected_response",
      message: "sevDesk returned an invoice in an unexpected format.",
    });
  });

  it("passes sevDesk errors through", async () => {
    const client = new FakeSevdeskClient([
      { ...listRoute, response: { error: new SevdeskError({ kind: "auth", message: "nope" }) } },
    ]);
    await expect(tool.handler(tool.input.parse({}), testContext(client))).rejects.toMatchObject({
      kind: "auth",
    });
  });
});
