import { describe, expect, it } from "vitest";

import {
  cleanText,
  compact,
  currencyCode,
  documentDateFilter,
  moneyFromUpstream,
  trimmedText,
} from "../../../src/domain/common.js";
import { toUnixSeconds } from "../../../src/sevdesk/dates.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

describe("currencyCode", () => {
  it.each([
    ["usd", "USD"],
    [" chf ", "CHF"],
    ["EUR", "EUR"],
    ["", "EUR"],
    ["  ", "EUR"],
    [undefined, "EUR"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(currencyCode(input)).toBe(expected);
  });

  it.each(["€", "EURO", "XYZ", "eu", "$"])(
    "rejects %j as an unexpected response without echoing it",
    (input) => {
      const error = catchError(() => currencyCode(input));
      expect(error).toBeInstanceOf(SevdeskError);
      expect(error).toMatchObject({ kind: "unexpected_response" });
      expect((error as Error).message).toBe(
        "sevDesk returned a currency that is not an ISO 4217 code.",
      );
    },
  );
});

describe("moneyFromUpstream", () => {
  it("builds exact money in the normalized currency", () => {
    expect(moneyFromUpstream("119", " usd ")).toEqual({ amount: "119.00", currency: "USD" });
    expect(moneyFromUpstream("1.5", undefined)).toEqual({ amount: "1.50", currency: "EUR" });
    expect(moneyFromUpstream(undefined, "€")).toBeUndefined();
  });

  it("raises unexpected_response, not a MoneyError, for an unknown currency or a bad amount", () => {
    expect(catchError(() => moneyFromUpstream("1.00", "€"))).toMatchObject({
      kind: "unexpected_response",
    });
    expect(catchError(() => moneyFromUpstream("1,00", "EUR"))).toMatchObject({
      kind: "unexpected_response",
    });
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("compact", () => {
  it("drops undefined members only", () => {
    const value = compact({ a: 1, b: undefined, c: null, d: "", e: false, f: 0 });
    expect(value).toEqual({ a: 1, c: null, d: "", e: false, f: 0 });
    expect(Object.hasOwn(value, "b")).toBe(false);
  });
});

describe("trimmedText", () => {
  it.each([
    [" Musterfirma ", "Musterfirma"],
    ["\n\t ", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("turns %j into %j", (input, expected) => {
    expect(trimmedText(input)).toBe(expected);
  });
});

describe("cleanText", () => {
  it("trims, sanitizes and drops empty text", () => {
    expect(cleanText("  Musterfirma\r\nGmbH  ", 50)).toBe("Musterfirma\nGmbH");
    expect(cleanText("   ", 50)).toBeUndefined();
    expect(cleanText("", 50)).toBeUndefined();
    expect(cleanText(undefined, 50)).toBeUndefined();
    expect(cleanText("abcdef", 3)).toBe("abc… [truncated 3 chars]");
  });

  it("removes whitespace that invisible characters hid, and leaves invisible-only text out", () => {
    expect(cleanText(` ${ZERO_WIDTH_SPACE} Muster ${ZERO_WIDTH_SPACE}`, 50)).toBe("Muster");
    expect(cleanText(ZERO_WIDTH_SPACE, 50)).toBeUndefined();
    expect(cleanText(` ${ZERO_WIDTH_SPACE} `, 50)).toBeUndefined();
  });

  it("does not count surrounding whitespace toward the cap", () => {
    expect(cleanText("abc\n", 3)).toBe("abc");
    expect(cleanText("  abc  ", 3)).toBe("abc");
    expect(cleanText(" abcd ", 3)).toBe("abc… [truncated 1 chars]");
  });
});

describe("documentDateFilter (D-046)", () => {
  it("starts one second before the first day and ends at the last second of the last day", () => {
    const filter = documentDateFilter({ from: "2026-03-01", to: "2026-03-31" });
    expect(filter.query).toEqual({
      startDate: toUnixSeconds("2026-03-01", "start") - 1,
      endDate: toUnixSeconds("2026-03-31", "end"),
    });
  });

  it("re-checks document dates against the inclusive range", () => {
    const { contains } = documentDateFilter({ from: "2026-03-01", to: "2026-03-31" });
    expect(contains("2026-03-01")).toBe(true);
    expect(contains("2026-03-31")).toBe(true);
    // What the one-second-early start lets in under the inclusive reading.
    expect(contains("2026-02-28")).toBe(false);
    expect(contains("2026-04-01")).toBe(false);
    expect(contains(undefined)).toBe(false);
  });

  it("handles open ranges", () => {
    const from = documentDateFilter({ from: "2026-03-01" });
    expect(from.query).toEqual({ startDate: toUnixSeconds("2026-03-01", "start") - 1 });
    expect(from.contains("2030-01-01")).toBe(true);
    expect(from.contains("2026-02-28")).toBe(false);

    const to = documentDateFilter({ to: "2026-03-31" });
    expect(to.query).toEqual({ endDate: toUnixSeconds("2026-03-31", "end") });
    expect(to.contains("2020-01-01")).toBe(true);
    expect(to.contains("2026-04-01")).toBe(false);
  });

  it("sends nothing and keeps everything, also undated documents, without a range", () => {
    const filter = documentDateFilter({});
    expect(filter.query).toEqual({});
    expect(filter.contains(undefined)).toBe(true);
    expect(filter.contains("1999-12-31")).toBe(true);
  });

  it("rejects an empty range before anything is sent", () => {
    expect(() => documentDateFilter({ from: "2026-04-01", to: "2026-03-01" })).toThrow(
      SevdeskError,
    );
  });
});
