import { describe, expect, it } from "vitest";

import { jsonNumber, pricePair } from "../../../src/domain/parts-write.js";

describe("pricePair", () => {
  it("computes gross from net, rounded half-up to cents", () => {
    expect(pricePair("42.01", "net", "19")).toEqual({ net: "42.01", gross: "49.99" });
    expect(pricePair("100", "net", "7")).toEqual({ net: "100.00", gross: "107.00" });
    expect(pricePair("0.05", "net", "19")).toEqual({ net: "0.05", gross: "0.06" });
    expect(pricePair("10", "net", "0")).toEqual({ net: "10.00", gross: "10.00" });
  });

  it("computes net from gross, rounded half-up to cents", () => {
    expect(pricePair("49.99", "gross", "19")).toEqual({ net: "42.01", gross: "49.99" });
    expect(pricePair("119", "gross", "19")).toEqual({ net: "100.00", gross: "119.00" });
    expect(pricePair("1", "gross", "7")).toEqual({ net: "0.93", gross: "1.00" });
    expect(pricePair("0", "gross", "19")).toEqual({ net: "0.00", gross: "0.00" });
    // 0.595 / 1.19 = 0.5 exactly; 0.6 / 1.19 = 0.50420… → 0.50
    expect(pricePair("0.6", "gross", "19")).toEqual({ net: "0.50", gross: "0.60" });
    // Decimal rates: 10 / 1.077 = 9.2850… → 9.29
    expect(pricePair("10", "gross", "7.7")).toEqual({ net: "9.29", gross: "10.00" });
  });

  it("rounds negative amounts away from zero", () => {
    expect(pricePair("-49.99", "gross", "19")).toEqual({ net: "-42.01", gross: "-49.99" });
  });

  it("refuses a rate that would divide by zero", () => {
    expect(() => pricePair("10", "gross", "-100")).toThrow(RangeError);
    expect(pricePair("10", "gross", "-200")).toEqual({ net: "-10.00", gross: "10.00" });
  });
});

describe("jsonNumber", () => {
  it("converts exact decimals to the same JSON number", () => {
    expect(jsonNumber("42.01")).toBe(42.01);
    expect(JSON.stringify({ v: jsonNumber("0.10") })).toBe('{"v":0.1}');
    expect(jsonNumber("100")).toBe(100);
  });

  it("refuses values that would lose digits", () => {
    expect(() => jsonNumber("12345678901234567.89")).toThrow(/too many digits/);
  });
});
