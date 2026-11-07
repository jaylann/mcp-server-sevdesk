import { describe, expect, it } from "vitest";

import { ordersListTool as tool } from "../../../../src/tools/orders/list.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const listRoute: FakeRoute = {
  path: "/Order",
  query: { embed: "contact" },
  response: { fixture: "orders/orders-list.json" },
};

async function list(args: Record<string, unknown>, routes: readonly FakeRoute[] = [listRoute]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  return { client, result };
}

describe("sevdesk_orders_list (community: recorded Order shape, fake data)", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("orders");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("maps type and status names to sevDesk's codes", async () => {
    const { client } = await list({
      type: "order_confirmation",
      status: "partially_invoiced",
      contactId: 1001,
      number: "AB-1002",
      from: "2026-09-01",
    });
    expect(client.methods()).toEqual(["GET"]);
    expect(client.calls[0]?.query).toMatchObject({
      embed: "contact",
      orderType: "AB",
      status: 750,
      "contact[id]": 1001,
      "contact[objectName]": "Contact",
      orderNumber: "AB-1002",
      startDate: 1788213600 - 1, // one second before 2026-09-01 00:00 CEST (D-046)
    });
    expect(client.calls[0]?.query).not.toHaveProperty("endDate");
  });

  it("re-checks the order date against the range without a scan (D-046)", async () => {
    // The fake ignores startDate/endDate; the re-check keeps the range exact.
    const { result } = await list({ from: "2026-09-15", to: "2026-09-30" });
    expect(result.data.items.map((item) => item.id)).toEqual([3002]);
    expect(result.data).toMatchObject({ total: 3, hasMore: false });
    expect(result.data.filteredLocally).toBeUndefined();
  });

  it("re-checks the order type on every row, so an ignored filter cannot leak (D-035)", async () => {
    // The fake returns the whole fixture regardless of orderType, as sevDesk does with a filter it
    // ignores.
    const { client, result } = await list({ type: "delivery_note" });
    expect(client.calls[0]?.query).toMatchObject({ orderType: "LI" });
    expect(result.data.items.map((item) => item.id)).toEqual([3003]);
    expect(result.data).toMatchObject({ filteredLocally: true, hasMore: false });
    expect(result.data.total).toBeUndefined();
  });

  it("maps every type and status name", async () => {
    const expected = {
      offer: "AN",
      delivery_note: "LI",
    } as const;
    for (const [type, code] of Object.entries(expected)) {
      const { client } = await list({ type });
      expect(client.calls[0]?.query["orderType"]).toBe(code);
    }
    for (const [status, code] of [
      ["draft", 100],
      ["sent", 200],
      ["rejected", 300],
      ["accepted", 500],
      ["invoiced", 1000],
    ] as const) {
      const { client } = await list({ status });
      expect(client.calls[0]?.query["status"]).toBe(code);
    }
  });

  it("returns compact rows for offers, confirmations and delivery notes", async () => {
    const { result } = await list({});
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.items[0]).toEqual({
      id: 3001,
      number: "AN-1001",
      type: { code: "AN", label: "Estimate / proposal", labelDe: "Angebot" },
      status: { code: 1000, label: "Calculated (invoiced)" },
      contact: { id: 1001, name: "Musterfirma GmbH" },
      date: "2026-09-10",
      currency: "EUR",
      totals: {
        net: { amount: "144.02", currency: "EUR" },
        tax: { amount: "27.36", currency: "EUR" },
        gross: { amount: "171.38", currency: "EUR" },
      },
      header: "Angebot AN-1001",
      sent: { date: "2026-09-10", via: "VPDF" },
      link: "https://my.sevdesk.de/om/detail/type/AN/id/3001",
    });
    expect(result.data.items[1]).toMatchObject({
      type: { code: "AB", labelDe: "Auftragsbestätigung" },
      status: { code: 500, label: "Accepted" },
    });
    expect(result.data.items[2]).toMatchObject({
      type: { code: "LI", labelDe: "Lieferschein" },
      status: { code: 100, label: "Draft" },
      contact: { id: 1001 },
      totals: { gross: { amount: "0.00", currency: "EUR" } },
      link: "https://my.sevdesk.de/om/edit/type/LI/id/3003",
    });
    expect(result.data.items[2]?.sent).toBeUndefined();
    expect(result.summary).toBe("Orders 1–3 of 3.");
  });

  it("re-checks the order number on every row", async () => {
    const { result } = await list({ number: "AB-1002" });
    expect(result.data.items.map((item) => item.id)).toEqual([3002]);
    expect(result.data).toMatchObject({ filteredLocally: true, hasMore: false });
    expect(result.summary).toBe(
      "1 matching orders in rows 1–3 (filtered by this server, not sevDesk); end of list.",
    );
  });

  it("keeps an unknown order type with the label 'unknown'", async () => {
    const { result } = await list({}, [
      {
        ...listRoute,
        response: { body: { objects: [{ id: "1", status: "100", orderType: "ZZ" }] } },
      },
    ]);
    expect(result.data.items[0]?.type).toEqual({ code: "ZZ", label: "unknown" });
  });

  it("rejects readable names it does not know", () => {
    expect(() => tool.input.parse({ type: "AN" })).toThrow();
    expect(() => tool.input.parse({ status: "paid" })).toThrow();
  });
});
