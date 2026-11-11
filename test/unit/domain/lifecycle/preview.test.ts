import { describe, expect, it } from "vitest";

import {
  documentFacts,
  documentTitle,
  formatMoney,
  KIND_DE,
  kindNoun,
  statusName,
  statusText,
  transactionStatusText,
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

describe("German previews", () => {
  it("write amounts in German notation, keeping every digit", () => {
    expect(formatMoney({ amount: "1190.50", currency: "EUR" }, "de")).toBe("1.190,50 EUR");
    expect(formatMoney({ amount: "-0.5", currency: "USD" }, "de")).toBe("-0,5 USD");
    expect(formatMoney({ amount: "1190.50", currency: "EUR" }, "en")).toBe("1190.50 EUR");
  });

  it("name a document by its German noun", () => {
    expect(documentTitle(invoiceDoc(), "de")).toBe("Rechnung RE-1001");
    expect(documentTitle(invoiceDoc({ invoiceNumber: null }), "de")).toBe(
      "Rechnung 1001 (noch ohne Nummer)",
    );
    expect(documentTitle(creditNoteDoc(), "de")).toBe("Gutschrift GU-1001");
    expect(documentTitle(orderDoc(), "de")).toBe("Auftrag AB-1002");
    expect(kindNoun("creditNote", "de")).toBe("Gutschrift");
    expect(kindNoun("creditNote")).toBe("credit note");
    expect(kindNoun("voucher", "de")).toBe("Beleg");
  });

  it("know the grammar of every kind", () => {
    expect(KIND_DE.invoice).toEqual({
      nominative: "die Rechnung",
      accusative: "die Rechnung",
      dative: "der Rechnung",
      thisOne: "diese Rechnung",
      thisOneDative: "dieser Rechnung",
    });
    expect(KIND_DE.voucher).toEqual({
      nominative: "der Beleg",
      accusative: "den Beleg",
      dative: "dem Beleg",
      thisOne: "dieser Beleg",
      thisOneDative: "diesem Beleg",
    });
    expect(KIND_DE.order.accusative).toBe("den Auftrag");
    expect(KIND_DE.creditNote.thisOneDative).toBe("dieser Gutschrift");
  });

  it("list the same facts as the English preview, in German", () => {
    const doc = invoiceDoc();
    const german = documentFacts(doc, "de");
    expect(german).toEqual([
      { label: "Rechnung", value: "RE-1001 (ID 1001)" },
      { label: "Typ", value: "Rechnung (RE)" },
      { label: "Status", value: "Offen / fällig (200)" },
      { label: "Kunde", value: "Musterfirma GmbH (Kontakt 1001)" },
      { label: "Datum", value: "01.10.2026" },
      { label: "Fällig am", value: "15.10.2026" },
      { label: "Netto", value: "149,02 EUR" },
      { label: "Umsatzsteuer", value: "28,31 EUR" },
      { label: "Brutto", value: "177,33 EUR" },
      { label: "Bisher bezahlt", value: "0,00 EUR" },
    ]);
    expect(german).toHaveLength(documentFacts(doc).length);
    expect(documentFacts(doc, "en")).toEqual(documentFacts(doc));
  });

  it("mark drafts without number, enshrined documents and contacts without a name", () => {
    const facts = documentFacts(
      invoiceDoc({
        invoiceNumber: null,
        enshrined: "2026-10-02T10:00:00+02:00",
        contact: { id: "1001", objectName: "Contact" },
      }),
      "de",
    );
    expect(facts[0]).toEqual({ label: "Rechnung", value: "ID 1001, noch ohne Nummer" });
    expect(facts).toContainEqual({ label: "Kunde", value: "Kontakt 1001" });
    expect(facts.at(-1)).toEqual({ label: "Festgeschrieben", value: "ja" });
  });

  it("leave out the same absent values and show foreign currencies the same way", () => {
    for (const overrides of [
      { contact: null, sumTax: null },
      {
        currency: "USD",
        sumNetForeignCurrency: "168.07",
        sumTaxForeignCurrency: "31.93",
        sumGrossForeignCurrency: "200",
      },
      { invoiceNumber: null },
    ]) {
      const doc = invoiceDoc(overrides);
      expect(documentFacts(doc, "de")).toHaveLength(documentFacts(doc).length);
    }
    const foreign = documentFacts(
      invoiceDoc({
        currency: "USD",
        sumNetForeignCurrency: "168.07",
        sumTaxForeignCurrency: "31.93",
        sumGrossForeignCurrency: "200",
      }),
      "de",
    );
    expect(foreign).toContainEqual({ label: "Brutto", value: "200,00 USD" });
    expect(foreign).toContainEqual({
      label: "Brutto in EUR (so bucht es sevDesk)",
      value: "177,33 EUR",
    });
    expect(foreign.map((fact) => fact.label)).not.toContain("Bisher bezahlt");
  });

  it("show a credit note and an order with their own nouns", () => {
    expect(documentFacts(creditNoteDoc(), "de")[0]).toEqual({
      label: "Gutschrift",
      value: "GU-1001 (ID 2001)",
    });
    const order = documentFacts(orderDoc(), "de");
    expect(order[0]).toEqual({ label: "Auftrag", value: "AB-1002 (ID 3002)" });
    expect(order[1]?.label).toBe("Typ");
  });

  it("name a status as sevDesk's web app does, with its code", () => {
    expect(statusText(invoiceDoc())).toBe("Open / due (200)");
    expect(statusText(invoiceDoc(), "de")).toBe("Offen / fällig (200)");
    expect(statusName(invoiceDoc({ status: "1000" }), "de")).toBe("Bezahlt");
    expect(statusName(invoiceDoc({ status: "1000" }))).toBe("Paid");
    expect(statusName(orderDoc(), "de")).toBe("Angenommen");
    // An undocumented code has no name in either language.
    expect(statusText(invoiceDoc({ status: "999" }))).toBe("unknown (999)");
    expect(statusText(invoiceDoc({ status: "999" }), "de")).toBe("unbekannt (999)");
  });

  it("name a bank transaction's status the same way", () => {
    expect(transactionStatusText({ code: 100, label: "Created" })).toBe("Created (100)");
    expect(transactionStatusText({ code: 100, label: "Created" }, "de")).toBe("Erstellt (100)");
    expect(transactionStatusText({ code: 400, label: "Booked" }, "de")).toBe("Gebucht (400)");
    expect(transactionStatusText({ code: 350, label: "x" }, "de")).toBe(
      "Automatisch gebucht (350)",
    );
    expect(transactionStatusText({ code: 7, label: "unknown" }, "de")).toBe("unbekannt (7)");
  });
});
