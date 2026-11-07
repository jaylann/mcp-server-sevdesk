import { describe, expect, it } from "vitest";

import {
  documentFacts,
  documentTitle,
  formatMoney,
} from "../../../../src/domain/lifecycle/preview.js";
import { creditNoteDoc, invoiceDoc, orderDoc } from "./docs.js";

describe("formatMoney", () => {
  it("writes the exact amount and the currency", () => {
    expect(formatMoney({ amount: "1190.50", currency: "EUR" })).toBe("1190.50 EUR");
  });
});

describe("documentTitle", () => {
  it("uses the number, or the id while there is none", () => {
    expect(documentTitle(invoiceDoc())).toBe("invoice RE-1001");
    expect(documentTitle(invoiceDoc({ invoiceNumber: null }))).toBe("invoice 1001 (no number yet)");
    expect(documentTitle(creditNoteDoc())).toBe("credit note GU-1001");
  });
});

describe("documentFacts", () => {
  it("lists number, type, status, customer, dates, totals and paid amount of an invoice", () => {
    expect(documentFacts(invoiceDoc())).toEqual([
      { label: "Invoice (Rechnung)", value: "RE-1001 (id 1001)" },
      { label: "Type", value: "Rechnung (RE)" },
      { label: "Status", value: "Open / due (200)" },
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      { label: "Date", value: "2026-10-01" },
      { label: "Due date", value: "2026-10-15" },
      { label: "Net", value: "149.02 EUR" },
      { label: "Tax", value: "28.31 EUR" },
      { label: "Gross", value: "177.33 EUR" },
      { label: "Paid so far", value: "0.00 EUR" },
    ]);
  });

  it("marks drafts without number, enshrined documents and contacts without a name", () => {
    const facts = documentFacts(
      invoiceDoc({
        invoiceNumber: null,
        enshrined: "2026-10-02T10:00:00+02:00",
        contact: { id: "1001", objectName: "Contact" },
      }),
    );
    expect(facts[0]).toEqual({ label: "Invoice (Rechnung)", value: "id 1001, no number yet" });
    expect(facts).toContainEqual({ label: "Customer", value: "contact 1001" });
    expect(facts.at(-1)).toEqual({ label: "Enshrined", value: "yes (festgeschrieben)" });
  });

  it("leaves out absent values", () => {
    const labels = documentFacts(invoiceDoc({ contact: null, sumTax: null })).map(
      (fact) => fact.label,
    );
    expect(labels).not.toContain("Customer");
    expect(labels).not.toContain("Tax");
  });

  it("shows foreign-currency totals with the EUR gross, without a paid amount", () => {
    const facts = documentFacts(
      invoiceDoc({
        currency: "USD",
        sumNetForeignCurrency: "168.07",
        sumTaxForeignCurrency: "31.93",
        sumGrossForeignCurrency: "200",
      }),
    );
    expect(facts).toContainEqual({ label: "Gross", value: "200.00 USD" });
    expect(facts).toContainEqual({
      label: "Gross in EUR (booked by sevDesk)",
      value: "177.33 EUR",
    });
    expect(facts.map((fact) => fact.label)).not.toContain("Paid so far");
  });

  it("shows a credit note and an order with their own nouns", () => {
    expect(documentFacts(creditNoteDoc())[0]).toEqual({
      label: "Credit note (Gutschrift)",
      value: "GU-1001 (id 2001)",
    });
    const order = documentFacts(orderDoc());
    expect(order[0]).toEqual({ label: "Order (Auftrag)", value: "AB-1002 (id 3002)" });
    expect(order[1]?.label).toBe("Type");
  });
});
