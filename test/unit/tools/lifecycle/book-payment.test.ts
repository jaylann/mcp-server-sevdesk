import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { bookPaymentTool } from "../../../../src/tools/lifecycle/book-payment.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  creditNoteRow,
  documentRoute,
  invoiceRow,
  type Row,
  StagedClient,
  transactionLogRoute,
  transactionRoute,
  transactionRow,
  writeRoute,
} from "./helpers.js";

const tool = bookPaymentTool("invoice");
const creditNoteTool = bookPaymentTool("creditNote");

/** 2026-11-02 12:00 Europe/Berlin (CET) in Unix seconds. */
const NOON_NOV_2 = 1_793_617_200;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

function invoiceClient(
  options: {
    readonly invoice?: Row;
    readonly after?: Row;
    readonly account?: Row;
    readonly transaction?: Row;
    readonly extra?: readonly FakeRoute[];
  } = {},
): StagedClient {
  const account = options.account ?? accountRow(4002);
  const reads: FakeRoute[] = [
    documentRoute("invoice", options.invoice ?? invoiceRow()),
    accountRoute(account),
    transactionRoute(options.transaction ?? transactionRow()),
    ...(options.extra ?? []),
    transactionLogRoute(),
  ];
  return new StagedClient(reads, [
    writeRoute("PUT", "/Invoice/1001/bookAmount", "invoice-book-amount.json"),
    documentRoute(
      "invoice",
      options.after ?? invoiceRow({ status: "1000", paidAmount: 177.33, payDate: "2026-11-02" }),
    ),
  ]);
}

const full = { id: 1001, amount: "177.33", date: "2026-11-02", checkAccountId: 4002 };

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  return (error as SevdeskError).message;
}

describe("sevdesk_invoice_book_payment (spec bookInvoice; community record shapes)", () => {
  it("is a commit tool", () => {
    expect(tool.name).toBe("sevdesk_invoice_book_payment");
    expect(tool.tier).toBe("commit");
    expect(tool.annotations.destructiveHint).toBe(true);
    expect(tool.annotations.openWorldHint).toBe(false);
  });

  it("books the full open amount linked to the bank transaction and reads the invoice back", async () => {
    const client = invoiceClient();

    const { plan, output } = await executeWrite(tool, { ...full, transactionId: 5101 }, client);

    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: "/Invoice/1001/bookAmount",
        tier: "commit",
        body: {
          amount: 177.33,
          date: NOON_NOV_2,
          type: "FULL_PAYMENT",
          checkAccount: { id: 4002, objectName: "CheckAccount" },
          checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
        },
      }),
    ]);
    expect(plan.preview.action).toBe(
      "Book a payment received of 177.33 EUR on invoice RE-1001 (full payment (FULL_PAYMENT)) " +
        "via check account Geschäftskonto Musterbank, linked to bank transaction 5101.",
    );
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.preview.warnings).toEqual([]);
    expect(plan.preview.facts.slice(-6)).toEqual([
      { label: "Open amount", value: "177.33 EUR" },
      { label: "Payment received", value: "177.33 EUR, full payment (FULL_PAYMENT)" },
      { label: "Booking date", value: "2026-11-02" },
      { label: "Check account", value: "Geschäftskonto Musterbank (id 4002, EUR, bank)" },
      {
        label: "Linked bank transaction",
        value: "id 5101, 177.33 EUR, 2026-01-05, Musterfirma GmbH, RE-1001",
      },
      { label: "Open after booking", value: "0.00 EUR (settled)" },
    ]);
    expect(output.data["invoice"]).toMatchObject({ status: { code: 1000 } });
    expect(output.data["payment"]).toEqual({
      amount: { amount: "177.33", currency: "EUR" },
      date: "2026-11-02",
      paymentType: "payment",
      checkAccountId: 4002,
      transactionId: 5101,
    });
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "CheckAccountTransaction", id: "5101" },
    ]);
    expect(output.summary).toBe(
      "Invoice 1001: FULL_PAYMENT booking of 177.33 EUR done; status Paid (1000).",
    );
  });

  it("books a partial payment (N) and says what stays open", async () => {
    const client = invoiceClient({
      after: invoiceRow({ status: "750", paidAmount: 100 }),
      transaction: transactionRow({ amount: "100" }),
    });

    const { plan, output } = await executeWrite(
      tool,
      { ...full, amount: 100, transactionId: 5101 },
      client,
    );

    expect(client.writes()[0]?.body).toMatchObject({ amount: 100, type: "N" });
    expect(plan.preview.facts).toContainEqual({
      label: "Open after booking",
      value: "77.33 EUR",
    });
    expect(plan.preview.warnings).toContain(
      "This is a partial payment: 77.33 EUR stays open and the invoice becomes partially paid " +
        "(750).",
    );
    expect(plan.previewDe.facts).toContainEqual({
      label: "Offen nach der Buchung",
      value: "77,33 EUR",
    });
    expect(plan.previewDe.warnings).toContain(
      "Das ist eine Teilzahlung: 77,33 EUR bleiben offen, und die Rechnung gilt danach als " +
        "teilweise bezahlt (750).",
    );
    expect(output.data["invoice"]).toMatchObject({ status: { code: 750 } });
  });

  it("books the rest of a partially paid invoice exactly (no float drift)", async () => {
    const client = invoiceClient({
      invoice: invoiceRow({ status: "750", paidAmount: 100.1 }),
      transaction: transactionRow({ amount: "77.23" }),
    });

    await executeWrite(tool, { ...full, amount: "77.23", transactionId: 5101 }, client);

    expect(client.writes()[0]?.body).toMatchObject({ amount: 77.23, type: "FULL_PAYMENT" });
  });

  it("pays the whole open amount from a larger transaction as N, the rest stays assignable", async () => {
    const client = invoiceClient({ transaction: transactionRow({ amount: "200" }) });

    const { plan } = await executeWrite(tool, { ...full, transactionId: 5101 }, client);

    expect(client.writes()[0]?.body).toMatchObject({ amount: 177.33, type: "N" });
    expect(plan.preview.action).toContain("(partial payment (N))");
    expect(plan.preview.warnings).toEqual([
      "Bank transaction 5101 is 200.00 EUR; the payment uses part of it, so it is sent as a " +
        "partial booking (N), and 22.67 EUR of the transaction stays assignable to other " +
        "documents (sevDesk marks it partly assigned, status 200).",
    ]);
    expect(plan.preview.facts).toContainEqual({
      label: "Open after booking",
      value: "0.00 EUR (settled)",
    });
  });

  it("counts what the booking log of a status-100 transaction already assigns as taken", async () => {
    const entry = {
      id: "9001",
      checkAccountTransaction: { id: "5101", objectName: "CheckAccountTransaction" },
      object: { id: "1009", objectName: "Invoice" },
      amountPaid: 22.67,
    };
    const client = invoiceClient({
      transaction: transactionRow({ amount: "200" }),
      extra: [transactionLogRoute([entry])],
    });

    const { plan } = await executeWrite(tool, { ...full, transactionId: 5101 }, client);

    expect(client.writes()[0]?.body).toMatchObject({ amount: 177.33, type: "N" });
    expect(plan.preview.warnings).toEqual([
      "Bank transaction 5101 is marked unbooked (status 100), but its booking log already " +
        "assigns 22.67 EUR of its 200.00 EUR to other documents; only 177.33 EUR is treated as " +
        "free. The payment is sent as a partial booking (N).",
    ]);
    expect(client.calls.map((call) => call.path)).toContain("/CheckAccountTransactionLog");
  });

  it("refuses a payment above what the log leaves free, and a log entry it cannot read", async () => {
    const taken = {
      id: "9001",
      checkAccountTransaction: { id: "5101", objectName: "CheckAccountTransaction" },
      amountPaid: 100,
    };
    let message = await refusalOf(
      prepareWrite(
        tool,
        { ...full, transactionId: 5101 },
        invoiceClient({
          transaction: transactionRow({ amount: "200" }),
          extra: [transactionLogRoute([taken])],
        }),
      ),
    );
    expect(message).toBe(
      "Bank transaction 5101 is marked unbooked (status 100), but its booking log already " +
        "assigns 100.00 EUR of its 200.00 EUR to other documents, so only 100.00 EUR is free, " +
        "less than the payment of 177.33 EUR. Book at most 100.00 EUR.",
    );
    message = await refusalOf(
      prepareWrite(
        tool,
        { ...full, transactionId: 5101 },
        invoiceClient({ extra: [transactionLogRoute([{ ...taken, amountPaid: null }])] }),
      ),
    );
    expect(message).toBe(
      "Bank transaction 5101 is marked unbooked (status 100), but its booking log has an entry " +
        "without an amount, so how much of it is free is unknown. Check it in the sevDesk web app.",
    );
  });

  it("books the rest of a partly assigned transaction (status 200) from its log", async () => {
    const entry = {
      id: "9002",
      checkAccountTransaction: { id: "5101", objectName: "CheckAccountTransaction" },
      object: { id: "1009", objectName: "Invoice" },
      amountPaid: 100,
    };
    const client = invoiceClient({
      transaction: transactionRow({ amount: "300", status: "200" }),
      extra: [transactionLogRoute([entry])],
    });
    const { plan } = await executeWrite(tool, { ...full, transactionId: 5101 }, client);
    expect(client.writes()[0]?.body).toMatchObject({ amount: 177.33, type: "N" });
    expect(plan.preview.warnings).toEqual([
      "Bank transaction 5101 is partly assigned (status 200): its booking log assigns 100.00 " +
        "EUR of its 300.00 EUR to other documents; only 200.00 EUR is treated as free. The " +
        "payment is sent as a partial booking (N), and 22.67 EUR of the transaction stays " +
        "assignable to other documents.",
    ]);
  });

  it("refuses a partly assigned transaction whose log has no entries", async () => {
    const message = await refusalOf(
      prepareWrite(
        tool,
        { ...full, transactionId: 5101 },
        invoiceClient({ transaction: transactionRow({ amount: "300", status: "200" }) }),
      ),
    );
    expect(message).toBe(
      "Bank transaction 5101 is partly assigned (status 200), but its booking log has no " +
        "entries, so how much of it is free is unknown. Book it in the sevDesk web app.",
    );
  });

  it("does not read the log of a transaction it refuses by status", async () => {
    const client = invoiceClient({ transaction: transactionRow({ status: "400" }) });
    await refusalOf(prepareWrite(tool, { ...full, transactionId: 5101 }, client));
    expect(client.calls.map((call) => call.path)).not.toContain("/CheckAccountTransactionLog");
  });

  it("refuses Skonto on part of a larger transaction", async () => {
    const client = invoiceClient({ transaction: transactionRow({ amount: "200" }) });
    const message = await refusalOf(
      prepareWrite(
        tool,
        { ...full, amount: "173.78", transactionId: 5101, paymentType: "cash_discount" },
        client,
      ),
    );
    expect(message).toContain(
      "can only be booked when the payment takes the whole bank transaction",
    );
    expect(client.writes()).toEqual([]);
  });

  it("settles with Skonto (CB) for less than the open amount", async () => {
    const client = invoiceClient({ transaction: transactionRow({ amount: "173.78" }) });

    const { plan } = await executeWrite(
      tool,
      { ...full, amount: "173.78", transactionId: 5101, paymentType: "cash_discount" },
      client,
    );

    expect(client.writes()[0]?.body).toMatchObject({ amount: 173.78, type: "CB" });
    expect(plan.preview.warnings).toEqual([
      "The document is marked as fully paid; the missing 3.55 EUR is written off as cash " +
        "discount (Skonto).",
    ]);
    expect(plan.previewDe.warnings).toEqual([
      "Das Dokument gilt danach als vollständig bezahlt; die fehlenden 3,55 EUR werden als Skonto " +
        "ausgebucht.",
    ]);
    expect(plan.previewDe.action).toContain("(Zahlung abzüglich Skonto (CB))");
  });

  it("refuses over-booking unless the extra is declared, then books reminder charges (OF)", async () => {
    const message = await refusalOf(
      prepareWrite(tool, { ...full, amount: "182.33", transactionId: 5101 }, invoiceClient()),
    );
    expect(message).toContain("is more than the open amount of 177.33 EUR");

    const client = invoiceClient({ transaction: transactionRow({ amount: "182.33" }) });
    await executeWrite(
      tool,
      { ...full, amount: "182.33", transactionId: 5101, paymentType: "reminder_charges" },
      client,
    );
    expect(client.writes()[0]?.body).toMatchObject({ amount: 182.33, type: "OF" });
  });

  it("refuses an online account without a transaction, before writing", async () => {
    const client = invoiceClient();
    const message = await refusalOf(prepareWrite(tool, full, client));
    expect(message).toContain("Check account 4002 is a bank account fed by imports");
    expect(client.writes()).toEqual([]);
  });

  it("books on the offline account without a transaction and warns about double counting", async () => {
    const client = invoiceClient({ account: accountRow(4001) });

    const { plan } = await executeWrite(tool, { ...full, checkAccountId: 4001 }, client);

    expect(client.writes()[0]?.body).toEqual({
      amount: 177.33,
      date: NOON_NOV_2,
      type: "FULL_PAYMENT",
      checkAccount: { id: 4001, objectName: "CheckAccount" },
    });
    expect(plan.preview.warnings[0]).toContain("sevDesk creates a new bank transaction");
    expect(client.calls.map(({ path }) => path)).not.toContain("/CheckAccountTransaction/5101");
  });

  it("defaults the booking date to today (Berlin) and warns about future dates", async () => {
    const client = invoiceClient({ account: accountRow(4003) });
    const { plan } = await executeWrite(
      tool,
      { id: 1001, amount: "177.33", checkAccountId: 4003 },
      client,
    );
    expect(plan.preview.facts).toContainEqual({ label: "Booking date", value: "2026-11-07" });
    expect(plan.previewDe.facts).toContainEqual({ label: "Buchungsdatum", value: "07.11.2026" });

    const future = await prepareWrite(
      tool,
      { id: 1001, amount: "177.33", checkAccountId: 4003, date: "2026-12-01" },
      invoiceClient({ account: accountRow(4003) }),
    );
    expect(future.preview.warnings).toContain("The booking date 2026-12-01 lies in the future.");
    expect(future.previewDe.warnings).toContain(
      "Das Buchungsdatum 01.12.2026 liegt in der Zukunft.",
    );
  });

  it.each([
    ["a draft", invoiceRow({ status: "100" }), "is a draft"],
    ["a paid invoice", invoiceRow({ status: "1000", paidAmount: 177.33 }), "already paid"],
    ["a reminder", invoiceRow({ invoiceType: "MA" }), "payment reminder"],
  ])("refuses %s", async (_label, invoice, message) => {
    const client = invoiceClient({ invoice });
    expect(await refusalOf(prepareWrite(tool, { ...full, transactionId: 5101 }, client))).toContain(
      message,
    );
    expect(client.writes()).toEqual([]);
  });

  it("refuses an unknown check account or transaction with a trusted message", async () => {
    const missing = new SevdeskError({ kind: "not_found", message: "sevDesk found nothing." });
    const noAccount = new StagedClient(
      [
        documentRoute("invoice", invoiceRow()),
        { path: "/CheckAccount/4002", response: { error: missing } },
      ],
      [],
    );
    expect(await refusalOf(prepareWrite(tool, full, noAccount))).toBe(
      "Check account 4002 does not exist; list the accounts with sevdesk_bank_accounts_list.",
    );

    const noTransaction = new StagedClient(
      [
        documentRoute("invoice", invoiceRow()),
        accountRoute(accountRow(4002)),
        { path: "/CheckAccountTransaction/5101", response: { error: missing } },
      ],
      [],
    );
    expect(
      await refusalOf(prepareWrite(tool, { ...full, transactionId: 5101 }, noTransaction)),
    ).toBe("Bank transaction 5101 does not exist; find it with sevdesk_transactions_list.");
  });

  it("passes other read failures on unchanged", async () => {
    const client = new StagedClient(
      [
        documentRoute("invoice", invoiceRow()),
        {
          path: "/CheckAccount/4002",
          response: { error: new SevdeskError({ kind: "server", message: "Down." }) },
        },
      ],
      [],
    );
    await expect(prepareWrite(tool, full, client)).rejects.toMatchObject({ kind: "server" });
  });

  it("books an unpaid foreign-currency invoice on an account in the same currency", async () => {
    const usdInvoice = invoiceRow({
      currency: "USD",
      sumNetForeignCurrency: "168.07",
      sumTaxForeignCurrency: "31.93",
      sumGrossForeignCurrency: "200",
    });
    const client = invoiceClient({
      invoice: usdInvoice,
      account: accountRow(4005),
      transaction: transactionRow({
        amount: "200",
        checkAccount: { id: "4005", objectName: "CheckAccount" },
      }),
    });

    const { plan } = await executeWrite(
      tool,
      { ...full, amount: "200", checkAccountId: 4005, transactionId: 5101 },
      client,
    );

    expect(client.writes()[0]?.body).toMatchObject({ amount: 200, type: "FULL_PAYMENT" });
    expect(plan.preview.facts).toContainEqual({ label: "Open amount", value: "200.00 USD" });
  });

  it("refuses a partially paid foreign-currency invoice and an account in another currency", async () => {
    const partUsd = invoiceRow({
      currency: "USD",
      status: "750",
      paidAmount: 50,
      sumGrossForeignCurrency: "200",
    });
    expect(
      await refusalOf(
        prepareWrite(tool, { ...full, amount: "10" }, invoiceClient({ invoice: partUsd })),
      ),
    ).toContain("is in USD and already has payments");

    expect(
      await refusalOf(
        prepareWrite(
          tool,
          { ...full, checkAccountId: 4005, transactionId: 5101 },
          invoiceClient({ account: accountRow(4005) }),
        ),
      ),
    ).toContain("Check account 4005 is in USD, invoice 1001 in EUR");
  });

  it("rejects zero, negative and over-precise amounts in the input schema", () => {
    const parse = (amount: unknown) => tool.input.safeParse({ ...full, amount }).success;
    expect(parse("0")).toBe(false);
    expect(parse(-5)).toBe(false);
    expect(parse("1.005")).toBe(false);
    expect(parse("1.190,50")).toBe(false);
    expect(parse(0.1)).toBe(true);
    expect(tool.input.safeParse({ ...full, date: "02.11.2026" }).success).toBe(false);
  });
});

describe("sevdesk_credit_note_book_payment", () => {
  function creditNoteClient(transaction?: Row, account: Row = accountRow(4001)): StagedClient {
    return new StagedClient(
      [
        documentRoute("creditNote", creditNoteRow()),
        accountRoute(account),
        ...(transaction === undefined
          ? []
          : [transactionRoute(transaction), transactionLogRoute()]),
      ],
      [
        writeRoute("PUT", "/CreditNote/2001/bookAmount", "credit-note-book-amount.json"),
        documentRoute("creditNote", creditNoteRow({ status: "1000" })),
      ],
    );
  }

  it("sends the payout as a negative amount and says so in the preview", async () => {
    const client = creditNoteClient();

    const { plan, output } = await executeWrite(
      creditNoteTool,
      { id: 2001, amount: "23.80", date: "2026-11-02", checkAccountId: 4001 },
      client,
    );

    expect(client.writes()[0]).toMatchObject({
      path: "/CreditNote/2001/bookAmount",
      tier: "commit",
      body: {
        amount: -23.8,
        date: NOON_NOV_2,
        type: "FULL_PAYMENT",
        checkAccount: { id: 4001, objectName: "CheckAccount" },
      },
    });
    expect(plan.preview.action).toContain("Book a payout of 23.80 EUR on credit note GU-1001");
    expect(plan.preview.facts).toContainEqual({
      label: "Sent to sevDesk as",
      value: "amount -23.8 (money leaving the account)",
    });
    expect(output.data["creditNote"]).toMatchObject({ status: { code: 1000 } });
    expect(output.data["payment"]).toMatchObject({ amount: { amount: "23.80", currency: "EUR" } });
  });

  it("links only an outgoing transaction", async () => {
    const incoming = transactionRow({ checkAccount: { id: "4001", objectName: "CheckAccount" } });
    expect(
      await refusalOf(
        prepareWrite(
          creditNoteTool,
          { id: 2001, amount: "23.80", checkAccountId: 4001, transactionId: 5101 },
          creditNoteClient(incoming),
        ),
      ),
    ).toContain("is not an outgoing payment");

    const outgoing = transactionRow({
      amount: "-23.80",
      checkAccount: { id: "4001", objectName: "CheckAccount" },
    });
    const client = creditNoteClient(outgoing);
    await executeWrite(
      creditNoteTool,
      { id: 2001, amount: "23.80", checkAccountId: 4001, transactionId: 5101 },
      client,
    );
    expect(client.writes()[0]?.body).toMatchObject({
      amount: -23.8,
      checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
    });
  });

  it("refuses a partially paid credit note (sevDesk reports no paid amount)", async () => {
    const client = new StagedClient(
      [documentRoute("creditNote", creditNoteRow({ status: "750" }))],
      [],
    );
    expect(
      await refusalOf(
        prepareWrite(creditNoteTool, { id: 2001, amount: "5", checkAccountId: 4001 }, client),
      ),
    ).toContain("sevDesk does not report how much");
  });

  it("does not offer reminder charges", () => {
    expect(
      creditNoteTool.input.safeParse({
        id: 2001,
        amount: "30",
        checkAccountId: 4001,
        paymentType: "reminder_charges",
      }).success,
    ).toBe(false);
  });
});
