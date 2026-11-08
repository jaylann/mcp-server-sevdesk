import { describe, expect, it } from "vitest";

import { bookingTimestamp } from "../../../../src/domain/lifecycle/payments.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { transactionBookTool as tool } from "../../../../src/tools/banking/transaction-book.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  invoiceRoute,
  invoiceRow,
  logEntry,
  logRoute,
  type Row,
  StagedClient,
  transactionRoute,
  transactionRow,
  voucherRoute,
  voucherRow,
} from "../../domain/reconciliation/helpers.js";

const DATE = bookingTimestamp("2026-01-05");

function invoice(id: number, gross: string, overrides: Row = {}): Row {
  return invoiceRow({
    id: String(id),
    invoiceNumber: `RE-${String(id)}`,
    sumGross: gross,
    sumNet: gross,
    sumTax: "0",
    ...overrides,
  });
}

function put(path: string, response: FakeRoute["response"] = { body: { objects: {} } }): FakeRoute {
  return { method: "PUT", path, response };
}

/** Reads before the first write, the write routes and read-backs after it. */
function staged(options: {
  readonly transaction?: Row;
  readonly log?: readonly Row[];
  readonly documents: readonly Row[];
  readonly after: readonly FakeRoute[];
  readonly transactionAfter?: Row;
  /** The transaction's log after the bookings; default: one entry taking all of it. */
  readonly logAfter?: readonly Row[] | FakeRoute;
}): StagedClient {
  const transaction = options.transaction ?? transactionRow();
  const reads: FakeRoute[] = [
    transactionRoute(transaction),
    accountRoute(accountRow(4002)),
    logRoute(Number(transaction["id"]), options.log ?? []),
    ...options.documents.map((row) => invoiceRoute(row)),
  ];
  const id = Number(transaction["id"]);
  const logAfter = options.logAfter ?? [
    logEntry(9001, id, "Invoice", 1, Number(transaction["amount"])),
  ];
  return new StagedClient(reads, [
    ...options.after,
    transactionRoute(options.transactionAfter ?? { ...transaction, status: "400" }),
    accountRoute(accountRow(4002)),
    Array.isArray(logAfter) ? logRoute(id, logAfter) : (logAfter as FakeRoute),
  ]);
}

describe("sevdesk_transaction_book", () => {
  it("is a commit tool with commit annotations", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("previews a 1:1 booking with every fact and writes nothing in prepare", async () => {
    const client = staged({ documents: [invoiceRow()], after: [] });
    const plan = await prepareWrite(
      tool,
      { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
      client,
    );
    expect(plan.preview.action).toBe(
      "Book bank transaction 5101 (177.33 EUR) to invoice RE-1001: 177.33 EUR in total.",
    );
    expect(plan.preview.facts).toEqual([
      { label: "Bank transaction (Umsatz)", value: "id 5101, 177.33 EUR (incoming)" },
      { label: "Value date", value: "2026-01-05" },
      { label: "Check account", value: "Geschäftskonto Musterbank (id 4002)" },
      { label: "Status", value: expect.stringContaining("(100)") as unknown },
      { label: "Counterparty", value: "Musterfirma GmbH" },
      { label: "Purpose (Verwendungszweck)", value: "RE-1001" },
      { label: "Unassigned before", value: "177.33 EUR" },
      { label: "Booking date", value: "2026-01-05" },
      {
        label: "Allocation 1: invoice RE-1001",
        value: expect.stringMatching(
          /^177\.33 EUR \(full payment, amount defaulted\); open 177\.33 EUR; status .+ \(200\) → paid \(1000\); Musterfirma GmbH$/,
        ) as unknown,
      },
      { label: "Unassigned after", value: "0.00 EUR (transaction fully booked, status 400)" },
    ]);
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.preview.warnings).toEqual([
      expect.stringContaining("To undo, use sevdesk_transaction_reset"),
    ]);
    expect(client.writes()).toEqual([]);
  });

  it("books 1:1 with FULL_PAYMENT, stamps commit and reads everything back", async () => {
    const client = staged({
      documents: [invoiceRow()],
      after: [
        put("/Invoice/1001/bookAmount"),
        invoiceRoute(invoiceRow({ status: "1000", paidAmount: "177.33" })),
      ],
    });
    const { output } = await executeWrite(
      tool,
      { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
      client,
    );
    const writes = client.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "PUT",
      path: "/Invoice/1001/bookAmount",
      tier: "commit",
      body: {
        amount: 177.33,
        date: DATE,
        type: "FULL_PAYMENT",
        checkAccount: { id: 4002, objectName: "CheckAccount" },
        checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
      },
    });
    expect(output.data.transaction.status?.code).toBe(400);
    expect(output.data.bookings).toEqual([
      {
        document: expect.objectContaining({
          kind: "invoice",
          id: 1001,
          status: expect.objectContaining({ code: 1000 }) as unknown,
        }) as unknown,
        amount: { amount: "177.33", currency: "EUR" },
        bookingType: "FULL_PAYMENT",
      },
    ]);
    expect(output.data.remaining).toEqual({ amount: "0.00", currency: "EUR" });
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "CheckAccountTransaction", id: "5101" },
    ]);
    expect(output.summary).toBe(
      "Bank transaction 5101 booked to 1 document; 0.00 EUR left unassigned.",
    );
  });

  it("splits with type N in the given order and says why in the preview", async () => {
    const transaction = transactionRow({ amount: "238" });
    const client = staged({
      transaction,
      documents: [invoice(1002, "119"), invoice(1001, "119")],
      after: [
        put("/Invoice/1002/bookAmount"),
        put("/Invoice/1001/bookAmount"),
        invoiceRoute(invoice(1001, "119", { status: "1000", paidAmount: "119" })),
        invoiceRoute(invoice(1002, "119", { status: "1000", paidAmount: "119" })),
      ],
    });
    const args = {
      transactionId: 5101,
      allocations: [
        { kind: "invoice", id: 1002 },
        { kind: "invoice", id: 1001, amount: "119" },
      ],
    };
    const { plan, output } = await executeWrite(tool, args, client);
    expect(client.writes().map((w) => [w.path, (w.body as { type: string }).type])).toEqual([
      ["/Invoice/1002/bookAmount", "N"],
      ["/Invoice/1001/bookAmount", "N"],
    ]);
    const allocationFact = plan.preview.facts.find((f) => f.label.startsWith("Allocation 2"));
    expect(allocationFact?.value).toContain(
      "119.00 EUR (full payment, sent as type N as it uses part of the transaction)",
    );
    expect(allocationFact?.value).toContain("→ paid (1000)");
    expect(plan.preview.action).toBe(
      "Book bank transaction 5101 (238.00 EUR) to invoice RE-1002 and invoice RE-1001: " +
        "238.00 EUR in total.",
    );
    expect(output.data.bookings.map((b) => b.bookingType)).toEqual(["N", "N"]);
  });

  it("previews a partial booking with what stays open and what stays unassigned", async () => {
    const client = staged({
      transaction: transactionRow({ amount: "238", status: "200" }),
      log: [logEntry(1, 5101, "Invoice", 1003, 138)],
      documents: [invoice(1001, "177.33")],
      after: [],
    });
    const plan = await prepareWrite(
      tool,
      { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001, amount: "50" }] },
      client,
    );
    const fact = plan.preview.facts.find((f) => f.label.startsWith("Allocation 1"));
    expect(fact?.value).toContain("50.00 EUR (partial payment)");
    expect(fact?.value).toContain("→ partially paid (750), 127.33 EUR stays open");
    expect(plan.preview.facts.at(-1)).toEqual({
      label: "Unassigned after",
      value: "50.00 EUR (status 200, partly linked)",
    });
    expect(plan.preview.warnings).toEqual([
      "Invoice 1001: This is a partial payment: 127.33 EUR stays open and the invoice becomes " +
        "partially paid (750).",
      "50.00 EUR of bank transaction 5101 stays unassigned: it becomes partly linked (status " +
        "200) and can be booked further with sevdesk_transaction_book.",
      expect.stringContaining("To undo"),
    ]);
  });

  it("books an expense voucher from an outgoing transaction", async () => {
    const transaction = transactionRow({ amount: "-298.1" });
    const client = new StagedClient(
      [
        transactionRoute(transaction),
        accountRoute(accountRow(4002)),
        logRoute(5101, []),
        voucherRoute(voucherRow()),
      ],
      [
        put("/Voucher/2001/bookAmount"),
        transactionRoute({ ...transaction, status: "400" }),
        accountRoute(accountRow(4002)),
        voucherRoute(voucherRow({ status: "1000", paidAmount: "298.1" })),
        logRoute(5101, [logEntry(9001, 5101, "Voucher", 2001, -298.1)]),
      ],
    );
    const { output } = await executeWrite(
      tool,
      { transactionId: 5101, allocations: [{ kind: "voucher", id: 2001 }] },
      client,
    );
    expect(client.writes()[0]?.body).toMatchObject({ amount: -298.1, type: "FULL_PAYMENT" });
    expect(output.data.bookings[0]?.document).toMatchObject({
      kind: "voucher",
      number: "RE-2026-0042",
      contact: { id: 1003 },
    });
  });

  it("reports the remaining amount from the booking log read after the bookings", async () => {
    const transaction = transactionRow({ amount: "238" });
    const client = staged({
      transaction,
      documents: [invoice(1001, "119")],
      after: [
        put("/Invoice/1001/bookAmount"),
        invoiceRoute(invoice(1001, "119", { status: "1000" })),
      ],
      transactionAfter: { ...transaction, status: "200" },
      // sevDesk shows 138 assigned, not the planned 119: the log wins.
      logAfter: [logEntry(9001, 5101, "Invoice", 1001, 138)],
    });
    const { output } = await executeWrite(
      tool,
      { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
      client,
    );
    expect(output.data.remaining).toEqual({ amount: "100.00", currency: "EUR" });
    expect(output.data.remainingNote).toBeUndefined();
    expect(output.summary).toBe(
      "Bank transaction 5101 booked to 1 document; 100.00 EUR left unassigned.",
    );
  });

  it("falls back to the planned remaining amount with a note when the log does not tell", async () => {
    const unreadable = staged({
      documents: [invoiceRow()],
      after: [put("/Invoice/1001/bookAmount"), invoiceRoute(invoiceRow({ status: "1000" }))],
      logAfter: {
        path: "/CheckAccountTransactionLog",
        response: { error: new SevdeskError({ kind: "server", message: "boom" }) },
      },
    });
    const { output } = await executeWrite(
      tool,
      { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
      unreadable,
    );
    expect(output.data.remaining).toEqual({ amount: "0.00", currency: "EUR" });
    expect(output.data.remainingNote).toBe(
      "This is the planned value: the booking log could not be read after the booking.",
    );
    expect(output.summary).toBe(
      "Bank transaction 5101 booked to 1 document; 0.00 EUR left unassigned (planned; the " +
        "booking log could not be read).",
    );

    const contradictory = staged({
      documents: [invoiceRow()],
      after: [put("/Invoice/1001/bookAmount"), invoiceRoute(invoiceRow({ status: "1000" }))],
      transactionAfter: transactionRow({ status: "200" }),
      logAfter: [],
    });
    const second = await executeWrite(
      tool,
      { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
      contradictory,
    );
    expect(second.output.data.remainingNote).toBe(
      "This is the planned value: after the booking, it is marked partly linked (status 200) " +
        "but its booking log has no entries.",
    );
  });

  it("passes a cancellation during the log read on", async () => {
    const client = staged({
      documents: [invoiceRow()],
      after: [put("/Invoice/1001/bookAmount"), invoiceRoute(invoiceRow({ status: "1000" }))],
      logAfter: {
        path: "/CheckAccountTransactionLog",
        response: { error: new SevdeskError({ kind: "aborted", message: "cancelled" }) },
      },
    });
    await expect(
      executeWrite(
        tool,
        { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
        client,
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("names what was booked when a later booking fails", async () => {
    const failure = new SevdeskError({ kind: "validation", status: 422, message: "refused" });
    const client = staged({
      transaction: transactionRow({ amount: "238" }),
      documents: [invoice(1001, "119"), invoice(1002, "119")],
      after: [put("/Invoice/1001/bookAmount"), put("/Invoice/1002/bookAmount", { error: failure })],
    });
    const error = (await executeWrite(
      tool,
      {
        transactionId: 5101,
        allocations: [
          { kind: "invoice", id: 1001 },
          { kind: "invoice", id: 1002 },
        ],
      },
      client,
    ).catch((e: unknown) => e)) as SevdeskError;
    expect(error.completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "CheckAccountTransaction", id: "5101" },
    ]);
    expect(client.writes()).toHaveLength(2);
  });

  it("reports the completed bookings when a read-back fails", async () => {
    const client = new StagedClient(
      [
        transactionRoute(transactionRow()),
        accountRoute(accountRow(4002)),
        logRoute(5101, []),
        invoiceRoute(invoiceRow()),
      ],
      [
        put("/Invoice/1001/bookAmount"),
        transactionRoute(transactionRow({ status: "400" })),
        accountRoute(accountRow(4002)),
        {
          path: "/Invoice/1001",
          query: { embed: "contact" },
          response: { error: new SevdeskError({ kind: "server", message: "boom" }) },
        },
      ],
    );
    const error = (await executeWrite(
      tool,
      { transactionId: 5101, allocations: [{ kind: "invoice", id: 1001 }] },
      client,
    ).catch((e: unknown) => e)) as SevdeskError;
    expect(error.kind).toBe("server");
    expect(error.completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "CheckAccountTransaction", id: "5101" },
    ]);
  });

  it("validates its input", () => {
    const parse = (allocations: unknown) => tool.input.safeParse({ transactionId: 1, allocations });
    expect(parse([]).success).toBe(false);
    expect(
      parse(Array.from({ length: 11 }, (_, i) => ({ kind: "invoice", id: i + 1 }))).success,
    ).toBe(false);
    expect(parse([{ kind: "invoice", id: 1, amount: "0" }]).success).toBe(false);
    expect(parse([{ kind: "invoice", id: 1, amount: "1.001" }]).success).toBe(false);
    expect(parse([{ kind: "order", id: 1 }]).success).toBe(false);
    expect(parse([{ kind: "invoice", id: 1, extra: true }]).success).toBe(false);
    expect(parse([{ kind: "credit_note", id: 1, paymentType: "cash_discount" }]).success).toBe(
      true,
    );
  });
});
