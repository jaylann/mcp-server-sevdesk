/** The single-record banking reads the payment tools use (`getBankAccount`, `getTransaction`). */
import { describe, expect, it } from "vitest";

import { getBankAccount, getTransaction } from "../../../../src/domain/banking.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  accountRoute,
  accountRow,
  transactionRoute,
  transactionRow,
} from "../../tools/lifecycle/helpers.js";

describe("getBankAccount (community: recorded CheckAccount keys)", () => {
  it("reads one account by id without a balance call", async () => {
    const client = new FakeSevdeskClient([accountRoute(accountRow(4001))]);

    const account = await getBankAccount(client, 4001);

    expect(account).toMatchObject({
      id: 4001,
      name: "Basiskonto",
      type: "clearing",
      currency: "EUR",
      isDefault: true,
    });
    expect(account).not.toHaveProperty("balance");
    expect(client.calls.map(({ path }) => path)).toEqual(["/CheckAccount/4001"]);
  });

  it("passes sevDesk's not-found error on", async () => {
    const client = new FakeSevdeskClient([
      { path: "/CheckAccount/4999", response: { body: { objects: [] } } },
    ]);
    await expect(getBankAccount(client, 4999)).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("getTransaction (community: recorded CheckAccountTransaction keys)", () => {
  it("reads one transaction with its account's name and currency", async () => {
    const client = new FakeSevdeskClient([
      transactionRoute(transactionRow({ amount: "-12.5" })),
      accountRoute(accountRow(4002)),
    ]);

    const transaction = await getTransaction(client, 5101);

    expect(transaction).toMatchObject({
      id: 5101,
      account: { id: 4002, name: "Geschäftskonto Musterbank" },
      amount: { amount: "-12.50", currency: "EUR" },
      direction: "out",
      status: { code: 100, label: "Created" },
      enshrined: false,
    });
  });

  it("takes the amount as EUR when the transaction has no account", async () => {
    const client = new FakeSevdeskClient([
      transactionRoute(transactionRow({ checkAccount: null })),
    ]);

    const transaction = await getTransaction(client, 5101);

    expect(transaction.account).toBeUndefined();
    expect(transaction.amount).toEqual({ amount: "177.33", currency: "EUR" });
    expect(client.calls).toHaveLength(1);
  });
});
