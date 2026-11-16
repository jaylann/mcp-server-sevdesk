/**
 * Issue #88's acceptance: "a cash sale and a cash expense can be recorded and booked through the
 * server, and sevdesk_cash_position shows them". sevDesk takes no hand-made transaction on a cash
 * register (Kasse); a cash sale or expense is a payment booked on its voucher against the register
 * without a transaction, and sevDesk creates the register row itself (recorded 2026-11-16, probe
 * `write-cash-register-transaction`, spec/deviations.md D-095). That path is the existing
 * `sevdesk_voucher_book_payment`; `sevdesk_transaction_create` refuses the register.
 *
 * The fake below keeps the register like the recording: an opening balance of 500, a booking
 * without a transaction adds a row with the signed amount at status 400 and pays the voucher, and
 * `getBalanceAtDate` sums the rows (500 → 511.9 after +23.80 and −11.90).
 */
import { describe, expect, it, vi } from "vitest";

import { bookingTimestamp } from "../../../../src/domain/lifecycle/payments.js";
import type { SevdeskRequest } from "../../../../src/sevdesk/types.js";
import { transactionCreateTool } from "../../../../src/tools/banking/transaction-create.js";
import { bookPaymentTool } from "../../../../src/tools/lifecycle/book-payment.js";
import { resetTool } from "../../../../src/tools/lifecycle/reset.js";
import { cashPositionTool } from "../../../../src/tools/reports/cash-position.js";
import { FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  listRoute,
  type Row,
  voucherRow,
} from "../../domain/reconciliation/helpers.js";

const REGISTER = 4003;
const DAY = "2026-11-16";
const OPENING = 50_000;

/** A sevDesk account whose cash register books payments like the recorded one. */
function cashBook() {
  const vouchers = new Map<number, Row>([
    [
      2101,
      voucherRow({
        id: "2101",
        creditDebit: "D",
        sumGross: "23.8",
        sumNet: "20",
        sumTax: "3.8",
        enshrined: null,
      }),
    ],
    [
      2102,
      voucherRow({
        id: "2102",
        creditDebit: "C",
        sumGross: "11.9",
        sumNet: "10",
        sumTax: "1.9",
        enshrined: null,
      }),
    ],
  ]);
  const rows: Row[] = [];
  const balances = new Map<number, number>([
    [4001, 0],
    [4002, 0],
    [4003, OPENING],
    [4005, 0],
  ]);
  const fake = new FakeSevdeskClient([
    accountsListRoute(),
    accountRoute(accountRow(REGISTER)),
    listRoute("/CheckAccountTransaction", []),
    ...[2101, 2102].map((id) => ({
      method: "PUT" as const,
      path: `/Voucher/${String(id)}/bookAmount`,
      response: { body: { objects: {} } },
    })),
  ]);
  const passOn = fake.request.bind(fake);
  vi.spyOn(fake, "request").mockImplementation(async (request: SevdeskRequest) => {
    const id = Number(/\/(\d+)(?:\/|$)/.exec(request.path)?.[1]);
    if (request.method === "GET" && /^\/Voucher\/\d+$/.test(request.path)) {
      return [vouchers.get(id)];
    }
    if (request.method === "PUT" && /^\/Voucher\/\d+\/bookAmount$/.test(request.path)) {
      // Recorded by the fake (writes()), then applied to the register.
      const answer = await passOn(request);
      const body = request.body as {
        amount: number;
        checkAccount: { id: number };
        checkAccountTransaction?: unknown;
      };
      // Without a transaction sevDesk creates the register row itself (status 400, D-095).
      expect(body.checkAccountTransaction).toBeUndefined();
      rows.push({ id: String(5500 + rows.length), amount: String(body.amount), status: "400" });
      const cents = Math.round(body.amount * 100);
      balances.set(body.checkAccount.id, (balances.get(body.checkAccount.id) ?? 0) + cents);
      const voucher = vouchers.get(id) ?? {};
      voucher["status"] = "1000";
      voucher["paidAmount"] = Math.abs(body.amount);
      return answer;
    }
    if (request.method === "GET" && request.path.endsWith("/getBalanceAtDate")) {
      return ((balances.get(id) ?? 0) / 100).toFixed(2);
    }
    return passOn(request);
  });
  return { fake, rows, vouchers };
}

describe("a cash sale and a cash expense on the cash register (D-095)", () => {
  it("are booked with sevdesk_voucher_book_payment and shown by sevdesk_cash_position", async () => {
    const { fake, rows, vouchers } = cashBook();
    const pay = bookPaymentTool("voucher");

    const sale = await executeWrite(
      pay,
      { id: 2101, amount: "23.80", date: DAY, checkAccountId: REGISTER },
      fake,
    );
    expect(sale.plan.preview.warnings).toContain(
      "sevDesk records this payment as a new entry in the cash book (Kassenbuch) of cash " +
        "register 4003, and the register's balance changes by it. Undoing the payment later " +
        "does not remove that entry: sevDesk books a counter-entry dated the day of the undo.",
    );
    const expense = await executeWrite(
      pay,
      { id: 2102, amount: "11.90", date: DAY, checkAccountId: REGISTER },
      fake,
    );
    expect(sale.output.data.voucher).toMatchObject({ status: { code: 1000 } });
    expect(expense.output.data.voucher).toMatchObject({ status: { code: 1000 } });

    // The recorded bodies: signed by the voucher's direction, noon Berlin, no transaction.
    const bookings = fake.writes().map((call) => call.body);
    expect(bookings).toEqual([
      {
        amount: 23.8,
        date: bookingTimestamp(DAY),
        type: "FULL_PAYMENT",
        checkAccount: { id: REGISTER, objectName: "CheckAccount" },
      },
      {
        amount: -11.9,
        date: bookingTimestamp(DAY),
        type: "FULL_PAYMENT",
        checkAccount: { id: REGISTER, objectName: "CheckAccount" },
      },
    ]);
    expect(rows.map((row) => row["amount"])).toEqual(["23.8", "-11.9"]);
    expect(vouchers.get(2101)?.["status"]).toBe("1000");

    const position = await cashPositionTool.handler(
      cashPositionTool.input.parse({ asOf: DAY }),
      testContext(fake),
    );
    const register = position.data.accounts.find((account) => account.id === REGISTER);
    expect(register).toMatchObject({
      type: "cash",
      balance: { amount: "511.90", currency: "EUR" },
    });
    expect(position.data.balances).toContainEqual(
      expect.objectContaining({ currency: "EUR", balance: { amount: "511.90", currency: "EUR" } }),
    );
  });

  it("says before an undo that sevDesk books a counter-entry on the register", async () => {
    const paid = voucherRow({ status: "1000", paidAmount: 23.8, enshrined: null });
    const plan = await prepareWrite(
      resetTool("voucher"),
      { id: 2001, to: "open" },
      new FakeSevdeskClient([{ path: "/Voucher/2001", response: { body: { objects: [paid] } } }]),
    );
    expect(plan.preview.warnings[0]).toContain(
      "On a cash register (Kasse) such a transaction stays: sevDesk books a counter-entry with " +
        "the opposite amount, dated the day of the reset (recorded).",
    );
  });

  it("are not entered as hand-made transactions: the register is refused first", async () => {
    const { fake } = cashBook();
    const error = await prepareWrite(
      transactionCreateTool,
      {
        checkAccountId: REGISTER,
        date: DAY,
        amount: "23.80",
        direction: "in",
        counterparty: "Barverkauf",
      },
      fake,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: "validation",
      message: expect.stringContaining(
        "Record a cash sale or cash expense by booking the payment on its document against " +
          "this register without transactionId",
      ) as unknown,
    });
    expect(fake.writes()).toEqual([]);
  });
});
