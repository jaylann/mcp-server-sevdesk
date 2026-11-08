/**
 * Over-booking a bank transaction (Zuordnung): sevDesk does not stop a booking that assigns more
 * than a transaction holds, more than a document's open amount, money in the wrong direction or
 * in another currency (a positive amount on an expense is accepted and leaves a negative paid
 * amount, D-041; the transaction exposes no remaining amount, D-057). Each mistake misstates the
 * bank account and the receivable or payable, and undoing it resets the documents with all their
 * payments (D-060).
 *
 * Guard: `sevdesk_transaction_book` plans every allocation before the first write: the
 * allocations together at most the transaction's unassigned amount (from the booking log for a
 * partly linked transaction), each at most the document's open amount (`planPayment`), the
 * transaction's direction and currency, and differences (Skonto) only when one document takes the
 * whole transaction. Every refusal below happens in `prepare`; no `bookAmount` is ever sent.
 */
import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { transactionBookTool as tool } from "../../src/tools/banking/transaction-book.js";
import { type FakeRoute, FakeSevdeskClient } from "../helpers/fake-client.js";
import { executeWrite } from "../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  creditNoteRoute,
  creditNoteRow,
  invoiceRoute,
  invoiceRow,
  logEntry,
  logRoute,
  type Row,
  transactionRoute,
  transactionRow,
  voucherRoute,
  voucherRow,
} from "../unit/domain/reconciliation/helpers.js";

function invoice(id: number, gross: string): Row {
  return invoiceRow({
    id: String(id),
    invoiceNumber: `RE-${String(id)}`,
    sumGross: gross,
    sumNet: gross,
    sumTax: "0",
  });
}

/** Routes for every read, plus `bookAmount` routes that would answer if a write slipped through. */
function client(transaction: Row, documents: readonly FakeRoute[], log: readonly Row[] = []) {
  const accountId = Number((transaction["checkAccount"] as { id: string }).id);
  return new FakeSevdeskClient([
    transactionRoute(transaction),
    accountRoute(accountRow(accountId)),
    logRoute(Number(transaction["id"]), log),
    ...documents,
    { method: "PUT", path: "/Invoice/1001/bookAmount", response: { body: { objects: {} } } },
    { method: "PUT", path: "/Invoice/1002/bookAmount", response: { body: { objects: {} } } },
    { method: "PUT", path: "/CreditNote/2001/bookAmount", response: { body: { objects: {} } } },
    { method: "PUT", path: "/Voucher/2001/bookAmount", response: { body: { objects: {} } } },
  ]);
}

async function refused(fake: FakeSevdeskClient, args: Record<string, unknown>): Promise<string> {
  const error = await executeWrite(tool, args, fake).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(fake.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

describe("over-booking: refused before any write", () => {
  it("refuses a split that adds up to more than the transaction", async () => {
    const fake = client(transactionRow({ amount: "238" }), [
      invoiceRoute(invoice(1001, "119")),
      invoiceRoute(invoice(1002, "200")),
    ]);
    const message = await refused(fake, {
      transactionId: 5101,
      allocations: [
        { kind: "invoice", id: 1001, amount: "119" },
        { kind: "invoice", id: 1002, amount: "120" },
      ],
    });
    expect(message).toBe(
      "The allocations add up to 239.00 EUR or more, more than the 238.00 EUR still unassigned " +
        "on bank transaction 5101. Lower the amounts.",
    );
  });

  it("refuses more than the rest of a partly linked transaction (remaining from the log)", async () => {
    const fake = client(
      transactionRow({ amount: "238", status: "200" }),
      [invoiceRoute(invoice(1002, "200"))],
      [logEntry(7001, 5101, "Invoice", 1001, 119)],
    );
    const message = await refused(fake, {
      transactionId: 5101,
      allocations: [{ kind: "invoice", id: 1002, amount: "120" }],
    });
    expect(message).toContain("more than the 119.00 EUR still unassigned");
  });

  it("refuses an allocation above the document's open amount", async () => {
    const fake = client(transactionRow({ amount: "238" }), [invoiceRoute(invoice(1001, "119"))]);
    const message = await refused(fake, {
      transactionId: 5101,
      allocations: [{ kind: "invoice", id: 1001, amount: "119.01" }],
    });
    expect(message).toContain("is more than the open amount of 119.00 EUR of invoice 1001");
  });

  it("refuses the wrong direction (incoming money to a credit note or an expense voucher)", async () => {
    const creditNote = client(transactionRow({ amount: "23.8" }), [
      creditNoteRoute(creditNoteRow()),
    ]);
    expect(
      await refused(creditNote, {
        transactionId: 5101,
        allocations: [{ kind: "credit_note", id: 2001 }],
      }),
    ).toContain("Credit note 2001 needs outgoing money, but bank transaction 5101 is incoming");
    const voucher = client(transactionRow({ amount: "298.1" }), [voucherRoute(voucherRow())]);
    expect(
      await refused(voucher, { transactionId: 5101, allocations: [{ kind: "voucher", id: 2001 }] }),
    ).toContain("Voucher 2001 needs outgoing money");
    const invoiceOut = client(transactionRow({ amount: "-177.33" }), [invoiceRoute(invoiceRow())]);
    expect(
      await refused(invoiceOut, {
        transactionId: 5101,
        allocations: [{ kind: "invoice", id: 1001 }],
      }),
    ).toContain("Invoice 1001 needs incoming money");
  });

  it("refuses a document in another currency than the transaction", async () => {
    const fake = client(
      transactionRow({ checkAccount: { id: "4005", objectName: "CheckAccount" } }),
      [invoiceRoute(invoiceRow())],
    );
    expect(
      await refused(fake, { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] }),
    ).toBe(
      "Invoice 1001 is in EUR, bank transaction 5101 in USD; sevDesk books a transaction only to " +
        "documents in its own currency.",
    );
    const foreignInvoice = client(transactionRow(), [
      invoiceRoute(
        invoiceRow({
          currency: "USD",
          sumGrossForeignCurrency: "177.33",
          sumNetForeignCurrency: "177.33",
        }),
      ),
    ]);
    expect(
      await refused(foreignInvoice, {
        transactionId: 5101,
        allocations: [{ kind: "invoice", id: 1001 }],
      }),
    ).toContain("Invoice 1001 is in USD, bank transaction 5101 in EUR");
  });

  it("refuses a Skonto write-off on part of a transaction", async () => {
    const fake = client(transactionRow({ amount: "238" }), [
      invoiceRoute(invoice(1001, "125")),
      invoiceRoute(invoice(1002, "119")),
    ]);
    const message = await refused(fake, {
      transactionId: 5101,
      allocations: [
        { kind: "invoice", id: 1001, amount: "119", paymentType: "cash_discount" },
        { kind: "invoice", id: 1002 },
      ],
    });
    expect(message).toContain(
      "can only be booked when the payment takes the whole bank transaction",
    );
  });

  it("refuses a transaction that is already fully booked", async () => {
    const fake = client(
      transactionRow({ amount: "238", status: "400" }),
      [invoiceRoute(invoice(1001, "119"))],
      [logEntry(7001, 5101, "Invoice", 1003, 238)],
    );
    expect(
      await refused(fake, { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] }),
    ).toContain("is already fully booked");
  });
});
