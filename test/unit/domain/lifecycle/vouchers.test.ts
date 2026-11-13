/**
 * Vouchers in the lifecycle domain: the snapshot, the per-kind status table, the payment direction
 * from `creditDebit` (D-041) and the booking date of `bookAmount`.
 */
import { describe, expect, it } from "vitest";

import {
  KINDS,
  readLifecycleDocument,
  STATUS,
  statusOf,
  toLifecycleDocument,
  VOUCHER_STATUS,
} from "../../../../src/domain/lifecycle/documents.js";
import {
  BOOKING_DATE_FORMATS,
  bookingTimestamp,
  paymentDirection,
  paymentSign,
  planPayment,
  wireBookingDate,
} from "../../../../src/domain/lifecycle/payments.js";
import { documentFacts, documentTitle } from "../../../../src/domain/lifecycle/preview.js";
import {
  assertBookable,
  assertEnshrinable,
  assertResettable,
} from "../../../../src/domain/lifecycle/transitions.js";
import { mapVoucherDetail } from "../../../../src/domain/vouchers.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { zOptionalDecimal } from "../../../../src/sevdesk/schema.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { openVoucherRow, type Row, voucherRoute } from "../../tools/vouchers/routes.js";
import { creditNoteDoc, invoiceDoc, orderDoc } from "./docs.js";

function voucherDoc(overrides: Row = {}) {
  const row = openVoucherRow({ enshrined: null, ...overrides });
  return toLifecycleDocument(
    "voucher",
    mapVoucherDetail(row),
    zOptionalDecimal.parse(row["paidAmount"]),
  );
}

function refusal(check: () => unknown): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SevdeskError);
    return (error as SevdeskError).message;
  }
}

describe("voucher snapshots", () => {
  it("reads GET /Voucher/{id} without an embed and maps the voucher", async () => {
    const fake = new FakeSevdeskClient([voucherRoute(openVoucherRow())]);
    const doc = await readLifecycleDocument(fake, "voucher", 2001, { cacheOwner: fake });
    expect(fake.calls[0]).toMatchObject({ path: "/Voucher/2001", query: {} });
    expect(doc).toMatchObject({
      kind: "voucher",
      id: 2001,
      number: "RE-2026-0042",
      typeCode: "VOU",
      typeLabel: "Beleg",
      status: 100,
      statusLabel: "Unpaid / due",
      contact: { id: 1003, name: "Beispiel Lieferant AG" },
      partyName: undefined,
      date: "2026-01-12",
      dueDate: "2026-01-26",
      currency: "EUR",
      paidAmount: "0",
      enshrined: true,
      direction: "out",
    });
    expect(doc.totals.gross).toEqual({ amount: "298.10", currency: "EUR" });
  });

  it("keeps a typed-in supplier without contact as partyName, revenue as direction in", () => {
    const doc = voucherDoc({ supplier: null, supplierName: "Tankstelle Nord", creditDebit: "D" });
    expect(doc.contact).toBeUndefined();
    expect(doc.partyName).toBe("Tankstelle Nord");
    expect(doc.direction).toBe("in");
    expect(voucherDoc({ creditDebit: null }).direction).toBeUndefined();
  });

  it("refuses a voucher without a status", () => {
    const error = refusal(() => voucherDoc({ status: null }));
    expect(error).toBe("sevDesk returned voucher 2001 without a status.");
  });

  it("gives the sales kinds their fixed direction", () => {
    expect(invoiceDoc().direction).toBe("in");
    expect(creditNoteDoc().direction).toBe("out");
    expect(orderDoc().direction).toBe("in");
    expect(invoiceDoc().partyName).toBeUndefined();
  });

  it("has a status table per kind", () => {
    expect(statusOf(voucherDoc())).toEqual({
      draft: 50,
      open: 100,
      partiallyPaid: 750,
      paid: 1000,
    });
    expect(statusOf(invoiceDoc())).toBe(STATUS);
    expect(KINDS.voucher.status).toBe(VOUCHER_STATUS);
  });
});

describe("voucher previews", () => {
  it("names a voucher by its id only: its Belegnummer is third-party text (facts only)", () => {
    expect(documentTitle(voucherDoc())).toBe("voucher 2001");
    expect(documentTitle(voucherDoc({ description: null }))).toBe("voucher 2001");
  });

  it("lists kind and supplier, a typed-in name without contact", () => {
    expect(documentFacts(voucherDoc())).toEqual([
      { label: "Voucher (Beleg)", value: "RE-2026-0042 (id 2001)" },
      { label: "Type", value: "Beleg (VOU)" },
      { label: "Status", value: "Unpaid / due (100)" },
      { label: "Kind", value: "expense (Ausgabe)" },
      { label: "Supplier (Lieferant)", value: "Beispiel Lieferant AG (contact 1003)" },
      { label: "Date", value: "2026-01-12" },
      { label: "Due date", value: "2026-01-26" },
      { label: "Net", value: "250.50 EUR" },
      { label: "Tax", value: "47.60 EUR" },
      { label: "Gross", value: "298.10 EUR" },
      { label: "Paid so far", value: "0.00 EUR" },
    ]);
    const revenue = documentFacts(
      voucherDoc({ supplier: null, supplierName: "Kasse", creditDebit: "D", description: null }),
    );
    expect(revenue[0]).toEqual({ label: "Voucher (Beleg)", value: "id 2001, no Belegnummer" });
    expect(revenue).toContainEqual({ label: "Kind", value: "revenue (Einnahme)" });
    expect(revenue).toContainEqual({ label: "Customer (Kunde)", value: "Kasse (no contact)" });
    const unknown = documentFacts(voucherDoc({ creditDebit: null }));
    expect(unknown.map((fact) => fact.label)).not.toContain("Kind");
  });
});

describe("voucher payments", () => {
  it("signs by the voucher's own direction (D-041)", () => {
    expect(paymentSign(voucherDoc())).toBe(-1);
    expect(paymentDirection(voucherDoc())).toBe("out");
    expect(paymentSign(voucherDoc({ creditDebit: "D" }))).toBe(1);
    expect(paymentSign("invoice")).toBe(1);
    expect(paymentSign(creditNoteDoc())).toBe(-1);
    expect(refusal(() => paymentSign(voucherDoc({ creditDebit: null })))).toContain(
      "does not say whether it is an expense or revenue",
    );
  });

  it("plans a full payment of an expense voucher as money out", () => {
    const plan = planPayment(voucherDoc(), {
      amount: "298.1",
      paymentType: "payment",
      date: "2026-11-02",
      checkAccountId: 4001,
    });
    expect(plan.payload).toEqual({
      amount: -298.1,
      date: bookingTimestamp("2026-11-02"),
      type: "FULL_PAYMENT",
      checkAccount: { id: 4001, objectName: "CheckAccount" },
    });
  });

  it("refuses reminder charges on vouchers", () => {
    expect(
      refusal(() =>
        planPayment(voucherDoc(), {
          amount: "300",
          paymentType: "reminder_charges",
          date: "2026-11-02",
          checkAccountId: 4001,
        }),
      ),
    ).toBe("Reminder charges can only be booked on invoices.");
  });

  it("writes the booking date as Unix noon, or as ISO when a kind is switched to it", () => {
    expect(wireBookingDate("voucher", "2026-11-02")).toBe(bookingTimestamp("2026-11-02"));
    const formats = BOOKING_DATE_FORMATS as Record<string, "unix" | "iso">;
    formats["voucher"] = "iso";
    try {
      expect(wireBookingDate("voucher", "2026-11-02")).toBe("2026-11-02T12:00:00+01:00");
      expect(wireBookingDate("voucher", "2026-07-01")).toBe("2026-07-01T12:00:00+02:00");
      const plan = planPayment(voucherDoc(), {
        amount: "1",
        paymentType: "payment",
        date: "2026-07-01",
        checkAccountId: 4001,
      });
      expect(plan.payload.date).toBe("2026-07-01T12:00:00+02:00");
    } finally {
      formats["voucher"] = "unix";
    }
  });
});

describe("voucher transitions", () => {
  it("books open and partially paid vouchers only", () => {
    expect(
      refusal(() => {
        assertBookable(voucherDoc());
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertBookable(voucherDoc({ status: "750", paidAmount: "10" }));
      }),
    ).toBe(undefined);
    expect(
      refusal(() => {
        assertBookable(voucherDoc({ status: "50" }));
      }),
    ).toContain("Finalize it first with sevdesk_voucher_finalize.");
  });

  it("enshrines from open (100) on", () => {
    expect(
      refusal(() => {
        assertEnshrinable(voucherDoc());
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertEnshrinable(voucherDoc({ status: "50" }));
      }),
    ).toContain("only from status open (100) on");
  });

  it("resets paid vouchers to open and open ones to draft", () => {
    expect(
      refusal(() => {
        assertResettable(voucherDoc({ status: "1000", paidAmount: "298.1" }), "open");
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertResettable(voucherDoc(), "draft");
      }),
    ).toBeUndefined();
    expect(
      refusal(() => {
        assertResettable(voucherDoc(), "open");
      }),
    ).toBe("Voucher 2001 is already open with no payments booked; there is nothing to reset.");
    expect(
      refusal(() => {
        assertResettable(voucherDoc({ status: "150" }), "draft");
      }),
    ).toBe("Voucher 2001 has status 150, Transferred; only open documents reset to draft.");
  });
});
