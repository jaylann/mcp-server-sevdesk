/**
 * A payment that uses only part of a linked bank transaction must not go out as FULL_PAYMENT.
 *
 * Live finding (lead, trial account, 2026-11-08): `PUT /{Invoice|CreditNote|Voucher}/{id}/bookAmount`
 * with `type: "FULL_PAYMENT"` and a `checkAccountTransaction` larger than `amount` answers 422
 * "Payment difference amount must be 0.0 when using type 'NONE'". Type `N` with the same amount
 * works: the document becomes paid (1000) when the amount covers its open amount (750 otherwise)
 * and the transaction partly assigned (200), its rest assignable to other documents. Until the fix
 * the book-payment tools only warned and sent FULL_PAYMENT, so exactly this case failed live.
 *
 * Guard: `planPayment` gets the transaction's amount (`transactionAmount`) and
 * `transactionBookingType` sends N for a payment of part of it; Skonto, bank fees and other
 * differences on part of a transaction are refused (unverified). Tested through the real HTTP
 * client, so the JSON on the wire is what is checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { bookPaymentTool } from "../../src/tools/lifecycle/book-payment.js";
import { envelope, type FakeReply } from "../helpers/fake-fetch.js";
import { executeWrite } from "../helpers/write-tools.js";
import {
  accountRow,
  fixtureRow,
  invoiceRow,
  type Row,
  transactionRow,
} from "../unit/tools/lifecycle/helpers.js";
import { openVoucherRow } from "../unit/tools/vouchers/routes.js";
import { fixtureReply, wireClient } from "../unit/tools/vouchers/wire.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-08T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The reads `prepare` makes with a transaction: document, country table (sales documents), account, transaction, its account, its
 * booking log (empty).
 */
function reads(document: Row, transaction: Row): FakeReply[] {
  const account = accountRow(4002);
  return [
    envelope([document]),
    ...(document["addressCountry"] === undefined || document["addressCountry"] === null
      ? []
      : [fixtureReply("meta/static-countries.json")]),
    envelope([account]),
    envelope([transaction]),
    envelope([account]),
    envelope([]),
  ];
}

describe("payments on part of a bank transaction", () => {
  it("pays an invoice's open amount from a larger transaction with type N", async () => {
    const { client, fake } = wireClient([
      ...reads(invoiceRow(), transactionRow({ amount: "200" })),
      envelope(fixtureRow("invoice-book-amount.json")),
      envelope([invoiceRow({ status: "1000", paidAmount: 177.33 })]),
      fixtureReply("meta/static-countries.json"),
    ]);

    await executeWrite(
      bookPaymentTool("invoice"),
      { id: 1001, amount: "177.33", date: "2026-11-02", checkAccountId: 4002, transactionId: 5101 },
      client,
    );

    const write = fake.requests.find((request) => request.method === "PUT");
    expect(JSON.parse(String(write?.body))).toEqual({
      amount: 177.33,
      date: 1_793_617_200,
      type: "N",
      checkAccount: { id: 4002, objectName: "CheckAccount" },
      checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
    });
  });

  it("pays an expense voucher from a larger outgoing transaction with type N and a negative amount", async () => {
    const voucher = openVoucherRow({ enshrined: null });
    const { client, fake } = wireClient([
      ...reads(voucher, transactionRow({ amount: "-300" })),
      fixtureReply("vouchers/voucher-book-amount.json"),
      envelope([{ ...voucher, status: "1000", paidAmount: "298.1" }]),
    ]);

    await executeWrite(
      bookPaymentTool("voucher"),
      { id: 2001, amount: "298.10", date: "2026-11-02", checkAccountId: 4002, transactionId: 5101 },
      client,
    );

    const write = fake.requests.find((request) => request.method === "PUT");
    expect(write?.url.pathname).toBe("/api/v1/Voucher/2001/bookAmount");
    expect(JSON.parse(String(write?.body))).toMatchObject({ amount: -298.1, type: "N" });
  });

  it("refuses a Skonto on part of a transaction before anything is sent", async () => {
    const { client, fake } = wireClient(reads(invoiceRow(), transactionRow({ amount: "200" })));
    const error = await executeWrite(
      bookPaymentTool("invoice"),
      {
        id: 1001,
        amount: "173.78",
        checkAccountId: 4002,
        transactionId: 5101,
        paymentType: "cash_discount",
      },
      client,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
  });
});
