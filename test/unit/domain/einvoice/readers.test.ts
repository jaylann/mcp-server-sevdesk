import { describe, expect, it } from "vitest";

import {
  ciiXml,
  CREDIT_NOTE,
  EN16931_INVOICE,
  ublCreditNoteXml,
} from "../../../../scripts/gen-einvoice-fixtures.js";
import { MAX_LINES, MAX_NOTES, MAX_ROWS } from "../../../../src/domain/einvoice/fields.js";
import { parseEInvoice } from "../../../../src/domain/einvoice/parse.js";
import { einvoiceText, utf8, validationMessage } from "./helpers.js";

const UBL_INVOICE = einvoiceText("kosit/01.01a-INVOICE_ubl.xml");
const CII_INVOICE = ciiXml(EN16931_INVOICE);

function refusal(text: string): Promise<string> {
  return validationMessage(parseEInvoice(utf8(text)));
}

describe("CII and UBL readers: limits", () => {
  it(`keeps at most ${MAX_NOTES} notes and says so`, async () => {
    const notes = Array.from(
      { length: MAX_NOTES + 1 },
      (_unused, index) => `Hinweis ${String(index)}`,
    );
    const cii = await parseEInvoice(utf8(ciiXml({ ...EN16931_INVOICE, notes })));
    const ubl = await parseEInvoice(utf8(ublCreditNoteXml({ ...CREDIT_NOTE, notes })));
    for (const parsed of [cii, ubl]) {
      expect(parsed.notes).toHaveLength(MAX_NOTES);
      expect(parsed.findings).toEqual([
        expect.objectContaining({ code: "SD-NOTES", severity: "warning" }),
      ]);
    }
  });

  it(`refuses more than ${MAX_LINES} lines and ${MAX_ROWS} rows`, async () => {
    const ciiLine = CII_INVOICE.slice(
      CII_INVOICE.indexOf("<ram:IncludedSupplyChainTradeLineItem>"),
      CII_INVOICE.indexOf("</ram:IncludedSupplyChainTradeLineItem>") +
        "</ram:IncludedSupplyChainTradeLineItem>".length,
    );
    const manyLines = CII_INVOICE.replace(
      ciiLine,
      "<ram:IncludedSupplyChainTradeLineItem/>".repeat(MAX_LINES + 1),
    );
    expect(await refusal(manyLines)).toContain(`more than ${MAX_LINES} lines`);
    const ciiTax = "<ram:ApplicableTradeTax><ram:CalculatedAmount>36.10</ram:CalculatedAmount>";
    const manyRows = CII_INVOICE.replace(
      ciiTax,
      `${"<ram:ApplicableTradeTax><ram:CategoryCode>S</ram:CategoryCode></ram:ApplicableTradeTax>".repeat(MAX_ROWS + 1)}${ciiTax}`,
    );
    expect(await refusal(manyRows)).toContain(`more than ${MAX_ROWS}`);

    const ublLine = UBL_INVOICE.slice(
      UBL_INVOICE.indexOf("<cac:InvoiceLine>"),
      UBL_INVOICE.indexOf("</cac:InvoiceLine>") + "</cac:InvoiceLine>".length,
    );
    expect(
      await refusal(UBL_INVOICE.replace(ublLine, "<cac:InvoiceLine/>".repeat(MAX_LINES + 1))),
    ).toContain(`more than ${MAX_LINES} lines`);
    const charge =
      "<cac:AllowanceCharge><cbc:ChargeIndicator>true</cbc:ChargeIndicator></cac:AllowanceCharge>";
    expect(
      await refusal(
        UBL_INVOICE.replace("<cac:TaxTotal>", `${charge.repeat(MAX_ROWS + 1)}<cac:TaxTotal>`),
      ),
    ).toContain(`more than ${MAX_ROWS}`);
  });

  it("refuses a UBL invoice without type code or readable issue date", async () => {
    expect(
      await refusal(UBL_INVOICE.replace(/<cbc:InvoiceTypeCode>380<\/cbc:InvoiceTypeCode>/, "")),
    ).toContain("type code (BT-3");
    expect(
      await refusal(
        UBL_INVOICE.replace(
          /<cbc:IssueDate>[^<]*<\/cbc:IssueDate>/,
          "<cbc:IssueDate>04.04.2016</cbc:IssueDate>",
        ),
      ),
    ).toContain("issue date (BT-2");
    expect(await refusal(UBL_INVOICE.replace(/<cbc:ID>123456XX<\/cbc:ID>/, ""))).toContain(
      "invoice number (BT-1",
    );
  });
});

describe("CII and UBL readers: VAT accounting currency (BT-6, BT-111)", () => {
  it("reads the tax total in the accounting currency from CII", async () => {
    const xml = CII_INVOICE.replace(
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
      "<ram:TaxCurrencyCode>CHF</ram:TaxCurrencyCode><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
    ).replace(
      '<ram:TaxTotalAmount currencyID="EUR">38.20</ram:TaxTotalAmount>',
      '<ram:TaxTotalAmount currencyID="CHF">36.00</ram:TaxTotalAmount><ram:TaxTotalAmount currencyID="EUR">38.20</ram:TaxTotalAmount>',
    );
    const parsed = await parseEInvoice(utf8(xml));
    expect(parsed).toMatchObject({
      currency: "EUR",
      taxCurrency: "CHF",
      totals: { tax: "38.20", taxInAccountingCurrency: "36.00" },
      findings: [],
    });
  });

  it("reads the tax total in the accounting currency from UBL", async () => {
    const xml = ublCreditNoteXml(CREDIT_NOTE)
      .replace(
        "<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>",
        "<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cbc:TaxCurrencyCode>CHF</cbc:TaxCurrencyCode>",
      )
      .replace(
        "<cac:TaxTotal>",
        '<cac:TaxTotal><cbc:TaxAmount currencyID="CHF">9.00</cbc:TaxAmount></cac:TaxTotal><cac:TaxTotal>',
      );
    const parsed = await parseEInvoice(utf8(xml));
    expect(parsed).toMatchObject({
      taxCurrency: "CHF",
      totals: { tax: "9.50", taxInAccountingCurrency: "9.00" },
      vatBreakdown: [{ taxAmount: "9.50" }],
      findings: [],
    });
  });

  it("records malformed amounts and dates as findings", async () => {
    const xml = CII_INVOICE.replace(
      "<ram:GrandTotalAmount>258.20</ram:GrandTotalAmount>",
      "<ram:GrandTotalAmount>258,20</ram:GrandTotalAmount>",
    ).replace(
      '<ram:DueDateDateTime><udt:DateTimeString format="102">20260129</udt:DateTimeString>',
      '<ram:DueDateDateTime><udt:DateTimeString format="610">202601</udt:DateTimeString>',
    );
    const parsed = await parseEInvoice(utf8(xml));
    expect(parsed.findings.map((finding) => finding.code)).toEqual([
      "SD-DATE",
      "SD-NUMBER",
      "BR-14",
    ]);
    expect(parsed.totals.gross).toBe("258.2");
    expect(parsed.dueDate).toBeUndefined();
  });

  it("divides the unit price by its base quantity", async () => {
    const xml = CII_INVOICE.replace(
      "<ram:ChargeAmount>30.00</ram:ChargeAmount>",
      '<ram:ChargeAmount>3000.00</ram:ChargeAmount><ram:BasisQuantity unitCode="C62">100</ram:BasisQuantity>',
    );
    const parsed = await parseEInvoice(utf8(xml));
    expect(parsed.lines[1]?.netPrice).toBe("30");
  });

  it("does not take a CII tax total in another currency for BT-110", async () => {
    // Review 2026-11, round 3: without a total in the invoice currency the first one was used.
    const xml = swap(
      CII_INVOICE,
      '<ram:TaxTotalAmount currencyID="EUR">38.20</ram:TaxTotalAmount>',
      '<ram:TaxTotalAmount currencyID="USD">38.20</ram:TaxTotalAmount>',
    );
    const parsed = await parseEInvoice(utf8(xml));
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        code: "BR-CO-14",
        severity: "error",
        message: expect.stringContaining("The total BT-110 is missing or unreadable") as string,
      }),
    ]);
  });
});

/** `text` with `from` replaced by `to`; fails when `from` is not there (a silent no-op test). */
function swap(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe("CII and UBL readers: namespaces (review 2026-11, round 3)", () => {
  const FOREIGN = 'xmlns:x="urn:attacker"';

  it("does not read a CII element of a foreign namespace as a field", async () => {
    // The foreign element comes first; lookups by local name alone took it for the currency
    // and the invoice in USD went through as one in EUR.
    const shadowed = swap(
      CII_INVOICE,
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
      `<x:InvoiceCurrencyCode ${FOREIGN}>EUR</x:InvoiceCurrencyCode>` +
        "<ram:InvoiceCurrencyCode>USD</ram:InvoiceCurrencyCode>",
    );
    expect((await parseEInvoice(utf8(shadowed))).currency).toBe("USD");

    // Only a foreign element: the field is missing.
    const onlyForeign = swap(
      CII_INVOICE,
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
      `<x:InvoiceCurrencyCode ${FOREIGN}>EUR</x:InvoiceCurrencyCode>`,
    );
    expect(await refusal(onlyForeign)).toContain("no invoice currency (BT-5)");
  });

  it("does not read a CII element in the wrong CII namespace or a foreign group", async () => {
    // `rsm:` is a CII namespace, but InvoiceCurrencyCode is defined in `ram:`.
    const wrongKnown = swap(
      CII_INVOICE,
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
      "<rsm:InvoiceCurrencyCode>EUR</rsm:InvoiceCurrencyCode>" +
        "<ram:InvoiceCurrencyCode>USD</ram:InvoiceCurrencyCode>",
    );
    expect((await parseEInvoice(utf8(wrongKnown))).currency).toBe("USD");

    // A foreign group with real CII elements inside is left out as a whole.
    const group = swap(
      CII_INVOICE,
      "<ram:SellerTradeParty>",
      `<x:SellerTradeParty ${FOREIGN}><ram:Name>Someone Else GmbH</ram:Name></x:SellerTradeParty>` +
        "<ram:SellerTradeParty>",
    );
    expect((await parseEInvoice(utf8(group))).seller.name).toBe(EN16931_INVOICE.seller.name);
  });

  it("does not read a prefixed attribute as currencyID", async () => {
    const xml = swap(
      CII_INVOICE,
      '<ram:TaxTotalAmount currencyID="EUR">38.20</ram:TaxTotalAmount>',
      `<ram:TaxTotalAmount ${FOREIGN} x:currencyID="EUR" currencyID="USD">38.20</ram:TaxTotalAmount>`,
    );
    const codes = (await parseEInvoice(utf8(xml))).findings.map((finding) => finding.code);
    expect(codes).toEqual(["BR-CO-14"]);
  });

  it("does not read a UBL element of a foreign or the wrong UBL namespace as a field", async () => {
    const shadowed = swap(
      UBL_INVOICE,
      "<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>",
      `<x:DocumentCurrencyCode ${FOREIGN}>EUR</x:DocumentCurrencyCode>` +
        // An aggregate namespace element with a value's name is not that value either.
        "<cac:DocumentCurrencyCode>EUR</cac:DocumentCurrencyCode>" +
        "<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>",
    );
    expect((await parseEInvoice(utf8(shadowed))).currency).toBe("USD");

    const foreignLine = swap(
      UBL_INVOICE,
      "<cac:InvoiceLine>",
      `<x:InvoiceLine ${FOREIGN}><cbc:ID>9</cbc:ID></x:InvoiceLine><cac:InvoiceLine>`,
    );
    expect(await parseEInvoice(utf8(foreignLine))).toEqual(await parseEInvoice(utf8(UBL_INVOICE)));
  });

  it("reads CII and UBL whatever prefixes the file uses", async () => {
    const expected = await parseEInvoice(utf8(CII_INVOICE));
    const renamed = CII_INVOICE.replaceAll("ram:", "a:")
      .replaceAll("rsm:", "r:")
      .replaceAll("udt:", "u:")
      .replace("xmlns:ram=", "xmlns:a=")
      .replace("xmlns:rsm=", "xmlns:r=")
      .replace("xmlns:udt=", "xmlns:u=");
    expect(renamed).not.toContain("ram:");
    expect(await parseEInvoice(utf8(renamed))).toEqual(expected);

    // The aggregate namespace as the default namespace, declared on the root.
    const defaulted = CII_INVOICE.replaceAll("<ram:", "<")
      .replaceAll("</ram:", "</")
      .replace("xmlns:ram=", "xmlns=");
    expect(await parseEInvoice(utf8(defaulted))).toEqual(expected);

    const ublExpected = await parseEInvoice(utf8(UBL_INVOICE));
    const ublRenamed = UBL_INVOICE.replaceAll("cbc:", "b:")
      .replaceAll("cac:", "g:")
      .replaceAll("<ubl:", "<doc:")
      .replaceAll("</ubl:", "</doc:")
      .replace("xmlns:cbc=", "xmlns:b=")
      .replace("xmlns:cac=", "xmlns:g=")
      .replace("xmlns:ubl=", "xmlns:doc=");
    expect(ublRenamed).not.toContain("cbc:");
    expect(await parseEInvoice(utf8(ublRenamed))).toEqual(ublExpected);

    // A namespace declared again further down, on the element that uses it.
    const local = swap(
      UBL_INVOICE,
      "<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>",
      '<n:DocumentCurrencyCode xmlns:n="urn:oasis:names:specification:ubl:schema:xsd:' +
        'CommonBasicComponents-2">EUR</n:DocumentCurrencyCode>',
    );
    expect(await parseEInvoice(utf8(local))).toEqual(ublExpected);
  });
});

describe("UBL reader: root element and type code (review 2026-11, round 3)", () => {
  const CREDIT_NOTE_XML = ublCreditNoteXml(CREDIT_NOTE);

  it("refuses a CreditNote root with an invoice type code", async () => {
    // It used to become documentKind "invoice" and was imported as a positive expense.
    const xml = swap(
      CREDIT_NOTE_XML,
      "<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>",
      "<cbc:CreditNoteTypeCode>380</cbc:CreditNoteTypeCode>",
    );
    expect(await refusal(xml)).toBe(
      "The e-invoice is a UBL credit note (root element CreditNote) but carries an invoice " +
        "type code (BT-3). The two contradict each other; ask the sender for a corrected file. " +
        "The e-invoice cannot be read; nothing was sent to sevDesk.",
    );
  });

  it("refuses an Invoice root with a credit note type code", async () => {
    const xml = swap(
      UBL_INVOICE,
      "<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>",
      "<cbc:InvoiceTypeCode>381</cbc:InvoiceTypeCode>",
    );
    expect(await refusal(xml)).toContain(
      "is a UBL invoice (root element Invoice) but carries a credit note type code (BT-3)",
    );
  });

  it("keeps matching codes and reports a code of neither list", async () => {
    expect(await parseEInvoice(utf8(CREDIT_NOTE_XML))).toMatchObject({
      typeCode: "381",
      documentKind: "credit_note",
    });
    expect(await parseEInvoice(utf8(UBL_INVOICE))).toMatchObject({
      typeCode: "380",
      documentKind: "invoice",
    });
    for (const [xml, element] of [
      [CREDIT_NOTE_XML, "CreditNoteTypeCode"],
      [UBL_INVOICE, "InvoiceTypeCode"],
    ] as const) {
      const other = xml.replace(
        new RegExp(`<cbc:${element}>\\d+</cbc:${element}>`),
        `<cbc:${element}>999</cbc:${element}>`,
      );
      const parsed = await parseEInvoice(utf8(other));
      expect(parsed.documentKind).toBe("other");
      expect(parsed.findings.map((finding) => finding.code)).toContain("SD-TYPE");
    }
  });
});

describe("CII and UBL readers: payee (BG-10)", () => {
  it("reads a separate payee from CII and UBL, and none when the file has none", async () => {
    const cii = swap(
      CII_INVOICE,
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>" +
        "<ram:PayeeTradeParty><ram:Name>Factor GmbH</ram:Name></ram:PayeeTradeParty>",
    );
    expect((await parseEInvoice(utf8(cii))).payment.payee).toEqual({ name: "Factor GmbH" });
    const ubl = swap(
      UBL_INVOICE,
      "<cac:PaymentMeans>",
      "<cac:PayeeParty><cac:PartyName><cbc:Name>Factor GmbH</cbc:Name></cac:PartyName>" +
        "</cac:PayeeParty><cac:PaymentMeans>",
    );
    expect((await parseEInvoice(utf8(ubl))).payment.payee).toEqual({ name: "Factor GmbH" });
    // A payee without a name is still a payee.
    const unnamed = swap(
      UBL_INVOICE,
      "<cac:PaymentMeans>",
      "<cac:PayeeParty><cac:PartyIdentification><cbc:ID>7</cbc:ID></cac:PartyIdentification>" +
        "</cac:PayeeParty><cac:PaymentMeans>",
    );
    expect((await parseEInvoice(utf8(unnamed))).payment.payee).toEqual({});
    expect((await parseEInvoice(utf8(CII_INVOICE))).payment.payee).toBeUndefined();
    expect((await parseEInvoice(utf8(UBL_INVOICE))).payment.payee).toBeUndefined();
  });
});

describe("CII and UBL readers: line net amounts (SD-LINE-NET)", () => {
  const LINE_NET = expect.objectContaining({ code: "SD-LINE-NET", severity: "warning" }) as unknown;
  const CII_PRICE = "<ram:ChargeAmount>100.00</ram:ChargeAmount>";
  const CII_LINE_TAX = "<ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax>";
  const ciiLineAdjustment = (charge: boolean, amount: string): string =>
    "<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator>" +
    `<udt:Indicator>${String(charge)}</udt:Indicator></ram:ChargeIndicator>` +
    `<ram:ActualAmount>${amount}</ram:ActualAmount></ram:SpecifiedTradeAllowanceCharge>`;
  /** The first CII line (2 × 100.00 = 200.00) with another price and line allowances/charges. */
  const ciiLine = (price: string, adjustments = ""): string =>
    swap(
      swap(CII_INVOICE, CII_PRICE, `<ram:ChargeAmount>${price}</ram:ChargeAmount>`),
      CII_LINE_TAX,
      // In CII the allowances and charges of a line follow its tax, inside the settlement.
      `${CII_LINE_TAX.replace("<ram:ApplicableTradeTax>", "")}${adjustments}<ram:ApplicableTradeTax>`,
    );

  it("warns when a line's quantity and price do not give its net amount", async () => {
    // Review 2026-11, round 3: 2 × 10.00 with a stated 200.00 passed every check.
    const parsed = await parseEInvoice(utf8(ciiLine("10.00")));
    expect(parsed.findings).toEqual([LINE_NET]);
    expect(parsed.findings[0]?.message).toBe(
      "On 1 line(s) the net amount (BT-131) is not the quantity times the net price " +
        "(BT-129 × BT-146 ÷ BT-149) plus line charges minus line allowances: line position 1. " +
        "The totals follow the stated line amounts; compare these lines with the visual " +
        "invoice before booking.",
    );
  });

  it("allows two cents of rounding and no more", async () => {
    expect((await parseEInvoice(utf8(ciiLine("100.01")))).findings).toEqual([]);
    expect((await parseEInvoice(utf8(ciiLine("99.99")))).findings).toEqual([]);
    expect((await parseEInvoice(utf8(ciiLine("100.02")))).findings).toEqual([LINE_NET]);
  });

  it("counts line allowances and charges exactly", async () => {
    // 2 × 110.00 − 25.00 + 5.00 = 200.00.
    const consistent = ciiLine(
      "110.00",
      ciiLineAdjustment(false, "25.00") + ciiLineAdjustment(true, "5.00"),
    );
    expect((await parseEInvoice(utf8(consistent))).findings).toEqual([]);
    // The same allowance on a line that was right without it.
    const off = ciiLine("100.00", ciiLineAdjustment(false, "25.00"));
    expect((await parseEInvoice(utf8(off))).findings).toEqual([LINE_NET]);
  });

  it("says nothing about a line with a part it cannot read", async () => {
    // An allowance without a readable amount or indicator: the sum is unknown, so no verdict
    // and no finding that would block the import.
    for (const adjustment of [
      ciiLineAdjustment(false, "12,50"),
      ciiLineAdjustment(false, "25.00").replace(">false<", ">maybe<"),
    ]) {
      expect((await parseEInvoice(utf8(ciiLine("10.00", adjustment)))).findings).toEqual([]);
    }
    const noPrice = swap(CII_INVOICE, CII_PRICE, "");
    expect((await parseEInvoice(utf8(noPrice))).findings).toEqual([]);
  });

  it("divides by the price base quantity without rounding", async () => {
    // 1 × 3000.00 per 100 = 30.00, the second line.
    const perHundred = swap(
      CII_INVOICE,
      "<ram:ChargeAmount>30.00</ram:ChargeAmount>",
      '<ram:ChargeAmount>3000.00</ram:ChargeAmount><ram:BasisQuantity unitCode="C62">100</ram:BasisQuantity>',
    );
    expect((await parseEInvoice(utf8(perHundred))).findings).toEqual([]);
    const off = swap(perHundred, "<ram:ChargeAmount>3000.00", "<ram:ChargeAmount>3300.00");
    const findings = (await parseEInvoice(utf8(off))).findings;
    expect(findings).toEqual([LINE_NET]);
    expect(findings[0]?.message).toContain("line position 2.");
  });

  it("checks UBL lines, with the line's own allowances and not the price discount", async () => {
    const UBL_PRICE = '<cbc:PriceAmount currencyID="EUR">26.07</cbc:PriceAmount>';
    const UBL_NET = '<cbc:LineExtensionAmount currencyID="EUR">26.07</cbc:LineExtensionAmount>';
    const wrong = swap(UBL_INVOICE, UBL_PRICE, UBL_PRICE.replace("26.07", "2.60"));
    expect((await parseEInvoice(utf8(wrong))).findings).toEqual([LINE_NET]);
    // 1 × 30.00 − 3.93 = 26.07; the discount inside cac:Price (BT-147) is information only.
    const withAllowance = swap(
      swap(
        UBL_INVOICE,
        UBL_PRICE,
        `${UBL_PRICE.replace("26.07", "30.00")}<cac:AllowanceCharge>` +
          "<cbc:ChargeIndicator>false</cbc:ChargeIndicator>" +
          '<cbc:Amount currencyID="EUR">5.00</cbc:Amount></cac:AllowanceCharge>',
      ),
      UBL_NET,
      `${UBL_NET}<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator>` +
        '<cbc:Amount currencyID="EUR">3.93</cbc:Amount></cac:AllowanceCharge>',
    );
    expect((await parseEInvoice(utf8(withAllowance))).findings).toEqual([]);
  });
});
