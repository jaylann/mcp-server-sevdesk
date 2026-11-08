import { describe, expect, it } from "vitest";

import type { TransactionDto } from "../../../../src/domain/banking.js";
import {
  entryShare,
  parseLogEntry,
  paymentsInPeriod,
  readTransactionLog,
  readWholeLog,
  remainingAmount,
  type TransactionLogEntry,
} from "../../../../src/domain/reconciliation/transaction-log.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import {
  accountsListRoute,
  listRoute,
  logEntry,
  logRoute,
  logRow,
  type Row,
  transactionRow,
  voucherRoute,
  voucherRow,
} from "./helpers.js";

const LOG = "/CheckAccountTransactionLog";

function splitRows(): Row[] {
  return structuredClone(
    (loadFixture("banking/transaction-log-split.json").body as { objects: Row[] }).objects,
  );
}

/** `count` minimal log rows of transaction `transactionId` (cheap: no fixture reads). */
function bulkLog(count: number, transactionId: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(100_000 + i),
    checkAccountTransaction: { id: String(transactionId), objectName: "CheckAccountTransaction" },
    object: { id: "1", objectName: "Invoice" },
    amountPaid: 1,
  }));
}

function transaction(amount: string, status: number): Pick<TransactionDto, "amount" | "status"> {
  return { amount: { amount, currency: "EUR" }, status: { code: status, label: "x" } };
}

function entry(amountPaid: string | undefined): TransactionLogEntry {
  return {
    id: 1,
    transactionId: 5201,
    document: { kind: "invoice", objectName: "Invoice", id: 1001 },
    amountPaid,
    fromStatus: 100,
    toStatus: 400,
    bookingDate: undefined,
  };
}

describe("parseLogEntry", () => {
  it("reads the recorded entry shape", () => {
    const [first] = splitRows();
    expect(parseLogEntry(first)).toEqual({
      id: 7001,
      transactionId: 5201,
      document: { kind: "invoice", objectName: "Invoice", id: 1001 },
      amountPaid: "119",
      fromStatus: 100,
      toStatus: 200,
      bookingDate: "2026-11-02",
    });
  });

  it("maps credit notes and vouchers, and anything else to other with a letters-only name", () => {
    expect(
      parseLogEntry(logRow({ object: { id: "2", objectName: "CreditNote" } })).document,
    ).toEqual({ kind: "creditNote", objectName: "CreditNote", id: 2 });
    expect(
      parseLogEntry(logRow({ object: { id: "3", objectName: "Voucher" } })).document?.kind,
    ).toBe("voucher");
    expect(
      parseLogEntry(logRow({ object: { id: "4", objectName: "Order<script>" } })).document,
    ).toEqual({ kind: "other", objectName: "Orderscript", id: 4 });
  });

  it("is lenient with missing or odd members", () => {
    const parsed = parseLogEntry({
      id: "9",
      checkAccountTransaction: "nonsense",
      object: null,
      amountPaid: "abc",
      fromStatus: "",
      toStatus: null,
      bookingDate: "not a date",
    });
    expect(parsed).toEqual({
      id: 9,
      transactionId: undefined,
      document: undefined,
      amountPaid: undefined,
      fromStatus: undefined,
      toStatus: undefined,
      bookingDate: undefined,
    });
  });

  it("refuses an entry without an id as unexpected_response", () => {
    expect(() => parseLogEntry({ amountPaid: 1 })).toThrow(
      expect.objectContaining({ kind: "unexpected_response" }),
    );
  });
});

describe("readTransactionLog", () => {
  it("sends the transaction filter with an explicit limit and returns the entries in order", async () => {
    const rows = splitRows().reverse();
    const client = new FakeSevdeskClient([logRoute(5201, rows)]);
    const log = await readTransactionLog(client, 5201);
    expect(log.complete).toBe(true);
    expect(log.entries.map((e) => e.id)).toEqual([7001, 7002]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.query).toMatchObject({
      "checkAccountTransaction[id]": 5201,
      "checkAccountTransaction[objectName]": "CheckAccountTransaction",
      limit: 1000,
    });
  });

  it("drops entries of other transactions and then also those without a reference", async () => {
    const rows = [
      ...splitRows(),
      logEntry(7003, 9999, "Invoice", 1003, 50),
      logRow({ id: "7004", checkAccountTransaction: null }),
    ];
    const log = await readTransactionLog(new FakeSevdeskClient([logRoute(5201, rows)]), 5201);
    expect(log.entries.map((e) => e.id)).toEqual([7001, 7002]);
    expect(log.complete).toBe(false);
  });

  it("keeps entries without a reference while the filter evidently worked", async () => {
    const rows = [logRow({ checkAccountTransaction: null })];
    const log = await readTransactionLog(new FakeSevdeskClient([logRoute(5201, rows)]), 5201);
    expect(log.entries).toHaveLength(1);
    expect(log.complete).toBe(true);
  });

  it("reads the whole log when the filtered page is full and filters it here", async () => {
    const others = Array.from({ length: 1000 }, (_, i) =>
      logEntry(10_000 + i, 8000 + i, "Invoice", 1, 1),
    );
    const rows = [...others, ...splitRows()];
    const client = new FakeSevdeskClient([
      {
        path: LOG,
        query: { "checkAccountTransaction[id]": 5201 },
        response: { body: { objects: rows } },
      },
    ]);
    const log = await readTransactionLog(client, 5201);
    expect(log.entries.map((e) => e.id)).toEqual([7001, 7002]);
    expect(log.complete).toBe(true);
    expect(client.calls.length).toBeGreaterThan(1);
  });

  it("is incomplete when even the whole log hits its cap (50,000 entries)", async () => {
    const client = new FakeSevdeskClient([listRoute(LOG, bulkLog(50_001, 8000))]);
    const log = await readTransactionLog(client, 5201);
    expect(log.complete).toBe(false);
  });

  it("validates the id before sending anything", async () => {
    const client = new FakeSevdeskClient([]);
    await expect(readTransactionLog(client, 0)).rejects.toBeInstanceOf(SevdeskError);
    expect(client.calls).toEqual([]);
  });
});

describe("readWholeLog", () => {
  it("reads every entry in order, unfiltered", async () => {
    const client = new FakeSevdeskClient([listRoute(LOG, [...splitRows()].reverse())]);
    const log = await readWholeLog(client);
    expect(log.complete).toBe(true);
    expect(log.entries.map((e) => e.id)).toEqual([7001, 7002]);
    expect(client.calls[0]?.query["checkAccountTransaction[id]"]).toBeUndefined();
  });

  it("is incomplete (and parses nothing) beyond its cap", async () => {
    const log = await readWholeLog(new FakeSevdeskClient([listRoute(LOG, bulkLog(50_001, 1))]));
    expect(log).toEqual({ entries: [], complete: false });
  });
});

describe("entryShare", () => {
  it("returns the absolute share of an entry in the transaction's direction", () => {
    expect(entryShare({ amountPaid: "119" }, "238")).toEqual({ share: "119" });
    expect(entryShare({ amountPaid: "-15.5" }, "-20")).toEqual({ share: "15.5" });
    expect(entryShare({ amountPaid: "0" }, "-20")).toEqual({ share: "0" });
  });

  it("reports entries without an amount or against the direction", () => {
    expect(entryShare({ amountPaid: undefined }, "238")).toEqual({
      problem: "its booking log has an entry without an amount",
    });
    expect(entryShare({ amountPaid: "-119" }, "238")).toEqual({
      problem: "its booking log has an entry against the transaction's direction",
    });
  });
});

describe("remainingAmount", () => {
  const complete = (entries: TransactionLogEntry[]) => ({ entries, complete: true });

  it("is the whole amount for a free transaction without entries", () => {
    expect(remainingAmount(transaction("-298.1", 100), complete([]))).toEqual({
      known: true,
      total: "298.1",
      assigned: "0",
      remaining: "298.1",
    });
  });

  it("subtracts the entries exactly for a partly linked transaction", () => {
    expect(remainingAmount(transaction("238", 200), complete([entry("119.1")]))).toEqual({
      known: true,
      total: "238",
      assigned: "119.1",
      remaining: "118.9",
    });
  });

  it("is zero for a fully booked split", () => {
    const result = remainingAmount(transaction("238", 400), complete([entry("119"), entry("119")]));
    expect(result).toMatchObject({ known: true, remaining: "0" });
  });

  it.each([
    [
      "an incomplete log",
      { entries: [], complete: false },
      100,
      "its booking log could not be read completely",
    ],
    [
      "an entry without amount",
      complete([entry(undefined)]),
      200,
      "its booking log has an entry without an amount",
    ],
    [
      "an entry against the direction",
      complete([entry("-1")]),
      200,
      "its booking log has an entry against the transaction's direction",
    ],
    [
      "more assigned than the amount",
      complete([entry("200"), entry("100")]),
      400,
      "its booking log assigns more than the transaction amount",
    ],
    [
      "entries on a free transaction",
      complete([entry("1")]),
      100,
      "it is marked unbooked (status 100) but its booking log has entries",
    ],
    [
      "no entries on a partly linked one",
      complete([]),
      200,
      "it is marked partly linked (status 200) but its booking log has no entries",
    ],
  ])("is unknown with %s", (_label, log, status, reason) => {
    expect(remainingAmount(transaction("238", status), log)).toEqual({ known: false, reason });
  });
});

describe("paymentsInPeriod", () => {
  const tx = (overrides: Row) =>
    transactionRow({ status: "400", valueDate: "2026-11-02T00:00:00+01:00", ...overrides });

  it("lists the payments of booked transactions in the value-date range, one per log entry", async () => {
    const transactions = [
      tx({ id: "5201", amount: "238" }),
      tx({ id: "5301", amount: "-298.1", valueDate: "2026-11-03T00:00:00+01:00" }),
      tx({ id: "5401", amount: "10", status: "100" }),
      tx({ id: "5501", amount: "10", valueDate: "2026-12-01T00:00:00+01:00" }),
    ];
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", transactions),
      logRoute(5201, splitRows()),
      logRoute(5301, [logEntry(7101, 5301, "Voucher", 2001, -298.1)]),
      voucherRoute(voucherRow()),
    ]);
    const progress: string[] = [];
    const result = await paymentsInPeriod(
      client,
      { from: "2026-11-01", to: "2026-11-30" },
      { onProgress: (_done, _total, message) => void progress.push(message) },
    );
    expect(result.payments).toEqual([
      {
        date: "2026-11-02",
        document: { objectName: "Invoice", id: 1001 },
        amount: { amount: "119.00", currency: "EUR" },
        direction: "in",
        signedForDocument: { amount: "119.00", currency: "EUR" },
        transactionId: 5201,
        checkAccountId: 4002,
        bookingDate: "2026-11-02",
      },
      {
        date: "2026-11-02",
        document: { objectName: "Invoice", id: 1002 },
        amount: { amount: "119.00", currency: "EUR" },
        direction: "in",
        signedForDocument: { amount: "119.00", currency: "EUR" },
        transactionId: 5201,
        checkAccountId: 4002,
        bookingDate: "2026-11-02",
      },
      {
        date: "2026-11-03",
        document: { objectName: "Voucher", id: 2001 },
        amount: { amount: "298.10", currency: "EUR" },
        direction: "out",
        signedForDocument: { amount: "298.10", currency: "EUR" },
        transactionId: 5301,
        checkAccountId: 4002,
        bookingDate: "2026-11-02",
      },
    ]);
    expect(result.truncated).toBe(false);
    expect(result.transactionsRead).toBe(2);
    expect(result.transactionsScanned).toBe(4);
    expect(result.notes).toHaveLength(1);
    expect(progress.some((m) => m.startsWith("Read the booking log"))).toBe(true);
    expect(client.writes()).toEqual([]);
  });

  it("signs payments for the document: refunds and bounced debits count negative", async () => {
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", [
        tx({ id: "5201", amount: "119" }),
        tx({ id: "5202", amount: "-119", valueDate: "2026-11-09T00:00:00+01:00" }),
        tx({ id: "5203", amount: "-23.8" }),
        tx({ id: "5204", amount: "23.8" }),
        tx({ id: "5205", amount: "50" }),
        tx({ id: "5206", amount: "-60" }),
      ]),
      logRoute(5201, [logEntry(1, 5201, "Invoice", 1001, 119)]),
      logRoute(5202, [logEntry(2, 5202, "Invoice", 1001, -119)]),
      logRoute(5203, [logEntry(3, 5203, "CreditNote", 2001, -23.8)]),
      logRoute(5204, [logEntry(4, 5204, "CreditNote", 2001, 23.8)]),
      logRoute(5205, [logEntry(5, 5205, "Voucher", 2002, 50)]),
      logRoute(5206, [logEntry(6, 5206, "Voucher", 2001, -60)]),
    ]);
    const result = await paymentsInPeriod(
      client,
      { from: "2026-11-01", to: "2026-11-30" },
      { voucherDirection: (id) => (id === 2002 ? "in" : "out") },
    );
    expect(result.payments.map((p) => [p.transactionId, p.signedForDocument.amount])).toEqual([
      [5201, "119.00"],
      [5203, "23.80"],
      [5204, "-23.80"],
      [5205, "50.00"],
      [5206, "60.00"],
      [5202, "-119.00"],
    ]);
    // The invoice's payments cancel out: paid, then the debit bounced.
    expect(client.callsTo("/Voucher/2001")).toEqual([]);
  });

  it("reads each paid voucher once for its direction and leaves out vouchers it cannot read", async () => {
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", [
        tx({ id: "5201", amount: "-10" }),
        tx({ id: "5202", amount: "-20" }),
        tx({ id: "5203", amount: "30" }),
      ]),
      logRoute(5201, [logEntry(1, 5201, "Voucher", 2001, -10)]),
      logRoute(5202, [logEntry(2, 5202, "Voucher", 2001, -20)]),
      logRoute(5203, [logEntry(3, 5203, "Voucher", 2999, 30)]),
      voucherRoute(voucherRow()),
      {
        path: "/Voucher/2999",
        response: { error: new SevdeskError({ kind: "not_found", message: "gone" }) },
      },
    ]);
    const result = await paymentsInPeriod(client, { from: "2026-11-01", to: "2026-11-30" });
    expect(result.payments.map((p) => p.signedForDocument.amount)).toEqual(["10.00", "20.00"]);
    expect(client.callsTo("/Voucher/2001")).toHaveLength(1);
    expect(result.notes).toContain(
      "1 log entries book vouchers that sevDesk no longer has or that do not say whether they " +
        "are an expense or revenue; they are left out.",
    );
  });

  it("passes other voucher read failures on", async () => {
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", [tx({ id: "5201", amount: "-10" })]),
      logRoute(5201, [logEntry(1, 5201, "Voucher", 2001, -10)]),
      {
        path: "/Voucher/2001",
        response: { error: new SevdeskError({ kind: "auth", message: "no" }) },
      },
    ]);
    await expect(
      paymentsInPeriod(client, { from: "2026-11-01", to: "2026-11-30" }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("notes entries it leaves out and booked transactions without entries", async () => {
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", [
        tx({ id: "5201", amount: "238" }),
        tx({ id: "5202", amount: "50" }),
      ]),
      logRoute(5201, [
        logEntry(1, 5201, "Order", 3001, 10),
        logEntry(2, 5201, "Invoice", 1001, null),
        logEntry(3, 5201, "Invoice", 1001, 0),
        logEntry(4, 5201, "Invoice", 1001, -5),
        logRow({
          id: "5",
          checkAccountTransaction: { id: "5201", objectName: "CheckAccountTransaction" },
          object: null,
        }),
      ]),
      logRoute(5202, []),
    ]);
    const result = await paymentsInPeriod(client, { from: "2026-11-01", to: "2026-11-30" });
    expect(result.payments).toEqual([]);
    expect(result.notes).toEqual([
      expect.stringContaining("booking log"),
      "2 log entries book something other than an invoice, credit note or voucher and are left out.",
      "2 log entries have no amount or one against the transaction's direction and are left out.",
      "1 booked or linked transactions have no booking log entries (booked another way, e.g. directly to an account) and are left out.",
    ]);
  });

  it("restricts to the given accounts and caps the transactions read", async () => {
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", [
        tx({ id: "5201", amount: "238" }),
        tx({ id: "5202", amount: "50", valueDate: "2026-11-05T00:00:00+01:00" }),
        tx({ id: "5203", amount: "50", checkAccount: { id: "4001", objectName: "CheckAccount" } }),
      ]),
      logRoute(5201, splitRows()),
      logRoute(5202, [logEntry(9, 5202, "Invoice", 1003, 50)]),
    ]);
    const result = await paymentsInPeriod(
      client,
      { from: "2026-11-01", to: "2026-11-30", accountIds: [4002, 4002] },
      { maxTransactions: 1 },
    );
    expect(result.truncated).toBe(true);
    expect(result.payments.map((p) => p.transactionId)).toEqual([5201, 5201]);
    expect(result.notes[1]).toContain("A cap stopped reading");
    const lists = client.calls.filter((c) => c.path === "/CheckAccountTransaction");
    expect(lists[0]?.query).toMatchObject({ "checkAccount[id]": 4002 });
  });

  it("joins one scan of the whole log for many transactions", async () => {
    const transactions = Array.from({ length: 30 }, (_, i) =>
      tx({ id: String(6000 + i), amount: "10" }),
    );
    const log = transactions.map((t, i) =>
      logEntry(20_000 + i, Number(t["id"]), "Invoice", 1000 + i, 10),
    );
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", transactions),
      listRoute(LOG, [
        ...log,
        logEntry(1, 1, "Invoice", 1, 5),
        logRow({ checkAccountTransaction: null }),
      ]),
    ]);
    const result = await paymentsInPeriod(client, { from: "2026-11-01", to: "2026-11-30" });
    expect(result.payments).toHaveLength(30);
    expect(result.truncated).toBe(false);
    const logCalls = client.calls.filter((c) => c.path === LOG);
    expect(logCalls.every((c) => c.query["checkAccountTransaction[id]"] === undefined)).toBe(true);
  });

  it("falls back to one read per transaction when the whole-log scan hits its cap", async () => {
    const transactions = Array.from({ length: 25 }, (_, i) =>
      tx({ id: String(6000 + i), amount: "10" }),
    );
    const perTransaction = transactions.map((t, i) =>
      logRoute(Number(t["id"]), [logEntry(30_000 + i, Number(t["id"]), "Invoice", 1, 10)]),
    );
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", transactions),
      ...perTransaction,
      // Unfiltered: more entries than the whole-log cap.
      listRoute(LOG, bulkLog(50_001, 1)),
    ]);
    const result = await paymentsInPeriod(client, { from: "2026-11-01", to: "2026-11-30" });
    expect(result.payments).toHaveLength(25);
    expect(result.truncated).toBe(false);
  });

  it("refuses an empty range before sending anything", async () => {
    const client = new FakeSevdeskClient([]);
    await expect(
      paymentsInPeriod(client, { from: "2026-12-01", to: "2026-11-01" }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(client.calls).toEqual([]);
  });

  it("stops when the call is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      paymentsInPeriod(
        new FakeSevdeskClient([]),
        { from: "2026-11-01", to: "2026-11-30" },
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
});
