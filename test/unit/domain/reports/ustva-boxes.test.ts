import { describe, expect, it } from "vitest";

import { TAX_RULES } from "../../../../src/domain/reference-data.js";
import {
  MAPPED_TAX_RULE_IDS,
  RECIPIENT_TAX_DEFAULT_RATE,
  sameRate,
  USTVA_FORM,
  USTVA_LINE_KEYS,
  USTVA_LINES,
  ustvaLine,
  ustvaTarget,
} from "../../../../src/domain/reports/ustva-boxes.js";

describe("USTVA_LINES (USt 1 A 2026)", () => {
  it("is the 2026 form with its sources and check date", () => {
    expect(USTVA_FORM.year).toBe(2026);
    expect(USTVA_FORM.checked).toBe("2026-11-08");
    expect(USTVA_FORM.sources.join(" ")).toContain("29.12.2025");
  });

  it("has one line per key, in form order, with the 2026 line numbers", () => {
    expect(USTVA_LINES.map((line) => line.key)).toEqual([...USTVA_LINE_KEYS]);
    const numbers = USTVA_LINES.map((line) => line.line);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    expect(Object.fromEntries(USTVA_LINES.map((line) => [line.key, line.line]))).toEqual({
      "81": 13,
      "86": 14,
      "35": 16,
      "41": 19,
      "43": 22,
      "48": 23,
      "89": 25,
      "93": 26,
      "95": 28,
      "46": 30,
      "84": 32,
      "60": 34,
      "21": 35,
      "45": 36,
      "66": 38,
      "61": 39,
      "67": 41,
    });
  });

  it("names the tax Kennzahl where the form has one and marks computed and input lines", () => {
    expect(ustvaLine("35")).toMatchObject({ baseKz: "35", taxKz: "36", taxOnForm: "entered" });
    expect(ustvaLine("95")).toMatchObject({ taxKz: "98" });
    expect(ustvaLine("46")).toMatchObject({ taxKz: "47", side: "output" });
    expect(ustvaLine("84")).toMatchObject({ taxKz: "85", side: "output" });
    expect(ustvaLine("81")).toMatchObject({ taxOnForm: "computed", rate: "19" });
    expect(ustvaLine("86")).toMatchObject({ taxOnForm: "computed", rate: "7" });
    for (const key of ["66", "61", "67"] as const) {
      expect(ustvaLine(key)).toMatchObject({ taxKz: key, taxOnForm: "tax_only", side: "input" });
      expect(ustvaLine(key).baseKz).toBeUndefined();
    }
    for (const key of ["41", "43", "48", "60", "21", "45"] as const) {
      expect(ustvaLine(key)).toMatchObject({ taxOnForm: "none", side: "none" });
    }
  });

  it("throws for a key without a line", () => {
    expect(() => ustvaLine("99" as never)).toThrow("No UStVA line 99");
  });
});

describe("ustvaTarget: every tax rule", () => {
  it("knows every rule in TAX_RULES", () => {
    expect(MAPPED_TAX_RULE_IDS).toEqual(TAX_RULES.map((rule) => rule.id).sort((a, b) => a - b));
  });

  it("rule 1 (taxable domestic revenue): 81 / 86 / 35+36, 0 % unmapped, counted by payment on cash basis", () => {
    expect(ustvaTarget(1, "revenue", "19")).toMatchObject({
      kind: "line",
      line: "81",
      cashBasis: true,
    });
    expect(ustvaTarget(1, "revenue", "19.00")).toMatchObject({ line: "81" });
    expect(ustvaTarget(1, "revenue", "7")).toMatchObject({ line: "86" });
    expect(ustvaTarget(1, "revenue", "0")).toMatchObject({ kind: "unmapped" });
    expect(ustvaTarget(1, "revenue", "0.00")).toMatchObject({
      reason: expect.stringContaining("only solar installations") as unknown,
    });
    expect(ustvaTarget(1, "revenue", "16")).toMatchObject({ line: "35" });
    expect(ustvaTarget(1, "revenue", "5")).toMatchObject({ line: "35", timing: "supply" });
  });

  it.each([
    [2, "43", undefined, "supply"],
    [3, "41", "L", "invoice_or_next_month"],
    [4, "48", undefined, "supply"],
    [5, "60", undefined, "supply"],
    [11, "48", undefined, "supply"],
    [17, "45", undefined, "supply"],
    [21, "21", "S", "invoice_or_next_month"],
  ] as const)("revenue rule %i → Kz %s", (rule, line, zm, timing) => {
    const target = ustvaTarget(rule, "revenue", "0");
    expect(target).toMatchObject({ kind: "line", line, cashBasis: false, timing });
    expect(target.kind === "line" ? target.zm : "x").toBe(zm);
  });

  it.each([18, 19, 20])("OSS rule %i → Kz 45 plus the OSS section", (rule) => {
    expect(ustvaTarget(rule, "revenue", "21")).toMatchObject({
      kind: "line",
      line: "45",
      oss: true,
    });
  });

  it("rule 8 (intra-EU acquisitions): 89/93/95 with input VAT 61; 0 % taxed at 19 % (assumed)", () => {
    expect(ustvaTarget(8, "expense", "0")).toMatchObject({
      kind: "line",
      line: "89",
      inputTax: "61",
      recipientRate: RECIPIENT_TAX_DEFAULT_RATE,
      assumedRate: true,
      timing: "invoice_or_next_month",
    });
    expect(ustvaTarget(8, "expense", "7")).toMatchObject({ line: "93", recipientRate: "7" });
    expect(ustvaTarget(8, "expense", "19")).toMatchObject({ line: "89", recipientRate: "19" });
    expect(ustvaTarget(8, "expense", "10")).toMatchObject({ line: "95", recipientRate: "10" });
    const target = ustvaTarget(8, "expense", "19");
    expect(target.kind === "line" && target.assumedRate).toBeFalsy();
  });

  it("rule 9 → input VAT Kz 66 once invoice and supply exist", () => {
    expect(ustvaTarget(9, "expense", "19")).toEqual({
      kind: "input_tax",
      line: "66",
      timing: "supply_and_invoice",
    });
  });

  it("rules 12, 13, 14 (§13b): 84/85 + 67, 84/85 without 67, 46/47 + 67", () => {
    expect(ustvaTarget(12, "expense", "0")).toMatchObject({
      line: "84",
      inputTax: "67",
      recipientRate: "19",
      assumedRate: true,
    });
    const thirteen = ustvaTarget(13, "expense", "0");
    expect(thirteen).toMatchObject({ line: "84", recipientRate: "19" });
    expect(thirteen.kind === "line" ? thirteen.inputTax : "x").toBeUndefined();
    expect(ustvaTarget(14, "expense", "0")).toMatchObject({
      line: "46",
      inputTax: "67",
      timing: "supply",
    });
  });

  it.each([10, 15, 16, 22])("rule %i is deliberately not in the UStVA", (rule) => {
    expect(ustvaTarget(rule, "expense", "0").kind).toBe("excluded");
    expect(ustvaTarget(rule, "revenue", "0").kind).toBe("excluded");
  });

  it("leaves unknown rules, missing rules and rules used in the wrong direction unmapped", () => {
    expect(ustvaTarget(undefined, "revenue", "19")).toMatchObject({
      kind: "unmapped",
      reason: "The document has no tax rule (Steuerregel).",
    });
    expect(ustvaTarget(99, "revenue", "19")).toMatchObject({
      kind: "unmapped",
      reason: "Tax rule 99 is not known to this server.",
    });
    expect(ustvaTarget(9, "revenue", "19")).toMatchObject({
      kind: "unmapped",
      reason: "Tax rule 9 is an expense rule but was used on revenue.",
    });
    expect(ustvaTarget(1, "expense", "19")).toMatchObject({
      kind: "unmapped",
      reason: "Tax rule 1 is a revenue rule but was used on an expense.",
    });
  });

  it("compares rates as decimals", () => {
    expect(sameRate("19", "19.00")).toBe(true);
    expect(sameRate("7", "7.5")).toBe(false);
  });
});
