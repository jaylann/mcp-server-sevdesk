import { bankAccountCreateTool } from "../../src/tools/banking/account-create.js";
import { transactionBookTool } from "../../src/tools/banking/transaction-book.js";
import { transactionCreateTool } from "../../src/tools/banking/transaction-create.js";
import { transactionDeleteTool } from "../../src/tools/banking/transaction-delete.js";
import { transactionEnshrineTool } from "../../src/tools/banking/transaction-enshrine.js";
import { transactionMarkPrivateTool } from "../../src/tools/banking/transaction-private.js";
import { transactionResetTool } from "../../src/tools/banking/transaction-reset.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  invoiceRoute,
  invoiceRow,
  listRoute,
  logEntry,
  logRoute,
  transactionRoute,
  transactionRow,
} from "../unit/domain/reconciliation/helpers.js";

const freeTransaction = transactionRow();
const bookedTransaction = transactionRow({ status: "400" });
const privateTransaction = transactionRow({ status: "300", amount: "-45.99" });
/** An active file-import account (type online, importType CSV, no bank server; D-097). */
const importAccount = accountRow(4004, { status: "100", name: "Import-Konto" });
/** A row entered by hand on it (status 100). */
const handMade = transactionRow({
  id: "5401",
  valueDate: "2026-11-09T12:00:00+01:00",
  entryDate: "2026-11-09T12:00:00+01:00",
  checkAccount: { id: "4004", objectName: "CheckAccount" },
});

/** The writes the cases below have seen in the current run (reset by their `setup`). */
const written = new Set<string>();

/** Starts a run of a case below with sevDesk's state before its write, and clears it after. */
function resetWrites(): Promise<{ readonly undo: () => void }> {
  written.clear();
  return Promise.resolve({
    undo: () => {
      written.clear();
    },
  });
}

/**
 * Routes for a tool that confirms its write by reading the record back: `path` answers `before`
 * until the `write` was answered in this run, then `after` (so `prepare` sees the record as it
 * was, and the read-back sees the change). The run starts with the case's `setup`.
 */
function changedByWrite(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  write: { readonly method: "PUT" | "DELETE"; readonly path: string; readonly objects: unknown },
  others: readonly FakeRoute[],
): FakeRoute[] {
  const key = `${write.method} ${write.path}`;
  return [
    {
      path,
      response: {
        get body() {
          return { objects: [written.has(key) ? after : before] };
        },
      },
    },
    ...others,
    {
      method: write.method,
      path: write.path,
      response: {
        get body() {
          written.add(key);
          return { objects: write.objects };
        },
      },
    },
  ];
}

/** Known-good cases of the M4 banking write tools (owned by the agent that ships the tools). */
export const BANKING_CASES: readonly WriteToolCase[] = [
  {
    label: "book a bank transaction to an invoice",
    tool: transactionBookTool,
    args: { id: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
    routes: [
      transactionRoute(freeTransaction),
      accountRoute(accountRow(4002)),
      logRoute(5101, []),
      invoiceRoute(invoiceRow()),
      { method: "PUT", path: "/Invoice/1001/bookAmount", response: { body: { objects: {} } } },
    ],
    writes: [{ method: "PUT", path: "/Invoice/1001/bookAmount" }],
  },
  {
    label: "mark a bank transaction as private",
    tool: transactionMarkPrivateTool,
    args: { id: 5101 },
    routes: [
      transactionRoute(transactionRow({ amount: "-45.99" })),
      accountRoute(accountRow(4002)),
      {
        method: "PUT",
        path: "/CheckAccountTransaction/5101",
        response: { body: { objects: privateTransaction } },
      },
    ],
    writes: [{ method: "PUT", path: "/CheckAccountTransaction/5101" }],
  },
  {
    label: "undo the booking of a bank transaction",
    tool: transactionResetTool,
    args: { id: 5101 },
    routes: [
      transactionRoute(bookedTransaction),
      accountRoute(accountRow(4002)),
      logRoute(5101, [logEntry(7001, 5101, "Invoice", 1001, 177.33)]),
      invoiceRoute(invoiceRow({ status: "1000", paidAmount: 177.33 })),
      { method: "PUT", path: "/Invoice/1001/resetToOpen", response: { body: { objects: null } } },
    ],
    writes: [{ method: "PUT", path: "/Invoice/1001/resetToOpen" }],
  },
  {
    label: "enter a bank transaction by hand and book it to an invoice",
    tool: transactionCreateTool,
    args: {
      checkAccountId: 4004,
      date: "2026-11-09",
      amount: "177.33",
      direction: "in",
      counterparty: "Musterfirma GmbH",
      purpose: "RE-1001",
      allocations: [{ kind: "invoice", id: 1001 }],
    },
    routes: [
      accountRoute(importAccount),
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", [], { "checkAccount[id]": 4004 }),
      invoiceRoute(invoiceRow()),
      {
        method: "POST",
        path: "/CheckAccountTransaction",
        response: { body: { objects: handMade } },
      },
      { method: "PUT", path: "/Invoice/1001/bookAmount", response: { body: { objects: {} } } },
      transactionRoute(handMade),
      logRoute(5401, []),
    ],
    writes: [
      { method: "POST", path: "/CheckAccountTransaction" },
      { method: "PUT", path: "/Invoice/1001/bookAmount" },
    ],
  },
  {
    label: "delete an unbooked bank transaction",
    tool: transactionDeleteTool,
    args: { id: 5401 },
    // The tool confirms the soft delete by deletedAt on the read-back (D-096).
    routes: changedByWrite(
      "/CheckAccountTransaction/5401",
      handMade,
      { ...handMade, deletedAt: "2026-11-09T12:30:00+01:00" },
      { method: "DELETE", path: "/CheckAccountTransaction/5401", objects: [null] },
      [accountRoute(importAccount)],
    ),
    setup: resetWrites,
    writes: [{ method: "DELETE", path: "/CheckAccountTransaction/5401" }],
  },
  {
    label: "enshrine a booked bank transaction",
    tool: transactionEnshrineTool,
    args: { id: 5101 },
    // The tool confirms the lock by enshrined on the read-back (D-098).
    routes: changedByWrite(
      "/CheckAccountTransaction/5101",
      bookedTransaction,
      { ...bookedTransaction, enshrined: "2026-11-09T12:30:00+01:00" },
      { method: "PUT", path: "/CheckAccountTransaction/5101/enshrine", objects: null },
      [
        accountRoute(accountRow(4002)),
        logRoute(5101, [logEntry(7001, 5101, "Invoice", 1001, 177.33)]),
      ],
    ),
    setup: resetWrites,
    writes: [{ method: "PUT", path: "/CheckAccountTransaction/5101/enshrine" }],
  },
  {
    label: "create a file-import account",
    tool: bankAccountCreateTool,
    args: { kind: "file_import", name: "Kasse Import" },
    routes: [
      { path: "/CheckAccount", response: { fixture: "banking/check-accounts.json" } },
      {
        method: "POST",
        path: "/CheckAccount/Factory/fileImportAccount",
        response: { fixture: "banking/file-import-account-create-4102.json" },
      },
    ],
    writes: [{ method: "POST", path: "/CheckAccount/Factory/fileImportAccount" }],
  },
];
