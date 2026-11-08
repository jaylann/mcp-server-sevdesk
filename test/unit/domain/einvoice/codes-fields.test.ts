import { describe, expect, it } from "vitest";

import {
  documentKindOf,
  isVatCategoryCode,
  profileOf,
  typeCodeLabel,
  unitLabel,
} from "../../../../src/domain/einvoice/codes.js";
import {
  divideDecimal,
  pricePerUnit,
  withinTolerance,
} from "../../../../src/domain/einvoice/decimal.js";
import { completeTotals } from "../../../../src/domain/einvoice/extracted.js";
import {
  FieldReader,
  normalizeDecimal,
  normalizeIban,
  normalizeVatId,
  partyOf,
  requireCurrency,
  requireVatCategory,
  toIsoDate,
} from "../../../../src/domain/einvoice/fields.js";

describe("codes", () => {
  it.each([
    ["urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0", "xrechnung"],
    ["urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3", "en16931"],
    ["urn:cen.eu:en16931:2017", "en16931"],
    ["urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0", "en16931"],
    ["urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended", "extended"],
    ["urn:cen.eu:en16931:2017#conformant#urn:zugferd.de:2p0:extended", "extended"],
    ["urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic", "basic"],
    ["urn:factur-x.eu:1p0:basicwl", "basic_wl"],
    ["urn:zugferd.de:2p0:minimum", "minimum"],
    ["urn:example:other", "unknown"],
    ["  ", "unknown"],
    [undefined, "unknown"],
  ] as const)("profileOf(%j) is %s", (id, profile) => {
    expect(profileOf(id)).toBe(profile);
  });

  it("maps type codes to document kinds and labels", () => {
    expect(documentKindOf("380")).toBe("invoice");
    expect(documentKindOf("384")).toBe("invoice");
    expect(documentKindOf("381")).toBe("credit_note");
    expect(documentKindOf("261")).toBe("credit_note");
    expect(documentKindOf("999")).toBe("other");
    expect(typeCodeLabel("381")).toContain("Gutschrift");
    expect(typeCodeLabel("999")).toBe("type code 999");
    expect(typeCodeLabel("A:B")).toBe("unknown type");
  });

  it("knows the VAT categories and common units", () => {
    expect(isVatCategoryCode("AE")).toBe(true);
    expect(isVatCategoryCode("X")).toBe(false);
    expect(unitLabel("hur")).toContain("hour");
    expect(unitLabel("ZZZ")).toBeUndefined();
    expect(unitLabel(undefined)).toBeUndefined();
  });
});

describe("field normalization", () => {
  it.each([
    [" +12.50 ", "12.50"],
    ["-0.5", "-0.5"],
    [".5", "0.5"],
    ["7.", "7"],
    ["1e3", undefined],
    ["1,50", undefined],
    ["", undefined],
    [".", undefined],
    ["1".repeat(31), undefined],
  ])("normalizeDecimal(%j) is %j", (value, expected) => {
    expect(normalizeDecimal(value)).toBe(expected);
  });

  it.each([
    ["20260131", undefined, "2026-01-31"],
    ["20260131", "102", "2026-01-31"],
    ["2026-01-31", undefined, "2026-01-31"],
    ["2026-01-31Z", undefined, "2026-01-31"],
    ["2026-01-31+01:00", undefined, "2026-01-31"],
    ["2026-01-31", "102", undefined],
    ["202601", "610", undefined],
    ["20260231", undefined, undefined],
  ])("toIsoDate(%j, %j) is %j", (value, format, expected) => {
    expect(toIsoDate(value, format)).toBe(expected);
  });

  it("normalizes VAT ids and IBANs", () => {
    expect(normalizeVatId(" de 123.456-789 ")).toBe("DE123456789");
    expect(normalizeVatId("  ")).toBeUndefined();
    expect(normalizeIban("de89 3704 0044 0532 0130 00")).toBe("DE89370400440532013000");
    expect(normalizeIban("DE!!")).toBeUndefined();
    expect(normalizeIban(undefined)).toBeUndefined();
  });

  it("refuses unknown VAT categories and currencies with trusted messages", () => {
    expect(requireVatCategory(" ae ", "Line 1")).toBe("AE");
    expect(() => requireVatCategory("Q", "Line 1")).toThrow(/Line 1 has no VAT category code/);
    expect(() => requireVatCategory(undefined, "Line 1")).toThrow(/cannot be read/);
    expect(requireCurrency("usd")).toBe("USD");
    expect(() => requireCurrency("XYZ")).toThrow(/ISO 4217/);
  });

  it("records malformed values as findings instead of guessing", () => {
    const fields = new FieldReader();
    expect(fields.amount("12,5", "The total (BT-112)")).toBeUndefined();
    expect(fields.amount("12,5", "The total (BT-112)")).toBeUndefined();
    expect(fields.date("31.01.2026", "The due date (BT-9)")).toBeUndefined();
    expect(fields.country("Deutschland", "The seller country code (BT-40)")).toBeUndefined();
    expect(fields.country(" de ", "The seller country code (BT-40)")).toBe("DE");
    expect(fields.code("not a code!")).toBeUndefined();
    expect(fields.code(undefined)).toBeUndefined();
    expect(fields.text(undefined, 10)).toBeUndefined();
    expect(fields.joined([undefined, "  "], 10)).toBeUndefined();
    expect(fields.joined(["Line 1", "Line 2"], 100)).toBe("Line 1\nLine 2");
    expect(fields.findings()).toEqual([
      {
        code: "SD-NUMBER",
        severity: "error",
        message: "The total (BT-112) is not a decimal number; it was ignored.",
      },
      expect.objectContaining({ code: "SD-DATE", severity: "error" }),
      expect.objectContaining({ code: "SD-COUNTRY", severity: "error" }),
    ]);
  });

  it("notes hidden characters once but not line breaks or tabs", () => {
    const fields = new FieldReader();
    expect(fields.text("Line 1\r\nLine\t2", 100)).toBe("Line 1\nLine\t2");
    expect(fields.findings()).toEqual([]);
    fields.text(`a${String.fromCodePoint(0x200b)}b`, 100);
    fields.text(`c${String.fromCodePoint(0x202e)}d`, 100);
    expect(fields.findings().map((finding) => finding.code)).toEqual(["SD-HIDDEN-TEXT"]);
  });

  it("builds parties without absent terms, falling back to the trading name", () => {
    expect(partyOf({ name: undefined, tradingName: "Trade" })).toEqual({
      name: "Trade",
      tradingName: "Trade",
      address: {},
    });
    expect(partyOf({ name: undefined })).toEqual({ name: "", address: {} });
  });
});

describe("decimal helpers", () => {
  it("divides exactly with half-up rounding", () => {
    expect(divideDecimal("10", "3")).toBe("3.333333");
    expect(divideDecimal("2", "3", 2)).toBe("0.67");
    expect(divideDecimal("-2", "3", 2)).toBe("-0.67");
    expect(divideDecimal("2", "-3", 2)).toBe("-0.67");
    expect(divideDecimal("12.5", "0")).toBe("12.5");
  });

  it("compares within a tolerance", () => {
    expect(withinTolerance("10.00", "10.99", "1")).toBe(true);
    expect(withinTolerance("10.00", "11.01", "1")).toBe(false);
    expect(withinTolerance("11.01", "10.00", "1")).toBe(false);
  });

  it("divides the price by its base quantity (BT-149)", () => {
    expect(pricePerUnit(undefined, "10")).toBeUndefined();
    expect(pricePerUnit("5", undefined)).toBe("5");
    expect(pricePerUnit("5", "1.00")).toBe("5");
    expect(pricePerUnit("5", "0")).toBe("5");
    expect(pricePerUnit("12.50", "100")).toBe("0.125");
  });
});

describe("completeTotals", () => {
  it("computes missing required totals and marks them", () => {
    const raw = {
      lineNet: undefined,
      allowances: "5",
      charges: "1",
      net: undefined,
      tax: undefined,
      taxInAccountingCurrency: undefined,
      gross: undefined,
      prepaid: "10",
      rounding: "0.01",
      due: undefined,
    };
    expect(completeTotals(raw, { lineAmounts: ["100", "4"], breakdownTax: ["19"] })).toEqual({
      totals: {
        lineNet: "104",
        allowances: "5",
        charges: "1",
        net: "100",
        tax: "19",
        gross: "119",
        prepaid: "10",
        rounding: "0.01",
        due: "109.01",
      },
      missingTotals: ["BT-106", "BT-109", "BT-110", "BT-112", "BT-115"],
    });
  });
});
