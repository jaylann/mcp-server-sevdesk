/**
 * Two payments on the same invoice, sent at the same time, must not both pass the open-amount
 * guard. sevDesk books whatever it is sent (see over-booking.test.ts), so the guard in `planPayment`
 * is the only check, and it runs on what `prepare` read. Two calls that interleave (both read
 * "177.33 open", then both book 100.00) over-booked the invoice (security review 2026-11,
 * finding 3).
 *
 * Guard: the payment tools declare `locks` (the document and a linked transaction); the write
 * flow runs calls on the same records of one account one after the other, from `prepare` to the
 * end of `execute`, so the second call reads what the first one booked and is refused.
 */
import { describe, expect, it, vi } from "vitest";

import type { SevdeskRequest } from "../../src/sevdesk/types.js";
import { transactionBookTool } from "../../src/tools/banking/transaction-book.js";
import { transactionMarkPrivateTool } from "../../src/tools/banking/transaction-private.js";
import { transactionResetTool } from "../../src/tools/banking/transaction-reset.js";
import { bookPaymentTool } from "../../src/tools/lifecycle/book-payment.js";
import { invoiceCancelTool } from "../../src/tools/lifecycle/cancel.js";
import { resetTool } from "../../src/tools/lifecycle/reset.js";
import { ACCOUNT_BOOKINGS, type AnyWriteToolDefinition } from "../../src/tools/types.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultText,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import {
  accountRoute,
  accountRow,
  documentRoute,
  invoiceRow,
  writeRoute,
} from "../unit/tools/lifecycle/helpers.js";

closeWriteHarnessesAfterEach();

/** Lets other pending calls run, as a real HTTP round trip would. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function harness() {
  // Invoice 1001: open, 177.33 gross, nothing paid yet. Its row is shared with the GET route, so
  // a booking below changes what the next read returns, as in sevDesk.
  const invoice = invoiceRow({ status: "200", paidAmount: 0 });
  const h = await writeHarness({
    tools: [bookPaymentTool("invoice")],
    routes: [
      documentRoute("invoice", invoice),
      accountRoute(accountRow(4001)),
      writeRoute("PUT", "/Invoice/1001/bookAmount", "invoice-book-amount.json"),
    ],
    config: { confirm: "off" },
  });
  const request = h.fake.request.bind(h.fake);
  vi.spyOn(h.fake, "request").mockImplementation(async (req: SevdeskRequest) => {
    await tick();
    const response = await request(req);
    if (req.method === "PUT") {
      const { amount } = req.body as { amount: number };
      invoice["paidAmount"] = Number(invoice["paidAmount"]) + amount;
    }
    return response;
  });
  return h;
}

const payment = (amount: string) => ({
  name: "sevdesk_invoice_book_payment",
  arguments: { id: 1001, amount, date: "2026-11-02", checkAccountId: 4001 },
});

describe("concurrent payments on one invoice", () => {
  it("books the first and refuses the second, which would exceed the open amount", async () => {
    const { client, fake } = await harness();

    const results = await Promise.all([
      client.callTool(payment("100.00")),
      client.callTool(payment("100.00")),
    ]);

    const refused = results.filter((result) => result.isError === true);
    const done = results.filter((result) => result.isError !== true);
    expect(refused).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(resultData(done[0]!)["status"]).toBe("done");
    expect(resultText(refused[0]!)).toMatch(/open/i);
    expect(writesOf(fake)).toEqual([{ method: "PUT", path: "/Invoice/1001/bookAmount" }]);
  });

  it("still books two payments that fit, one after the other", async () => {
    const { client, fake } = await harness();

    const results = await Promise.all([
      client.callTool(payment("77.33")),
      client.callTool(payment("100.00")),
    ]);

    expect(results.map((result) => resultData(result)["status"])).toEqual(["done", "done"]);
    expect(writesOf(fake)).toHaveLength(2);
  });
});

describe("bookings and their undo run one at a time per account (security review 2026-11, wave 2)", () => {
  it("every tool that books or undoes payments takes the account-wide bookings lock", () => {
    const tools: readonly [AnyWriteToolDefinition, Record<string, unknown>][] = [
      [bookPaymentTool("invoice"), { id: 1001 }],
      [transactionBookTool, { id: 5101, allocations: [{ kind: "invoice", id: 1001 }] }],
      [transactionResetTool, { id: 5101 }],
      [transactionMarkPrivateTool, { id: 5101 }],
      [resetTool("invoice"), { id: 1001 }],
      [invoiceCancelTool, { id: 1001 }],
    ];
    for (const [tool, args] of tools) {
      expect(tool.locks?.(args as never), tool.name).toContainEqual(ACCOUNT_BOOKINGS);
    }
  });
});
