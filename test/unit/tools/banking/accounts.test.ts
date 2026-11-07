import { afterEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { bankAccountsListTool as tool } from "../../../../src/tools/banking/accounts.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const accountsRoute: FakeRoute = {
  path: "/CheckAccount",
  response: { fixture: "banking/check-accounts.json" },
};

function balance(id: number, response: FakeRoute["response"], date?: string): FakeRoute {
  return {
    path: `/CheckAccount/${id}/getBalanceAtDate`,
    ...(date === undefined ? {} : { query: { date } }),
    response,
  };
}

const balanceRoutes: FakeRoute[] = [
  balance(4001, { fixture: "banking/balance-4001.json" }),
  balance(4002, { body: { objects: 2345.6 } }),
  balance(4003, { body: { objects: "0" } }),
  balance(4004, { body: { objects: "-1" } }),
  balance(4005, { body: { objects: "-12.5" } }),
];

async function run(args: Record<string, unknown>, routes: readonly FakeRoute[]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  return { client, result };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sevdesk_bank_accounts_list (community: recorded CheckAccount shape, fake data)", () => {
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

  it("fetches each active account's balance for today in Berlin, as YYYY-MM-DD", async () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Berlin.
    vi.useFakeTimers({ now: new Date("2026-12-31T23:30:00Z"), toFake: ["Date"] });
    const { client, result } = await run({}, [accountsRoute, ...balanceRoutes]);

    expect(client.methods().every((method) => method === "GET")).toBe(true);
    expect(client.calls[0]).toMatchObject({ path: "/CheckAccount", query: { limit: 1000 } });
    const balanceCalls = client.calls.filter((call) => call.path.endsWith("getBalanceAtDate"));
    expect(balanceCalls.map((call) => call.path)).toEqual([
      "/CheckAccount/4001/getBalanceAtDate",
      "/CheckAccount/4002/getBalanceAtDate",
      "/CheckAccount/4003/getBalanceAtDate",
      "/CheckAccount/4005/getBalanceAtDate",
    ]);
    expect(balanceCalls.every((call) => call.query["date"] === "2027-01-01")).toBe(true);
    expect(result.data.balanceDate).toBe("2027-01-01");
    expect(result.summary).toBe(
      "4 payment accounts, balances at 2027-01-01. Note: 1 archived hidden " +
        "(includeArchived=true shows them).",
    );
  });

  it("returns readable types, masked IBANs and exact balances in the account currency", async () => {
    const { result } = await run({ balanceDate: "2026-06-30" }, [accountsRoute, ...balanceRoutes]);
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.archivedHidden).toBe(1);
    expect(result.data.items).toEqual([
      {
        id: 4001,
        name: "Basiskonto",
        type: "clearing",
        sevdeskType: "offline",
        currency: "EUR",
        status: { code: 100, label: "Active" },
        isDefault: true,
        accountingNumber: "1820",
        balance: { amount: "1500.25", currency: "EUR" },
      },
      {
        id: 4002,
        name: "Geschäftskonto Musterbank",
        type: "bank",
        sevdeskType: "online",
        currency: "EUR",
        status: { code: 100, label: "Active" },
        isDefault: false,
        ibanMasked: "****1234",
        accountingNumber: "1800",
        providerBalance: { amount: "1234.56", currency: "EUR" },
        balance: { amount: "2345.60", currency: "EUR" },
      },
      expect.objectContaining({
        id: 4003,
        type: "cash",
        balance: { amount: "0.00", currency: "EUR" },
      }),
      expect.objectContaining({
        id: 4005,
        currency: "USD",
        balance: { amount: "-12.50", currency: "USD" },
        providerBalance: { amount: "88.10", currency: "USD" },
      }),
    ]);
    expect(JSON.stringify(result.data)).not.toContain("DE00");
  });

  it("lists archived accounts on request", async () => {
    const { result } = await run({ balanceDate: "2026-06-30", includeArchived: true }, [
      accountsRoute,
      ...balanceRoutes,
    ]);
    expect(result.data.archivedHidden).toBe(0);
    expect(result.data.items.find((item) => item.id === 4004)).toMatchObject({
      status: { code: 0, label: "Archived" },
      ibanMasked: "****9999",
      balance: { amount: "-1.00", currency: "EUR" },
    });
    expect(result.summary).toBe("5 payment accounts, balances at 2026-06-30.");
  });

  it("marks a balance sevDesk refuses for one account and keeps the others", async () => {
    const refused = new SevdeskError({ kind: "validation", message: "Invalid request." });
    const { result } = await run({ balanceDate: "2026-06-30" }, [
      accountsRoute,
      balance(4001, { error: refused }),
      balance(4002, { body: { objects: null } }),
      ...balanceRoutes.slice(2),
    ]);
    expect(result.data.items.slice(0, 2)).toEqual([
      expect.objectContaining({ id: 4001, balanceMissing: "sevdesk_error" }),
      expect.objectContaining({ id: 4002, balanceMissing: "sevdesk_error" }),
    ]);
    expect(result.data.items[0]?.balance).toBeUndefined();
    expect(result.summary).toContain("2 balances refused by sevDesk");
  });

  it("fails the call on errors that concern every account", async () => {
    const auth = new SevdeskError({ kind: "auth", message: "The sevDesk API token was rejected." });
    await expect(
      run({ balanceDate: "2026-06-30" }, [accountsRoute, balance(4001, { error: auth })]),
    ).rejects.toBe(auth);
  });

  it(`caps balance calls at 25 accounts and says so`, async () => {
    const objects = Array.from({ length: 27 }, (_, index) => ({
      id: String(8000 + index),
      name: `Konto ${index + 1}`,
      type: "offline",
      currency: "EUR",
      status: "100",
    }));
    const routes: FakeRoute[] = [
      { path: "/CheckAccount", response: { body: { objects } } },
      ...objects.map((account) => balance(Number(account.id), { body: { objects: "1" } })),
    ];
    const { client, result } = await run({ balanceDate: "2026-06-30" }, routes);
    expect(client.calls.filter((call) => call.path.endsWith("getBalanceAtDate"))).toHaveLength(25);
    expect(result.data.items.slice(25).map((item) => item.balanceMissing)).toEqual([
      "account_cap",
      "account_cap",
    ]);
    expect(result.summary).toBe(
      "27 payment accounts, balances at 2026-06-30. Note: 2 balances omitted (cap of 25 " +
        "accounts per call).",
    );
  });

  it("handles an account without name, type or currency, and an empty list", async () => {
    const { result } = await run({ balanceDate: "2026-06-30" }, [
      { path: "/CheckAccount", response: { body: { objects: [{ id: "8100" }] } } },
      balance(8100, { body: { objects: "5" } }),
    ]);
    expect(result.data.items).toEqual([
      {
        id: 8100,
        name: "(unnamed account 8100)",
        type: "unknown",
        currency: "EUR",
        isDefault: false,
        balance: { amount: "5.00", currency: "EUR" },
      },
    ]);

    const empty = await run({}, [{ path: "/CheckAccount", response: { body: { objects: [] } } }]);
    expect(empty.result.summary).toMatch(/^No payment accounts found\.$/);
  });

  it("says when sevDesk has more accounts than one request returns", async () => {
    const { result } = await run({ balanceDate: "2026-06-30" }, [
      {
        path: "/CheckAccount",
        response: { body: { total: "1200", objects: [{ id: "8100", status: "100" }] } },
      },
      balance(8100, { body: { objects: "5" } }),
    ]);
    expect(result.summary).toContain("sevDesk returned only the first 1000 accounts");
  });

  it("validates balanceDate before sending anything", () => {
    expect(tool.input.safeParse({ balanceDate: "30.06.2026" }).success).toBe(false);
    expect(tool.input.safeParse({ balanceDate: "2026-02-30" }).success).toBe(false);
    expect(tool.input.safeParse({ includeArchived: "yes" }).success).toBe(false);
  });
});
