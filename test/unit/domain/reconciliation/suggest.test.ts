import { describe, expect, it } from "vitest";

import type { TransactionDto } from "../../../../src/domain/banking.js";
import {
  loadOpenItems,
  OPEN_ITEMS_SCAN_MAX,
  skipReason,
  suggestMatches,
} from "../../../../src/domain/reconciliation/suggest.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  creditNoteRow,
  invoiceRow,
  listRoute,
  logEntry,
  logRoute,
  type Row,
  transactionRoute,
  transactionRow,
  voucherRow,
} from "./helpers.js";

function fixtureRows(path: string): Row[] {
  return structuredClone((loadFixture(path).body as { objects: Row[] }).objects);
}

/** Open-item list routes: invoices 200/750, credit notes 200, vouchers 100/750. */
function openItemRoutes(items: {
  readonly invoices?: readonly Row[];
  readonly invoicesPartly?: readonly Row[];
  readonly creditNotes?: readonly Row[];
  readonly vouchers?: readonly Row[];
  readonly vouchersPartly?: readonly Row[];
}): FakeRoute[] {
  return [
    listRoute("/Invoice", items.invoices ?? [], { status: 200 }),
    listRoute("/Invoice", items.invoicesPartly ?? [], { status: 750 }),
    listRoute("/CreditNote", items.creditNotes ?? [], { status: 200 }),
    listRoute("/Voucher", items.vouchers ?? [], { status: 100 }),
    listRoute("/Voucher", items.vouchersPartly ?? [], { status: 750 }),
  ];
}

describe("loadOpenItems", () => {
  it("reads payable invoices and revenue vouchers for money in, with exact open amounts", async () => {
    const client = new FakeSevdeskClient(
      openItemRoutes({
        invoices: [
          invoiceRow(),
          invoiceRow({ id: "1101", invoiceType: "SR" }),
          invoiceRow({ id: "1102", invoiceType: "MA" }),
          invoiceRow({ id: "1103", invoiceType: "WKR" }),
          invoiceRow({ id: "1104", sumGross: "-10" }),
          invoiceRow({ id: "1105", paidAmount: "177.33" }),
          invoiceRow({ id: "1106", status: "1000" }),
        ],
        invoicesPartly: [
          invoiceRow({ id: "1201", status: "750", paidAmount: "77.33" }),
          invoiceRow({
            id: "1202",
            status: "750",
            currency: "USD",
            sumGrossForeignCurrency: "100",
            sumNetForeignCurrency: "100",
          }),
        ],
        vouchers: [
          voucherRow({ id: "2101", creditDebit: "D", supplierName: "Kunde AG", supplier: null }),
          voucherRow({ id: "2102", voucherType: "RV" }),
        ],
      }),
    );
    const read = await loadOpenItems(client, new Set(["in"]));
    expect(read.candidates.map((c) => [c.kind, c.id, c.open, c.direction])).toEqual([
      ["invoice", 1001, "177.33", "in"],
      ["invoice", 1201, "100", "in"],
      ["voucher", 2101, "298.1", "in"],
    ]);
    expect(read.candidates[0]).toMatchObject({
      number: "RE-1001",
      contactId: 1001,
      contactName: "Musterfirma GmbH",
      currency: "EUR",
      date: "2026-10-01",
    });
    expect(read.candidates[2]).toMatchObject({ number: "RE-2026-0042", contactName: "Kunde AG" });
    expect(read.excluded).toEqual({ notPayable: 4, openUnknown: 1, settled: 2 });
    expect(read.truncated).toBe(false);
    // Only revenue vouchers were asked for.
    const voucherCalls = client.callsTo("/Voucher");
    expect(voucherCalls.every((c) => c.query["creditDebit"] === "D")).toBe(true);
    expect(client.callsTo("/CreditNote")).toEqual([]);
  });

  it("reads open credit notes and expense vouchers for money out", async () => {
    const client = new FakeSevdeskClient(
      openItemRoutes({
        creditNotes: [creditNoteRow(), creditNoteRow({ id: "2002", status: "750" })],
        vouchers: [
          voucherRow(),
          voucherRow({ id: "2103", creditDebit: null }),
          voucherRow({ id: "2104", paidAmount: "-5" }),
          voucherRow({
            id: "2105",
            currency: "USD",
            paidAmount: "10",
            sumGrossForeignCurrency: "50",
          }),
        ],
        vouchersPartly: [voucherRow({ id: "2106", status: "750", paidAmount: null })],
      }),
    );
    const read = await loadOpenItems(client, new Set(["out"]));
    expect(read.candidates.map((c) => [c.kind, c.id, c.open, c.direction])).toEqual([
      ["creditNote", 2001, "23.8", "out"],
      ["voucher", 2001, "298.1", "out"],
    ]);
    expect(read.excluded.openUnknown).toBe(5);
    expect(client.callsTo("/Invoice")).toEqual([]);
  });

  it("lists an item once even when sevDesk ignores the status filter", async () => {
    const both = [voucherRow()];
    const client = new FakeSevdeskClient(openItemRoutes({ vouchers: both, vouchersPartly: both }));
    const read = await loadOpenItems(client, new Set(["in", "out"]));
    expect(read.candidates.filter((c) => c.kind === "voucher")).toHaveLength(1);
    expect(client.callsTo("/Voucher").every((c) => c.query["creditDebit"] === undefined)).toBe(
      true,
    );
  });

  it("stops at the row cap and reports it", async () => {
    const base = invoiceRow();
    const many = Array.from({ length: OPEN_ITEMS_SCAN_MAX + 1 }, (_, i) => ({
      ...base,
      id: String(100_000 + i),
    }));
    const read = await loadOpenItems(
      new FakeSevdeskClient(openItemRoutes({ invoices: many })),
      new Set(["in"]),
    );
    expect(read.truncated).toBe(true);
    expect(read.scanned).toBe(OPEN_ITEMS_SCAN_MAX);
  });
});

describe("skipReason", () => {
  const dto = (overrides: Partial<TransactionDto> = {}): TransactionDto => ({
    id: 1,
    account: { id: 4002 },
    amount: { amount: "10", currency: "EUR" },
    direction: "in",
    status: { code: 100, label: "Created" },
    enshrined: false,
    ...overrides,
  });
  const known = { known: true as const, total: "10", assigned: "0", remaining: "10" };

  it.each([
    [{ enshrined: true }, known, "It is enshrined (festgeschrieben) and cannot be booked anymore."],
    [{ status: { code: 300, label: "x" } }, known, "It is marked as private."],
    [{ status: { code: 400, label: "x" } }, known, "It is already booked."],
    [{ status: { code: 350, label: "x" } }, known, "It is already booked."],
    [{ status: { code: 250, label: "x" } }, known, "It has status 250, which cannot be booked."],
    [{ status: undefined }, known, "It has status unknown, which cannot be booked."],
    [{ account: undefined }, known, "It belongs to no check account."],
    [{ direction: "none" as const }, known, "Its amount is zero."],
    [{}, { known: false as const, reason: "why" }, "Its remaining amount is unknown: why."],
    [{}, { ...known, remaining: "0" }, "Nothing of it is left to assign."],
  ])("skips %j", (overrides, remaining, reason) => {
    expect(skipReason(dto(overrides), remaining)).toBe(reason);
  });

  it("accepts a free or partly linked transaction with something left", () => {
    expect(skipReason(dto(), known)).toBeUndefined();
    expect(skipReason(dto({ status: { code: 200, label: "x" } }), known)).toBeUndefined();
  });
});

describe("suggestMatches", () => {
  const invoices = fixtureRows("invoices/invoices-list.json");

  it("suggests for one transaction, reading its log and the open items once", async () => {
    const client = new FakeSevdeskClient([
      transactionRoute(transactionRow()),
      accountRoute(accountRow(4002)),
      logRoute(5101, []),
      ...openItemRoutes({
        invoices: invoices.filter((row) => row["status"] === "200"),
        invoicesPartly: invoices.filter((row) => row["status"] === "750"),
      }),
    ]);
    const result = await suggestMatches(client, {
      transactionId: 5101,
      limit: 10,
      offset: 0,
      matchesPerTransaction: 3,
    });
    const [suggestion] = result.suggestions;
    expect(suggestion?.skipped).toBeUndefined();
    expect(suggestion?.remaining).toMatchObject({ known: true, remaining: "177.33" });
    const first = suggestion?.matches[0];
    expect(first?.type).toBe("single");
    if (first?.type !== "single") throw new Error("expected a single");
    expect(first.candidate.id).toBe(1001);
    expect(first.confidence).toBe("high");
    // RE-1007 has the same amount but not the number: ranked after.
    expect(suggestion?.matches.map((m) => (m.type === "single" ? m.candidate.id : 0))).toContain(
      1007,
    );
    expect(suggestion?.excluded.currency).toBe(1);
    expect(result.openItems?.truncated).toBe(false);
    expect(client.writes()).toEqual([]);
  });

  it("scans unassigned transactions of an account and matches outgoing ones to vouchers", async () => {
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", fixtureRows("banking/transactions-list.json")),
      ...openItemRoutes({ vouchers: [voucherRow()] }),
    ]);
    const result = await suggestMatches(client, {
      checkAccountId: 4002,
      from: "2026-01-01",
      to: "2026-01-31",
      limit: 10,
      offset: 0,
      matchesPerTransaction: 3,
    });
    expect(result.suggestions.map((s) => s.transaction.id)).toEqual([5001]);
    const [match] = result.suggestions[0]?.matches ?? [];
    expect(match?.type === "single" && match.candidate.id).toBe(2001);
    expect(match?.confidence).toBe("high");
    expect(result.hasMore).toBe(false);
    expect(result.rowsScanned).toBe(7);
    expect(client.callsTo("/CheckAccountTransactionLog")).toEqual([]);
  });

  it("reads the log of partly linked transactions and skips what cannot be booked", async () => {
    const client = new FakeSevdeskClient([
      accountsListRoute(),
      listRoute("/CheckAccountTransaction", fixtureRows("banking/transactions-list.json")),
      logRoute(5006, [logEntry(1, 5006, "Voucher", 2001, -100)]),
      ...openItemRoutes({ vouchers: [voucherRow()] }),
    ]);
    const result = await suggestMatches(client, {
      limit: 10,
      offset: 0,
      matchesPerTransaction: 2,
    });
    const byId = new Map(result.suggestions.map((s) => [s.transaction.id, s]));
    expect([...byId.keys()]).toEqual([5001, 5004, 5006, 5007]);
    expect(byId.get(5006)?.skipped).toBe(
      "It is enshrined (festgeschrieben) and cannot be booked anymore.",
    );
    expect(byId.get(5006)?.remaining).toMatchObject({ known: true, remaining: "278" });
    expect(byId.get(5001)?.matches.length).toBeGreaterThan(0);
    expect(client.callsTo("/CheckAccountTransactionLog")).toHaveLength(1);
  });

  it("reads no open items when no transaction can be booked", async () => {
    const client = new FakeSevdeskClient([
      transactionRoute(transactionRow({ status: "400" })),
      accountRoute(accountRow(4002)),
      logRoute(5101, [logEntry(1, 5101, "Invoice", 1001, 177.33)]),
    ]);
    const result = await suggestMatches(client, {
      transactionId: 5101,
      limit: 10,
      offset: 0,
      matchesPerTransaction: 3,
    });
    expect(result.openItems).toBeUndefined();
    expect(result.suggestions[0]?.skipped).toBe("It is already booked.");
    expect(result.suggestions[0]?.matches).toEqual([]);
  });
});
