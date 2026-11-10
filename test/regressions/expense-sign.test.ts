/**
 * Sign conventions for expenses, revenue and bank transactions.
 *
 * The real-world trap: sevDesk's `PUT /Voucher/{id}/bookAmount` takes the amount **as it flows
 * over the check account**, so a payment for an expense voucher (creditDebit `C`) must be
 * negative. A positive amount is accepted without any error, stored as a negative `paidAmount`,
 * and the voucher silently stays "partially paid" (status 750) with no pay date: the books look
 * fine at a glance and are wrong (genz-its/sevdesk, verified against a live account; see also
 * spec/deviations.md sources). Other sevDesk integrations also read `creditDebit` backwards and
 * filed receipts as revenue.
 *
 * Pinned here:
 * - voucher `creditDebit`: C = credit = expense (Ausgabe), D = debit = revenue (Einnahme), both
 *   when reading and when filtering (spec tag `Voucher`, attribute table);
 * - voucher sums are positive for both kinds; the kind carries the direction;
 * - payments: expense → out → negative booking amount, revenue → in → positive;
 * - bank transaction amounts: negative = outgoing, positive = incoming, exact and signed;
 * - a negative `paidAmount` (the trace the trap leaves) is flagged on read.
 */
import { describe, expect, it } from "vitest";

import { directionOf, listTransactions } from "../../src/domain/banking.js";
import {
  bookingAmountSign,
  creditDebitForKind,
  getVoucherDetails,
  listVouchers,
  voucherKindFromCreditDebit,
} from "../../src/domain/vouchers.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";

const PAGE = { limit: 100, offset: 0 };

function voucherClient(objects: readonly Record<string, unknown>[]) {
  return new FakeSevdeskClient([
    { path: "/Voucher", response: { body: { objects: [...objects] } } },
    ...objects.map((object) => ({
      path: `/Voucher/${String(object["id"])}`,
      response: { body: { objects: [object] } },
    })),
    { path: "/VoucherPos", response: { body: { objects: [] } } },
  ]);
}

describe("expense and revenue signs", () => {
  it("reads creditDebit C as expense and D as revenue", async () => {
    expect(voucherKindFromCreditDebit("C")).toBe("expense");
    expect(voucherKindFromCreditDebit("D")).toBe("revenue");
    const client = voucherClient([
      { id: "1", creditDebit: "C", sumGross: "119" },
      { id: "2", creditDebit: "D", sumGross: "119" },
    ]);
    const { items } = await listVouchers(client, PAGE);
    expect(items.map((item) => [item.id, item.kind, item.totals.gross?.amount])).toEqual([
      [1, "expense", "119.00"],
      [2, "revenue", "119.00"],
    ]);
  });

  it("filters expenses with creditDebit=C and revenue with creditDebit=D", async () => {
    expect(creditDebitForKind("expense")).toBe("C");
    expect(creditDebitForKind("revenue")).toBe("D");
    const client = voucherClient([]);
    await listVouchers(client, { ...PAGE, kind: "expense" });
    await listVouchers(client, { ...PAGE, kind: "revenue" });
    expect(client.callsTo("/Voucher").map((call) => call.query["creditDebit"])).toEqual(["C", "D"]);
  });

  it("books expense payments negative and revenue payments positive", async () => {
    expect(bookingAmountSign("expense")).toBe(-1);
    expect(bookingAmountSign("revenue")).toBe(1);
    const client = voucherClient([
      { id: "1", creditDebit: "C" },
      { id: "2", creditDebit: "D" },
    ]);
    expect((await getVoucherDetails(client, 1)).voucher.paymentDirection).toBe("out");
    expect((await getVoucherDetails(client, 2)).voucher.paymentDirection).toBe("in");
  });

  it("flags the trace of a positive booking on an expense: a negative paidAmount", async () => {
    const client = voucherClient([
      { id: "1", creditDebit: "C", status: "750", sumGross: "119", paidAmount: -119 },
      { id: "2", creditDebit: "C", status: "1000", sumGross: "119", paidAmount: 119 },
    ]);
    const { items } = await listVouchers(client, PAGE);
    expect(items[0]?.warnings).toEqual([expect.stringContaining("wrong sign")]);
    expect(items[1]?.warnings).toBeUndefined();
  });

  it("keeps bank transaction amounts signed: negative = out, positive = in", async () => {
    expect(directionOf("-298.10")).toBe("out");
    expect(directionOf("1190")).toBe("in");
    const client = new FakeSevdeskClient([
      { path: "/CheckAccount", response: { body: { objects: [] } } },
      {
        path: "/CheckAccountTransaction",
        response: {
          body: {
            objects: [
              { id: "1", amount: "-298.1", valueDate: "2026-01-05T00:00:00+01:00" },
              { id: "2", amount: 1190, valueDate: "2026-01-07T00:00:00+01:00" },
            ],
          },
        },
      },
    ]);
    const { items } = await listTransactions(client, PAGE);
    expect(items.map((item) => [item.amount.amount, item.direction])).toEqual([
      ["-298.10", "out"],
      ["1190.00", "in"],
    ]);
    const outgoing = await listTransactions(client, { ...PAGE, direction: "out" });
    expect(outgoing.items.map((item) => item.id)).toEqual([1]);
  });
});
