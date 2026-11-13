import { describe, expect, it } from "vitest";

import type { TransactionDto } from "../../../../src/domain/banking.js";
import { inLanguage, type Phrase } from "../../../../src/domain/preview-text.js";
import {
  assertMarkablePrivate,
  MAX_RESET_DOCUMENTS,
  planTransactionReset,
  statusPayload,
} from "../../../../src/domain/reconciliation/transaction-status.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  accountRoute,
  accountRow,
  creditNoteRoute,
  creditNoteRow,
  invoiceRoute,
  invoiceRow,
  listRoute,
  logEntry,
  logRoute,
  type Row,
  transactionRoute,
  transactionRow,
} from "./helpers.js";

/** The English wording of preview sentences. */
const english = (phrases: readonly Phrase[]): string[] => inLanguage(phrases, "en");

function dto(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 5101,
    amount: { amount: "-45.99", currency: "EUR" },
    direction: "out",
    status: { code: 100, label: "Created" },
    enshrined: false,
    ...overrides,
  };
}

function paidInvoice(id: number, paid: string, overrides: Row = {}): Row {
  return invoiceRow({
    id: String(id),
    invoiceNumber: `RE-${String(id)}`,
    status: "1000",
    sumGross: "119",
    sumNet: "100",
    sumTax: "19",
    paidAmount: paid,
    ...overrides,
  });
}

const SPLIT_LOG = [
  logEntry(7001, 5201, "Invoice", 1001, 119),
  logEntry(7002, 5201, "Invoice", 1002, 119),
];

/** `count` minimal log rows of transaction 1 (cheap: no fixture reads). */
function bulkLog(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(100_000 + i),
    checkAccountTransaction: { id: "1", objectName: "CheckAccountTransaction" },
    object: { id: "1", objectName: "Invoice" },
    amountPaid: 1,
  }));
}

function client(options: {
  readonly transaction?: Row;
  readonly log?: readonly Row[];
  readonly documents?: readonly FakeRoute[];
  /** The unfiltered log (`GET /CheckAccountTransactionLog` without a transaction filter). */
  readonly wholeLog?: readonly Row[];
}): FakeSevdeskClient {
  const transaction =
    options.transaction ?? transactionRow({ id: "5201", amount: "238", status: "400" });
  const accountId = Number((transaction["checkAccount"] as { id?: string } | null)?.id ?? 4002);
  return new FakeSevdeskClient(
    withCountryRoute([
      transactionRoute(transaction),
      accountRoute(accountRow(accountId)),
      logRoute(Number(transaction["id"]), options.log ?? SPLIT_LOG),
      ...(options.documents ?? [
        invoiceRoute(paidInvoice(1001, "119")),
        invoiceRoute(paidInvoice(1002, "119")),
      ]),
      listRoute("/CheckAccountTransactionLog", options.wholeLog ?? []),
    ]),
  );
}

async function refusal(fake: FakeSevdeskClient, id = 5201): Promise<string> {
  const error = await planTransactionReset(fake, id).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(fake.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

describe("statusPayload", () => {
  it("builds the strict private and unbooked bodies", () => {
    expect(statusPayload("private")).toEqual({ status: 300 });
    expect(statusPayload("created")).toEqual({ status: 100 });
  });
});

describe("assertMarkablePrivate", () => {
  it("names a withdrawal for money out and a deposit for money in", () => {
    expect(assertMarkablePrivate(dto())).toBe("Privatentnahme");
    expect(
      assertMarkablePrivate(dto({ direction: "in", amount: { amount: "10", currency: "EUR" } })),
    ).toBe("Privateinlage");
  });

  it.each([
    [{ enshrined: true }, "is enshrined (festgeschrieben) and cannot be changed anymore"],
    [{ status: { code: 300, label: "Private" } }, "is already marked as private"],
    [{ status: { code: 400, label: "Booked" } }, "status 400); only unbooked transactions"],
    [{ status: undefined }, "status unknown); only unbooked"],
    [{ direction: "none" as const }, "has the amount zero"],
  ])("refuses %j", (overrides, text) => {
    expect(() => assertMarkablePrivate(dto(overrides))).toThrow(text);
  });
});

describe("planTransactionReset", () => {
  it("sets a private transaction back without reading its log", async () => {
    const fake = client({ transaction: transactionRow({ id: "5201", status: "300" }) });
    const plan = await planTransactionReset(fake, 5201);
    expect(plan.mode).toBe("private");
    expect(english(plan.warnings)).toEqual([
      "The transaction is no longer private: it counts as unbooked again and can be booked to " +
        "documents (sevdesk_reconcile_suggest, sevdesk_transaction_book).",
    ]);
    expect(fake.callsTo("/CheckAccountTransactionLog")).toEqual([]);
  });

  it("lists every document of a split with its share and no collateral", async () => {
    const plan = await planTransactionReset(client({}), 5201);
    if (plan.mode !== "linked") throw new Error("expected linked");
    expect(plan.documents.map((d) => [d.doc.id, d.share, d.otherPayments])).toEqual([
      [1001, "119", "0"],
      [1002, "119", "0"],
    ]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]?.en).toContain("removes ALL payments booked on it");
  });

  it("finds the other transactions on a document in the whole log and names them", async () => {
    const log = [logEntry(1, 5201, "Invoice", 1001, 100), logEntry(2, 5201, "Invoice", 1001, 19)];
    const fake = client({
      log,
      documents: [invoiceRoute(paidInvoice(1001, "177.33", { sumGross: "177.33" }))],
      wholeLog: [
        ...log,
        logEntry(3, 5302, "Invoice", 1001, 50),
        logEntry(4, 5302, "Invoice", 1001, 8.33),
        logEntry(5, 5303, "Invoice", 1002, 99),
        logEntry(6, 5304, "Order", 1001, 1),
        logEntry(7, 5305, "Invoice", 1001, 1),
        logEntry(8, 5305, "Voucher", 2001, 5),
      ],
    });
    const plan = await planTransactionReset(fake, 5201);
    if (plan.mode !== "linked") throw new Error("expected linked");
    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0]?.share).toBe("119");
    expect(plan.documents[0]?.otherPayments).toBe("58.33");
    // 5302 paid only this invoice: unbooked afterwards; 5305 still pays voucher 2001: 200.
    expect(plan.documents[0]?.otherTransactions).toEqual([
      { id: 5302, amount: "58.33", statusAfter: 100 },
      { id: 5305, amount: "1", statusAfter: 200 },
    ]);
    expect(english(plan.warnings)).toContain(
      "Invoice 1001 also loses its payments from bank transaction 5302 (58.33 EUR, then " +
        "unbooked (100)), bank transaction 5305 (1.00 EUR, then partly linked (200)); book them " +
        "again afterwards if they stand.",
    );
    expect(plan.warnings[0]?.en).toContain(
      "This transaction loses all its bookings and goes back to unbooked (status 100).",
    );
    expect(plan.warnings[0]?.en).toContain("goes back to partly linked (200)");
  });

  it("says when the paid amount shows more than the log explains", async () => {
    const fake = client({
      log: [logEntry(1, 5201, "Invoice", 1001, 119)],
      documents: [invoiceRoute(paidInvoice(1001, "177.33", { sumGross: "177.33" }))],
      wholeLog: [logEntry(1, 5201, "Invoice", 1001, 119), logEntry(2, 5302, "Invoice", 1001, null)],
    });
    const plan = await planTransactionReset(fake, 5201);
    if (plan.mode !== "linked") throw new Error("expected linked");
    expect(plan.documents[0]?.otherTransactions).toEqual([
      { id: 5302, amount: undefined, statusAfter: 100 },
    ]);
    expect(english(plan.warnings)).toContain(
      "Invoice 1001 also loses its payments from bank transaction 5302 (then unbooked (100)); " +
        "book them again afterwards if they stand.",
    );
    expect(english(plan.warnings)).toContain(
      "Invoice 1001 shows 58.33 EUR more paid than its bank transactions explain; that payment " +
        "is removed too.",
    );
  });

  it("scans the log for credit notes, which report no paid amount", async () => {
    const fake = client({
      transaction: transactionRow({ id: "5201", amount: "-23.8", status: "400" }),
      log: [logEntry(1, 5201, "CreditNote", 2001, -23.8)],
      documents: [creditNoteRoute(creditNoteRow({ status: "1000" }))],
      wholeLog: [logEntry(1, 5201, "CreditNote", 2001, -23.8)],
    });
    const plan = await planTransactionReset(fake, 5201);
    if (plan.mode !== "linked") throw new Error("expected linked");
    expect(plan.documents[0]?.otherPayments).toBeUndefined();
    expect(plan.documents[0]?.otherTransactions).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
  });

  it("does not scan the whole log when the paid amounts show no other payments", async () => {
    const fake = client({});
    await planTransactionReset(fake, 5201);
    const logCalls = fake.callsTo("/CheckAccountTransactionLog");
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]?.query["checkAccountTransaction[id]"]).toBe(5201);
  });

  it("refuses when other payments exist but the log cannot name their transactions", async () => {
    const base = {
      log: [logEntry(1, 5201, "Invoice", 1001, 119)],
      documents: [invoiceRoute(paidInvoice(1001, "177.33", { sumGross: "177.33" }))],
    };
    const tooLarge = client({ ...base, wholeLog: bulkLog(50_001) });
    expect(await refusal(tooLarge)).toBe(
      "Bank transaction 5201: the documents it paid have other payments, and sevDesk's booking " +
        "log is too large to read completely, so the reset cannot list every bank transaction " +
        "it would unlink; nothing is reset. Reset the documents in the sevDesk web app or one by " +
        "one with their reset tools (sevdesk_invoice_reset, sevdesk_credit_note_reset, " +
        "sevdesk_voucher_reset).",
    );
    const unnamed = client({
      ...base,
      wholeLog: [{ ...logEntry(2, 1, "Invoice", 1001, 58.33), checkAccountTransaction: null }],
    });
    expect(await refusal(unnamed)).toContain(
      "its booking log has an entry on them that names no transaction",
    );
  });

  it("warns that sevDesk deletes transactions it created on offline and cash accounts", async () => {
    const fake = client({
      transaction: transactionRow({
        id: "5201",
        amount: "238",
        status: "400",
        checkAccount: { id: "4001", objectName: "CheckAccount" },
      }),
    });
    const plan = await planTransactionReset(fake, 5201);
    expect(plan.warnings.at(-1)?.en).toContain("such a transaction is deleted by the reset");
  });

  it("refuses unknown, enshrined and unbooked transactions", async () => {
    const missing = new FakeSevdeskClient([
      {
        path: "/CheckAccountTransaction/5201",
        response: { error: new SevdeskError({ kind: "not_found", message: "x" }) },
      },
    ]);
    expect(await refusal(missing)).toBe(
      "Bank transaction 5201 does not exist; find it with sevdesk_transactions_list.",
    );
    expect(
      await refusal(
        client({
          transaction: transactionRow({ id: "5201", enshrined: "2026-03-01T00:00:00+01:00" }),
        }),
      ),
    ).toContain("is enshrined (festgeschrieben)");
    expect(await refusal(client({ transaction: transactionRow({ id: "5201" }) }))).toBe(
      "Bank transaction 5201 is not booked (status 100); there is nothing to reset.",
    );
    expect(
      await refusal(client({ transaction: transactionRow({ id: "5201", status: null }) })),
    ).toBe("Bank transaction 5201 is not booked (status unknown); there is nothing to reset.");
  });

  it("refuses a log it cannot fully attribute", async () => {
    expect(await refusal(client({ log: [] }))).toContain("links it to no document");
    expect(await refusal(client({ log: [logEntry(1, 5201, "Order", 3001, 238)] }))).toContain(
      "linked to a record other than an invoice, credit note or voucher",
    );
    expect(await refusal(client({ log: [logEntry(1, 5201, "Invoice", 1001, null)] }))).toBe(
      "Bank transaction 5201: its booking log has an entry without an amount; nothing is reset.",
    );
    const ignored = [
      logEntry(1, 9999, "Invoice", 1, 1),
      { ...logEntry(2, 5201, "Invoice", 1001, 119), checkAccountTransaction: null },
    ];
    expect(await refusal(client({ log: ignored }))).toContain(
      "its booking log could not be read completely",
    );
  });

  it("refuses more documents than it resets at once", async () => {
    const log = Array.from({ length: MAX_RESET_DOCUMENTS + 1 }, (_, i) =>
      logEntry(i + 1, 5201, "Invoice", 1000 + i, 1),
    );
    expect(await refusal(client({ log }))).toContain("is linked to 11 documents");
  });

  it("refuses enshrined, missing and non-resettable documents", async () => {
    const enshrined = client({
      documents: [
        invoiceRoute(paidInvoice(1001, "119", { enshrined: "2026-03-01T00:00:00+01:00" })),
      ],
      log: [logEntry(1, 5201, "Invoice", 1001, 119)],
    });
    expect(await refusal(enshrined)).toBe(
      "Invoice 1001 is enshrined (festgeschrieben); this tool does not reset enshrined " +
        "documents. Use sevdesk_invoice_reset if it must be done.",
    );
    const gone = client({
      documents: [
        {
          path: "/Invoice/1001",
          response: { error: new SevdeskError({ kind: "not_found", message: "x" }) },
        },
      ],
      log: [logEntry(1, 5201, "Invoice", 1001, 119)],
    });
    expect(await refusal(gone)).toContain("no longer exists");
    const draft = client({
      documents: [invoiceRoute(paidInvoice(1001, "0", { status: "100" }))],
      log: [logEntry(1, 5201, "Invoice", 1001, 119)],
    });
    expect(await refusal(draft)).toContain("is a draft");
  });
});
