import { describe, expect, it } from "vitest";

import type { BankAccountDto, TransactionDto } from "../../../../src/domain/banking.js";
import {
  bookingTimestamp,
  checkPaymentAccount,
  checkPaymentTransaction,
  exactNumber,
  openAmount,
  paymentDirection,
  type PaymentRequest,
  paymentTypeOf,
  planPayment,
} from "../../../../src/domain/lifecycle/payments.js";
import { inLanguage, type Phrase } from "../../../../src/domain/preview-text.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteDoc, invoiceDoc } from "./docs.js";

/** The English wording of preview sentences. */
const english = (phrases: readonly Phrase[]): string[] => inLanguage(phrases, "en");

function refusal(check: () => unknown): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    return (error as SevdeskError).message;
  }
}

const request = (overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  amount: "177.33",
  paymentType: "payment",
  date: "2026-11-02",
  checkAccountId: 4002,
  ...overrides,
});

const account = (overrides: Partial<BankAccountDto> = {}): BankAccountDto => ({
  id: 4002,
  name: "Geschäftskonto Musterbank",
  type: "bank",
  currency: "EUR",
  status: { code: 100, label: "Active" },
  isDefault: false,
  ...overrides,
});

const transaction = (overrides: Partial<TransactionDto> = {}): TransactionDto => ({
  id: 5101,
  account: { id: 4002, name: "Geschäftskonto Musterbank" },
  valueDate: "2026-11-02",
  amount: { amount: "177.33", currency: "EUR" },
  direction: "in",
  status: { code: 100, label: "Created" },
  enshrined: false,
  ...overrides,
});

describe("openAmount", () => {
  it("is gross minus paid, exactly", () => {
    expect(openAmount(invoiceDoc())).toEqual({
      currency: "EUR",
      gross: "177.33",
      paid: "0",
      open: "177.33",
    });
    expect(openAmount(invoiceDoc({ status: "750", paidAmount: 0.1 })).open).toBe("177.23");
    expect(openAmount(invoiceDoc({ status: "750", paidAmount: "177.32" })).open).toBe("0.01");
  });

  it("treats an open credit note without paid amount as unpaid", () => {
    expect(openAmount(creditNoteDoc()).open).toBe("23.8");
  });

  it("refuses when the open amount cannot be known", () => {
    expect(refusal(() => openAmount(creditNoteDoc({ status: "750" })))).toContain(
      "sevDesk does not report how much",
    );
    expect(refusal(() => openAmount(invoiceDoc({ paidAmount: "-10" })))).toContain(
      "negative paid amount",
    );
    expect(refusal(() => openAmount(invoiceDoc({ sumGross: null })))).toContain("no gross total");
    expect(refusal(() => openAmount(invoiceDoc({ sumGross: "0" })))).toContain("zero or less");
    expect(refusal(() => openAmount(invoiceDoc({ status: "750", paidAmount: "177.33" })))).toBe(
      "Invoice 1001 has nothing left to pay (gross 177.33, paid 177.33).",
    );
  });

  it("allows an unpaid foreign-currency document in its own currency", () => {
    const doc = invoiceDoc({
      currency: "USD",
      sumGrossForeignCurrency: "200",
      sumNetForeignCurrency: "168.07",
      sumTaxForeignCurrency: "31.93",
    });
    expect(openAmount(doc)).toMatchObject({ currency: "USD", gross: "200", open: "200" });
  });

  it("refuses a foreign-currency document with payments (paidAmount currency undocumented)", () => {
    const doc = invoiceDoc({
      currency: "USD",
      status: "750",
      paidAmount: "50",
      sumGrossForeignCurrency: "200",
    });
    expect(refusal(() => openAmount(doc))).toContain("is in USD and already has payments");
  });
});

describe("planPayment", () => {
  it("books the whole open amount as FULL_PAYMENT, signed positive, at noon Berlin", () => {
    const plan = planPayment(invoiceDoc(), request({ transactionId: 5101 }));

    expect(plan.bookingType).toBe("FULL_PAYMENT");
    expect(plan.payload).toEqual({
      amount: 177.33,
      date: 1_793_617_200,
      type: "FULL_PAYMENT",
      checkAccount: { id: 4002, objectName: "CheckAccount" },
      checkAccountTransaction: { id: 5101, objectName: "CheckAccountTransaction" },
    });
    expect(plan.remaining).toBeUndefined();
    expect(plan.difference).toBeUndefined();
    expect(english(plan.warnings)).toEqual([]);
  });

  it("books less than the open amount as a partial payment (N) and says what stays open", () => {
    const plan = planPayment(invoiceDoc(), request({ amount: "100" }));

    expect(plan.bookingType).toBe("N");
    expect(plan.payload.amount).toBe(100);
    expect(plan.payload).not.toHaveProperty("checkAccountTransaction");
    expect(plan.remaining).toEqual({ amount: "77.33", currency: "EUR" });
    expect(english(plan.warnings)).toEqual([
      "This is a partial payment: 77.33 EUR stays open and the invoice becomes partially paid " +
        "(750).",
    ]);
  });

  it("books the rest of a partially paid invoice as FULL_PAYMENT", () => {
    const plan = planPayment(
      invoiceDoc({ status: "750", paidAmount: "100" }),
      request({ amount: "77.33" }),
    );
    expect(plan.bookingType).toBe("FULL_PAYMENT");
    expect(plan.open.open).toBe("77.33");
  });

  it("refuses over-booking a plain payment and names the explicit alternatives", () => {
    expect(refusal(() => planPayment(invoiceDoc(), request({ amount: "177.34" })))).toBe(
      "The payment of 177.34 EUR is more than the open amount of 177.33 EUR of invoice 1001. " +
        'Book at most the open amount, or choose paymentType "reminder_charges" (the customer ' +
        'paid reminder charges on top) or "other_difference" if the extra is intended.',
    );
    expect(
      refusal(() => planPayment(creditNoteDoc(), request({ amount: "30", checkAccountId: 4001 }))),
    ).toContain('or choose paymentType "other_difference"');
  });

  it("settles with cash discount (CB) or bank fees (MTC) for less than the open amount", () => {
    const skonto = planPayment(
      invoiceDoc(),
      request({ amount: "173.78", paymentType: "cash_discount" }),
    );
    expect(skonto.bookingType).toBe("CB");
    expect(skonto.difference).toEqual({ amount: "-3.55", currency: "EUR" });
    expect(english(skonto.warnings)).toEqual([
      "The document is marked as fully paid; the missing 3.55 EUR is written off as cash " +
        "discount (Skonto).",
    ]);

    const fees = planPayment(invoiceDoc(), request({ amount: "175", paymentType: "bank_fees" }));
    expect(fees.bookingType).toBe("MTC");
    expect(fees.warnings[0]?.en).toContain("as bank fees (Geldverkehrskosten)");
  });

  it("refuses cash discount or bank fees without a difference or above the open amount", () => {
    expect(
      refusal(() => planPayment(invoiceDoc(), request({ paymentType: "cash_discount" }))),
    ).toContain('there is no difference to write off; use paymentType "payment"');
    expect(
      refusal(() =>
        planPayment(invoiceDoc(), request({ amount: "200", paymentType: "bank_fees" })),
      ),
    ).toContain("is more than the open amount");
  });

  it("books reminder charges (OF) only above the open amount and only on invoices", () => {
    const plan = planPayment(
      invoiceDoc(),
      request({ amount: "182.33", paymentType: "reminder_charges" }),
    );
    expect(plan.bookingType).toBe("OF");
    expect(plan.difference).toEqual({ amount: "5.00", currency: "EUR" });
    expect(plan.warnings[0]?.en).toBe(
      "The document is marked as fully paid; the extra 5.00 EUR is booked as reminder charges " +
        "(Mahngebühren).",
    );
    expect(
      refusal(() => planPayment(invoiceDoc(), request({ paymentType: "reminder_charges" }))),
    ).toContain('for the open amount or less use "payment"');
    expect(
      refusal(() =>
        planPayment(creditNoteDoc(), request({ amount: "30", paymentType: "reminder_charges" })),
      ),
    ).toBe("Reminder charges can only be booked on invoices.");
  });

  it("books another difference (O) above or below the open amount, never at it", () => {
    expect(
      planPayment(invoiceDoc(), request({ amount: "180", paymentType: "other_difference" }))
        .bookingType,
    ).toBe("O");
    expect(
      planPayment(invoiceDoc(), request({ amount: "170", paymentType: "other_difference" }))
        .warnings[0]?.en,
    ).toContain("the missing 7.33 EUR is written off as a difference for other reasons");
    expect(
      refusal(() => planPayment(invoiceDoc(), request({ paymentType: "other_difference" }))),
    ).toContain("there is no difference");
  });

  it("sends a credit note payout as a negative amount (money out)", () => {
    const plan = planPayment(creditNoteDoc(), request({ amount: "23.80", checkAccountId: 4001 }));
    expect(plan.payload.amount).toBe(-23.8);
    expect(plan.amount).toEqual({ amount: "23.80", currency: "EUR" });
    expect(plan.bookingType).toBe("FULL_PAYMENT");
  });

  it("says partial payouts leave the credit note partially paid", () => {
    const plan = planPayment(creditNoteDoc(), request({ amount: "10", checkAccountId: 4001 }));
    expect(plan.payload.amount).toBe(-10);
    expect(plan.warnings[0]?.en).toContain("the credit note becomes partially paid (750)");
  });
});

describe("bookingTimestamp", () => {
  it("is 12:00 Berlin time in winter and summer", () => {
    expect(new Date(bookingTimestamp("2026-11-02") * 1000).toISOString()).toBe(
      "2026-11-02T11:00:00.000Z",
    );
    expect(new Date(bookingTimestamp("2026-08-25") * 1000).toISOString()).toBe(
      "2026-08-25T10:00:00.000Z",
    );
    // sevdesk-rs's measured request (tests/requests.rs) sends the same instant for that day.
    expect(bookingTimestamp("2026-08-25")).toBe(1_787_652_000);
  });

  it("keeps the calendar day on DST transition days", () => {
    expect(new Date(bookingTimestamp("2026-03-29") * 1000).toISOString().slice(0, 10)).toBe(
      "2026-03-29",
    );
    expect(new Date(bookingTimestamp("2026-10-25") * 1000).toISOString().slice(0, 10)).toBe(
      "2026-10-25",
    );
  });
});

describe("exactNumber", () => {
  it("turns exact decimals into JSON numbers", () => {
    expect(exactNumber("177.33")).toBe(177.33);
    expect(exactNumber("-0.1")).toBe(-0.1);
  });

  it("refuses values a double cannot hold exactly", () => {
    expect(refusal(() => exactNumber("12345678901234567.89"))).toBe(
      "The amount has too many digits to be sent to sevDesk exactly.",
    );
  });
});

describe("paymentDirection", () => {
  it("is in for invoices and out for credit notes", () => {
    expect(paymentDirection("invoice")).toBe("in");
    expect(paymentDirection("creditNote")).toBe("out");
  });
});

describe("checkPaymentAccount", () => {
  it("accepts an online account when a transaction is linked", () => {
    expect(checkPaymentAccount(invoiceDoc(), account(), true)).toEqual([]);
  });

  it("refuses an online account without a transaction (spec: you must provide one)", () => {
    expect(refusal(() => checkPaymentAccount(invoiceDoc(), account(), false))).toContain(
      "needs the imported transaction to link",
    );
  });

  it("warns that sevDesk creates a transaction on offline and cash accounts", () => {
    const warnings = checkPaymentAccount(
      invoiceDoc(),
      account({ id: 4001, type: "clearing" }),
      false,
    );
    expect(english(warnings)).toEqual([
      "sevDesk creates a new bank transaction for this payment on account 4001. If the payment " +
        "is already in sevDesk as an imported transaction, pass its transactionId instead, or it " +
        "is counted twice.",
    ]);
    expect(warnings[0]?.de).toBe(
      "sevDesk legt für diese Zahlung einen neuen Kontoumsatz auf dem Konto 4001 an. Ist die " +
        "Zahlung bereits als importierter Umsatz in sevDesk vorhanden, muss stattdessen dieser " +
        "Umsatz verknüpft werden (transactionId), sonst wird sie doppelt gezählt.",
    );
    const unknown = checkPaymentAccount(invoiceDoc(), account({ type: "unknown" }), false)[0];
    expect(unknown?.en).toContain("it may refuse an account of another type");
    expect(unknown?.de).toContain("bei einem Konto anderen Typs kann sevDesk ablehnen");
  });

  it("refuses archived accounts and other currencies", () => {
    expect(
      refusal(() =>
        checkPaymentAccount(invoiceDoc(), account({ status: { code: 0, label: "x" } }), true),
      ),
    ).toContain("is archived");
    expect(
      refusal(() => checkPaymentAccount(invoiceDoc(), account({ currency: "USD" }), true)),
    ).toBe(
      "Check account 4002 is in USD, invoice 1001 in EUR; payments are only booked in the " +
        "document's currency.",
    );
  });
});

describe("checkPaymentTransaction", () => {
  it("accepts a free incoming transaction of the same amount", () => {
    expect(checkPaymentTransaction(invoiceDoc(), 4002, transaction(), "177.33")).toEqual([]);
  });

  it("accepts a free outgoing transaction for a credit note payout", () => {
    const outgoing = transaction({
      amount: { amount: "-23.8", currency: "EUR" },
      direction: "out",
    });
    expect(checkPaymentTransaction(creditNoteDoc(), 4002, outgoing, "23.80")).toEqual([]);
  });

  it("warns when the transaction is larger than the payment", () => {
    expect(checkPaymentTransaction(invoiceDoc(), 4002, transaction(), "100")).toEqual([
      {
        en:
          "Bank transaction 5101 is 177.33 EUR; the payment uses part of it, so it is sent as " +
          "a partial booking (N), and 77.33 EUR of the transaction stays assignable to other " +
          "documents (sevDesk marks it partly assigned, status 200).",
        de:
          "Kontoumsatz 5101 beträgt 177,33 EUR; die Zahlung nutzt nur einen Teil davon und wird " +
          "deshalb als Teilbuchung (N) gesendet. 77,33 EUR des Umsatzes bleiben für andere " +
          "Dokumente zuordenbar (sevDesk markiert ihn als teilweise zugeordnet, Status 200).",
      },
    ]);
  });

  it.each([
    [
      "another account",
      transaction({ account: { id: 4001 } }),
      "belongs to check account 4001, not to check account 4002",
    ],
    ["no account", transaction({ account: undefined }), "belongs to no check account"],
    ["an enshrined transaction", transaction({ enshrined: true }), "is enshrined"],
    [
      "a partly assigned transaction",
      transaction({ status: { code: 200, label: "Linked" } }),
      "partly assigned",
    ],
    ["a booked transaction", transaction({ status: { code: 400, label: "Booked" } }), "booked"],
    ["a private transaction", transaction({ status: { code: 300, label: "Private" } }), "private"],
    ["an auto-booked transaction", transaction({ status: { code: 350, label: "x" } }), "auto"],
    ["an unknown status", transaction({ status: { code: 999, label: "x" } }), "has status 999"],
    ["no status", transaction({ status: undefined }), "has no status"],
    [
      "another currency",
      transaction({ amount: { amount: "177.33", currency: "USD" } }),
      "is in USD, invoice 1001 in EUR",
    ],
    [
      "an outgoing transaction",
      transaction({ amount: { amount: "-177.33", currency: "EUR" }, direction: "out" }),
      "is not an incoming payment",
    ],
    [
      "a smaller transaction",
      transaction({ amount: { amount: "100", currency: "EUR" } }),
      "is 100.00 EUR, less than the payment of 177.33 EUR",
    ],
  ] as [string, TransactionDto, string][])("refuses %s", (_label, tx, message) => {
    expect(refusal(() => checkPaymentTransaction(invoiceDoc(), 4002, tx, "177.33"))).toContain(
      message,
    );
  });

  it("refuses an incoming transaction for a credit note payout", () => {
    expect(
      refusal(() => checkPaymentTransaction(creditNoteDoc(), 4002, transaction(), "23.80")),
    ).toContain("is not an outgoing payment");
  });
});

describe("checkPaymentTransaction with shares already in the log", () => {
  it("treats only the rest as free and says the payment goes out as N", () => {
    expect(
      checkPaymentTransaction(
        invoiceDoc(),
        4002,
        transaction({ amount: { amount: "200", currency: "EUR" } }),
        "100",
        "50",
      ),
    ).toEqual([
      {
        en:
          "Bank transaction 5101 is marked unbooked (status 100), but its booking log already " +
          "assigns 50.00 EUR of its 200.00 EUR to other documents; only 150.00 EUR is treated " +
          "as free. The payment is sent as a partial booking (N), and 50.00 EUR of the " +
          "transaction stays assignable to other documents.",
        de:
          "Kontoumsatz 5101 gilt als ungebucht (Status 100), sein Buchungsprotokoll ordnet aber " +
          "bereits 50,00 EUR von 200,00 EUR anderen Dokumenten zu; nur 150,00 EUR gelten als " +
          "frei. Die Zahlung wird als Teilbuchung (N) gesendet, und 50,00 EUR des Umsatzes " +
          "bleiben für andere Dokumente zuordenbar.",
      },
    ]);
  });

  it("keeps the old behavior without log shares", () => {
    expect(checkPaymentTransaction(invoiceDoc(), 4002, transaction(), "177.33", "0")).toEqual([]);
  });
});

describe("planPayment with a linked transaction larger than the payment", () => {
  it("sends a payment of the whole open amount as N (FULL_PAYMENT would be refused, 422)", () => {
    const plan = planPayment(
      invoiceDoc(),
      request({ transactionId: 5101, transactionAmount: "200" }),
    );
    expect(plan.bookingType).toBe("N");
    expect(plan.payload.type).toBe("N");
    expect(plan.remaining).toBeUndefined();
    expect(english(plan.warnings)).toEqual([]);
  });

  it("keeps FULL_PAYMENT when the payment takes the whole transaction", () => {
    const plan = planPayment(
      invoiceDoc(),
      request({ transactionId: 5101, transactionAmount: "177.33" }),
    );
    expect(plan.bookingType).toBe("FULL_PAYMENT");
  });

  it("keeps a partial payment N and its warning", () => {
    const plan = planPayment(
      invoiceDoc(),
      request({ amount: "100", transactionId: 5101, transactionAmount: "150" }),
    );
    expect(plan.bookingType).toBe("N");
    expect(plan.warnings[0]?.en).toContain("This is a partial payment: 77.33 EUR stays open");
  });

  it("refuses a difference type on part of a transaction", () => {
    expect(
      refusal(() =>
        planPayment(
          invoiceDoc(),
          request({
            amount: "170",
            paymentType: "cash_discount",
            transactionId: 5101,
            transactionAmount: "177.33",
          }),
        ),
      ),
    ).toBe(
      "Skonto, bank fees and other differences (paymentType cash_discount, bank_fees, " +
        "other_difference, reminder_charges) can only be booked when the payment takes the " +
        "whole bank transaction. Book the transaction's full amount, use paymentType " +
        '"payment" here, or book the difference in the sevDesk web app.',
    );
  });
});

describe("paymentTypeOf", () => {
  it("names each sevDesk booking type with the paymentType input value", () => {
    expect(
      (["FULL_PAYMENT", "N", "CB", "MTC", "O", "OF"] as const).map((type) => paymentTypeOf(type)),
    ).toEqual([
      "payment",
      "payment",
      "cash_discount",
      "bank_fees",
      "other_difference",
      "reminder_charges",
    ]);
  });
});
