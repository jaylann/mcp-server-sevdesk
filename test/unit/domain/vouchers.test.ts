import { describe, expect, it } from "vitest";

import {
  bookingAmountSign,
  creditDebitForKind,
  describeInterval,
  getVoucherDetails,
  listVouchers,
  type VoucherDto,
  voucherKindFromCreditDebit,
} from "../../../src/domain/vouchers.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";

const PAGE = { limit: 100, offset: 0 };

async function rows(objects?: readonly unknown[]): Promise<readonly VoucherDto[]> {
  const response =
    objects === undefined
      ? { fixture: "vouchers/vouchers-list.json" }
      : { body: { objects: [...objects] } };
  const client = new FakeSevdeskClient([{ path: "/Voucher", response }]);
  return (await listVouchers(client, PAGE)).items;
}

async function row(id: number): Promise<VoucherDto> {
  const found = (await rows()).find((item) => item.id === id);
  if (found === undefined) throw new Error(`fixture has no voucher ${id}`);
  return found;
}

describe("voucher vocabulary", () => {
  it("maps creditDebit C to expense and D to revenue, case-insensitively", () => {
    expect(voucherKindFromCreditDebit("C")).toBe("expense");
    expect(voucherKindFromCreditDebit("D")).toBe("revenue");
    expect(voucherKindFromCreditDebit(" d ")).toBe("revenue");
    expect(voucherKindFromCreditDebit("X")).toBeUndefined();
    expect(voucherKindFromCreditDebit(undefined)).toBeUndefined();
    expect(creditDebitForKind("expense")).toBe("C");
    expect(creditDebitForKind("revenue")).toBe("D");
  });

  it("signs payments as they flow over the account", () => {
    expect(bookingAmountSign("expense")).toBe(-1);
    expect(bookingAmountSign("revenue")).toBe(1);
  });

  it("describes ISO 8601 intervals in any of sevDesk's spellings (D-007)", () => {
    expect(describeInterval("P0Y1M")).toBe("every 1 month");
    expect(describeInterval("P0Y1M0W")).toBe("every 1 month");
    expect(describeInterval("P0Y0M2W")).toBe("every 2 weeks");
    expect(describeInterval("P1Y0M0W")).toBe("every 1 year");
    expect(describeInterval("P0Y3M")).toBe("every 3 months");
    expect(describeInterval("P1Y6M")).toBe("every 1 year 6 months");
    expect(describeInterval("P10D")).toBe("every 10 days");
    expect(describeInterval("P0Y0M0W")).toBeUndefined();
    expect(describeInterval("monthly")).toBeUndefined();
  });
});

describe("voucher DTO mapping", () => {
  it("keeps the legacy 1.0 voucher: taxType instead of taxRule, no supplier contact", async () => {
    expect(await row(2003)).toEqual({
      id: 2003,
      number: "Kassenbon 0815",
      supplier: { name: "Bürobedarf Muster KG" },
      date: "2023-05-02",
      payDate: "2023-05-02",
      status: { code: 1000, label: "Paid" },
      kind: "expense",
      type: "normal",
      currency: "EUR",
      totals: {
        net: { amount: "50.00", currency: "EUR" },
        tax: { amount: "9.50", currency: "EUR" },
        gross: { amount: "59.50", currency: "EUR" },
      },
      paid: { amount: "59.50", currency: "EUR" },
      link: "https://my.sevdesk.de/ex/detail/id/2003",
    });
  });

  it("shows foreign-currency vouchers in their own currency with the EUR base apart", async () => {
    const voucher = await row(2004);
    expect(voucher).toMatchObject({
      currency: "USD",
      totals: {
        net: { amount: "378.00", currency: "USD" },
        tax: { amount: "0.00", currency: "USD" },
        gross: { amount: "378.00", currency: "USD" },
      },
      totalsEur: {
        net: { amount: "324.59", currency: "EUR" },
        tax: { amount: "0.00", currency: "EUR" },
        gross: { amount: "324.59", currency: "EUR" },
      },
      paid: { amount: "0.00", currency: "EUR" },
    });
  });

  it("fails the list with unexpected_response on a currency that is not ISO 4217", async () => {
    // Before, money() threw a MoneyError, which surfaced as a generic internal error.
    await expect(rows([{ id: "9001", currency: "€", sumGross: "1.00" }])).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });

  it("uses the plain sums when a foreign-currency voucher has no foreign sums", async () => {
    const [voucher] = await rows([
      { id: "2100", currency: "chf", sumGross: "10", sumGrossForeignCurrency: "0" },
    ]);
    expect(voucher).toMatchObject({
      currency: "CHF",
      totals: { gross: { amount: "10.00", currency: "CHF" } },
    });
    expect(voucher?.totalsEur).toBeUndefined();
  });

  it("warns when paidAmount is negative: a payment booked with the wrong sign", async () => {
    const voucher = await row(2005);
    expect(voucher.status).toEqual({ code: 750, label: "Partially paid" });
    expect(voucher.paid).toEqual({ amount: "-119.00", currency: "EUR" });
    expect(voucher.warnings).toEqual([expect.stringContaining("wrong sign")]);
    expect((await row(2001)).warnings).toBeUndefined();
  });

  it("labels recurring vouchers and keeps unknown status codes and kinds", async () => {
    expect(await row(2006)).toMatchObject({
      type: "recurring",
      supplier: { name: "Musterhosting GmbH" },
    });
    const [odd] = await rows([
      { id: "2100", status: "300", creditDebit: null, voucherType: "XX", currency: null },
    ]);
    expect(odd).toEqual({
      id: 2100,
      status: { code: 300, label: "unknown" },
      currency: "EUR",
      totals: {},
      link: "https://my.sevdesk.de/ex/detail/id/2100",
    });
  });

  it("falls back to supplierNameAtSave and sanitizes untrusted text", async () => {
    const hidden = String.fromCodePoint(0x200b);
    const [voucher] = await rows([
      {
        id: "2100",
        supplierName: null,
        supplierNameAtSave: `Muster${hidden} AG`,
        description: `  RE-1${hidden}  `,
      },
    ]);
    expect(voucher).toMatchObject({ number: "RE-1", supplier: { name: "Muster AG" } });
  });

  it("caps long descriptions", async () => {
    const [voucher] = await rows([{ id: "2100", description: "x".repeat(500) }]);
    expect(voucher?.number).toMatch(/^x{200}… \[truncated 300 chars\]$/);
  });

  it("fails loudly on an unreadable date or amount instead of dropping the row", async () => {
    await expect(rows([{ id: "2100", voucherDate: "yesterday" }])).rejects.toMatchObject({
      kind: "unexpected_response",
    });
    await expect(rows([{ id: "2100", sumGross: "1,5" }])).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });
});

describe("getVoucherDetails", () => {
  function client(voucher: Record<string, unknown>, positions: readonly unknown[]) {
    return new FakeSevdeskClient([
      { path: "/Voucher/2100", response: { body: { objects: [{ id: "2100", ...voucher }] } } },
      { path: "/VoucherPos", response: { body: { objects: [...positions] } } },
    ]);
  }

  it("keeps an unknown tax rule id without a name and reads legacy tax types", async () => {
    const withRule = await getVoucherDetails(
      client({ taxRule: { id: "99", objectName: "TaxRule" } }, []),
      2100,
    );
    expect(withRule.voucher.tax).toEqual({ generation: "2.0", rule: { id: 99 } });

    const legacy = await getVoucherDetails(client({ taxType: "eu", taxRule: null }, []), 2100);
    expect(legacy.voucher.tax).toEqual({ generation: "1.0", taxType: "eu" });
    expect(legacy.positions).toEqual([]);
  });

  it("describes a recurring voucher and leaves out unparsable intervals' text form", async () => {
    const details = await getVoucherDetails(
      client(
        {
          voucherType: "RV",
          recurringInterval: "P0Y0M2W",
          recurringNextVoucher: "2026-12-01T00:00:00+01:00",
          document: null,
        },
        [],
      ),
      2100,
    );
    expect(details.voucher.recurring).toEqual({
      interval: "P0Y0M2W",
      every: "every 2 weeks",
      nextDate: "2026-12-01",
    });
    expect(details.voucher.hasDocument).toBe(false);

    const odd = await getVoucherDetails(client({ recurringInterval: "R/P1M" }, []), 2100);
    expect(odd.voucher.recurring).toEqual({ interval: "R/P1M" });
  });

  it("shows positions of a foreign-currency voucher in the voucher's currency", async () => {
    const details = await getVoucherDetails(
      client({ currency: "USD", creditDebit: "C" }, [
        {
          id: "3100",
          voucher: { id: "2100", objectName: "Voucher" },
          accountDatev: { id: "3797", objectName: "AccountDatev" },
          accountingType: { id: "26", objectName: "AccountingType" },
          taxRate: "0",
          sumNet: "324.59",
          sumGross: "324.59",
          sumNetForeignCurrency: "378",
          sumGrossForeignCurrency: "378",
        },
        { id: "3101", voucher: { id: "2100", objectName: "Voucher" }, comment: "" },
      ]),
      2100,
    );
    expect(details.voucher.paymentDirection).toBe("out");
    expect(details.positions).toEqual([
      {
        id: 3100,
        taxRate: "0",
        totals: {
          net: { amount: "378.00", currency: "USD" },
          gross: { amount: "378.00", currency: "USD" },
        },
        totalsEur: {
          net: { amount: "324.59", currency: "EUR" },
          gross: { amount: "324.59", currency: "EUR" },
        },
        // Both booking references present: Update 2.0 wins, the legacy one is not shown.
        generation: "2.0",
        accountDatev: { id: 3797 },
      },
      { id: 3101 },
    ]);
  });

  it("rejects an invalid id locally", async () => {
    await expect(getVoucherDetails(client({}, []), 0)).rejects.toMatchObject({
      kind: "validation",
    });
  });
});
