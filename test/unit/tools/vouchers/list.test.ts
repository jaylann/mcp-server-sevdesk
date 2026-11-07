import { describe, expect, it } from "vitest";

import { toUnixSeconds } from "../../../../src/sevdesk/dates.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { vouchersListTool as tool } from "../../../../src/tools/vouchers/list.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const listRoute: FakeRoute = {
  path: "/Voucher",
  response: { fixture: "vouchers/vouchers-list.json" },
};

async function list(args: Record<string, unknown>, routes: readonly FakeRoute[] = [listRoute]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  return { client, result };
}

describe("sevdesk_vouchers_list (community: recorded Voucher shape, fake data)", () => {
  it("is a read tool in the vouchers toolset with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("vouchers");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("sends one GET with an explicit limit and no filters by default", async () => {
    const { client } = await list({});
    expect(client.calls).toEqual([
      {
        operation: "list",
        method: "GET",
        path: "/Voucher",
        query: { limit: 25, offset: 0, countAll: true },
        sideEffect: false,
      },
    ]);
  });

  it("maps every filter to sevDesk's documented voucher filters", async () => {
    const { client } = await list({
      status: "partially_paid",
      kind: "expense",
      supplierId: 1003,
      supplierName: "Beispiel",
      description: "RE-2026",
      from: "2026-01-01",
      to: "2026-01-31",
      type: "recurring",
    });
    expect(client.calls[0]?.query).toEqual({
      status: 750,
      creditDebit: "C",
      "contact[id]": 1003,
      "contact[objectName]": "Contact",
      supplierName: "Beispiel",
      descriptionLike: "RE-2026",
      // One second before the first day, so "bigger than" and "equal or higher" both include it.
      startDate: toUnixSeconds("2026-01-01") - 1,
      endDate: toUnixSeconds("2026-01-31", "end"),
      voucherType: "RV",
      // The type is also checked here, so the list scans in chunks (see listDocuments).
      limit: 200,
      offset: 0,
      countAll: true,
    });
  });

  it("re-checks the voucher type on every row, so an ignored filter cannot leak", async () => {
    // The fake ignores voucherType, as sevDesk does with filters it does not understand (D-035).
    const { client, result } = await list({ type: "recurring" });
    expect(client.calls[0]?.query).toMatchObject({ voucherType: "RV" });
    expect(result.data.items.map((item) => [item.id, item.type])).toEqual([[2006, "recurring"]]);
    expect(result.data).toMatchObject({ filteredLocally: true, hasMore: false });
    expect(result.data.total).toBeUndefined();
    expect(result.summary).toBe(
      "1 matching vouchers in rows 1–6 (filtered by this server, not sevDesk); end of list.",
    );

    const normal = await list({ type: "normal", limit: 2 });
    expect(normal.result.data.items.map((item) => item.id)).toEqual([2001, 2002]);
    expect(normal.result.data).toMatchObject({ hasMore: true, nextOffset: 2 });
  });

  it("re-checks the voucher date against the range, keeping sevDesk's paging (D-046)", async () => {
    // The fake ignores startDate/endDate, so rows outside the range come back as they could at
    // the edges under the inclusive reading: the re-check drops them.
    const { result } = await list({ from: "2026-02-01", to: "2026-02-19" });
    expect(result.data.items.map((item) => [item.id, item.date])).toEqual([
      [2002, "2026-02-19"],
      [2004, "2026-02-01"],
      [2005, "2026-02-10"],
    ]);
    expect(result.data).toMatchObject({ total: 6, hasMore: false });
    expect(result.summary).toBe("Vouchers 1–6 of 6.");
  });

  it.each([
    ["draft", 50],
    ["open", 100],
    ["transferred", 150],
    ["partially_paid", 750],
    ["paid", 1000],
  ] as const)("sends status %s as %i", async (status, code) => {
    const { client } = await list({ status });
    expect(client.calls[0]?.query["status"]).toBe(code);
  });

  it("sends kind revenue as creditDebit D and type normal as VOU", async () => {
    const { client } = await list({ kind: "revenue", type: "normal" });
    expect(client.calls[0]?.query).toMatchObject({ creditDebit: "D", voucherType: "VOU" });
  });

  it("returns compact rows that satisfy the output schema", async () => {
    const { result } = await list({ limit: 2 });
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.items[0]).toEqual({
      id: 2001,
      number: "RE-2026-0042",
      supplier: { id: 1003, name: "Beispiel Lieferant AG" },
      date: "2026-01-12",
      paymentDeadline: "2026-01-26",
      status: { code: 100, label: "Unpaid / due" },
      kind: "expense",
      type: "normal",
      currency: "EUR",
      net: { amount: "250.50", currency: "EUR" },
      tax: { amount: "47.60", currency: "EUR" },
      gross: { amount: "298.10", currency: "EUR" },
      paidAmount: { amount: "0.00", currency: "EUR" },
      generation: "2.0",
      link: "https://my.sevdesk.de/ex/detail/id/2001",
    });
  });

  it("pages with total, hasMore and nextOffset", async () => {
    const first = await list({ limit: 4 });
    expect(first.result.data).toMatchObject({ total: 6, offset: 0, limit: 4, hasMore: true });
    expect(first.result.data.nextOffset).toBe(4);
    expect(first.result.summary).toBe("Vouchers 1–4 of 6; more may follow (nextOffset 4).");

    const last = await list({ limit: 4, offset: 4 });
    expect(last.result.data.items.map((item) => item.id)).toEqual([2005, 2006]);
    expect(last.result.data).toMatchObject({ hasMore: false });
    expect(last.result.data.nextOffset).toBeUndefined();
    expect(last.result.summary).toBe("Vouchers 5–6 of 6.");
  });

  it("continues after a short page at offset + rows received", async () => {
    const objects = Array.from({ length: 3 }, (_, index) => ({ id: String(2100 + index) }));
    const { result } = await list({ limit: 25, offset: 25 }, [
      { ...listRoute, response: { body: { total: "60", objects } } },
    ]);
    expect(result.data).toMatchObject({ total: 60, hasMore: true, nextOffset: 28 });
  });

  it("without a total, treats a non-empty page as possibly not the last", async () => {
    const { result } = await list({}, [
      { ...listRoute, response: { body: { total: null, objects: [{ id: "2100" }] } } },
    ]);
    expect(result.data.total).toBeUndefined();
    expect(result.data).toMatchObject({ hasMore: true, nextOffset: 1 });
  });

  it("says so when nothing matched", async () => {
    const { result } = await list({}, [{ ...listRoute, response: { body: { objects: [] } } }]);
    expect(result.data).toMatchObject({ items: [], hasMore: false });
    expect(result.summary).toBe("No vouchers found.");
  });

  it("rejects an empty date range and invalid input before sending anything", async () => {
    const client = new FakeSevdeskClient([listRoute]);
    await expect(
      tool.handler(tool.input.parse({ from: "2026-02-01", to: "2026-01-01" }), testContext(client)),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(client.calls).toEqual([]);
    expect(tool.input.safeParse({ status: "booked" }).success).toBe(false);
    expect(tool.input.safeParse({ kind: "C" }).success).toBe(false);
    expect(tool.input.safeParse({ supplierId: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ from: "01.01.2026" }).success).toBe(false);
    expect(tool.input.safeParse({ limit: 101 }).success).toBe(false);
    expect(tool.input.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("passes sevDesk errors through", async () => {
    const error = new SevdeskError({
      kind: "auth",
      message: "The sevDesk API token was rejected.",
    });
    await expect(list({}, [{ ...listRoute, response: { error } }])).rejects.toBe(error);
  });

  it("fails loudly on a row that does not fit instead of skipping it", async () => {
    await expect(
      list({}, [{ ...listRoute, response: { body: { objects: [{ id: "abc" }] } } }]),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
  });
});
