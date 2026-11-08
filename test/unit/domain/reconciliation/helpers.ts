/**
 * Test helpers for the bank reconciliation: rows built from the fixtures with overrides (same keys
 * and scalar types as the recordings), and routes for them. Invoice, credit note, account and
 * transaction rows come from the lifecycle helpers; vouchers and booking log entries are added
 * here.
 */
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { loadFixture } from "../../../helpers/fake-client.js";
import {
  accountRoute,
  accountRow,
  creditNoteRow,
  documentRoute,
  invoiceRow,
  type Row,
  StagedClient,
  transactionRoute,
  transactionRow,
} from "../../tools/lifecycle/helpers.js";

export {
  accountRoute,
  accountRow,
  creditNoteRow,
  invoiceRow,
  type Row,
  StagedClient,
  transactionRoute,
  transactionRow,
};

function rowsOf(path: string): Row[] {
  const objects = (loadFixture(path).body as { objects: unknown }).objects;
  return structuredClone(Array.isArray(objects) ? objects : [objects]) as Row[];
}

/**
 * Voucher 2001 (community: sevDesk.NET recording, fake values): Belegnummer RE-2026-0042, open
 * (100), expense (C), EUR, gross 298.10, paidAmount 0, supplier contact 1003 "Beispiel Lieferant
 * AG", enshrined. Overrides replace keys.
 */
export function voucherRow(overrides: Row = {}): Row {
  return { ...rowsOf("vouchers/voucher-2001.json")[0], ...overrides };
}

/** `GET /Voucher/{id}` answering with `row`. */
export function voucherRoute(row: Row): FakeRoute {
  return { path: `/Voucher/${String(row["id"])}`, response: { body: { objects: [row] } } };
}

/**
 * A booking log entry (keys of sevdesk-rs's recorded entry, see the fixture's provenance): entry
 * 7001, transaction 5201, invoice 1001, amountPaid 119, 100 → 200, booked 2026-11-02.
 */
export function logRow(overrides: Row = {}): Row {
  return { ...rowsOf("banking/transaction-log-split.json")[0], ...overrides };
}

/** An entry of `transactionId` booking `amountPaid` on `objectName` `documentId`. */
export function logEntry(
  id: number,
  transactionId: number,
  objectName: string,
  documentId: number,
  amountPaid: number | string | null,
  overrides: Row = {},
): Row {
  return logRow({
    id: String(id),
    checkAccountTransaction: { id: String(transactionId), objectName: "CheckAccountTransaction" },
    object: { id: String(documentId), objectName },
    amountPaid,
    ...overrides,
  });
}

/** `GET /CheckAccountTransactionLog` filtered by `transactionId`, answering with `rows`. */
export function logRoute(transactionId: number, rows: readonly Row[]): FakeRoute {
  return {
    path: "/CheckAccountTransactionLog",
    query: { "checkAccountTransaction[id]": transactionId },
    response: { body: { objects: rows } },
  };
}

/** `GET /CheckAccount` (all accounts of the fixture), for the transaction lists. */
export function accountsListRoute(): FakeRoute {
  return { path: "/CheckAccount", response: { fixture: "banking/check-accounts.json" } };
}

/** A list route answering with `rows` as the whole collection (the fake pages it). */
export function listRoute(
  path: string,
  rows: readonly Row[],
  query?: FakeRoute["query"],
): FakeRoute {
  return {
    path,
    ...(query === undefined ? {} : { query }),
    response: { body: { objects: rows } },
  };
}

/** Invoice route shortcut. */
export function invoiceRoute(row: Row): FakeRoute {
  return documentRoute("invoice", row);
}

/** Credit note route shortcut. */
export function creditNoteRoute(row: Row): FakeRoute {
  return documentRoute("creditNote", row);
}
