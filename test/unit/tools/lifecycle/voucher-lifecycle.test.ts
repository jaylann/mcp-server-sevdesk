/**
 * The lifecycle factories for vouchers (Belege): book payment, reset, enshrine. Vouchers use their
 * own status codes (draft 50, open 100) and take their payment direction from `creditDebit`
 * (D-041: expense money out, negative amount).
 */
import { describe, expect, it } from "vitest";

import { bookingTimestamp } from "../../../../src/domain/lifecycle/payments.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { bookPaymentTool } from "../../../../src/tools/lifecycle/book-payment.js";
import { enshrineTool } from "../../../../src/tools/lifecycle/enshrine.js";
import { resetTool } from "../../../../src/tools/lifecycle/reset.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { openVoucherRow, type Row, voucherRoute, writeRoute } from "../vouchers/routes.js";
import {
  accountRoute,
  accountRow,
  StagedClient,
  transactionLogRoute,
  transactionRoute,
  transactionRow,
} from "./helpers.js";

const book = bookPaymentTool("voucher");
const reset = resetTool("voucher");
const enshrine = enshrineTool("voucher");

/** Open expense voucher 2001 (RE-2026-0042, gross 298.10), not enshrined. */
function open(overrides: Row = {}): Row {
  return openVoucherRow({ enshrined: null, ...overrides });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  return (error as SevdeskError).message;
}

const outgoing = transactionRow({ amount: "-298.1", paymtPurpose: "RE-2026-0042" });

function bookClient(row: Row, extra: readonly FakeRoute[] = []): StagedClient {
  return new StagedClient(
    [
      voucherRoute(row),
      accountRoute(accountRow(4002)),
      accountRoute(accountRow(4001)),
      transactionRoute(outgoing),
      ...extra,
      transactionLogRoute(),
    ],
    [
      writeRoute("PUT", "/Voucher/2001/bookAmount", "voucher-book-amount.json"),
      voucherRoute({ ...row, status: "1000", paidAmount: "298.1" }),
    ],
  );
}

describe("sevdesk_voucher_book_payment", () => {
  it("lives in the vouchers toolset as a commit tool", () => {
    expect(book.name).toBe("sevdesk_voucher_book_payment");
    expect(book.toolset).toBe("vouchers");
    expect(book.tier).toBe("commit");
    expect(book.title).toBe("Book a payment on a sevDesk voucher");
    expect(book.description.length).toBeLessThanOrEqual(1000);
    expect(book.input.shape.id.description).toBe(
      "Voucher id (not the Belegnummer), e.g. from sevdesk_vouchers_list.",
    );
  });

  it("pays an expense voucher with a negative amount, linked to an outgoing transaction (D-041)", async () => {
    const fake = bookClient(open());
    const { plan, output } = await executeWrite(
      book,
      { id: 2001, amount: "298.10", date: "2026-11-02", checkAccountId: 4002, transactionId: 5101 },
      fake,
    );
    const writes = fake.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "PUT",
      path: "/Voucher/2001/bookAmount",
      tier: "commit",
    });
    expect(writes[0]?.body).toEqual({
      amount: -298.1,
      date: bookingTimestamp("2026-11-02"),
      type: "FULL_PAYMENT",
      checkAccount: { id: 4002, objectName: "CheckAccount" },
      checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
    });
    expect(plan.preview.action).toBe(
      "Book a payout of 298.10 EUR on voucher 2001 (full payment (FULL_PAYMENT)) via " +
        "check account Geschäftskonto Musterbank, linked to bank transaction 5101.",
    );
    expect(plan.preview.facts).toContainEqual({ label: "Kind", value: "expense (Ausgabe)" });
    expect(plan.preview.facts).toContainEqual({
      label: "Supplier (Lieferant)",
      value: "Beispiel Lieferant AG (contact 1003)",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Sent to sevDesk as",
      value: "amount -298.1 (money leaving the account)",
    });
    expect(output.data).toMatchObject({
      voucher: { id: 2001, status: { code: 1000 } },
      payment: { paymentType: "payment", amount: { amount: "298.10", currency: "EUR" } },
    });
    expect(output.affected).toEqual([
      { objectName: "Voucher", id: "2001" },
      { objectName: "CheckAccountTransaction", id: "5101" },
    ]);
  });

  it("pays a revenue voucher with a positive amount and refuses an outgoing transaction", async () => {
    const revenue = open({ creditDebit: "D" });
    const plan = await prepareWrite(
      book,
      { id: 2001, amount: "100", date: "2026-11-02", checkAccountId: 4001 },
      bookClient(revenue),
    );
    expect(plan.state.payload.amount).toBe(100);
    expect(plan.preview.facts).toContainEqual({
      label: "Customer (Kunde)",
      value: "Beispiel Lieferant AG (contact 1003)",
    });
    expect(plan.preview.warnings).toContain(
      "This is a partial payment: 198.10 EUR stays open and the voucher becomes partially paid (750).",
    );
    const message = await refusal(
      prepareWrite(
        book,
        { id: 2001, amount: "298.10", checkAccountId: 4002, transactionId: 5101 },
        bookClient(revenue),
      ),
    );
    expect(message).toBe(
      "Bank transaction 5101 is not an incoming payment, which a payment of voucher 2001 needs.",
    );
  });

  it("offers no reminder charges on vouchers", () => {
    expect(() =>
      book.input.parse({
        id: 2001,
        amount: "1",
        checkAccountId: 4001,
        paymentType: "reminder_charges",
      }),
    ).toThrow();
  });

  it.each([
    [
      "a draft",
      { status: "50" },
      "Voucher 2001 is a draft; sevDesk books payments only on finalized documents. Finalize it " +
        "first with sevdesk_voucher_finalize.",
    ],
    [
      "a paid voucher",
      { status: "1000", paidAmount: "298.1" },
      "Voucher 2001 is already paid (status 1000, Paid). To undo its payments, reset it to open " +
        "with sevdesk_voucher_reset.",
    ],
    [
      "a transferred voucher (150)",
      { status: "150" },
      "Voucher 2001 has status 150, Transferred; payments can only be booked on open or " +
        "partially paid vouchers.",
    ],
    [
      "a voucher without creditDebit",
      { creditDebit: null },
      "Voucher 2001 does not say whether it is an expense or revenue (creditDebit), so the sign " +
        "of the payment is unknown. Check it in sevDesk.",
    ],
  ])("refuses %s", async (_label, overrides, expected) => {
    const message = await refusal(
      prepareWrite(
        book,
        { id: 2001, amount: "1", checkAccountId: 4001 },
        bookClient(open(overrides)),
      ),
    );
    expect(message).toBe(expected);
  });

  it("refuses a negative paid amount (the trace of a wrongly signed booking)", async () => {
    const message = await refusal(
      prepareWrite(
        book,
        { id: 2001, amount: "1", checkAccountId: 4001 },
        bookClient(open({ status: "750", paidAmount: "-10" })),
      ),
    );
    expect(message).toContain("shows a negative paid amount");
  });
});

describe("sevdesk_voucher_reset", () => {
  it("resets a paid voucher to open (resetToOpen) with the voucher codes", async () => {
    const paid = open({ status: "1000", paidAmount: "298.1" });
    const fake = new StagedClient(
      [voucherRoute(paid)],
      [writeRoute("PUT", "/Voucher/2001/resetToOpen", "voucher-reset.json"), voucherRoute(open())],
    );
    const { plan, output } = await executeWrite(reset, { id: 2001, to: "open" }, fake);
    expect(fake.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["PUT", "/Voucher/2001/resetToOpen", "commit"],
    ]);
    expect(plan.preview.action).toBe(
      "Reset voucher 2001 to open (Paid → open 100) and unlink all its payments.",
    );
    expect(output.summary).toBe("Voucher 2001 reset to open: status Unpaid / due (100).");
  });

  it("resets an open voucher without payments to draft (resetToDraft)", async () => {
    const fake = new StagedClient(
      [voucherRoute(open())],
      [
        writeRoute("PUT", "/Voucher/2001/resetToDraft", "voucher-reset.json"),
        voucherRoute(open({ status: "50" })),
      ],
    );
    const { plan } = await executeWrite(reset, { id: 2001, to: "draft" }, fake);
    expect(plan.preview.action).toBe("Reset voucher 2001 to draft (open 100 → draft 50).");
    expect(plan.preview.warnings).toEqual([
      "The voucher stops being booked and can be changed again (sevdesk_voucher_update_draft); " +
        "it has to be finalized again afterwards (sevdesk_voucher_finalize).",
    ]);
  });

  it("refuses a draft and an enshrined voucher to draft", async () => {
    const draft = new FakeSevdeskClient([voucherRoute(open({ status: "50" }))]);
    expect(await refusal(prepareWrite(reset, { id: 2001, to: "draft" }, draft))).toBe(
      "Voucher 2001 is already a draft; there is nothing to reset.",
    );
    expect(await refusal(prepareWrite(reset, { id: 2001, to: "open" }, draft))).toBe(
      "Voucher 2001 is a draft; a reset cannot raise the status. Open it by finalizing it with " +
        "sevdesk_voucher_finalize.",
    );
    const enshrined = new FakeSevdeskClient([voucherRoute(openVoucherRow())]);
    expect(await refusal(prepareWrite(reset, { id: 2001, to: "draft" }, enshrined))).toContain(
      "is enshrined (festgeschrieben); sevDesk never resets an enshrined document to draft.",
    );
  });
});

describe("sevdesk_voucher_enshrine", () => {
  it("enshrines an open voucher, irreversibly", async () => {
    const fake = new StagedClient(
      [voucherRoute(open())],
      [
        writeRoute("PUT", "/Voucher/2001/enshrine", "voucher-delete.json"),
        voucherRoute(openVoucherRow()),
      ],
    );
    const { plan, output } = await executeWrite(enshrine, { id: 2001 }, fake);
    expect(fake.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["PUT", "/Voucher/2001/enshrine", "commit"],
    ]);
    expect(plan.preview.irreversible).toBe(true);
    expect(output.data).toMatchObject({ voucher: { id: 2001, enshrined: true } });
  });

  it("refuses a draft voucher and an enshrined one", async () => {
    const draft = new FakeSevdeskClient([voucherRoute(open({ status: "50" }))]);
    expect(await refusal(prepareWrite(enshrine, { id: 2001 }, draft))).toBe(
      "Voucher 2001 is a draft; sevDesk enshrines documents only from status open (100) on. " +
        "Finalize it first with sevdesk_voucher_finalize.",
    );
    const done = new FakeSevdeskClient([voucherRoute(openVoucherRow())]);
    expect(await refusal(prepareWrite(enshrine, { id: 2001 }, done))).toBe(
      "Voucher 2001 is already enshrined (festgeschrieben); there is nothing to do.",
    );
  });
});
