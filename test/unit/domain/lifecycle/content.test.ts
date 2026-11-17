/**
 * `readDocumentContent`: the stored content of a document as preview facts, and the approval
 * binding over the same read (review 2026-11, round 3: an approval showed number, customer and
 * totals only, so a foot text written before the human was asked went through unseen).
 */
import { describe, expect, it } from "vitest";

import {
  type DocumentContent,
  MAX_LISTED_POSITIONS,
  readDocumentContent,
} from "../../../../src/domain/lifecycle/content.js";
import {
  type LifecycleKind,
  readLifecycleDocument,
} from "../../../../src/domain/lifecycle/documents.js";
import { displayPreview } from "../../../../src/safety/preview.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  noDiscountsRoute,
  orderRow,
  type Row,
} from "../../tools/lifecycle/helpers.js";
import { openVoucherRow, positionRow, voucherRoute } from "../../tools/vouchers/routes.js";

const TODAY = "2026-11-07";

const PATHS = {
  invoice: { path: "/InvoicePos", parent: "invoice", objectName: "Invoice" },
  creditNote: { path: "/CreditNotePos", parent: "creditNote", objectName: "CreditNote" },
  order: { path: "/OrderPos", parent: "order", objectName: "Order" },
  voucher: { path: "/VoucherPos", parent: "voucher", objectName: "Voucher" },
} as const;

/**
 * Reads `row`, its `positions` and (sales documents) its document `discounts` the way finalize,
 * send and enshrine do.
 */
async function contentOf(
  kind: LifecycleKind,
  row: Row,
  positions: readonly Row[] = [],
  positionsBody?: unknown,
  discounts: readonly Row[] = [],
): Promise<DocumentContent> {
  const route: FakeRoute = kind === "voucher" ? voucherRoute(row) : documentRoute(kind, row);
  const client = new FakeSevdeskClient(
    withCountryRoute([
      route,
      { path: PATHS[kind].path, response: { body: positionsBody ?? { objects: positions } } },
      {
        path: `/${PATHS[kind].objectName}/${String(row["id"])}/getDiscounts`,
        response: { body: { objects: discounts, total: null } },
      },
    ]),
  );
  const doc = await readLifecycleDocument(client, kind, Number(row["id"]), {
    today: TODAY,
    cacheOwner: client,
  });
  const content = await readDocumentContent(client, doc);
  // One read of the positions serves the facts and the binding.
  expect(client.callsTo(PATHS[kind].path)).toHaveLength(1);
  return content;
}

/** A position row of `kind`'s document `id`. */
function position(kind: Exclude<LifecycleKind, "voucher">, id: string, overrides: Row = {}): Row {
  const { parent, objectName } = PATHS[kind];
  return {
    id: "7001",
    objectName: `${objectName}Pos`,
    [parent]: { id, objectName },
    positionNumber: "0",
    name: "Beratung",
    text: "Beratung im November",
    quantity: "1",
    price: "100",
    taxRate: "19",
    discount: "0",
    isPercentage: "1",
    optional: "0",
    sumNet: "100",
    sumTax: "19",
    sumGross: "119",
    sumNetForeignCurrency: "0",
    sumTaxForeignCurrency: "0",
    sumGrossForeignCurrency: "0",
    ...overrides,
  };
}

function valueOf(facts: readonly { label: string; value: string }[], label: string) {
  return facts.find((fact) => fact.label === label)?.value;
}

describe("the content facts of an invoice", () => {
  it("puts the printed address after the customer and lists title, terms, texts and positions", async () => {
    const content = await contentOf("invoice", invoiceRow(), [position("invoice", "1001")]);

    expect(content.identity("en").map((fact) => fact.label)).toEqual([
      "Invoice (Rechnung)",
      "Type",
      "Status",
      "Customer",
      "Address on the document",
      "Date",
      "Due date",
      "Net",
      "Tax",
      "Gross",
      "Paid so far",
    ]);
    expect(content.printed("en")).toEqual([
      { label: "Title on the document (Betreff)", value: "Rechnung RE-1001" },
      { label: "Delivery date or period (Leistungsdatum)", value: "2026-10-01" },
      { label: "Cash discount (Skonto)", value: "2 % within 7 days" },
      { label: "Tax rule (Steuerregel)", value: "1 Umsatzsteuerpflichtige Umsätze" },
      { label: "Head text (Kopftext)", value: "Vielen Dank für Ihren Auftrag." },
      {
        label: "Position 1",
        value:
          "Beratung: 1 × 100.00 EUR net, 19 % VAT → 100.00 EUR net, 119.00 EUR gross\n" +
          "Text: Beratung im November",
      },
      {
        label: "Foot text (Fußtext)",
        value: "Bitte überweisen Sie den Betrag innerhalb von 14 Tagen.",
      },
    ]);
    expect(content.facts("en")).toEqual([...content.identity("en"), ...content.printed("en")]);
  });

  it("gives the same facts in German, in the same order", async () => {
    const content = await contentOf("invoice", invoiceRow(), [position("invoice", "1001")]);

    expect(valueOf(content.identity("de"), "Anschrift auf dem Dokument")).toBe(
      "Musterfirma GmbH\nMusterstraße 1\n12345 Musterstadt",
    );
    expect(content.printed("de")).toEqual([
      { label: "Betreff auf dem Dokument", value: "Rechnung RE-1001" },
      { label: "Leistungsdatum oder -zeitraum", value: "01.10.2026" },
      { label: "Skonto", value: "2 % innerhalb von 7 Tagen" },
      { label: "Steuerregel", value: "1 Umsatzsteuerpflichtige Umsätze" },
      { label: "Kopftext", value: "Vielen Dank für Ihren Auftrag." },
      {
        label: "Position 1",
        value:
          "Beratung: 1 × 100,00 EUR netto, 19 % USt. → 100,00 EUR netto, 119,00 EUR brutto\n" +
          "Text: Beratung im November",
      },
      { label: "Fußtext", value: "Bitte überweisen Sie den Betrag innerhalb von 14 Tagen." },
    ]);
    expect(content.facts("de")).toHaveLength(content.facts("en").length);
    expect(content.notShown.en).toContain("Not shown: the contact person (Ansprechpartner)");
    expect(content.notShown.en).toContain("sevdesk_invoice_pdf");
    expect(content.notShown.de).toContain("Nicht gezeigt werden: der Ansprechpartner");
  });

  it("shows texts as stored: whole, with their HTML, past the DTO's 2,000 characters", async () => {
    const long = `${"Zahlbar innerhalb von 14 Tagen. ".repeat(70)}IBAN DE00 1234 5678 9012 3456 78`;
    const content = await contentOf(
      "invoice",
      invoiceRow({
        headText: "<p>Bitte <b>neue Bankverbindung</b> beachten.</p>",
        footText: long,
        taxText: "Steuerschuldnerschaft des Leistungsempfängers",
      }),
    );

    expect(long.length).toBeGreaterThan(2_000);
    expect(valueOf(content.printed("en"), "Foot text (Fußtext)")).toBe(long);
    expect(valueOf(content.printed("de"), "Fußtext")).toBe(long);
    expect(valueOf(content.printed("en"), "Head text (Kopftext)")).toBe(
      "<p>Bitte <b>neue Bankverbindung</b> beachten.</p>",
    );
    expect(valueOf(content.printed("en"), "Tax note (Steuerhinweis)")).toBe(
      "Steuerschuldnerschaft des Leistungsempfängers",
    );
  });

  it("keeps hidden characters out of what is displayed, not out of what is hashed", async () => {
    const content = await contentOf("invoice", invoiceRow({ footText: "IBAN DE00​ 1234" }));
    const facts = content.printed("en");

    expect(valueOf(facts, "Foot text (Fußtext)")).toBe("IBAN DE00​ 1234");
    const shown = displayPreview({ action: "x", facts, warnings: [], irreversible: false });
    expect(valueOf(shown.facts, "Foot text (Fußtext)")).toBe("IBAN DE00 1234");
  });

  it("leaves absent values out and says when there are no positions", async () => {
    const content = await contentOf(
      "invoice",
      invoiceRow({
        header: null,
        headText: "",
        footText: "  ",
        address: null,
        deliveryDate: null,
        discount: "0",
      }),
    );

    expect(content.identity("en").map((fact) => fact.label)).not.toContain(
      "Address on the document",
    );
    expect(content.printed("en")).toEqual([
      { label: "Tax rule (Steuerregel)", value: "1 Umsatzsteuerpflichtige Umsätze" },
      { label: "Positions", value: "none" },
    ]);
    expect(content.printed("de")).toEqual([
      { label: "Steuerregel", value: "1 Umsatzsteuerpflichtige Umsätze" },
      { label: "Positionen", value: "keine" },
    ]);
  });

  it("composes the address from the structured parts and shows both when they differ", async () => {
    const parts = {
      addressName: "Andere Firma GmbH",
      addressStreet: "Postfach 1",
      addressZip: "54321",
      addressCity: "Anderswo",
    };
    const onlyParts = await contentOf("invoice", invoiceRow({ address: null, ...parts }));
    expect(valueOf(onlyParts.identity("en"), "Address on the document")).toBe(
      "Andere Firma GmbH\nPostfach 1\n54321 Anderswo",
    );

    const same = await contentOf(
      "invoice",
      invoiceRow({ address: "Andere Firma GmbH\nPostfach 1\n54321  Anderswo\n", ...parts }),
    );
    expect(same.identity("en").map((fact) => fact.label)).not.toContain(
      "Address fields (structured)",
    );

    const both = await contentOf("invoice", invoiceRow(parts));
    expect(valueOf(both.identity("en"), "Address on the document")).toBe(
      "Musterfirma GmbH\nMusterstraße 1\n12345 Musterstadt",
    );
    expect(valueOf(both.identity("en"), "Address fields (structured)")).toBe(
      "Andere Firma GmbH\nPostfach 1\n54321 Anderswo",
    );
    expect(valueOf(both.identity("de"), "Adressfelder (strukturiert)")).toBe(
      "Andere Firma GmbH\nPostfach 1\n54321 Anderswo",
    );
  });

  it("lists positions in printed order with discount, gross prices and optional lines", async () => {
    const content = await contentOf("invoice", invoiceRow({ showNet: "0" }), [
      position("invoice", "1001", {
        id: "7003",
        positionNumber: "2",
        name: "Nachlass\nSonderaktion",
        text: null,
        quantity: "1",
        price: "-10",
        discount: "5",
        isPercentage: "0",
        sumNet: "-8.4",
        sumGross: "-10",
      }),
      position("invoice", "1001", {
        id: "7002",
        positionNumber: "1",
        name: "Lizenz",
        text: null,
        quantity: "2.5",
        price: "49.9",
        discount: "10",
        sumNet: "94.33",
        sumGross: "112.28",
      }),
    ]);

    expect(content.printed("en").filter((fact) => fact.label.startsWith("Position"))).toEqual([
      {
        label: "Position 1",
        value:
          "Lizenz: 2.5 × 49.90 EUR gross, 19 % VAT, 10 % discount → 94.33 EUR net, 112.28 EUR gross",
      },
      {
        label: "Position 2",
        // The name is folded onto one line; an amount discount is shown as money.
        value:
          "Nachlass Sonderaktion: 1 × -10.00 EUR gross, 19 % VAT, 5.00 EUR discount → " +
          "-8.40 EUR net, -10.00 EUR gross",
      },
    ]);
    expect(valueOf(content.printed("de"), "Position 1")).toBe(
      "Lizenz: 2,5 × 49,90 EUR brutto, 19 % USt., 10 % Rabatt → 94,33 EUR netto, 112,28 EUR brutto",
    );
  });

  it(`lists ${String(MAX_LISTED_POSITIONS)} positions and counts the rest`, async () => {
    const rows = Array.from({ length: MAX_LISTED_POSITIONS + 3 }, (_, index) =>
      position("invoice", "1001", {
        id: String(8000 + index),
        positionNumber: String(index),
        name: `Posten ${String(index + 1)}`,
        text: null,
      }),
    );
    const content = await contentOf("invoice", invoiceRow(), rows);

    const listed = content.printed("en").filter((fact) => /^Position \d+$/.test(fact.label));
    expect(listed).toHaveLength(MAX_LISTED_POSITIONS);
    expect(listed.at(-1)?.value).toContain(`Posten ${String(MAX_LISTED_POSITIONS)}:`);
    expect(valueOf(content.printed("en"), "More positions")).toBe(
      `3 more positions are not listed here (${String(MAX_LISTED_POSITIONS + 3)} in total). ` +
        "Check them in sevDesk before you approve.",
    );
    expect(valueOf(content.printed("de"), "Weitere Positionen")).toBe(
      `3 weitere Positionen sind hier nicht aufgeführt (insgesamt ` +
        `${String(MAX_LISTED_POSITIONS + 3)}). Prüfe sie vor der Freigabe in sevDesk.`,
    );
    expect(content.printed("de")).toHaveLength(content.printed("en").length);
  });

  it("says so when sevDesk has more positions than one read returns", async () => {
    // More rows than `listChildRows` reads (10,000): the list is cut, and the fact says it.
    const rows = Array.from({ length: 10_001 }, (_, index) => ({
      id: String(100_000 + index),
      invoice: { id: "1001", objectName: "Invoice" },
      positionNumber: String(index),
      name: `Posten ${String(index + 1)}`,
    }));
    const client = new FakeSevdeskClient(
      withCountryRoute([
        documentRoute("invoice", invoiceRow()),
        { path: "/InvoicePos", response: { body: { objects: rows } } },
        noDiscountsRoute,
      ]),
    );
    const doc = await readLifecycleDocument(client, "invoice", 1001, {
      today: TODAY,
      cacheOwner: client,
    });
    const content = await readDocumentContent(client, doc);

    expect(valueOf(content.printed("en"), "More positions")).toBe(
      `sevDesk did not return every position: 10000 were read, ${String(MAX_LISTED_POSITIONS)} ` +
        "are listed here, and there are more. Check them in sevDesk before you approve.",
    );
    expect(valueOf(content.printed("de"), "Weitere Positionen")).toBe(
      `sevDesk hat nicht alle Positionen geliefert: 10000 wurden gelesen, ` +
        `${String(MAX_LISTED_POSITIONS)} sind hier aufgeführt, und es gibt weitere. Prüfe ` +
        "sie vor der Freigabe in sevDesk.",
    );
  });

  it("refuses a position row it cannot read instead of leaving it out", async () => {
    const error = await contentOf("invoice", invoiceRow(), [
      position("invoice", "1001", { quantity: { amount: 1 } }),
    ]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("unexpected_response");
  });
});

describe("the binding", () => {
  it("is the same for the same document and changes with what the facts do not show", async () => {
    const rows = [position("invoice", "1001")];
    const first = await contentOf("invoice", invoiceRow(), rows);
    const again = await contentOf("invoice", invoiceRow(), rows);
    const edited = await contentOf(
      "invoice",
      invoiceRow({ update: "2026-10-01T17:30:00+02:00" }),
      rows,
    );
    const otherUnit = await contentOf("invoice", invoiceRow(), [
      position("invoice", "1001", { unity: { id: "9", objectName: "Unity" } }),
    ]);

    expect(again.binding).toBe(first.binding);
    expect(first.binding).toMatch(/^[0-9a-f]{64}$/);
    expect(edited.facts("en")).toEqual(first.facts("en"));
    expect(edited.binding).not.toBe(first.binding);
    expect(otherUnit.facts("en")).toEqual(first.facts("en"));
    expect(otherUnit.binding).not.toBe(first.binding);
  });

  it("covers the document discounts as sevDesk listed them (D-116)", async () => {
    const rows = [position("invoice", "1001")];
    const none = await contentOf("invoice", invoiceRow(), rows);
    const ten = await contentOf("invoice", invoiceRow(), rows, undefined, [
      discount("Invoice", 1001),
    ]);
    const twenty = await contentOf("invoice", invoiceRow(), rows, undefined, [
      discount("Invoice", 1001, { value: "20" }),
    ]);
    // A field the facts do not show (the row's update time) still changes the binding.
    const touched = await contentOf("invoice", invoiceRow(), rows, undefined, [
      discount("Invoice", 1001, { update: "2026-11-16T11:00:00+01:00" }),
    ]);

    const bindings = new Set([none, ten, twenty, touched].map((content) => content.binding));
    expect(bindings.size).toBe(4);
    expect(touched.facts("en")).toEqual(ten.facts("en"));
  });
});

/** A document discount row as `getDiscounts` lists it (recorded keys and string scalars). */
function discount(kind: "Invoice" | "CreditNote" | "Order", id: number, overrides: Row = {}): Row {
  return {
    id: "9001",
    objectName: "Discounts",
    create: "2026-11-16T10:00:00+01:00",
    update: "2026-11-16T10:00:00+01:00",
    object: { id: String(id), objectName: kind },
    text: "Treuerabatt",
    discount: "1",
    percentage: "1",
    value: "10",
    isNet: "1",
    ...overrides,
  };
}

describe("the document discounts in the content facts (D-116)", () => {
  it("lists the discount after the positions with what it deducts, in both languages", async () => {
    const content = await contentOf(
      "invoice",
      invoiceRow({ footText: "Danke.", sumDiscountNet: "-10", sumDiscountGross: "-11.9" }),
      [position("invoice", "1001")],
      undefined,
      [discount("Invoice", 1001)],
    );

    const labels = content.printed("en").map((fact) => fact.label);
    expect(labels.slice(labels.indexOf("Position 1"))).toEqual([
      "Position 1",
      "Discount on the whole document (Rabatt)",
      "Discounts in total",
      "Foot text (Fußtext)",
    ]);
    expect(valueOf(content.printed("en"), "Discount on the whole document (Rabatt)")).toBe(
      "10 % of the net total\nText: Treuerabatt",
    );
    expect(valueOf(content.printed("en"), "Discounts in total")).toBe(
      "-10.00 EUR net, -11.90 EUR gross",
    );
    expect(valueOf(content.printed("de"), "Rabatt auf den Gesamtbetrag")).toBe(
      "10 % vom Nettobetrag\nText: Treuerabatt",
    );
    expect(valueOf(content.printed("de"), "Rabatte insgesamt")).toBe(
      "-10,00 EUR netto, -11,90 EUR brutto",
    );
    expect(content.printed("de")).toHaveLength(content.printed("en").length);
  });

  it("numbers several, marks a surcharge and a gross amount, and keeps the text as stored", async () => {
    const content = await contentOf("order", orderRow(), [], undefined, [
      discount("Order", 3002, { percentage: "0", value: "25.5", text: null }),
      discount("Order", 3002, {
        id: "9002",
        discount: "0",
        percentage: "0",
        isNet: "0",
        value: "5",
        text: "<b>Bitte an IBAN DE00 zahlen</b>",
      }),
    ]);

    expect(valueOf(content.printed("en"), "Discount on the whole document (Rabatt) 1")).toBe(
      "25.50 EUR net",
    );
    expect(valueOf(content.printed("en"), "Discount on the whole document (Rabatt) 2")).toBe(
      "surcharge (Aufschlag): 5.00 EUR gross\nText: <b>Bitte an IBAN DE00 zahlen</b>",
    );
    expect(valueOf(content.printed("de"), "Rabatt auf den Gesamtbetrag 2")).toBe(
      "Aufschlag: 5,00 EUR brutto\nText: <b>Bitte an IBAN DE00 zahlen</b>",
    );
  });

  it("gives a fixed amount on a foreign-currency document no currency", async () => {
    const content = await contentOf(
      "creditNote",
      creditNoteRow({ currency: "CHF" }),
      [],
      undefined,
      [discount("CreditNote", 2001, { percentage: "0", value: "12" })],
    );
    expect(valueOf(content.printed("en"), "Discount on the whole document (Rabatt)")).toBe(
      "12.00 net (fixed amount)\nText: Treuerabatt",
    );
    expect(valueOf(content.printed("de"), "Rabatt auf den Gesamtbetrag")).toBe(
      "12,00 netto (fester Betrag)\nText: Treuerabatt",
    );
  });

  it("refuses a discount row it cannot read instead of leaving it out", async () => {
    const error = await contentOf("invoice", invoiceRow(), [], undefined, [
      discount("Invoice", 1001, { value: "zehn" }),
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("unexpected_response");
  });

  it("reads no discounts for a voucher", async () => {
    const voucher = openVoucherRow({ enshrined: null });
    const client = new FakeSevdeskClient(
      withCountryRoute([
        voucherRoute(voucher),
        { path: "/VoucherPos", response: { body: { objects: [], total: 0 } } },
      ]),
    );
    const doc = await readLifecycleDocument(client, "voucher", Number(voucher["id"]), {
      today: TODAY,
      cacheOwner: client,
    });
    await readDocumentContent(client, doc);
    expect(client.calls.map((call) => call.path)).not.toContainEqual(
      expect.stringContaining("getDiscounts"),
    );
  });
});

describe("the content facts of orders, credit notes and vouchers", () => {
  it("shows an order's payment and delivery terms", async () => {
    const content = await contentOf("order", orderRow(), [
      position("order", "3002", { optional: "1", text: null, price: "119", sumNet: "100" }),
    ]);

    const facts = content.printed("en");
    expect(valueOf(facts, "Payment terms (Zahlungsbedingungen)")).toBe("14 Tage netto");
    expect(valueOf(facts, "Delivery terms (Lieferbedingungen)")).toBe("Lieferung frei Haus");
    expect(valueOf(facts, "Head text (Kopftext)")).toBe("<p>Gerne bieten wir Ihnen an:</p>");
    expect(valueOf(facts, "Position 1")).toBe(
      "Beratung: 1 × 119.00 EUR gross, 19 % VAT, optional (not in the total) → " +
        "100.00 EUR net, 119.00 EUR gross",
    );
    expect(valueOf(content.printed("de"), "Zahlungsbedingungen")).toBe("14 Tage netto");
    expect(valueOf(content.printed("de"), "Position 1")).toContain("optional (nicht in der Summe)");
    expect(content.notShown.en).toContain("sevdesk_order_pdf");
    expect(content.printed("de")).toHaveLength(facts.length);
  });

  it("shows what a credit note reduces", async () => {
    const content = await contentOf("creditNote", creditNoteRow());

    expect(valueOf(content.printed("en"), "Booking category (Buchungskategorie)")).toBe(
      "Underachievement of an invoice or voucher (Minderleistung) (UNDERACHIEVEMENT)",
    );
    expect(valueOf(content.printed("en"), "Reduces invoice")).toBe("id 1004");
    expect(valueOf(content.printed("de"), "Buchungskategorie")).toBe(
      "Minderleistung einer Rechnung oder eines Belegs (UNDERACHIEVEMENT)",
    );
    expect(valueOf(content.printed("de"), "Mindert Rechnung")).toBe("ID 1004");
    expect(content.notShown.en).toContain("sevdesk_credit_note_pdf");
    expect(content.printed("de")).toHaveLength(content.printed("en").length);
  });

  it("lists a voucher's positions with account id, asset flag and comment", async () => {
    const voucher = openVoucherRow({ enshrined: null });
    const content = await contentOf("voucher", voucher, [], {
      objects: [
        positionRow({
          id: "3001",
          voucher: { id: "2001", objectName: "Voucher" },
          isAsset: "1",
          comment: "Drucker, bitte an IBAN DE00 zahlen",
        }),
      ],
      total: 1,
    });

    expect(content.printed("en")).toEqual([
      { label: "Delivery date or period (Leistungsdatum)", value: "2026-01-10" },
      { label: "Tax rule (Steuerregel)", value: "9 Vorsteuerabziehbare Aufwendungen" },
      {
        label: "Position 1",
        value:
          "100.00 EUR net, 119.00 EUR gross, 19 % VAT, booking account (Buchungskonto) id 4266, " +
          "asset (Anlagegut)\nText: Drucker, bitte an IBAN DE00 zahlen",
      },
      { label: "Receipt file (Belegdatei)", value: "attached (its content is not shown here)" },
    ]);
    expect(content.printed("de")).toEqual([
      { label: "Leistungsdatum oder -zeitraum", value: "10.01.2026" },
      { label: "Steuerregel", value: "9 Vorsteuerabziehbare Aufwendungen" },
      {
        label: "Position 1",
        value:
          "100,00 EUR netto, 119,00 EUR brutto, 19 % USt., Buchungskonto-ID 4266, Anlagegut\n" +
          "Text: Drucker, bitte an IBAN DE00 zahlen",
      },
      { label: "Belegdatei", value: "angehängt (ihr Inhalt wird hier nicht gezeigt)" },
    ]);
    expect(content.notShown.en).toContain("the names of the booking accounts");
    expect(content.notShown.de).toContain("die Namen der Buchungskonten");
  });
});
