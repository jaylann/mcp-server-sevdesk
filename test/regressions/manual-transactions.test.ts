/**
 * Bank transactions entered by hand, deleted and locked (#88): three traps sevDesk sets, each
 * checked through the whole tool call (the write flow with confirmation off), so no request
 * leaves when it must not.
 *
 * - `POST /CheckAccountTransaction` works only on file-import accounts. The cash register and
 *   offline (clearing) accounts refuse it with 422 (D-071, D-095), and a bank-connected account
 *   gets its rows from the bank. Sending it anyway would at best be refused, and a cash sale must
 *   be booked on its document instead; the tool refuses before anything is sent.
 * - `DELETE /CheckAccountTransaction/{id}` is a soft delete: the row stays readable by id with
 *   `deletedAt` (D-096). A read by id alone would present it as a live, unbooked row that could
 *   still be booked, locked or marked private.
 * - `PUT /CheckAccountTransaction/{id}/enshrine` is irreversible and needs status 200 or higher
 *   (422 at 100, D-098); the tool refuses lower statuses itself.
 */
import { describe, expect, it } from "vitest";

import { transactionBookTool } from "../../src/tools/banking/transaction-book.js";
import { transactionCreateTool } from "../../src/tools/banking/transaction-create.js";
import { transactionDeleteTool } from "../../src/tools/banking/transaction-delete.js";
import { transactionEnshrineTool } from "../../src/tools/banking/transaction-enshrine.js";
import { transactionGetTool } from "../../src/tools/banking/transaction-get.js";
import { transactionMarkPrivateTool } from "../../src/tools/banking/transaction-private.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultSummary,
  resultText,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  invoiceRoute,
  invoiceRow,
  listRoute,
  logRoute,
  type Row,
  transactionRoute,
  transactionRow,
} from "../unit/domain/reconciliation/helpers.js";

closeWriteHarnessesAfterEach();

/** Every request that would write, answered, so a request that leaves shows up in the writes. */
const WRITES: readonly FakeRoute[] = [
  {
    method: "POST",
    path: "/CheckAccountTransaction",
    response: { body: { objects: { id: "1" } } },
  },
  ...["/CheckAccountTransaction/5401", "/CheckAccountTransaction/5401/enshrine"].flatMap(
    (path): FakeRoute[] => [
      { method: "PUT", path, response: { body: { objects: null } } },
      { method: "DELETE", path, response: { body: { objects: [null] } } },
    ],
  ),
  { method: "PUT", path: "/Invoice/1001/bookAmount", response: { body: { objects: {} } } },
];

async function harness(routes: readonly FakeRoute[]) {
  return writeHarness({
    tools: [
      transactionCreateTool,
      transactionDeleteTool,
      transactionEnshrineTool,
      transactionGetTool,
      transactionBookTool,
      transactionMarkPrivateTool,
    ],
    routes: [...routes, ...WRITES],
    config: { confirm: "off" },
  });
}

describe("a transaction is never created on a cash register, offline or bank-connected account", () => {
  it.each([
    [4003, "cash register (Kasse)"],
    [4001, "clearing account (Verrechnungskonto, offline)"],
    [4002, "connected to a bank (or PayPal)"],
  ])("refuses account %d and sends nothing", async (id, kind) => {
    const { client, fake } = await harness([
      accountRoute(accountRow(id)),
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", []),
    ]);
    const result = await client.callTool({
      name: "sevdesk_transaction_create",
      arguments: {
        checkAccountId: id,
        date: "2026-11-16",
        amount: "23.80",
        direction: "in",
        counterparty: "Barverkauf",
      },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(kind);
    expect(resultText(result)).toContain("nothing was sent");
    expect(writesOf(fake)).toEqual([]);
  });
});

describe("a soft-deleted row is reported as deleted and never as live", () => {
  const deleted: Row = transactionRow({
    id: "5401",
    amount: "177.33",
    status: "100",
    checkAccount: { id: "4004", objectName: "CheckAccount" },
    deletedAt: "2026-11-16T22:01:00+01:00",
  });
  const routes = [
    transactionRoute(deleted),
    accountRoute(accountRow(4004, { status: "100" })),
    logRoute(5401, []),
    invoiceRoute(invoiceRow()),
  ];

  it("shows it as deleted", async () => {
    const { client } = await harness(routes);
    const result = await client.callTool({
      name: "sevdesk_transaction_get",
      arguments: { id: 5401 },
    });
    expect(resultSummary(result)).toContain("Bank transaction 5401 was deleted on 2026-11-16");
    expect(resultData(result)["transaction"]).toMatchObject({
      deleted: true,
      deletedOn: "2026-11-16",
    });
    expect(resultData(result)).not.toHaveProperty("remaining");
  });

  it.each([
    ["sevdesk_transaction_book", { id: 5401, allocations: [{ kind: "invoice", id: 1001 }] }],
    ["sevdesk_transaction_mark_private", { id: 5401 }],
    ["sevdesk_transaction_enshrine", { id: 5401 }],
    ["sevdesk_transaction_delete", { id: 5401 }],
  ])("%s refuses it and sends nothing", async (name, args) => {
    const { client, fake } = await harness(routes);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/was deleted/);
    expect(writesOf(fake)).toEqual([]);
  });
});

describe("no enshrine below status 200", () => {
  it.each([["100"], [null]])("refuses a row at status %s and sends nothing", async (status) => {
    const { client, fake } = await harness([
      transactionRoute(
        transactionRow({
          id: "5401",
          status,
          checkAccount: { id: "4004", objectName: "CheckAccount" },
        }),
      ),
      accountRoute(accountRow(4004, { status: "100" })),
      logRoute(5401, []),
    ]);
    const result = await client.callTool({
      name: "sevdesk_transaction_enshrine",
      arguments: { id: 5401 },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("status 200 or higher");
    expect(writesOf(fake)).toEqual([]);
  });
});
