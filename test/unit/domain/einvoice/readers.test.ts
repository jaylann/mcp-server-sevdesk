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
});
