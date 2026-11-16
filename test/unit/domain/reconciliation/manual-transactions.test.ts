/**
 * Bank transactions entered by hand, deleted and locked: the checks, payloads and read-back
 * checks of `src/domain/reconciliation/manual-transactions.ts`, against the recorded behaviour
 * (spec/deviations.md D-071, D-095, D-096, D-097, D-098).
 */
import { describe, expect, it } from "vitest";

import type { BankAccountDto } from "../../../../src/domain/banking.js";
import { bookingTimestamp } from "../../../../src/domain/lifecycle/payments.js";
import { inLanguage } from "../../../../src/domain/preview-text.js";
import {
  assertManualEntryAccount,
  executeTransactionCreate,
  executeTransactionDelete,
  executeTransactionEnshrine,
  paidDocumentText,
  planTransactionCreate,
  planTransactionDelete,
  planTransactionEnshrine,
  type TransactionCreateInput,
} from "../../../../src/domain/reconciliation/manual-transactions.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  listRoute,
  logEntry,
  logRoute,
  type Row,
  transactionRoute,
  transactionRow,
} from "./helpers.js";

/** An active file-import account (type online, importType CSV, no bank server; D-097). */
const IMPORT = accountRow(4004, { status: "100", name: "Import-Konto" });
const IMPORT_REF = { id: "4004", objectName: "CheckAccount" };

function row(overrides: Row = {}): Row {
  return transactionRow({
    id: "5401",
    amount: "-11.9",
    status: "100",
    valueDate: "2026-11-16T12:00:00+01:00",
    entryDate: "2026-11-16T12:00:00+01:00",
    payeePayerName: "Bäckerei Huber",
    paymtPurpose: "Kaffee",
    checkAccount: IMPORT_REF,
    ...overrides,
  });
}

const INPUT: TransactionCreateInput = {
  checkAccountId: 4004,
  date: "2026-11-16",
  amount: "11.9",
  direction: "out",
  counterparty: "Bäckerei Huber",
  purpose: "Kaffee",
};

/** The account's rows of the duplicate check (`GET /CheckAccountTransaction` by account). */
function rowsOfAccount(rows: readonly Row[]): FakeRoute {
  return listRoute("/CheckAccountTransaction", rows, { "checkAccount[id]": 4004 });
}

function createClient(account: Row = IMPORT, rows: readonly Row[] = []): FakeSevdeskClient {
  return new FakeSevdeskClient([accountRoute(account), accountsListRoute(), rowsOfAccount(rows)]);
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  const error = await run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  return (error as SevdeskError).message;
}

function account(overrides: Partial<BankAccountDto>): BankAccountDto {
  return {
    id: 4003,
    name: "Kasse",
    type: "cash",
    fileImport: false,
    currency: "EUR",
    status: { code: 100, label: "Active" },
    isDefault: false,
    ...overrides,
  };
}

describe("assertManualEntryAccount", () => {
  it("accepts an active file-import account", () => {
    expect(() => {
      assertManualEntryAccount(
        account({ id: 4004, type: "bank", fileImport: true, importType: "CSV" }),
      );
    }).not.toThrow();
  });

  it.each([
    [
      "a cash register",
      account({}),
      "Check account 4003 is a cash register (Kasse), and sevDesk takes no hand-made " +
        "transactions on it. Record a cash sale or cash expense by booking the payment on its " +
        "document against this register without transactionId (sevdesk_voucher_book_payment, " +
        "sevdesk_invoice_book_payment or sevdesk_credit_note_book_payment); sevDesk then adds " +
        "the entry to the cash book itself.",
    ],
    [
      "a clearing account",
      account({ id: 4001, type: "clearing" }),
      "Check account 4001 is a clearing account (Verrechnungskonto, offline), and sevDesk takes " +
        "no hand-made transactions on it. Book the payment on its document against this account " +
        "without transactionId (sevdesk_voucher_book_payment, sevdesk_invoice_book_payment or " +
        "sevdesk_credit_note_book_payment); sevDesk then creates the transaction itself.",
    ],
    [
      "a bank-connected account",
      account({ id: 4002, type: "bank" }),
      "Check account 4002 is connected to a bank (or PayPal): its transactions come from the " +
        "bank, so none are entered by hand. Book the imported row with sevdesk_transaction_book " +
        "once it is there; for transactions entered by hand use a file-import account " +
        "(sevdesk_bank_account_create, kind file_import).",
    ],
    [
      "an account of unknown type",
      account({ id: 4009, type: "unknown" }),
      "Check account 4009 is of an account type sevDesk does not document; transactions are " +
        "entered by hand only on file-import accounts (fileImport in sevdesk_bank_accounts_list).",
    ],
    [
      "an archived file-import account",
      account({
        id: 4004,
        type: "bank",
        fileImport: true,
        status: { code: 0, label: "Archived" },
      }),
      "Check account 4004 is archived; enter the transaction on an active file-import account.",
    ],
  ])("refuses %s, saying what to do instead", (_label, refused, message) => {
    expect(() => {
      assertManualEntryAccount(refused);
    }).toThrow(message);
  });
});

describe("planTransactionCreate", () => {
  it("builds the recorded request body: both dates at 12:00 Berlin in UTC, status 100", async () => {
    const client = createClient();
    const plan = await planTransactionCreate(client, INPUT);
    expect(plan.payload).toEqual({
      objectName: "CheckAccountTransaction",
      mapAll: true,
      valueDate: "2026-11-16T11:00:00.000Z",
      entryDate: "2026-11-16T11:00:00.000Z",
      amount: -11.9,
      paymtPurpose: "Kaffee",
      payeePayerName: "Bäckerei Huber",
      checkAccount: { id: 4004, objectName: "CheckAccount" },
      status: 100,
    });
    expect(plan.payload.valueDate).toBe(
      new Date(bookingTimestamp("2026-11-16") * 1000).toISOString(),
    );
    expect(plan.amount).toEqual({ amount: "-11.90", currency: "EUR" });
    expect(plan.duplicates).toEqual([]);
    expect(client.writes()).toEqual([]);
  });

  it("keeps the day in summer time and leaves out a purpose that was not given", async () => {
    const plan = await planTransactionCreate(createClient(), {
      ...INPUT,
      date: "2026-07-01",
      direction: "in",
      amount: "23.8",
      purpose: undefined,
    });
    expect(plan.payload.valueDate).toBe("2026-07-01T10:00:00.000Z");
    expect(plan.payload.amount).toBe(23.8);
    expect(plan.payload).not.toHaveProperty("paymtPurpose");
    expect(plan.purpose).toBeUndefined();
  });

  it("names rows of that day with the same amount and purpose (duplicate check)", async () => {
    const rows = [
      row(),
      row({ id: "5402", paymtPurpose: "  KAFFEE " }),
      row({ id: "5403", paymtPurpose: "Kuchen" }),
      row({ id: "5404", amount: "11.9" }),
      row({ id: "5405", valueDate: "2026-11-15T12:00:00+01:00" }),
      row({ id: "5406", checkAccount: { id: "4002", objectName: "CheckAccount" } }),
    ];
    const plan = await planTransactionCreate(createClient(IMPORT, rows), INPUT);
    expect(plan.duplicates).toEqual([5401, 5402]);
    expect(inLanguage(plan.warnings, "en")).toContain(
      "Account 4004 already has 2 rows on 2026-11-16 with the same amount and purpose (bank " +
        "transaction 5401, 5402). If this is the same payment, do not create it again.",
    );
    expect(inLanguage(plan.warnings, "de")).toContain(
      "Das Konto 4004 hat am 16.11.2026 bereits 2 Umsätze mit demselben Betrag und " +
        "Verwendungszweck (Kontoumsatz 5401, 5402). Ist es dieselbe Zahlung, lege sie nicht " +
        "noch einmal an.",
    );
  });

  it("says what the new row changes", async () => {
    const plan = await planTransactionCreate(createClient(), INPUT);
    expect(plan.warnings[0]).toEqual({
      en:
        "The new row changes the balance of account 4004 by -11.90 EUR and counts as unbooked " +
        "(status 100) until it is booked to documents. It can be deleted again only while it is " +
        "unbooked (sevdesk_transaction_delete).",
      de:
        "Der neue Umsatz ändert den Saldo des Kontos 4004 um -11,90 EUR und gilt als ungebucht " +
        "(Status 100), bis er Dokumenten zugeordnet ist. Löschen lässt er sich nur, solange er " +
        "ungebucht ist (sevdesk_transaction_delete).",
    });
  });

  it("refuses an unknown account and every account but a file-import account, reading only", async () => {
    const missing = new FakeSevdeskClient([
      {
        path: "/CheckAccount/4999",
        response: { error: new SevdeskError({ kind: "not_found", message: "x" }) },
      },
    ]);
    expect(
      await refusal(() => planTransactionCreate(missing, { ...INPUT, checkAccountId: 4999 })),
    ).toBe("Check account 4999 does not exist; list the accounts with sevdesk_bank_accounts_list.");
    for (const id of [4001, 4002, 4003]) {
      const client = createClient(accountRow(id));
      expect(
        await refusal(() => planTransactionCreate(client, { ...INPUT, checkAccountId: id })),
      ).toMatch(/takes no hand-made transactions|connected to a bank/);
      // Refused before the duplicate check, and nothing is sent.
      expect(client.callsTo("/CheckAccountTransaction")).toEqual([]);
      expect(client.writes()).toEqual([]);
    }
  });
});

describe("executeTransactionCreate", () => {
  const state = (bookings: Parameters<typeof executeTransactionCreate>[1]["bookings"] = []) => ({
    payload: {
      objectName: "CheckAccountTransaction" as const,
      mapAll: true as const,
      valueDate: "2026-11-16T11:00:00.000Z",
      entryDate: "2026-11-16T11:00:00.000Z",
      amount: -11.9,
      payeePayerName: "Bäckerei Huber",
      checkAccount: { id: 4004, objectName: "CheckAccount" as const },
      status: 100 as const,
    },
    bookings,
  });
  const voucherBooking = {
    kind: "voucher" as const,
    id: 2001,
    payload: {
      amount: -11.9,
      date: bookingTimestamp("2026-11-16"),
      type: "FULL_PAYMENT" as const,
      checkAccount: { id: 4004, objectName: "CheckAccount" as const },
    },
  };

  function post(objects: unknown): FakeRoute {
    return { method: "POST", path: "/CheckAccountTransaction", response: { body: { objects } } };
  }

  it.each([
    ["one object", { id: "5401", objectName: "CheckAccountTransaction" }],
    ["an array of one", [{ id: "5401", objectName: "CheckAccountTransaction" }]],
    ["a nested object", { checkAccountTransaction: { id: "5401" } }],
  ])("creates the row once and reads its id from %s", async (_label, objects) => {
    const client = new FakeSevdeskClient([post(objects)]);
    const result = await executeTransactionCreate(client, state());
    expect(result).toEqual({
      id: 5401,
      changed: [{ objectName: "CheckAccountTransaction", id: "5401" }],
    });
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/CheckAccountTransaction",
        body: state().payload,
      }),
    ]);
  });

  it("says the row was probably created when the answer names no id, and books nothing", async () => {
    const client = new FakeSevdeskClient([post({ objectName: "CheckAccountTransaction" })]);
    const error = await executeTransactionCreate(client, state([voucherBooking])).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      kind: "unexpected_response",
      message:
        "sevDesk accepted the new bank transaction, but its answer did not name it, so its id is " +
        "unknown and nothing was booked. Do not repeat the call: look for the row with " +
        "sevdesk_transactions_list (account 4004) first.",
    });
    expect(client.writes()).toHaveLength(1);
  });

  it("links each planned booking to the new row", async () => {
    const client = new FakeSevdeskClient([
      post({ id: "5401" }),
      { method: "PUT", path: "/Voucher/2001/bookAmount", response: { body: { objects: {} } } },
    ]);
    const result = await executeTransactionCreate(client, state([voucherBooking]));
    expect(client.writes().map((call) => call.body)).toEqual([
      state().payload,
      {
        ...voucherBooking.payload,
        checkAccountTransaction: { id: 5401, objectName: "CheckAccountTransaction" },
      },
    ]);
    expect(result.changed).toEqual([
      { objectName: "Voucher", id: "2001" },
      { objectName: "CheckAccountTransaction", id: "5401" },
    ]);
  });

  it("reports the created row when its booking fails, so the call is not repeated", async () => {
    const refused = new SevdeskError({ kind: "validation", status: 422, message: "x" });
    const first = new FakeSevdeskClient([
      post({ id: "5401" }),
      { method: "PUT", path: "/Voucher/2001/bookAmount", response: { error: refused } },
    ]);
    const error = await executeTransactionCreate(first, state([voucherBooking])).catch(
      (e: unknown) => e,
    );
    expect((error as SevdeskError).completedWrites).toEqual([
      { objectName: "CheckAccountTransaction", id: "5401" },
    ]);

    // A later booking fails: the booked document and the row, each once.
    const second = new FakeSevdeskClient([
      post({ id: "5401" }),
      { method: "PUT", path: "/Voucher/2001/bookAmount", response: { body: { objects: {} } } },
      { method: "PUT", path: "/Voucher/2002/bookAmount", response: { error: refused } },
    ]);
    const later = await executeTransactionCreate(
      second,
      state([voucherBooking, { ...voucherBooking, id: 2002 }]),
    ).catch((e: unknown) => e);
    expect((later as SevdeskError).completedWrites).toEqual([
      { objectName: "Voucher", id: "2001" },
      { objectName: "CheckAccountTransaction", id: "5401" },
    ]);
  });
});

describe("planTransactionDelete", () => {
  function deleteClient(transaction: Row, accountRows: readonly Row[] = [IMPORT]) {
    return new FakeSevdeskClient([transactionRoute(transaction), ...accountRows.map(accountRoute)]);
  }

  it("accepts an unbooked row of a file-import account", async () => {
    const plan = await planTransactionDelete(deleteClient(row()), 5401);
    expect(plan.transaction.id).toBe(5401);
    expect(plan.account.fileImport).toBe(true);
  });

  it.each([
    [
      "an unknown row",
      undefined,
      "Bank transaction 5401 does not exist; find it with sevdesk_transactions_list.",
    ],
    [
      "a row deleted already",
      row({ deletedAt: "2026-11-16T22:01:00+01:00" }),
      "Bank transaction 5401 was deleted already on 2026-11-16; there is nothing to do.",
    ],
    [
      "an enshrined row",
      row({ status: "400", enshrined: "2026-11-16T22:00:00+01:00" }),
      "Bank transaction 5401 is enshrined (festgeschrieben); sevDesk never deletes it.",
    ],
    [
      "a private row",
      row({ status: "300" }),
      "Bank transaction 5401 is marked as private; sevDesk deletes only unbooked rows (status " +
        "100). Set it back to unbooked with sevdesk_transaction_reset first.",
    ],
    [
      "a booked row",
      row({ status: "400" }),
      "Bank transaction 5401 is booked or linked to documents (status 400); sevDesk deletes " +
        "only unbooked rows (status 100). Undo its bookings with sevdesk_transaction_reset " +
        "first (it resets the documents it pays to open), then delete it.",
    ],
    [
      "a cash register entry",
      row({ status: "400", checkAccount: { id: "4003", objectName: "CheckAccount" } }),
      "Bank transaction 5401 is on a cash register (Kasse), whose entries come from payments " +
        "booked there; this tool does not delete them. Undo the payment by resetting its " +
        "document to open (sevdesk_voucher_reset, sevdesk_invoice_reset or " +
        "sevdesk_credit_note_reset): sevDesk then books a counter-entry dated that day.",
    ],
    [
      "a clearing account row",
      row({ checkAccount: { id: "4001", objectName: "CheckAccount" } }),
      "Bank transaction 5401 is on a clearing account (Verrechnungskonto), whose transactions " +
        "sevDesk creates for payments booked there; this tool does not delete them. Undo the " +
        "payment by resetting its document to open (sevdesk_voucher_reset, " +
        "sevdesk_invoice_reset or sevdesk_credit_note_reset), which deletes the transaction.",
    ],
    [
      "a bank-connected row",
      row({ checkAccount: { id: "4002", objectName: "CheckAccount" } }),
      "Bank transaction 5401 is on a bank-connected account: its rows come from the bank, and " +
        "deleting them through the API has not been tried. Delete a duplicate import in the " +
        "sevDesk web app.",
    ],
  ])("refuses %s", async (_label, transaction, message) => {
    const client =
      transaction === undefined
        ? new FakeSevdeskClient([
            {
              path: "/CheckAccountTransaction/5401",
              response: { error: new SevdeskError({ kind: "not_found", message: "x" }) },
            },
          ])
        : deleteClient(transaction, [IMPORT, accountRow(4001), accountRow(4002), accountRow(4003)]);
    expect(await refusal(() => planTransactionDelete(client, 5401))).toBe(message);
    expect(client.writes()).toEqual([]);
  });
});

describe("executeTransactionDelete", () => {
  function deleteRoute(): FakeRoute {
    return {
      method: "DELETE",
      path: "/CheckAccountTransaction/5401",
      response: { body: { objects: [null] } },
    };
  }

  it("confirms the soft delete by deletedAt on the read-back (D-096)", async () => {
    const client = new FakeSevdeskClient([
      deleteRoute(),
      transactionRoute(row({ deletedAt: "2026-11-16T22:01:00+01:00" })),
      accountRoute(IMPORT),
    ]);
    const after = await executeTransactionDelete(client, 5401);
    expect(after).toMatchObject({ id: 5401, deleted: true, deletedOn: "2026-11-16" });
    expect(client.writes()).toEqual([
      expect.objectContaining({ method: "DELETE", path: "/CheckAccountTransaction/5401" }),
    ]);
    expect(client.writes()[0]).not.toHaveProperty("body");
  });

  it("never takes a live read-back or a missing row for a deletion", async () => {
    const live = new FakeSevdeskClient([
      deleteRoute(),
      transactionRoute(row()),
      accountRoute(IMPORT),
    ]);
    const stillLive = await executeTransactionDelete(live, 5401).catch((e: unknown) => e);
    expect(stillLive).toMatchObject({
      kind: "unexpected_response",
      message:
        "sevDesk accepted the delete of bank transaction 5401, but the row still reads back as " +
        "not deleted. Check it with sevdesk_transaction_get before trying again.",
      completedWrites: [{ objectName: "CheckAccountTransaction", id: "5401" }],
    });

    const gone = new FakeSevdeskClient([
      deleteRoute(),
      {
        path: "/CheckAccountTransaction/5401",
        response: { error: new SevdeskError({ kind: "not_found", status: 404, message: "x" }) },
      },
    ]);
    const missing = await executeTransactionDelete(gone, 5401).catch((e: unknown) => e);
    expect(missing).toMatchObject({
      kind: "unexpected_response",
      message: expect.stringContaining("could not be read back afterwards") as unknown,
      completedWrites: [{ objectName: "CheckAccountTransaction", id: "5401" }],
    });
  });
});

describe("planTransactionEnshrine", () => {
  function enshrineClient(transaction: Row, log: readonly Row[] = []) {
    return new FakeSevdeskClient([
      transactionRoute(transaction),
      accountRoute(IMPORT),
      logRoute(5401, log),
    ]);
  }

  it("accepts a booked row and names the documents it pays", async () => {
    const plan = await planTransactionEnshrine(
      enshrineClient(row({ status: "400" }), [
        logEntry(7001, 5401, "Voucher", 2001, -11.9),
        logEntry(7002, 5401, "Voucher", 2001, 0),
        logEntry(7003, 5401, "Order", 3002, 1),
      ]),
      5401,
    );
    expect(plan.documents).toEqual([
      { kind: "voucher", id: 2001, objectName: "Voucher" },
      { kind: "other", id: 3002, objectName: "Order" },
    ]);
    expect(plan.logComplete).toBe(true);
    expect(plan.documents.map((document) => paidDocumentText(document, "en"))).toEqual([
      "voucher 2001",
      "Order 3002",
    ]);
    expect(plan.documents.map((document) => paidDocumentText(document, "de"))).toEqual([
      "Beleg 2001",
      "Order 3002",
    ]);
  });

  it("accepts every status from 200 (linked) on", async () => {
    for (const status of ["200", "300", "350", "400"]) {
      const plan = await planTransactionEnshrine(enshrineClient(row({ status })), 5401);
      expect(plan.transaction.status?.code).toBe(Number(status));
    }
  });

  it.each([
    [
      "an unbooked row (sevDesk: 422 below 200)",
      row(),
      "Bank transaction 5401 is unbooked (status 100); sevDesk locks only transactions that are " +
        "linked or booked (status 200 or higher). Book it first (sevdesk_transaction_book).",
    ],
    [
      "a row without status",
      row({ status: null }),
      "Bank transaction 5401 is at status unknown; sevDesk locks only transactions that are " +
        "linked or booked (status 200 or higher). Book it first (sevdesk_transaction_book).",
    ],
    [
      "an enshrined row",
      row({ status: "400", enshrined: "2026-11-16T22:00:00+01:00" }),
      "Bank transaction 5401 is already enshrined (festgeschrieben); there is nothing to do.",
    ],
    [
      "a deleted row",
      row({ deletedAt: "2026-11-16T22:01:00+01:00" }),
      "Bank transaction 5401 was deleted; a deleted row cannot be locked.",
    ],
  ])("refuses %s", async (_label, transaction, message) => {
    const client = enshrineClient(transaction);
    expect(await refusal(() => planTransactionEnshrine(client, 5401))).toBe(message);
    expect(client.writes()).toEqual([]);
  });
});

describe("executeTransactionEnshrine", () => {
  const enshrine: FakeRoute = {
    method: "PUT",
    path: "/CheckAccountTransaction/5401/enshrine",
    response: { body: { objects: null } },
  };

  it("locks the row once and confirms enshrined on the read-back", async () => {
    const client = new FakeSevdeskClient([
      enshrine,
      transactionRoute(row({ status: "400", enshrined: "2026-11-16T22:00:00+01:00" })),
      accountRoute(IMPORT),
    ]);
    const after = await executeTransactionEnshrine(client, 5401);
    expect(after.enshrined).toBe(true);
    expect(client.writes()).toEqual([
      expect.objectContaining({ method: "PUT", path: "/CheckAccountTransaction/5401/enshrine" }),
    ]);
    expect(client.writes()[0]).not.toHaveProperty("body");
  });

  it("fails with the row as a completed write when it does not read back enshrined", async () => {
    const client = new FakeSevdeskClient([
      enshrine,
      transactionRoute(row({ status: "400" })),
      accountRoute(IMPORT),
    ]);
    const error = await executeTransactionEnshrine(client, 5401).catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: "unexpected_response",
      completedWrites: [{ objectName: "CheckAccountTransaction", id: "5401" }],
    });
  });
});
