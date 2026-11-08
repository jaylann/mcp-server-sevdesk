import { transactionBookTool } from "../../src/tools/banking/transaction-book.js";
import { transactionMarkPrivateTool } from "../../src/tools/banking/transaction-private.js";
import { transactionResetTool } from "../../src/tools/banking/transaction-reset.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import {
  accountRoute,
  accountRow,
  invoiceRoute,
  invoiceRow,
  logEntry,
  logRoute,
  transactionRoute,
  transactionRow,
} from "../unit/domain/reconciliation/helpers.js";

const freeTransaction = transactionRow();
const bookedTransaction = transactionRow({ status: "400" });
const privateTransaction = transactionRow({ status: "300", amount: "-45.99" });

/** Known-good cases of the M4 banking write tools (owned by the agent that ships the tools). */
export const BANKING_CASES: readonly WriteToolCase[] = [
  {
    label: "book a bank transaction to an invoice",
    tool: transactionBookTool,
    args: { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
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
    args: { transactionId: 5101 },
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
    args: { transactionId: 5101 },
    routes: [
      transactionRoute(bookedTransaction),
      accountRoute(accountRow(4002)),
      logRoute(5101, [logEntry(7001, 5101, "Invoice", 1001, 177.33)]),
      invoiceRoute(invoiceRow({ status: "1000", paidAmount: 177.33 })),
      { method: "PUT", path: "/Invoice/1001/resetToOpen", response: { body: { objects: null } } },
    ],
    writes: [{ method: "PUT", path: "/Invoice/1001/resetToOpen" }],
  },
];
