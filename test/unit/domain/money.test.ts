import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  add,
  compare,
  type Decimal,
  decimal,
  DEFAULT_CURRENCY,
  format,
  isCurrencyCode,
  isDecimal,
  isZero,
  money,
  MoneyError,
  multiply,
  negate,
  round,
  subtract,
  sumMoney,
  toDecimalString,
} from "../../../src/domain/money.js";

// Fixed seeds keep CI deterministic; fast-check reports the seed and shrink path on failure.
const propertyOptions = { numRuns: 100, seed: 20261112 };
const units = fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n });
const exactDecimal = fc.record({ units, scale: fc.integer({ min: 0, max: 12 }) });

/** Compare rational values by cross multiplication, independently of the decimal helpers. */
function expectExact(actual: Decimal, expectedUnits: bigint, expectedScale: number): void {
  expect(actual.units * 10n ** BigInt(expectedScale)).toBe(
    expectedUnits * 10n ** BigInt(actual.scale),
  );
}

describe("money properties", () => {
  it("round-trips decimal strings, fixed formatting and Money without rounding", () => {
    fc.assert(
      fc.property(exactDecimal, (value) => {
        const parsed = decimal(toDecimalString(value));
        expectExact(parsed, value.units, value.scale);
        expect(decimal(format(value, value.scale))).toEqual(parsed);
        expect(decimal(money(value).amount)).toEqual(parsed);
        expect(decimal(`${value.units}e-${String(value.scale)}`)).toEqual(parsed);
      }),
      propertyOptions,
    );
  });

  it("adds, subtracts and multiplies signed decimals exactly", () => {
    fc.assert(
      fc.property(exactDecimal, exactDecimal, (a, b) => {
        // A rational oracle keeps every digit, including amounts beyond Number's safe range.
        const aUnits = a.units * 10n ** BigInt(b.scale);
        const bUnits = b.units * 10n ** BigInt(a.scale);
        expectExact(add(a, b), aUnits + bUnits, a.scale + b.scale);
        expectExact(subtract(a, b), aUnits - bUnits, a.scale + b.scale);
        expectExact(multiply(a, b), a.units * b.units, a.scale + b.scale);
        expect(subtract(add(a, b), b)).toEqual(decimal(a));
      }),
      propertyOptions,
    );
  });

  it("sums fractional amounts without float drift", () => {
    fc.assert(
      fc.property(fc.array(units, { maxLength: 40 }), (cents) => {
        const total = sumMoney(cents.map((value) => money(`${value}e-2`)));
        expectExact(
          decimal(total.amount),
          cents.reduce((sum, value) => sum + value, 0n),
          2,
        );
        expect(total.currency).toBe("EUR");
      }),
      propertyOptions,
    );
  });

  it("rounds within half a unit, symmetrically and idempotently", () => {
    fc.assert(
      fc.property(exactDecimal, fc.integer({ min: 0, max: 12 }), (value, places) => {
        const rounded = round(value, places);
        const error = subtract(value, rounded);
        const magnitude = error.units < 0n ? -error.units : error.units;
        expect(2n * magnitude * 10n ** BigInt(places)).toBeLessThanOrEqual(
          10n ** BigInt(error.scale),
        );
        expect(round(rounded, places)).toEqual(rounded);
        expect(round(negate(value), places)).toEqual(negate(rounded));
      }),
      propertyOptions,
    );
  });
});

describe("decimal parsing", () => {
  it.each([
    ["0", 0n, 0],
    ["12.34", 1234n, 2],
    ["-12.340", -1234n, 2],
    ["+5", 5n, 0],
    [".5", 5n, 1],
    ["5.", 5n, 0],
    ["007.50", 75n, 1],
    ["1e3", 1000n, 0],
    ["1.5E-3", 15n, 4],
    ["-0", 0n, 0],
    ["-0.000", 0n, 0],
  ])("parses %j exactly", (input, units, scale) => {
    expect(decimal(input)).toEqual({ units, scale });
  });

  it("parses numbers through their shortest representation", () => {
    expect(toDecimalString(2903.62000000001)).toBe("2903.62000000001");
    expect(toDecimalString(0.1)).toBe("0.1");
    expect(toDecimalString(1e21)).toBe("1000000000000000000000");
    expect(toDecimalString(1e-7)).toBe("0.0000001");
    expect(toDecimalString(-0)).toBe("0");
    expect(toDecimalString(123n)).toBe("123");
  });

  it("accepts a Decimal and normalizes it", () => {
    expect(decimal({ units: 1500n, scale: 3 })).toEqual({ units: 15n, scale: 1 });
  });

  it.each(["", " 1", "1 ", "1,5", "abc", ".", "-", "1e", "e5", "0x10", "1.2.3", "Infinity", "NaN"])(
    "rejects %j",
    (input) => {
      expect(() => decimal(input)).toThrow(MoneyError);
      expect(isDecimal(input)).toBe(false);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the number %d",
    (input) => {
      expect(() => decimal(input)).toThrow(MoneyError);
    },
  );

  it("rejects pathological sizes from untrusted input", () => {
    expect(() => decimal("1e1000000")).toThrow(MoneyError);
    expect(() => decimal(`0.${"1".repeat(150)}`)).toThrow(MoneyError);
    expect(() => decimal({ units: 1n, scale: -1 })).toThrow(MoneyError);
    expect(isDecimal("12.5")).toBe(true);
  });
});

describe("arithmetic", () => {
  it("adds 0.1 and 0.2 to exactly 0.3", () => {
    expect(toDecimalString(add("0.1", "0.2"))).toBe("0.3");
    expect(compare(add(0.1, 0.2), "0.3")).toBe(0);
  });

  it("subtracts, multiplies and negates exactly", () => {
    expect(toDecimalString(subtract("10", "0.01"))).toBe("9.99");
    expect(toDecimalString(subtract("0.01", "10"))).toBe("-9.99");
    expect(toDecimalString(multiply("19.99", "3"))).toBe("59.97");
    expect(toDecimalString(multiply("1.2345", "0.19"))).toBe("0.234555");
    expect(toDecimalString(multiply("-2.5", "-2"))).toBe("5");
    expect(toDecimalString(negate("12.50"))).toBe("-12.5");
    expect(toDecimalString(negate("-0.01"))).toBe("0.01");
    expect(toDecimalString(negate("0"))).toBe("0");
  });

  it("handles large values without precision loss", () => {
    const big = "123456789012345678901234567890.123456789";
    expect(toDecimalString(add(big, "0.000000001"))).toBe(
      "123456789012345678901234567890.12345679",
    );
    expect(toDecimalString(multiply("99999999999999999.99", "100"))).toBe("9999999999999999999");
  });

  it("computes 4-decimal unit prices times quantities", () => {
    const net = multiply("12.3456", "7");
    expect(toDecimalString(net)).toBe("86.4192");
    expect(format(net, 2)).toBe("86.42");
    const gross = multiply(net, "1.19");
    expect(toDecimalString(gross)).toBe("102.838848");
    expect(format(gross, 2)).toBe("102.84");
  });

  it("compares and detects zero", () => {
    expect(compare("1.10", "1.1")).toBe(0);
    expect(compare("-1", "0")).toBe(-1);
    expect(compare("0.001", "0")).toBe(1);
    expect(isZero("0.000")).toBe(true);
    expect(isZero(0)).toBe(true);
    expect(isZero("-0")).toBe(true);
    expect(isZero("0.001")).toBe(false);
  });
});

describe("rounding (half-up away from zero)", () => {
  it.each([
    ["33.605", 2, "33.61"],
    ["33.604", 2, "33.6"],
    ["-0.005", 2, "-0.01"],
    ["-0.004", 2, "0"],
    ["0.005", 2, "0.01"],
    ["2.5", 0, "3"],
    ["-2.5", 0, "-3"],
    ["1.4999", 0, "1"],
    ["1.995", 2, "2"],
    ["2903.62000000001", 2, "2903.62"],
    ["12.3", 2, "12.3"],
    ["99.99999", 4, "100"],
  ])("rounds %s to %i places as %s", (input, places, expected) => {
    expect(toDecimalString(round(input, places))).toBe(expected);
  });

  it("does not round the float approximation", () => {
    // As a float, 1.005 is 1.00499999999999989…; parsed from "1.005" it rounds up.
    expect(format(1.005, 2)).toBe("1.01");
  });

  it.each([-1, 1.5, Number.NaN, 101])("rejects %d places", (places) => {
    expect(() => round("1", places)).toThrow(MoneyError);
  });
});

describe("format", () => {
  it.each([
    ["33.605", 2, "33.61"],
    [5, 2, "5.00"],
    ["0", 2, "0.00"],
    ["-0.004", 2, "0.00"],
    ["-0.005", 2, "-0.01"],
    ["-12.5", 2, "-12.50"],
    ["0.5", 0, "1"],
    ["1234567.891", 2, "1234567.89"],
    ["0.0001", 4, "0.0001"],
    ["1e21", 2, "1000000000000000000000.00"],
  ])("formats %j with %i places as %s", (input, places, expected) => {
    expect(format(input, places)).toBe(expected);
  });
});

describe("Money", () => {
  it("defaults to EUR and keeps the exact amount with at least two decimals", () => {
    expect(DEFAULT_CURRENCY).toBe("EUR");
    expect(money("119")).toEqual({ amount: "119.00", currency: "EUR" });
    expect(money("33.605")).toEqual({ amount: "33.605", currency: "EUR" });
    expect(money(-0.1, "usd")).toEqual({ amount: "-0.10", currency: "USD" });
    expect(money(0)).toEqual({ amount: "0.00", currency: "EUR" });
    expect(money("-0.00")).toEqual({ amount: "0.00", currency: "EUR" });
  });

  it("validates ISO 4217 codes", () => {
    expect(isCurrencyCode("EUR")).toBe(true);
    expect(isCurrencyCode("CHF")).toBe(true);
    expect(isCurrencyCode("eur")).toBe(false);
    expect(isCurrencyCode("EURO")).toBe(false);
    expect(isCurrencyCode("XYZ")).toBe(false);
    expect(() => money("1", "XYZ")).toThrow(MoneyError);
    expect(() => money("1", "")).toThrow(MoneyError);
    expect(() => money("abc")).toThrow(MoneyError);
  });

  it("sums exactly", () => {
    const items = [money("0.1"), money("0.2"), money("19.99"), money("-5")];
    expect(sumMoney(items)).toEqual({ amount: "15.29", currency: "EUR" });
  });

  it("sums an empty list to zero in the given currency", () => {
    expect(sumMoney([])).toEqual({ amount: "0.00", currency: "EUR" });
    expect(sumMoney([], "chf")).toEqual({ amount: "0.00", currency: "CHF" });
  });

  it("rejects mixed currencies", () => {
    expect(() => sumMoney([money("1"), money("1", "USD")])).toThrow(MoneyError);
    expect(() => sumMoney([money("1")], "USD")).toThrow(MoneyError);
  });

  it("treats zero amounts as values", () => {
    expect(sumMoney([money(0), money("0.00")])).toEqual({ amount: "0.00", currency: "EUR" });
    expect(isZero(money(0).amount)).toBe(true);
  });
});
