import { describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { transactionsListTool as tool } from "../../../../src/tools/banking/transactions.js";
import type { ToolContext } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const accountsRoute: FakeRoute = {
  path: "/CheckAccount",
  response: { fixture: "banking/check-accounts.json" },
};
const transactionsRoute: FakeRoute = {
  path: "/CheckAccountTransaction",
  response: { fixture: "banking/transactions-list.json" },
};

async function run(
  args: Record<string, unknown>,
  routes: readonly FakeRoute[] = [accountsRoute, transactionsRoute],
  context?: (client: FakeSevdeskClient) => ToolContext,
) {
  const client = new FakeSevdeskClient(routes);
  const ctx = context === undefined ? testContext(client) : context(client);
  const result = await tool.handler(tool.input.parse(args), ctx);
  const listCalls = client.callsTo("/CheckAccountTransaction");
  return { client, result, listCalls };
}

/** `count` transactions in sevDesk's shape; every `matchEvery`-th one has status 100. */
function manyTransactions(count: number, matchEvery: number): FakeRoute["response"] {
  const objects = Array.from({ length: count }, (_, index) => ({
    id: String(60_000 + index),
    valueDate: "2026-03-02T00:00:00+01:00",
    amount: "-1",
    checkAccount: { id: "4002", objectName: "CheckAccount" },
    status: (index + 1) % matchEvery === 0 ? "100" : "400",
  }));
  return { body: { objects } };
}

describe("sevdesk_transactions_list (community: recorded transaction shape, fake data)", () => {
  it("is a read tool in the banking toolset with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("banking");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("without filters reads one page with the requested limit, plus the account names", async () => {
    const { client, result, listCalls } = await run({ limit: 3 });
    expect(client.methods().every((method) => method === "GET")).toBe(true);
    expect(client.callsTo("/CheckAccount")).toHaveLength(1);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.query).toEqual({ limit: 3, offset: 0, countAll: true });
    expect(result.data).toMatchObject({
      total: 7,
      offset: 0,
      limit: 3,
      hasMore: true,
      nextOffset: 3,
      rowsScanned: 3,
      rowsTotal: 7,
      filteredLocally: false,
    });
    expect(result.summary).toBe(
      "3 transactions in sevDesk rows 1–3 of 7; more may follow (nextOffset 3).",
    );
  });

  it("returns signed amounts with direction, account and sanitized texts", async () => {
    const { result } = await run({ limit: 100 });
    expect(tool.output.parse(result.data)).toEqual(result.data);
    const [first, second, third] = result.data.items;
    expect(first).toEqual({
      id: 5001,
      account: { id: 4002, name: "Geschäftskonto Musterbank" },
      valueDate: "2026-01-05",
      entryDate: "2026-01-05",
      amount: { amount: "-298.10", currency: "EUR" },
      direction: "out",
      status: { code: 100, label: "Created", key: "created" },
      counterparty: "Beispiel Lieferant AG",
      purpose: "RE-2026-0042 Kundennr 4711",
      enshrined: false,
    });
    // amount as a JSON number (D-008) and a later entry date.
    expect(second).toMatchObject({
      amount: { amount: "1190.00", currency: "EUR" },
      direction: "in",
      valueDate: "2026-01-07",
      entryDate: "2026-01-08",
      status: { code: 400, label: "Booked" },
    });
    expect(third?.entryDate).toBeUndefined();
    const usd = result.data.items.find((item) => item.id === 5006);
    expect(usd).toMatchObject({
      amount: { amount: "-378.00", currency: "USD" },
      status: { code: 200, label: "Linked" },
      enshrined: true,
    });
    expect(result.data.hasMore).toBe(false);
    expect(result.data.nextOffset).toBeUndefined();
  });

  it("filters the account in sevDesk and re-checks it locally", async () => {
    const { listCalls, result } = await run({ checkAccountId: 4001 });
    expect(listCalls[0]?.query).toMatchObject({
      "checkAccount[id]": 4001,
      "checkAccount[objectName]": "CheckAccount",
      limit: 25,
    });
    // The fake ignores the filter, as sevDesk might: rows of other accounts never come through.
    expect(result.data.items.map((item) => item.id)).toEqual([5004, 5007]);
    expect(result.data.filteredLocally).toBe(false);
  });

  it("filters unbooked (created) transactions locally and counts sevDesk rows, not matches", async () => {
    const { listCalls, result } = await run({ status: ["created"], limit: 2 });
    // D-020: a single status is also sent to narrow the read; the fake ignores it, as a server
    // without that filter would, and the local check still keeps only status 100.
    expect(listCalls[0]?.query).toMatchObject({ status: 100 });
    expect(listCalls[0]?.query).not.toHaveProperty("isBooked");
    expect(result.data.items.map((item) => item.id)).toEqual([5001, 5004]);
    // The second match is the 4th row: the next page starts right after it.
    expect(result.data).toMatchObject({
      offset: 0,
      hasMore: true,
      nextOffset: 4,
      rowsScanned: 4,
      rowsTotal: 7,
      filteredLocally: true,
    });
    expect(result.data.total).toBeUndefined();
    expect(result.summary).toBe(
      "2 transactions in sevDesk rows 1–4 of 7; more may follow (nextOffset 4).",
    );

    const next = await run({ status: ["created"], limit: 2, offset: 4 });
    expect(next.result.data.items.map((item) => item.id)).toEqual([5007]);
    expect(next.result.data).toMatchObject({ hasMore: false, rowsScanned: 3 });
    expect(next.result.summary).toBe("1 transaction in sevDesk rows 5–7 of 7.");
  });

  it("combines several statuses and a direction", async () => {
    const { listCalls, result } = await run({
      status: ["created", "auto_booked"],
      direction: "out",
    });
    // Several statuses cannot go into one sevDesk filter: they are only checked here.
    expect(listCalls[0]?.query).not.toHaveProperty("status");
    expect(result.data.items.map((item) => item.id)).toEqual([5001, 5005, 5007]);
    const incoming = await run({ direction: "in" });
    expect(incoming.result.data.items.map((item) => item.id)).toEqual([5002, 5004]);
    const privateOnes = await run({ status: ["private", "linked", "booked"] });
    expect(privateOnes.result.data.items.map((item) => item.id)).toEqual([5002, 5003, 5006]);
  });

  it("filters a value-date range here only, since sevDesk's date filters cut by entryDate", async () => {
    const { listCalls, result } = await run({ from: "2026-01-07", to: "2026-01-31" });
    // D-047: sending startDate/endDate would silently drop rows whose entry date is outside.
    expect(listCalls[0]?.query).not.toHaveProperty("startDate");
    expect(listCalls[0]?.query).not.toHaveProperty("endDate");
    // 5002 has value date 7 Jan but entry date 8 Jan; it is in a value-date range from 7 Jan.
    expect(result.data.items.map((item) => [item.id, item.valueDate])).toEqual([
      [5002, "2026-01-07"],
      [5003, "2026-01-15"],
      [5004, "2026-01-20"],
      [5005, "2026-01-31"],
    ]);
    expect(result.data).toMatchObject({ filteredLocally: true, rowsScanned: 7 });
    expect(result.data.total).toBeUndefined();
  });

  it("lets sevDesk filter an entry-date range and re-checks entryDate", async () => {
    const { listCalls, result } = await run({
      from: "2026-01-08",
      to: "2026-01-31",
      dateField: "entry",
    });
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.query).toMatchObject({
      startDate: "2026-01-08T00:00:00+01:00",
      endDate: "2026-01-31T23:59:59+01:00",
      limit: 25,
      offset: 0,
    });
    // The fake ignores the date filter: the local check keeps the range exact. 5003 has no entry
    // date and 5001 (5 Jan) is before the range.
    expect(result.data.items.map((item) => [item.id, item.entryDate])).toEqual([
      [5002, "2026-01-08"],
      [5004, "2026-01-20"],
      [5005, "2026-01-31"],
    ]);
    // sevDesk did the filtering: one page, its total, no local scan.
    expect(result.data).toMatchObject({ filteredLocally: false, total: 7, rowsScanned: 7 });
  });

  it("defaults dateField to value", () => {
    expect(tool.input.parse({}).dateField).toBe("value");
    expect(tool.input.safeParse({ dateField: "booking" }).success).toBe(false);
  });

  it("reads further pages until it has limit matches", async () => {
    const { listCalls, result } = await run({ status: ["created"], limit: 3 }, [
      accountsRoute,
      { ...transactionsRoute, response: manyTransactions(450, 100) },
    ]);
    expect(listCalls.map((call) => [call.query["offset"], call.query["limit"]])).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
    ]);
    expect(result.data.items.map((item) => item.id)).toEqual([60_099, 60_199, 60_299]);
    expect(result.data).toMatchObject({ rowsScanned: 300, nextOffset: 300, hasMore: true });
  });

  it("stops at the end of the collection without an extra empty request", async () => {
    const { listCalls, result } = await run({ status: ["created"], limit: 10 }, [
      accountsRoute,
      { ...transactionsRoute, response: manyTransactions(150, 100) },
    ]);
    expect(listCalls).toHaveLength(2);
    expect(result.data.items).toHaveLength(1);
    expect(result.data).toMatchObject({ rowsScanned: 150, hasMore: false });
  });

  it(`stops after examining 5000 rows, reports it and keeps the offset honest`, async () => {
    const progress = vi.fn(() => Promise.resolve());
    const { result } = await run(
      { status: ["created"], limit: 5 },
      [accountsRoute, { ...transactionsRoute, response: manyTransactions(6000, 10_000) }],
      (client) => ({ ...testContext(client), progress }),
    );
    expect(result.data.items).toEqual([]);
    expect(result.data).toMatchObject({ rowsScanned: 5000, nextOffset: 5000, hasMore: true });
    expect(result.summary).toBe(
      "0 transactions in sevDesk rows 1–5000 of 6000; more may follow (nextOffset 5000). " +
        "Stopped after examining 5000 rows; continue with nextOffset.",
    );
    expect(progress).toHaveBeenLastCalledWith(5000, 6000, "Examined 5000 transactions.");
  });

  it("ends on an empty page when sevDesk reports no total", async () => {
    const row = {
      id: "5100",
      valueDate: "2026-03-02T00:00:00+01:00",
      amount: "0",
      status: "100",
      checkAccount: { id: "4999", objectName: "CheckAccount" },
    };
    const pages = [[row], []];
    const list = vi.fn((path: string) =>
      Promise.resolve({
        items: path === "/CheckAccount" ? [] : (pages.shift() ?? []),
        total: undefined,
      }),
    );
    const client = { list } as unknown as FakeSevdeskClient;
    const result = await tool.handler(
      tool.input.parse({ status: ["created"] }),
      testContext(client),
    );
    expect(list).toHaveBeenCalledTimes(3);
    // Unknown account: no name, sevDesk's default currency.
    expect(result.data.items).toEqual([
      expect.objectContaining({
        account: { id: 4999 },
        amount: { amount: "0.00", currency: "EUR" },
        direction: "none",
      }),
    ]);
    expect(result.data).toMatchObject({ rowsScanned: 1, hasMore: false });
    expect(result.data.rowsTotal).toBeUndefined();
    expect(result.summary).toBe("1 transaction in sevDesk rows 1–1.");
  });

  it("reports empty results", async () => {
    const empty: FakeRoute = { ...transactionsRoute, response: { body: { objects: [] } } };
    const first = await run({}, [accountsRoute, empty]);
    expect(first.result.summary).toBe("No transactions found.");
    const later = await run({ status: ["booked"], offset: 10 }, [accountsRoute, empty]);
    expect(later.result.summary).toBe("No more transactions after offset 10.");
    expect(later.result.data).toMatchObject({ items: [], hasMore: false, rowsScanned: 0 });
  });

  it("rejects invalid input before sending anything", async () => {
    const client = new FakeSevdeskClient([accountsRoute, transactionsRoute]);
    await expect(
      tool.handler(tool.input.parse({ from: "2026-02-01", to: "2026-01-01" }), testContext(client)),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(client.calls).toEqual([]);
    expect(tool.input.safeParse({ status: [] }).success).toBe(false);
    expect(tool.input.safeParse({ status: ["unbooked"] }).success).toBe(false);
    expect(tool.input.safeParse({ status: "created" }).success).toBe(false);
    expect(tool.input.safeParse({ direction: "both" }).success).toBe(false);
    expect(tool.input.safeParse({ checkAccountId: -1 }).success).toBe(false);
    expect(tool.input.safeParse({ isBooked: false }).success).toBe(false);
  });

  it("passes sevDesk errors through and fails on rows that do not fit", async () => {
    const error = new SevdeskError({ kind: "server", message: "sevDesk had a server error." });
    await expect(
      run({}, [accountsRoute, { ...transactionsRoute, response: { error } }]),
    ).rejects.toBe(error);
    await expect(
      run({}, [
        accountsRoute,
        { ...transactionsRoute, response: { body: { objects: [{ id: "1" }] } } },
      ]),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
  });
});
