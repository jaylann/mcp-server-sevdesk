import { describe, expect, it } from "vitest";

import {
  MONTH_PATTERN,
  monthPeriod,
  parsePeriod,
  PERIOD_PATTERN,
  previousMonth,
  previousQuarter,
  quarterPeriod,
} from "../../../src/prompts/periods.js";

describe("periods", () => {
  it("builds a month with its last day, leap years included", () => {
    expect(monthPeriod(2028, 2)).toEqual({
      year: 2028,
      month: 2,
      key: "2028-02",
      label: "February 2028",
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(monthPeriod(2026, 2).to).toBe("2026-02-28");
    expect(monthPeriod(2026, 12).to).toBe("2026-12-31");
  });

  it("builds a quarter from its first to its last month", () => {
    expect(quarterPeriod(2026, 3)).toEqual({
      year: 2026,
      quarter: 3,
      key: "2026-Q3",
      label: "Q3 2026 (July–September)",
      from: "2026-07-01",
      to: "2026-09-30",
    });
    expect(quarterPeriod(2026, 4).to).toBe("2026-12-31");
  });

  it("parses months and quarters (q in either case)", () => {
    expect(parsePeriod("2026-10")).toEqual(monthPeriod(2026, 10));
    expect(parsePeriod("2026-Q1")).toEqual(quarterPeriod(2026, 1));
    expect(parsePeriod("2026-q2")).toEqual(quarterPeriod(2026, 2));
  });

  it("finds the previous month and quarter across year ends", () => {
    expect(previousMonth("2026-11-09").key).toBe("2026-10");
    expect(previousMonth("2027-01-01").key).toBe("2026-12");
    expect(previousQuarter("2026-11-09").key).toBe("2026-Q3");
    expect(previousQuarter("2027-02-15").key).toBe("2026-Q4");
    expect(previousQuarter("2026-04-01").key).toBe("2026-Q1");
  });

  it.each([
    ["2026-10", true, true],
    ["2026-Q3", false, true],
    ["2026-q4", false, true],
    ["2026-13", false, false],
    ["2026-00", false, false],
    ["2026-Q5", false, false],
    ["1999-12", false, false],
    ["2026-1", false, false],
    ["2026-10\n", false, false],
    [" 2026-10", false, false],
  ])("%j: month %s, period %s", (value, month, period) => {
    expect(MONTH_PATTERN.test(value)).toBe(month);
    expect(PERIOD_PATTERN.test(value)).toBe(period);
  });
});
