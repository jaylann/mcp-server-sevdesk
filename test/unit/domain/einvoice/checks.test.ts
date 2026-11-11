import { beforeAll, describe, expect, it } from "vitest";

import { checkEInvoice, sortFindings } from "../../../../src/domain/einvoice/checks.js";
import type { EInvoiceFacts, LinePricing } from "../../../../src/domain/einvoice/extracted.js";
import type { ParsedEInvoice } from "../../../../src/domain/einvoice/model.js";
import { parseEInvoice } from "../../../../src/domain/einvoice/parse.js";
import { einvoiceFixture } from "./helpers.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

const FACTS: EInvoiceFacts = {
  sellerLegalId: false,
  buyerLegalId: false,
  missingTotals: [],
  paymentInstructions: true,
  taxCurrencyTotal: false,
};

let base: ParsedEInvoice;

beforeAll(async () => {
  base = await parseEInvoice(einvoiceFixture("generated/cii-en16931-invoice.xml"));
});

/** Codes of the findings for a changed copy of the synthetic EN 16931 invoice. */
function codesFor(
  change: (invoice: Mutable<ParsedEInvoice>) => void,
  facts: Partial<EInvoiceFacts> = {},
): string[] {
  const invoice = structuredClone(base) as Mutable<ParsedEInvoice>;
  change(invoice);
  return checkEInvoice(invoice, { ...FACTS, ...facts }).map((finding) => finding.code);
}

function messagesFor(change: (invoice: Mutable<ParsedEInvoice>) => void): string[] {
  const invoice = structuredClone(base) as Mutable<ParsedEInvoice>;
  change(invoice);
  return checkEInvoice(invoice, FACTS).map((finding) => finding.message);
}

describe("checkEInvoice", () => {
  it("finds nothing in a consistent invoice", () => {
    expect(codesFor(() => undefined)).toEqual([]);
  });

  it("reports missing required terms (BR-01, BR-06–BR-11, BR-16)", () => {
    expect(
      codesFor((invoice) => {
        delete invoice.specificationId;
        invoice.seller.name = "";
        invoice.buyer.name = "";
        invoice.seller.address = {};
        invoice.buyer.address = {};
        invoice.lines = [];
      }),
    ).toEqual(
      expect.arrayContaining([
        "BR-01",
        "BR-06",
        "BR-07",
        "BR-08",
        "BR-09",
        "BR-10",
        "BR-11",
        "BR-16",
      ]),
    );
  });

  it("reports missing totals and skips the sums they feed", () => {
    const codes = codesFor(() => undefined, {
      missingTotals: ["BT-106", "BT-109", "BT-110", "BT-112", "BT-115"],
    });
    expect(codes).toEqual(["BR-12", "BR-13", "BR-CO-14", "BR-14", "BR-15"]);
  });

  it.each([
    ["BR-CO-10", (invoice: Mutable<ParsedEInvoice>) => void (invoice.totals.lineNet = "231.00")],
    ["BR-CO-11", (invoice: Mutable<ParsedEInvoice>) => void (invoice.totals.allowances = "9.00")],
    ["BR-CO-12", (invoice: Mutable<ParsedEInvoice>) => void (invoice.totals.charges = "1.00")],
    ["BR-CO-14", (invoice: Mutable<ParsedEInvoice>) => void (invoice.totals.tax = "38.21")],
    ["BR-CO-16", (invoice: Mutable<ParsedEInvoice>) => void (invoice.totals.due = "258.00")],
  ])("checks the totals: %s", (code, change) => {
    expect(codesFor(change)).toContain(code);
  });

  it("checks BT-109 and BT-112 (BR-CO-13, BR-CO-15) and quotes both amounts", () => {
    expect(codesFor((invoice) => void (invoice.totals.net = "221.00"))).toEqual(
      expect.arrayContaining(["BR-CO-13", "BR-CO-15"]),
    );
    expect(messagesFor((invoice) => void (invoice.totals.gross = "258.30"))).toEqual([
      "The total with VAT (BT-112) does not equal BT-109 + BT-110: stated 258.30, computed 258.2 (EUR).",
      "The amount due (BT-115) does not equal BT-112 − BT-113 + BT-114: stated 258.20, computed 258.3 (EUR).",
    ]);
  });

  it("accounts for paid and rounding amounts (BR-CO-16)", () => {
    expect(
      codesFor((invoice) => {
        invoice.totals.prepaid = "58.20";
        invoice.totals.rounding = "0.01";
        invoice.totals.due = "200.01";
      }),
    ).toEqual([]);
  });

  it("checks the VAT breakdown per category and rate (BR-S-08, BR-CO-17)", () => {
    expect(
      codesFor((invoice) => {
        invoice.vatBreakdown[0]!.taxableAmount = "191.00";
      }),
    ).toContain("BR-S-08");
    expect(codesFor((invoice) => void (invoice.vatBreakdown[1]!.taxAmount = "3.20"))).toEqual(
      expect.arrayContaining(["BR-CO-17"]),
    );
    // Within the Schematron tolerance of one currency unit: no BR-CO-17 (but BR-CO-14).
    expect(codesFor((invoice) => void (invoice.vatBreakdown[1]!.taxAmount = "2.60"))).not.toContain(
      "BR-CO-17",
    );
  });

  it("requires a breakdown row for every category in use (BR-C-01)", () => {
    expect(
      codesFor((invoice) => {
        invoice.lines[1]!.vatCategory = "Z";
        invoice.lines[1]!.vatRate = "0";
      }),
    ).toEqual(expect.arrayContaining(["BR-Z-01", "BR-S-08"]));
    expect(
      codesFor((invoice) => {
        invoice.lines[1]!.vatRate = "5";
      }),
    ).toEqual(expect.arrayContaining(["BR-S-01"]));
  });

  it("checks line VAT rates per category (BR-C-05)", () => {
    expect(codesFor((invoice) => void (invoice.lines[0]!.vatRate = "0"))).toContain("BR-S-05");
    expect(
      codesFor((invoice) => {
        invoice.lines[0]!.vatCategory = "Z";
        invoice.lines[0]!.vatRate = "7";
      }),
    ).toContain("BR-Z-05");
    expect(
      codesFor((invoice) => {
        invoice.lines[0]!.vatCategory = "O";
      }),
    ).toContain("BR-O-05");
    expect(
      codesFor((invoice) => {
        invoice.lines[0]!.vatCategory = "L";
      }),
    ).not.toContain("BR-L-05");
  });

  it("requires 0 VAT and an exemption reason for exempt categories (BR-C-09, BR-C-10)", () => {
    const toExempt = (invoice: Mutable<ParsedEInvoice>): void => {
      invoice.lines = [
        { ...invoice.lines[1]!, vatCategory: "E", vatRate: "0", netAmount: "230.00" },
      ];
      invoice.allowancesCharges = [];
      invoice.vatBreakdown = [
        { category: "E", rate: "0", taxableAmount: "230.00", taxAmount: "1.00" },
      ];
      invoice.totals = {
        lineNet: "230.00",
        net: "230.00",
        tax: "1.00",
        gross: "231.00",
        due: "231.00",
      };
    };
    expect(codesFor(toExempt)).toEqual(["BR-E-09", "BR-E-10"]);
    expect(
      codesFor((invoice) => {
        toExempt(invoice);
        invoice.vatBreakdown[0]!.taxAmount = "0";
        invoice.vatBreakdown[0]!.exemptionCode = "VATEX-EU-132";
        invoice.totals.tax = "0";
        invoice.totals.gross = "230.00";
        invoice.totals.due = "230.00";
      }),
    ).toEqual([]);
  });

  it("checks the identifiers VAT treatment depends on", () => {
    const noSellerIds = (invoice: Mutable<ParsedEInvoice>): void => {
      delete invoice.seller.vatId;
      delete invoice.seller.taxNumber;
    };
    expect(codesFor(noSellerIds)).toEqual(["BR-CO-26", "BR-S-02"]);
    expect(codesFor(noSellerIds, { sellerLegalId: true })).toEqual(["BR-S-02"]);

    const reverseCharge = (invoice: Mutable<ParsedEInvoice>): void => {
      invoice.vatBreakdown.push({
        category: "AE",
        rate: "0",
        taxableAmount: "0",
        taxAmount: "0",
        exemptionReason: "Reverse charge",
      });
      invoice.vatBreakdown.push({
        category: "K",
        rate: "0",
        taxableAmount: "0",
        taxAmount: "0",
        exemptionReason: "Intra-community supply",
      });
      invoice.vatBreakdown.push({
        category: "G",
        rate: "0",
        taxableAmount: "0",
        taxAmount: "0",
        exemptionReason: "Export",
      });
      delete invoice.buyer.vatId;
    };
    expect(codesFor(reverseCharge)).toEqual(["BR-AE-02", "BR-K-02"]);
    expect(codesFor(reverseCharge, { buyerLegalId: true })).toEqual(["BR-K-02"]);
    expect(
      codesFor((invoice) => {
        reverseCharge(invoice);
        delete invoice.seller.vatId;
      }),
    ).toEqual(["BR-CO-26", "BR-AE-02", "BR-K-02", "BR-G-02"]);
  });

  it("needs a due date or payment terms for a positive amount due (BR-CO-25)", () => {
    expect(
      codesFor((invoice) => {
        delete invoice.dueDate;
        delete invoice.payment.terms;
      }),
    ).toEqual(["BR-CO-25"]);
  });

  it("applies the XRechnung rules only to XRechnung", () => {
    const strip = (invoice: Mutable<ParsedEInvoice>): void => {
      delete invoice.seller.address.city;
      delete invoice.seller.address.postcode;
      delete invoice.buyer.address.city;
      delete invoice.buyer.address.postcode;
      delete invoice.payment.iban;
    };
    expect(codesFor(strip, { paymentInstructions: false })).toEqual([]);
    expect(
      codesFor(
        (invoice) => {
          strip(invoice);
          invoice.profile = "xrechnung";
        },
        { paymentInstructions: false },
      ),
    ).toEqual(["BR-DE-1", "BR-DE-3", "BR-DE-4", "BR-DE-8", "BR-DE-9", "BR-DE-15", "BR-DE-23-a"]);
  });

  it("marks MINIMUM/BASIC WL and unknown type codes", () => {
    expect(codesFor((invoice) => void (invoice.profile = "basic_wl"))).toEqual(["SD-PROFILE"]);
    const findings = (() => {
      const invoice = structuredClone(base) as Mutable<ParsedEInvoice>;
      invoice.documentKind = "other";
      return checkEInvoice(invoice, FACTS);
    })();
    expect(findings).toEqual([expect.objectContaining({ code: "SD-TYPE", severity: "warning" })]);
  });
});

describe("line net amounts (SD-LINE-NET, review 2026-11, round 3)", () => {
  // The synthetic invoice: line 1 is 2 × 100.00 = 200.00, line 2 is 1 × 30.00 = 30.00.
  const priced = (
    first: Partial<LinePricing> | undefined,
    second: Partial<LinePricing> = {},
  ): Pick<EInvoiceFacts, "linePricing"> => ({
    linePricing: [
      first === undefined
        ? undefined
        : { quantity: "2", price: "100.00", baseQuantity: "1", adjustment: "0", ...first },
      { quantity: "1", price: "30.00", baseQuantity: "1", adjustment: "0", ...second },
    ],
  });

  it("is a warning and names the line by its position", () => {
    const invoice = structuredClone(base);
    const findings = checkEInvoice(invoice, { ...FACTS, ...priced({ price: "10.00" }) });
    expect(findings).toEqual([
      {
        code: "SD-LINE-NET",
        severity: "warning",
        message: expect.stringContaining("On 1 line(s)") as string,
      },
    ]);
    expect(findings[0]?.message).toContain("line position 1.");
  });

  it.each<[string, Partial<LinePricing>, boolean]>([
    ["the stated amount", {}, false],
    ["two cents off", { price: "100.01" }, false],
    ["three cents off", { price: "100.015" }, true],
    ["a price per 100 units", { price: "10000", baseQuantity: "100" }, false],
    ["a price per 3 units that does not divide evenly", { quantity: "1", price: "600" }, true],
    ["a price per 3 units", { quantity: "1", price: "600", baseQuantity: "3" }, false],
    ["a line allowance", { price: "110", adjustment: "-20" }, false],
    ["a line charge that is not in the amount", { adjustment: "5" }, true],
    ["a zero quantity with an amount", { quantity: "0" }, true],
  ])("with %s", (_label, pricing, warns) => {
    expect(codesFor(() => undefined, priced(pricing))).toEqual(warns ? ["SD-LINE-NET"] : []);
  });

  it("checks credited (negative) amounts the same way", () => {
    const negative = (invoice: Mutable<ParsedEInvoice>): void => {
      const line = invoice.lines[0];
      if (line !== undefined) line.netAmount = "-200.00";
    };
    const codes = (pricing: Partial<LinePricing>): string[] =>
      codesFor(negative, priced(pricing)).filter((code) => code === "SD-LINE-NET");
    expect(codes({ quantity: "-2" })).toEqual([]);
    expect(codes({ quantity: "2" })).toEqual(["SD-LINE-NET"]);
  });

  it("skips lines without pricing and invoices without the list", () => {
    expect(codesFor(() => undefined)).toEqual([]);
    expect(codesFor(() => undefined, priced(undefined, { price: "30.00" }))).toEqual([]);
    expect(codesFor(() => undefined, priced(undefined, { price: "3.00" }))).toEqual([
      "SD-LINE-NET",
    ]);
  });

  it("names at most five lines and counts the rest", () => {
    const invoice = structuredClone(base) as Mutable<ParsedEInvoice>;
    const line = invoice.lines[1];
    if (line === undefined) throw new Error("the fixture has two lines");
    invoice.lines = Array.from({ length: 8 }, () => ({ ...line }));
    const linePricing = invoice.lines.map(() => ({
      quantity: "1",
      price: "3.00",
      baseQuantity: "1",
      adjustment: "0",
    }));
    const message = checkEInvoice(invoice, { ...FACTS, linePricing }).find(
      (finding) => finding.code === "SD-LINE-NET",
    )?.message;
    expect(message).toContain("On 8 line(s)");
    expect(message).toContain("line position 1, 2, 3, 4, 5 and 3 more.");
  });
});

describe("sortFindings", () => {
  it("puts errors first and drops duplicates", () => {
    const warning = { code: "W", severity: "warning", message: "w" } as const;
    const error = { code: "E", severity: "error", message: "e" } as const;
    expect(sortFindings([warning, error, warning, error])).toEqual([error, warning]);
  });
});
