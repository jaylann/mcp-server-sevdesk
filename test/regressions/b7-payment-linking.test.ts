/**
 * B7: a payment must be linked to the bank transaction it came from.
 *
 * `PUT /Invoice/{id}/bookAmount` takes the check account and, optionally, the
 * `checkAccountTransaction` to link. Without the transaction sevDesk creates a new one on offline
 * and cash accounts, so booking an imported payment with only the account id counts the money
 * twice ("Booking with only checkAccountId creates an additional payment rather than linking the
 * existing one", joosthel/sevdesk-mcp PR #7); other servers made the transaction optional or left
 * out `objectName`, which the spec says causes a logic error, and online accounts need the
 * transaction anyway (spec `bookInvoice`). Linking the wrong transaction (another account, already
 * booked, wrong direction, too small) misstates both the account and the receivable.
 *
 * Guard: `sevdesk_{invoice,credit_note}_book_payment` send the transaction as an
 * `{id, objectName}` reference over the wire, refuse online accounts without one, check the
 * transaction before anything is sent, and warn when sevDesk would create a new one. Tested
 * through the real HTTP client, so the JSON on the wire is what is checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { bookPaymentTool } from "../../src/tools/lifecycle/book-payment.js";
import {
  createFakeClock,
  createFakeFetch,
  envelope,
  type FakeReply,
} from "../helpers/fake-fetch.js";
import { executeWrite, prepareWrite } from "../helpers/write-tools.js";
import {
  accountRow,
  creditNoteRow,
  fixtureRow,
  invoiceRow,
  type Row,
  transactionRow,
} from "../unit/tools/lifecycle/helpers.js";

const invoiceTool = bookPaymentTool("invoice");
const creditNoteTool = bookPaymentTool("creditNote");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(replies: FakeReply[]) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const client = createSevdeskClient(
    {
      token: "0123456789abcdef0123456789abcdef",
      baseUrl: "https://my.sevdesk.de/api/v1",
      allowedTiers: new Set<Tier>(["read", "write", "commit", "external"]),
      readOnly: false,
      dryRun: false,
      requestsPerSecond: 1000,
      timeoutMs: 1000,
      userAgent: "test",
    },
    { fetch: fake.fetch, sleep: clock.sleep, now: clock.now, monotonicNow: clock.now },
  );
  return { client, fake };
}

/**
 * The reads `prepare` makes with a transaction: document, account, transaction, its account, and
 * the transaction's booking log (empty here).
 */
function readsWithTransaction(document: Row, transaction: Row, account: Row): FakeReply[] {
  return [
    envelope([document]),
    envelope([account]),
    envelope([transaction]),
    envelope([account]),
    envelope([]),
  ];
}

function requestLines(fake: ReturnType<typeof setup>["fake"]): string[] {
  return fake.requests.map((request) => `${request.method} ${request.url.pathname}`);
}

describe("B7: payments are linked to their bank transaction", () => {
  it("sends the transaction as an {id, objectName} reference next to the check account", async () => {
    const { client, fake } = setup([
      ...readsWithTransaction(invoiceRow(), transactionRow(), accountRow(4002)),
      envelope(fixtureRow("invoice-book-amount.json")),
      envelope([invoiceRow({ status: "1000", paidAmount: 177.33 })]),
    ]);

    const { output } = await executeWrite(
      invoiceTool,
      { id: 1001, amount: "177.33", date: "2026-11-02", checkAccountId: 4002, transactionId: 5101 },
      client,
    );

    const writes = fake.requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("PUT");
    expect(writes[0]?.url.pathname).toBe("/api/v1/Invoice/1001/bookAmount");
    expect(JSON.parse(String(writes[0]?.body))).toEqual({
      amount: 177.33,
      date: 1_793_617_200,
      type: "FULL_PAYMENT",
      checkAccount: { id: 4002, objectName: "CheckAccount" },
      checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
    });
    expect(output.affected).toContainEqual({
      objectName: "CheckAccountTransaction",
      id: "5101",
    });
  });

  it("links an outgoing transaction to a credit note payout with the negative amount", async () => {
    const outgoing = transactionRow({ amount: "-23.8" });
    const { client, fake } = setup([
      ...readsWithTransaction(creditNoteRow(), outgoing, accountRow(4002)),
      envelope(fixtureRow("credit-note-book-amount.json")),
      envelope([creditNoteRow({ status: "1000" })]),
    ]);

    await executeWrite(
      creditNoteTool,
      { id: 2001, amount: "23.80", date: "2026-11-02", checkAccountId: 4002, transactionId: 5101 },
      client,
    );

    const put = fake.requests.find((request) => request.method === "PUT");
    expect(JSON.parse(String(put?.body))).toMatchObject({
      amount: -23.8,
      checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
    });
  });

  it("refuses an online account without a transaction before anything is sent", async () => {
    const { client, fake } = setup([envelope([invoiceRow()]), envelope([accountRow(4002)])]);

    const error = await prepareWrite(
      invoiceTool,
      { id: 1001, amount: "177.33", checkAccountId: 4002 },
      client,
    ).catch((e: unknown) => e);

    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain("pass transactionId");
    expect(requestLines(fake)).toEqual([
      "GET /api/v1/Invoice/1001",
      "GET /api/v1/CheckAccount/4002",
    ]);
  });

  it("warns that sevDesk creates a second transaction when an offline booking has none", async () => {
    const { client } = setup([envelope([invoiceRow()]), envelope([accountRow(4001)])]);

    const plan = await prepareWrite(
      invoiceTool,
      { id: 1001, amount: "177.33", checkAccountId: 4001 },
      client,
    );

    expect(plan.preview.warnings).toContain(
      "sevDesk creates a new bank transaction for this payment on account 4001. If the payment " +
        "is already in sevDesk as an imported transaction, pass its transactionId instead, or it " +
        "is counted twice.",
    );
  });

  it.each([
    ["is already booked", transactionRow({ status: "400" }), "is already booked"],
    ["is partly assigned", transactionRow({ status: "200" }), "partly assigned"],
    [
      "belongs to another account",
      transactionRow({ checkAccount: { id: "4001", objectName: "CheckAccount" } }),
      "belongs to check account 4001",
    ],
    ["goes the wrong way", transactionRow({ amount: "-177.33" }), "is not an incoming payment"],
    ["is too small", transactionRow({ amount: "100" }), "less than the payment"],
    ["is enshrined", transactionRow({ enshrined: "2026-10-01T00:00:00+02:00" }), "is enshrined"],
  ])("refuses a transaction that %s, without writing", async (_label, transaction, message) => {
    // prepare reads the booking account (4002), then the transaction and its own account, and
    // for a free (status 100) transaction its booking log (empty here).
    const owner = (transaction["checkAccount"] as { id: string }).id;
    const { client, fake } = setup([
      envelope([invoiceRow()]),
      envelope([accountRow(4002)]),
      envelope([transaction]),
      envelope([accountRow(Number(owner))]),
      envelope([]),
    ]);

    const error = await prepareWrite(
      invoiceTool,
      { id: 1001, amount: "177.33", checkAccountId: 4002, transactionId: 5101 },
      client,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain(message);
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
  });
});
