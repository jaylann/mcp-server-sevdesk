import { describe, expect, it } from "vitest";

import { bookingTimestamp } from "../../../../src/domain/lifecycle/payments.js";
import { inLanguage, type Phrase } from "../../../../src/domain/preview-text.js";
import {
  type AllocationRequest,
  documentBookingType,
  executeAllocation,
  MAX_ALLOCATIONS,
  planAllocation,
} from "../../../../src/domain/reconciliation/allocate.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
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
} from "./helpers.js";

/** The English wording of preview sentences. */
const english = (phrases: readonly Phrase[]): string[] => inLanguage(phrases, "en");

const DATE = bookingTimestamp("2026-01-05");

/** Invoice `id` of gross `gross` (net/tax split at 19 %), open (200), nothing paid. */
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

interface Setup {
  readonly transaction?: Row;
  readonly log?: readonly Row[];
  readonly documents?: readonly FakeRoute[];
  readonly extra?: readonly FakeRoute[];
}

function client(setup: Setup = {}): FakeSevdeskClient {
  const transaction = setup.transaction ?? transactionRow();
  const accountId = Number((transaction["checkAccount"] as { id?: string } | null)?.id ?? 4002);
  return new FakeSevdeskClient([
    transactionRoute(transaction),
    accountRoute(accountRow(accountId)),
    logRoute(Number(transaction["id"]), setup.log ?? []),
    ...(setup.documents ?? [invoiceRoute(invoiceRow())]),
    ...(setup.extra ?? []),
  ]);
}

async function refusal(fake: FakeSevdeskClient, requests: readonly AllocationRequest[], id = 5101) {
  const error = await planAllocation(fake, id, requests).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(fake.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

describe("planAllocation", () => {
  it("books a transaction 1:1 as a full payment linked to it, amount defaulted", async () => {
    const fake = client();
    const plan = await planAllocation(fake, 5101, [{ kind: "invoice", id: 1001 }]);
    expect(plan.remainingBefore).toBe("177.33");
    expect(plan.allocated).toBe("177.33");
    expect(plan.remainingAfter).toBe("0");
    expect(plan.bookingDate).toBe("2026-01-05");
    const [allocation] = plan.allocations;
    expect(allocation?.amountDefaulted).toBe(true);
    expect(allocation?.plan.payload).toEqual({
      amount: 177.33,
      date: DATE,
      type: "FULL_PAYMENT",
      checkAccount: { id: 4002, objectName: "CheckAccount" },
      checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
    });
    expect(english(plan.warnings)).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });

  it("splits one transaction over two invoices with type N, both settled", async () => {
    const fake = client({
      transaction: transactionRow({ amount: "238" }),
      documents: [invoiceRoute(invoice(1001, "119")), invoiceRoute(invoice(1002, "119"))],
    });
    const plan = await planAllocation(fake, 5101, [
      { kind: "invoice", id: 1001 },
      { kind: "invoice", id: 1002 },
    ]);
    expect(plan.allocations.map((a) => a.plan.payload.type)).toEqual(["N", "N"]);
    expect(plan.allocations.map((a) => a.plan.amount.amount)).toEqual(["119.00", "119.00"]);
    expect(plan.allocations.map((a) => documentBookingType(a.plan))).toEqual([
      "FULL_PAYMENT",
      "FULL_PAYMENT",
    ]);
    expect(plan.remainingAfter).toBe("0");
  });

  it("books part of a transaction with type N and says what stays unassigned", async () => {
    const fake = client({
      transaction: transactionRow({ amount: "238" }),
      documents: [invoiceRoute(invoice(1001, "119"))],
    });
    const plan = await planAllocation(fake, 5101, [{ kind: "invoice", id: 1001 }]);
    expect(plan.allocations[0]?.plan.payload.type).toBe("N");
    expect(plan.remainingAfter).toBe("119");
    expect(english(plan.warnings)).toEqual([
      "119.00 EUR of bank transaction 5101 stays unassigned: it becomes partly linked (status " +
        "200) and can be booked further with sevdesk_transaction_book.",
    ]);
  });

  it("books the rest of a partly linked transaction (status 200) from its log", async () => {
    const fake = client({
      transaction: transactionRow({ amount: "238", status: "200" }),
      log: [logEntry(7001, 5101, "Invoice", 1001, 119)],
      documents: [invoiceRoute(invoice(1002, "200"))],
    });
    const plan = await planAllocation(fake, 5101, [{ kind: "invoice", id: 1002 }]);
    expect(plan.remainingBefore).toBe("119");
    expect(plan.allocations[0]?.plan.amount.amount).toBe("119.00");
    expect(plan.allocations[0]?.plan.payload.type).toBe("N");
    expect(documentBookingType(plan.allocations[0]!.plan)).toBe("N");
    expect(plan.remainingAfter).toBe("0");
  });

  it("books a transaction smaller than the invoice as a partial payment", async () => {
    const fake = client({ transaction: transactionRow({ amount: "100" }) });
    const plan = await planAllocation(fake, 5101, [{ kind: "invoice", id: 1001 }]);
    const [allocation] = plan.allocations;
    expect(allocation?.plan.payload.type).toBe("N");
    expect(allocation?.plan.remaining?.amount).toBe("77.33");
    expect(english(plan.warnings)).toEqual([
      "Invoice 1001: This is a partial payment: 77.33 EUR stays open and the invoice becomes " +
        "partially paid (750).",
    ]);
  });

  it("allows Skonto when one invoice takes the whole transaction", async () => {
    const fake = client({ transaction: transactionRow({ amount: "172.01" }) });
    const plan = await planAllocation(fake, 5101, [
      { kind: "invoice", id: 1001, paymentType: "cash_discount" },
    ]);
    expect(plan.allocations[0]?.plan.payload.type).toBe("CB");
    expect(plan.allocations[0]?.plan.payload.amount).toBe(172.01);
  });

  it("pays out a credit note from an outgoing transaction with a negative amount", async () => {
    const fake = client({
      transaction: transactionRow({ amount: "-23.8" }),
      documents: [creditNoteRoute(creditNoteRow())],
    });
    const plan = await planAllocation(fake, 5101, [{ kind: "creditNote", id: 2001 }]);
    expect(plan.allocations[0]?.plan.payload).toMatchObject({
      amount: -23.8,
      type: "FULL_PAYMENT",
    });
  });

  it("pays an expense voucher from an outgoing transaction with a negative amount", async () => {
    const fake = client({
      transaction: transactionRow({ amount: "-298.1" }),
      documents: [voucherRoute(voucherRow())],
    });
    const plan = await planAllocation(fake, 5101, [
      { kind: "voucher", id: 2001, amount: "298.10" },
    ]);
    expect(plan.allocations[0]?.plan.payload).toMatchObject({
      amount: -298.1,
      type: "FULL_PAYMENT",
      checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
    });
    expect(plan.allocations[0]?.amountDefaulted).toBe(false);
  });

  it("books on the entry date when the value date is missing", async () => {
    const fake = client({ transaction: transactionRow({ valueDate: null }) });
    const plan = await planAllocation(fake, 5101, [{ kind: "invoice", id: 1001 }]);
    expect(plan.bookingDate).toBe("2026-01-05");
  });
});

describe("planAllocation refusals (nothing is sent)", () => {
  it("refuses an empty list, too many documents and a document named twice", async () => {
    expect(await refusal(client(), [])).toBe(
      "Name at least one document to book the transaction to.",
    );
    const many = Array.from({ length: MAX_ALLOCATIONS + 1 }, (_, i) => ({
      kind: "invoice" as const,
      id: i + 1,
    }));
    expect(await refusal(client(), many)).toBe("At most 10 documents can be booked in one call.");
    expect(
      await refusal(client(), [
        { kind: "invoice", id: 1001 },
        { kind: "invoice", id: 1001 },
      ]),
    ).toContain("Invoice 1001 is named twice");
  });

  it("refuses an unknown transaction or document with a trusted hint", async () => {
    const missing = new FakeSevdeskClient([
      {
        path: "/CheckAccountTransaction/5101",
        response: { error: new SevdeskError({ kind: "not_found", message: "x" }) },
      },
    ]);
    expect(await refusal(missing, [{ kind: "invoice", id: 1001 }])).toBe(
      "Bank transaction 5101 does not exist; find it with sevdesk_transactions_list.",
    );
    const noDocument = client({
      documents: [
        {
          path: "/Invoice/1001",
          response: { error: new SevdeskError({ kind: "not_found", message: "x" }) },
        },
      ],
    });
    expect(await refusal(noDocument, [{ kind: "invoice", id: 1001 }])).toBe(
      "Invoice 1001 does not exist; look it up with sevdesk_invoices_list.",
    );
  });

  it("passes other read failures on unchanged", async () => {
    const failing = new FakeSevdeskClient([
      {
        path: "/CheckAccountTransaction/5101",
        response: { error: new SevdeskError({ kind: "server", message: "boom" }) },
      },
    ]);
    await expect(
      planAllocation(failing, 5101, [{ kind: "invoice", id: 1001 }]),
    ).rejects.toMatchObject({ kind: "server" });
  });

  it.each([
    ["enshrined", { enshrined: "2026-03-01T00:00:00+01:00" }, "is enshrined (festgeschrieben)"],
    ["private", { status: "300" }, "is marked as private"],
    ["auto-booked", { status: "350" }, "was booked automatically"],
    ["booked", { status: "400" }, "is already fully booked"],
    ["of unknown status", { status: "250" }, "has status 250"],
    ["without status", { status: null }, "has no status"],
    ["without account", { checkAccount: null }, "belongs to no check account"],
    ["of zero amount", { amount: "0" }, "has the amount zero"],
  ])("refuses a transaction that is %s", async (_label, overrides, text) => {
    const fake = client({ transaction: transactionRow(overrides) });
    expect(await refusal(fake, [{ kind: "invoice", id: 1001 }])).toContain(text);
  });

  it("refuses a transaction whose remaining amount is unknown or zero", async () => {
    const unknown = client({ transaction: transactionRow({ status: "200" }) });
    expect(await refusal(unknown, [{ kind: "invoice", id: 1001 }])).toBe(
      "Bank transaction 5101: how much of it is still unassigned cannot be told (it is marked " +
        "partly linked (status 200) but its booking log has no entries), so nothing is booked. " +
        "Check it in the sevDesk web app.",
    );
    const used = client({
      transaction: transactionRow({ status: "200" }),
      log: [logEntry(1, 5101, "Invoice", 1, 177.33)],
    });
    expect(await refusal(used, [{ kind: "invoice", id: 1001 }])).toBe(
      "Bank transaction 5101 has nothing left to assign; it is fully booked.",
    );
  });

  it("refuses the wrong direction", async () => {
    const fake = client({ transaction: transactionRow({ amount: "-177.33" }) });
    expect(await refusal(fake, [{ kind: "invoice", id: 1001 }])).toBe(
      "Invoice 1001 needs incoming money, but bank transaction 5101 is outgoing. Invoices and " +
        "revenue vouchers take incoming payments; credit notes and expense vouchers outgoing ones.",
    );
    const payout = client({ documents: [creditNoteRoute(creditNoteRow())] });
    expect(await refusal(payout, [{ kind: "creditNote", id: 2001 }])).toContain(
      "needs outgoing money, but bank transaction 5101 is incoming",
    );
  });

  it("refuses a document in another currency than the transaction", async () => {
    const fake = client({
      transaction: transactionRow({ checkAccount: { id: "4005", objectName: "CheckAccount" } }),
    });
    expect(await refusal(fake, [{ kind: "invoice", id: 1001 }])).toBe(
      "Invoice 1001 is in EUR, bank transaction 5101 in USD; sevDesk books a transaction only " +
        "to documents in its own currency.",
    );
  });

  it("refuses a transaction on an archived account", async () => {
    const fake = client({
      transaction: transactionRow({ checkAccount: { id: "4004", objectName: "CheckAccount" } }),
    });
    expect(await refusal(fake, [{ kind: "invoice", id: 1001 }])).toContain("is archived");
  });

  it("refuses a draft document", async () => {
    const fake = client({ documents: [invoiceRoute(invoiceRow({ status: "100" }))] });
    expect(await refusal(fake, [{ kind: "invoice", id: 1001 }])).toContain("is a draft");
  });

  it("refuses allocations above the transaction's remaining amount", async () => {
    const fake = client({
      transaction: transactionRow({ amount: "238" }),
      documents: [invoiceRoute(invoice(1001, "119")), invoiceRoute(invoice(1002, "200"))],
    });
    expect(
      await refusal(fake, [
        { kind: "invoice", id: 1001, amount: "119" },
        { kind: "invoice", id: 1002, amount: "150" },
      ]),
    ).toBe(
      "The allocations add up to 269.00 EUR or more, more than the 238.00 EUR still unassigned " +
        "on bank transaction 5101. Lower the amounts.",
    );
  });

  it("refuses an allocation above the document's open amount", async () => {
    const fake = client({
      transaction: transactionRow({ amount: "238" }),
      documents: [invoiceRoute(invoice(1001, "119"))],
    });
    expect(await refusal(fake, [{ kind: "invoice", id: 1001, amount: "150" }])).toContain(
      "more than the open amount of 119.00 EUR",
    );
  });

  it("refuses a defaulted allocation when nothing is left for it", async () => {
    const fake = client({
      documents: [invoiceRoute(invoiceRow()), invoiceRoute(invoice(1002, "50"))],
    });
    expect(
      await refusal(fake, [
        { kind: "invoice", id: 1001, amount: "177.33" },
        { kind: "invoice", id: 1002 },
      ]),
    ).toBe(
      "Nothing of bank transaction 5101 is left for invoice 1002: the documents before it take " +
        "all 177.33 EUR.",
    );
  });

  it("refuses Skonto on part of a transaction (the shared rule)", async () => {
    const fake = client({
      transaction: transactionRow({ amount: "238" }),
      documents: [invoiceRoute(invoice(1001, "125")), invoiceRoute(invoice(1002, "119"))],
    });
    expect(
      await refusal(fake, [
        { kind: "invoice", id: 1001, amount: "119", paymentType: "cash_discount" },
        { kind: "invoice", id: 1002 },
      ]),
    ).toContain("can only be booked when the payment takes the whole bank transaction");
  });

  it("refuses a transaction without any date", async () => {
    const fake = client({ transaction: transactionRow({ valueDate: null, entryDate: null }) });
    expect(await refusal(fake, [{ kind: "invoice", id: 1001 }])).toBe(
      "Bank transaction 5101 has no date to book the payments on.",
    );
  });
});

describe("executeAllocation", () => {
  const payload = (type: "N" | "FULL_PAYMENT") => ({
    amount: 119,
    date: DATE,
    type,
    checkAccount: { id: 4002, objectName: "CheckAccount" as const },
    checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" as const },
  });
  const bookings = [
    { kind: "invoice" as const, id: 1001, payload: payload("N") },
    { kind: "voucher" as const, id: 2001, payload: payload("N") },
  ];

  it("sends the bookings in order and returns the documents and the transaction", async () => {
    const fake = new FakeSevdeskClient([
      { method: "PUT", path: "/Invoice/1001/bookAmount", response: { body: { objects: {} } } },
      { method: "PUT", path: "/Voucher/2001/bookAmount", response: { body: { objects: {} } } },
    ]);
    const changed = await executeAllocation(fake, 5101, bookings);
    expect(fake.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /Invoice/1001/bookAmount",
      "PUT /Voucher/2001/bookAmount",
    ]);
    expect(fake.writes()[0]?.body).toEqual(payload("N"));
    expect(changed).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "Voucher", id: "2001" },
      { objectName: "CheckAccountTransaction", id: "5101" },
    ]);
  });

  it("names what was booked when a later booking fails, and never retries", async () => {
    const failure = new SevdeskError({ kind: "validation", status: 422, message: "refused" });
    const fake = new FakeSevdeskClient([
      { method: "PUT", path: "/Invoice/1001/bookAmount", response: { body: { objects: {} } } },
      { method: "PUT", path: "/Voucher/2001/bookAmount", response: { error: failure } },
    ]);
    const error = (await executeAllocation(fake, 5101, bookings).catch(
      (e: unknown) => e,
    )) as SevdeskError;
    expect(error.kind).toBe("validation");
    expect(error.status).toBe(422);
    expect(error.completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "CheckAccountTransaction", id: "5101" },
    ]);
    expect(fake.writes()).toHaveLength(2);
  });

  it("passes a failure of the first booking on unchanged", async () => {
    const failure = new SevdeskError({ kind: "server", message: "boom" });
    const fake = new FakeSevdeskClient([
      { method: "PUT", path: "/Invoice/1001/bookAmount", response: { error: failure } },
    ]);
    const error = await executeAllocation(fake, 5101, bookings).catch((e: unknown) => e);
    expect(error).toBe(failure);
    expect(fake.writes()).toHaveLength(1);
  });

  it("passes non-sevDesk errors on unchanged", async () => {
    const fake = new FakeSevdeskClient([
      { method: "PUT", path: "/Invoice/1001/bookAmount", response: { body: { objects: {} } } },
    ]);
    // No route for the voucher: the fake throws a plain Error.
    await expect(executeAllocation(fake, 5101, bookings)).rejects.toThrow(/no route/);
  });
});
