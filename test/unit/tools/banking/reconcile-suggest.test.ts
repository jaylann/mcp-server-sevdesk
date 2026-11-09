import { describe, expect, it } from "vitest";

import { reconcileSuggestTool as tool } from "../../../../src/tools/banking/reconcile-suggest.js";
import { transactionBookTool } from "../../../../src/tools/banking/transaction-book.js";
import {
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  testContext,
} from "../../../helpers/fake-client.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  invoiceRow,
  listRoute,
  logRoute,
  type Row,
  transactionRoute,
  transactionRow,
  voucherRow,
} from "../../domain/reconciliation/helpers.js";

function openItemRoutes(invoices: readonly Row[], vouchers: readonly Row[] = []): FakeRoute[] {
  return [
    listRoute("/Invoice", invoices, { status: 200 }),
    listRoute("/Invoice", [], { status: 750 }),
    listRoute("/CreditNote", [], { status: 200 }),
    listRoute("/Voucher", vouchers, { status: 100 }),
    listRoute("/Voucher", [], { status: 750 }),
  ];
}

async function run(args: Record<string, unknown>, routes: readonly FakeRoute[]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  tool.output.parse(result.data);
  return { client, result };
}

describe("sevdesk_reconcile_suggest", () => {
  it("is a read tool with read annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it("returns ranked matches with reasons and the exact booking call", async () => {
    const { client, result } = await run({ transactionId: 5101 }, [
      transactionRoute(transactionRow()),
      accountRoute(accountRow(4002)),
      logRoute(5101, []),
      ...openItemRoutes([invoiceRow(), invoiceRow({ id: "1007", invoiceNumber: "RE-1007" })]),
    ]);
    const [suggestion] = result.data.suggestions;
    expect(suggestion?.remaining).toEqual({ amount: "177.33", currency: "EUR" });
    const [best, second] = suggestion?.matches ?? [];
    expect(best).toMatchObject({
      type: "single",
      confidence: "high",
      allocations: [
        {
          kind: "invoice",
          id: 1001,
          number: "RE-1001",
          contact: { id: 1001, name: "Musterfirma GmbH" },
          openAmount: { amount: "177.33", currency: "EUR" },
          amount: { amount: "177.33", currency: "EUR" },
        },
      ],
      followUp: {
        tool: "sevdesk_transaction_book",
        arguments: {
          id: 5101,
          allocations: [{ kind: "invoice", id: 1001, amount: "177.33" }],
        },
      },
    });
    expect(best?.reasons).toContain("The document number appears in the purpose.");
    expect(second?.allocations[0]?.id).toBe(1007);
    // The follow-up call is valid input for the booking tool.
    expect(() => transactionBookTool.input.parse(best?.followUp.arguments)).not.toThrow();
    expect(result.summary).toBe("1 transaction, 1 with suggestions.");
    expect(client.writes()).toEqual([]);
  });

  it("turns a split into one follow-up call with every part", async () => {
    const { result } = await run({ transactionId: 5101, maxMatches: 5 }, [
      transactionRoute(transactionRow({ amount: "238", paymtPurpose: "RE-1 RE-2" })),
      accountRoute(accountRow(4002)),
      logRoute(5101, []),
      ...openItemRoutes([
        invoiceRow({ id: "1", invoiceNumber: "RE-1", sumGross: "119" }),
        invoiceRow({ id: "2", invoiceNumber: "RE-2", sumGross: "119" }),
      ]),
    ]);
    const split = result.data.suggestions[0]?.matches.find((m) => m.type === "split");
    expect(split?.followUp.arguments.allocations).toEqual([
      { kind: "invoice", id: 1, amount: "119.00" },
      { kind: "invoice", id: 2, amount: "119.00" },
    ]);
    expect(split?.confidence).toBe("high");
  });

  it("scans an account's unassigned transactions, pages and reports skips and other currencies", async () => {
    const transactions = (loadFixture("banking/transactions-list.json").body as { objects: Row[] })
      .objects;
    const { result } = await run({ limit: 1 }, [
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", transactions),
      ...openItemRoutes(
        [],
        [
          voucherRow(),
          voucherRow({ id: "2010", currency: "USD", sumGrossForeignCurrency: "298.1" }),
        ],
      ),
    ]);
    expect(result.data.suggestions).toHaveLength(1);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextOffset).toBe(1);
    expect(result.data.rowsScanned).toBe(1);
    expect(result.data.suggestions[0]?.otherCurrencyItems).toBe(1);
    expect(result.data.openItems).toMatchObject({ truncated: false });
    expect(result.summary).toBe(
      "1 transaction, 1 with suggestions; more may follow (nextOffset 1).",
    );
  });

  it("says why a transaction gets no suggestions", async () => {
    const { result } = await run({ transactionId: 5101 }, [
      transactionRoute(transactionRow({ status: "300" })),
      accountRoute(accountRow(4002)),
      logRoute(5101, []),
    ]);
    expect(result.data.suggestions[0]).toMatchObject({
      skipped: "It is marked as private.",
      matches: [],
    });
    expect(result.data.openItems).toBeUndefined();
    expect(result.summary).toBe("1 transaction, 0 with suggestions.");
  });

  it("reports when there is nothing to suggest for", async () => {
    const { result } = await run({ checkAccountId: 4003 }, [
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", []),
    ]);
    expect(result.data.suggestions).toEqual([]);
    expect(result.summary).toBe("No unassigned transactions found.");
  });

  it("marks capped open items in the summary", async () => {
    const base = invoiceRow({ sumGross: "1" });
    const many = Array.from({ length: 3001 }, (_, i) => ({ ...base, id: String(100_000 + i) }));
    const { result } = await run({ transactionId: 5101 }, [
      transactionRoute(transactionRow()),
      accountRoute(accountRow(4002)),
      logRoute(5101, []),
      ...openItemRoutes(many),
    ]);
    expect(result.summary).toBe("1 transaction, 1 with suggestions; open items were capped.");
  });

  it("refuses a transaction id together with list filters", async () => {
    const client = new FakeSevdeskClient([]);
    await expect(
      tool.handler(tool.input.parse({ transactionId: 1, checkAccountId: 2 }), testContext(client)),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Pass either transactionId or checkAccountId/from/to, not both.",
    });
    expect(client.calls).toEqual([]);
  });

  it("validates its input", () => {
    expect(() => tool.input.parse({ limit: 26 })).toThrow();
    expect(() => tool.input.parse({ maxMatches: 0 })).toThrow();
    expect(() => tool.input.parse({ unknown: 1 })).toThrow();
    expect(tool.input.parse({})).toMatchObject({ limit: 10, offset: 0, maxMatches: 3 });
  });
});
