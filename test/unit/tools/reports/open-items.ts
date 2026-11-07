/**
 * Open receivables and payables shared by the aging and cash-position tests (fake data on the
 * recorded row shapes). Reference day 2026-11-07; tests pin the system date to it.
 */
import { afterEach, beforeEach, vi } from "vitest";

import type { FakeRoute } from "../../../helpers/fake-client.js";
import { embeddedContact, invoice, rows, voucher } from "./records.js";

export const AS_OF = "2026-11-07";

/** Pins "today" (Berlin) to {@link AS_OF} for the tests of the calling file. */
export function pinToday(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

const usd = {
  currency: "USD",
  sumNet: "92.59",
  sumTax: "0",
  sumGross: "92.59",
  sumNetForeignCurrency: "100",
  sumTaxForeignCurrency: "0",
  sumGrossForeignCurrency: "100",
  contact: { id: "1003", objectName: "Contact" },
};

/** `GET /Invoice?status=200`: open invoices (and rows the re-check must drop). */
const openInvoices = [
  // Due 2026-10-15: 23 days overdue; nothing paid: exact.
  invoice({
    id: "11",
    status: "200",
    invoiceDate: "2026-10-01T00:00:00+02:00",
    timeToPay: "14",
    paidAmount: "0",
  }),
  // USD, no payment term: no due date; paid unknown, status open: approximate.
  invoice({
    id: "13",
    status: "200",
    invoiceDate: "2026-11-05T00:00:00+01:00",
    timeToPay: null,
    ...usd,
  }),
  // Cancellation invoice: not a receivable.
  invoice({
    id: "15",
    status: "200",
    invoiceType: "SR",
    sumGross: "-46.65",
    sumNet: "-39.2",
    sumTax: "-7.45",
  }),
  // Fully paid but still listed as open: nothing outstanding.
  invoice({
    id: "16",
    status: "200",
    sumGross: "119",
    sumNet: "100",
    sumTax: "19",
    paidAmount: "119",
  }),
  // Paid invoice that sevDesk should not have sent for status=200.
  invoice({ id: "17", status: "1000" }),
  // Due today: not yet overdue.
  invoice({
    id: "18",
    status: "200",
    invoiceDate: "2026-11-07T00:00:00+01:00",
    timeToPay: "0",
    sumNet: "0.1",
    sumTax: "0",
    sumGross: "0.1",
    paidAmount: "0",
    contact: embeddedContact("1002", "Beispiel GmbH"),
  }),
  // Due exactly 30 days ago.
  invoice({
    id: "19",
    status: "200",
    invoiceDate: "2026-10-08T00:00:00+02:00",
    timeToPay: "0",
    sumNet: "0.2",
    sumTax: "0",
    sumGross: "0.2",
    paidAmount: "0",
    contact: embeddedContact("1002", "Beispiel GmbH"),
  }),
  // Recurring template (Abo-Rechnung) and reminder (Mahnung): not receivables of their own.
  invoice({ id: "30", status: "200", invoiceType: "WKR" }),
  invoice({ id: "31", status: "200", invoiceType: "MA" }),
  // Final invoice whose advances exceed its total: 100.00 owed to the customer.
  invoice({
    id: "32",
    status: "200",
    invoiceType: "ER",
    sumNet: "-84.03",
    sumTax: "-15.97",
    sumGross: "-100",
    paidAmount: "0",
  }),
];

/** `GET /Invoice?status=750`: partially paid invoices. */
const partiallyPaidInvoices = [
  // Due 2026-10-01 (37 days): 238 − 50 = 188.00.
  invoice({
    id: "12",
    status: "750",
    invoiceDate: "2026-09-01T00:00:00+02:00",
    timeToPay: "30",
    sumNet: "200",
    sumTax: "38",
    sumGross: "238",
    paidAmount: "50",
  }),
  // USD, partially paid: paid amount not usable → unknown; due 2026-07-31 (99 days).
  invoice({
    id: "14",
    status: "750",
    invoiceDate: "2026-07-01T00:00:00+02:00",
    timeToPay: "30",
    ...usd,
    sumGrossForeignCurrency: "50",
    sumNetForeignCurrency: "50",
  }),
];

export const invoiceRoutes: FakeRoute[] = [
  rows("/Invoice", openInvoices, { status: 200 }),
  rows("/Invoice", partiallyPaidInvoices, { status: 750 }),
];

/** `GET /Voucher?status=100&creditDebit=C`. */
const openVouchers = [
  // Deadline 2026-10-26: 12 days overdue; exact 298.10.
  voucher({
    id: "21",
    status: "100",
    paymentDeadline: "2026-10-26T00:00:00+01:00",
    paidAmount: "0",
  }),
  // USD with EUR base values: paid amount not used; open → approximate 378.
  voucher({
    id: "24",
    status: "100",
    currency: "USD",
    sumNet: "324.59",
    sumTax: "0",
    sumGross: "324.59",
    sumNetForeignCurrency: "378",
    sumTaxForeignCurrency: "0",
    sumGrossForeignCurrency: "378",
    paidAmount: "0",
    supplier: null,
    supplierName: "Example Cloud Inc.",
    paymentDeadline: "2026-11-20T00:00:00+01:00",
  }),
  // Revenue voucher sevDesk should not have sent for creditDebit=C.
  voucher({ id: "25", status: "100", creditDebit: "D" }),
  // Fully paid but still open.
  voucher({
    id: "26",
    status: "100",
    sumNet: "10",
    sumTax: "1.9",
    sumGross: "11.9",
    paidAmount: "11.9",
  }),
  // Recurring template sevDesk sent although voucherType=VOU was asked for.
  voucher({ id: "27", status: "100", voucherType: "RV" }),
  // Supplier credit: 50.00 owed back by the supplier.
  voucher({
    id: "28",
    status: "100",
    sumNet: "-42.02",
    sumTax: "-7.98",
    sumGross: "-50",
    paidAmount: "0",
  }),
];

/** `GET /Voucher?status=750&creditDebit=C`. */
const partiallyPaidVouchers = [
  // No deadline: 119 − 50 = 69.00.
  voucher({
    id: "22",
    status: "750",
    sumNet: "100",
    sumTax: "19",
    sumGross: "119",
    paidAmount: "50",
    paymentDeadline: null,
  }),
  // Payment booked with the wrong sign: unknown; deadline 2026-08-01 (98 days).
  voucher({
    id: "23",
    status: "750",
    sumNet: "100",
    sumTax: "19",
    sumGross: "119",
    paidAmount: "-119",
    paymentDeadline: "2026-08-01T00:00:00+02:00",
  }),
];

export const voucherRoutes: FakeRoute[] = [
  rows("/Voucher", openVouchers, { status: 100, creditDebit: "C" }),
  rows("/Voucher", partiallyPaidVouchers, { status: 750, creditDebit: "C" }),
];
