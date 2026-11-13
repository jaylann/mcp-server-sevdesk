import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  berlinDateOf,
  isIsoDate,
  toBerlinDate,
  toSevdeskDate,
  toUnixSeconds,
} from "../../../src/sevdesk/dates.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";

function errorOf(run: () => unknown): SevdeskError {
  try {
    run();
  } catch (error) {
    if (error instanceof SevdeskError) return error;
    throw error;
  }
  throw new Error("expected a SevdeskError");
}

const utcSeconds = (iso: string): number => Date.parse(iso) / 1000;

const propertyOptions = { numRuns: 100, seed: 20261112 };
const calendarDate = fc
  .date({
    min: new Date("1000-01-01T00:00:00Z"),
    max: new Date("9999-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().slice(0, 10));

describe("date serializer properties", () => {
  it("round-trips document dates and both Berlin day edges", () => {
    fc.assert(
      fc.property(calendarDate, (date) => {
        expect(isIsoDate(date)).toBe(true);
        expect(toBerlinDate(toSevdeskDate(date))).toBe(date);
        for (const edge of ["start", "end"] as const) {
          const seconds = toUnixSeconds(date, edge);
          expect(Number.isInteger(seconds)).toBe(true);
          expect(toBerlinDate(seconds)).toBe(date);
          const iso = new Date(seconds * 1000).toISOString();
          // Midnight on 1000-01-01 in Berlin is still year 0999 in UTC, outside the
          // accepted ISO input range. The numeric and document forms cover that boundary.
          if (isIsoDate(iso.slice(0, 10))) expect(toBerlinDate(iso)).toBe(date);
          // The response's digit-string form represents nonnegative Unix seconds only.
          if (seconds >= 0) expect(toBerlinDate(String(seconds))).toBe(date);
        }
      }),
      {
        ...propertyOptions,
        examples: [["1000-01-01"], ["9999-12-31"], ["2024-02-29"], ["2026-03-29"], ["2026-10-25"]],
      },
    );
  });

  it("rejects calendar overflow instead of normalizing it into another day", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 9999 }),
        fc.integer({ min: 1, max: 12 }),
        (year, month) => {
          const overflow = new Date(Date.UTC(year, month, 0)).getUTCDate() + 1;
          const mm = String(month).padStart(2, "0");
          for (const day of [0, overflow]) {
            const dd = String(day).padStart(2, "0");
            const invalid = `${String(year)}-${mm}-${dd}`;
            expect(isIsoDate(invalid)).toBe(false);
            expect(errorOf(() => toSevdeskDate(invalid)).kind).toBe("validation");
            for (const edge of ["start", "end"] as const) {
              expect(errorOf(() => toUnixSeconds(invalid, edge)).kind).toBe("validation");
            }
            for (const value of [invalid, `${dd}.${mm}.${String(year)}`, `${invalid}T12:00:00Z`]) {
              expect(errorOf(() => toBerlinDate(value)).kind).toBe("unexpected_response");
            }
          }
        },
      ),
      propertyOptions,
    );
  });

  it("rejects arbitrary text outside the canonical request-date format", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }).filter((text) => !/^\d{4}-\d{2}-\d{2}$/.test(text)),
        (text) => {
          expect(isIsoDate(text)).toBe(false);
          expect(errorOf(() => toSevdeskDate(text)).kind).toBe("validation");
          expect(errorOf(() => toUnixSeconds(text)).kind).toBe("validation");
        },
      ),
      propertyOptions,
    );
  });
});

describe("isIsoDate", () => {
  it.each(["2026-11-07", "2024-02-29", "2000-02-29", "1999-12-31"])("accepts %s", (date) => {
    expect(isIsoDate(date)).toBe(true);
  });

  it.each([
    "2026-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-1-1",
    "0999-01-01",
    "2026-11-07T00:00:00Z",
    "07.11.2026",
    "",
  ])("rejects %j", (date) => {
    expect(isIsoDate(date)).toBe(false);
  });
});

describe("toSevdeskDate", () => {
  it("formats as dd.mm.yyyy", () => {
    expect(toSevdeskDate("2026-11-07")).toBe("07.11.2026");
    expect(toSevdeskDate("2024-02-29")).toBe("29.02.2024");
    expect(toSevdeskDate("2026-01-01")).toBe("01.01.2026");
  });

  it.each(["2026-02-30", "2026-11-7", "07.11.2026", "tomorrow"])("rejects %j", (date) => {
    const error = errorOf(() => toSevdeskDate(date));
    expect(error.kind).toBe("validation");
    expect(error.message).not.toContain(date);
  });
});

describe("toUnixSeconds", () => {
  it.each([
    ["2026-11-07", "2026-11-06T23:00:00Z"],
    ["2026-07-01", "2026-06-30T22:00:00Z"],
    ["2026-01-01", "2025-12-31T23:00:00Z"],
    // DST starts on 2026-03-29 at 02:00 local: midnight is still CET.
    ["2026-03-29", "2026-03-28T23:00:00Z"],
    ["2026-03-30", "2026-03-29T22:00:00Z"],
    // DST ends on 2026-10-25 at 03:00 local: midnight is still CEST.
    ["2026-10-25", "2026-10-24T22:00:00Z"],
    ["2026-10-26", "2026-10-25T23:00:00Z"],
  ])("anchors %s to Berlin midnight (%s)", (date, utc) => {
    expect(toUnixSeconds(date)).toBe(utcSeconds(utc));
  });

  it("gives the last second of the Berlin day for the end edge", () => {
    expect(toUnixSeconds("2026-11-07", "end")).toBe(utcSeconds("2026-11-07T22:59:59Z"));
    expect(toUnixSeconds("2026-12-31", "end")).toBe(utcSeconds("2026-12-31T22:59:59Z"));
  });

  it("handles 23- and 25-hour days", () => {
    const length = (date: string) => toUnixSeconds(date, "end") - toUnixSeconds(date) + 1;
    expect(length("2026-03-29")).toBe(23 * 3600);
    expect(length("2026-10-25")).toBe(25 * 3600);
    expect(length("2026-11-07")).toBe(24 * 3600);
  });

  it("rejects invalid dates", () => {
    expect(errorOf(() => toUnixSeconds("2026-02-29")).kind).toBe("validation");
  });
});

describe("toBerlinDate", () => {
  it.each([
    ["2024-04-08T00:00:00+02:00", "2024-04-08"],
    ["2024-04-08T00:00:00+0200", "2024-04-08"],
    ["2024-04-07T22:00:00Z", "2024-04-08"],
    ["2024-04-07T21:59:59Z", "2024-04-07"],
    ["2024-04-07T21:59:59.999z", "2024-04-07"],
    ["2024-01-15T23:30:00+01:00", "2024-01-15"],
    ["2024-01-15 23:30", "2024-01-15"],
    ["2024-04-08T00:00:00", "2024-04-08"],
    ["2024-04-08", "2024-04-08"],
    ["08.04.2024", "2024-04-08"],
    ["1712527200", "2024-04-08"],
    [" 1712527199 ", "2024-04-07"],
    [1712527200, "2024-04-08"],
  ])("reads %j as %s", (input, expected) => {
    expect(toBerlinDate(input)).toBe(expected);
  });

  it.each([null, undefined, ""])("returns undefined for %j", (input) => {
    expect(toBerlinDate(input)).toBeUndefined();
  });

  it.each([
    "tomorrow",
    "31.02.2024",
    "2024-02-30T00:00:00Z",
    "2024-04-08T25:00:00Z",
    "2024-04-08T12:60:00Z",
    "2024-04-08T12:00:61Z",
    "2024-04-08T12:00:00+25:00",
    "8.4.2024",
    "1712527200000000",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    {},
    true,
  ])("rejects %j without echoing it", (input) => {
    const error = errorOf(() => toBerlinDate(input));
    expect(error.kind).toBe("unexpected_response");
    if (typeof input === "string") expect(error.message).not.toContain(input);
  });
});

describe("berlinDateOf", () => {
  it("uses the Berlin calendar day", () => {
    expect(berlinDateOf(Date.parse("2026-11-06T23:00:00Z"))).toBe("2026-11-07");
    expect(berlinDateOf(Date.parse("2026-11-06T22:59:59Z"))).toBe("2026-11-06");
  });
});
