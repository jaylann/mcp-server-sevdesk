import { describe, expect, it, vi } from "vitest";

import { money } from "../../../src/domain/money.js";
import {
  AGING_BUCKETS,
  bucketOf,
  buildAging,
  daysOverdue,
  type OpenItem,
} from "../../../src/domain/reports/aging.js";
import { formatBerlinInstant, instantOf, parseSince } from "../../../src/domain/reports/changes.js";
import {
  daysBetween,
  monthOf,
  plural,
  quarterOf,
  type ScanPage,
  scanPages,
  shiftDays,
  throwIfAborted,
} from "../../../src/domain/reports/shared.js";
import { DocumentTotals, FlowTotals } from "../../../src/domain/reports/totals.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";

const eur = (amount: string) => money(amount, "EUR");

describe("scanPages", () => {
  /** A list of `size` numbers served in pages, like a domain list function would. */
  function source(size: number, reportTotal = true) {
    const total = reportTotal ? size : undefined;
    const fetch = vi.fn((offset: number, limit: number): Promise<ScanPage<number>> => {
      const items = Array.from(
        { length: Math.max(0, Math.min(limit, size - offset)) },
        (_, i) => offset + i,
      );
      const nextOffset = offset + items.length;
      return Promise.resolve({
        items,
        received: items.length,
        total,
        hasMore: items.length > 0 && (total === undefined || nextOffset < total),
        nextOffset,
      });
    });
    return fetch;
  }

  it("reads page by page until sevDesk reports no more rows", async () => {
    const fetch = source(2500);
    const progress = vi.fn();
    const result = await scanPages(fetch, { max: 10_000, noun: "rows", onProgress: progress });
    expect(result).toMatchObject({ scanned: 2500, total: 2500, truncated: false });
    expect(result.items).toHaveLength(2500);
    expect(fetch.mock.calls).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000],
    ]);
    expect(progress).toHaveBeenLastCalledWith(2500, 2500, "Read 2500 rows.");
  });

  it("stops at the cap and says so when more rows exist", async () => {
    const fetch = source(30);
    const result = await scanPages(fetch, { max: 25, noun: "rows" });
    expect(result).toMatchObject({ scanned: 25, truncated: true });
    expect(fetch.mock.calls).toEqual([[0, 25]]);
  });

  it("is not truncated when the list ends exactly at the cap", async () => {
    const result = await scanPages(source(25), { max: 25, noun: "rows" });
    expect(result).toMatchObject({ scanned: 25, truncated: false });
  });

  it("without a total pages until an empty page", async () => {
    const fetch = source(3, false);
    const result = await scanPages(fetch, { max: 100, noun: "rows" });
    expect(result).toMatchObject({ scanned: 3, total: undefined, truncated: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("continues progress counts of earlier scans and reads nothing without budget", async () => {
    const progress = vi.fn();
    await scanPages(source(5), { max: 10, noun: "rows", alreadyScanned: 7, onProgress: progress });
    expect(progress).toHaveBeenCalledWith(12, 12, "Read 12 rows.");
    const fetch = source(5);
    const none = await scanPages(fetch, { max: 0, noun: "rows" });
    expect(none).toMatchObject({ scanned: 0, truncated: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the signal before every page", async () => {
    const controller = new AbortController();
    const fetch = source(3000);
    const progress = vi.fn(() => {
      controller.abort();
    });
    const scan = scanPages(fetch, {
      max: 10_000,
      noun: "rows",
      signal: controller.signal,
      onProgress: progress,
    });
    await expect(scan).rejects.toMatchObject({ kind: "aborted" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(() => {
      throwIfAborted(undefined);
    }).not.toThrow();
  });
});

describe("calendar helpers", () => {
  it("counts calendar days, unaffected by daylight saving changes", () => {
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // spring forward on 2026-03-29
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2); // fall back on 2026-10-25
    expect(daysBetween("2026-11-07", "2026-11-07")).toBe(0);
    expect(daysBetween("2026-11-08", "2026-11-07")).toBe(-1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // leap year
  });

  it("shifts days across month and year ends", () => {
    expect(shiftDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(shiftDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("names months and quarters", () => {
    expect(monthOf("2026-11-07")).toBe("2026-11");
    expect(quarterOf("2026-01-31")).toBe("2026-Q1");
    expect(quarterOf("2026-03-31")).toBe("2026-Q1");
    expect(quarterOf("2026-04-01")).toBe("2026-Q2");
    expect(quarterOf("2026-12-31")).toBe("2026-Q4");
    expect(plural(1, "currency", "currencies")).toBe("1 currency");
    expect(plural(2, "group")).toBe("2 groups");
  });
});

describe("DocumentTotals", () => {
  it("adds exactly: 0.1 + 0.2 is 0.30, never 0.30000000000000004", () => {
    const totals = new DocumentTotals();
    totals.add({ currency: "EUR", net: eur("0.1"), tax: eur("0.019"), gross: eur("0.119") });
    totals.add({ currency: "EUR", net: eur("0.2"), tax: eur("0.038"), gross: eur("0.238") });
    expect(totals.lineList()).toEqual([
      {
        currency: "EUR",
        count: 2,
        net: { amount: "0.30", currency: "EUR" },
        tax: { amount: "0.057", currency: "EUR" },
        gross: { amount: "0.357", currency: "EUR" },
      },
    ]);
  });

  it("keeps currencies apart (EUR first), adds negative amounts and EUR base values", () => {
    const totals = new DocumentTotals();
    totals.add({
      currency: "USD",
      net: money("100", "USD"),
      tax: money("0", "USD"),
      gross: money("100", "USD"),
      eur: { net: eur("92.59"), tax: eur("0"), gross: eur("92.59") },
    });
    totals.add({
      currency: "USD",
      net: money("10", "USD"),
      tax: money("0", "USD"),
      gross: money("10", "USD"),
    });
    totals.add({ currency: "EUR", net: eur("39.20"), tax: eur("7.45"), gross: eur("46.65") });
    totals.add({ currency: "EUR", net: eur("-39.2"), tax: eur("-7.45"), gross: eur("-46.65") });
    totals.add({ currency: "CHF", net: money("5", "CHF") });
    const [first, second, third] = totals.lineList();
    expect(first).toEqual({
      currency: "EUR",
      count: 2,
      net: { amount: "0.00", currency: "EUR" },
      tax: { amount: "0.00", currency: "EUR" },
      gross: { amount: "0.00", currency: "EUR" },
    });
    expect(second).toEqual({
      currency: "CHF",
      count: 1,
      net: { amount: "5.00", currency: "CHF" },
      tax: { amount: "0.00", currency: "CHF" },
      gross: { amount: "0.00", currency: "CHF" },
      incompleteRecords: 1,
    });
    expect(third).toMatchObject({
      currency: "USD",
      count: 2,
      gross: { amount: "110.00", currency: "USD" },
      eur: { records: 1, gross: { amount: "92.59", currency: "EUR" } },
    });
    expect(totals.count).toBe(5);
    expect(totals.eurGrossForOrdering()).toEqual({ units: 9259n, scale: 2 });
  });

  it("separates voucher kinds within a currency", () => {
    const totals = new DocumentTotals();
    totals.add({ currency: "EUR", gross: eur("119") }, "revenue");
    totals.add({ currency: "EUR", gross: eur("59.5") }, "expense");
    totals.add({ currency: "EUR", gross: eur("1") }, "unknown");
    expect(totals.lineList().map((line) => [line.kind, line.gross?.amount])).toEqual([
      ["expense", "59.50"],
      ["revenue", "119.00"],
      ["unknown", "1.00"],
    ]);
  });

  it("refuses an amount in another currency than its line (programming error)", () => {
    const totals = new DocumentTotals();
    expect(() => {
      totals.add({ currency: "EUR", gross: money("1", "USD") });
    }).toThrow(/USD amount in a EUR line/);
  });
});

describe("FlowTotals", () => {
  it("sums incoming and outgoing apart; netFlow = incoming + outgoing", () => {
    const flows = new FlowTotals();
    for (const amount of ["1190", "-298.10", "-45.99", "0.1", "0.2", "0"]) flows.add(eur(amount));
    flows.add(money("-378", "USD"));
    expect(flows.lineList()).toEqual([
      {
        currency: "EUR",
        count: 6,
        incoming: { amount: "1190.30", currency: "EUR" },
        outgoing: { amount: "-344.09", currency: "EUR" },
        netFlow: { amount: "846.21", currency: "EUR" },
      },
      {
        currency: "USD",
        count: 1,
        incoming: { amount: "0.00", currency: "USD" },
        outgoing: { amount: "-378.00", currency: "USD" },
        netFlow: { amount: "-378.00", currency: "USD" },
      },
    ]);
  });
});

describe("aging buckets", () => {
  const asOf = "2026-11-07";

  it("treats the due date itself as not yet due and buckets by whole days", () => {
    expect(bucketOf("2026-11-07", asOf)).toBe("not_due");
    expect(bucketOf("2026-12-01", asOf)).toBe("not_due");
    expect(bucketOf("2026-11-06", asOf)).toBe("days_1_30");
    expect(bucketOf("2026-10-08", asOf)).toBe("days_1_30"); // exactly 30 days
    expect(bucketOf("2026-10-07", asOf)).toBe("days_31_60"); // 31 days
    expect(bucketOf("2026-09-08", asOf)).toBe("days_31_60"); // 60
    expect(bucketOf("2026-09-07", asOf)).toBe("days_61_90"); // 61
    expect(bucketOf("2026-08-09", asOf)).toBe("days_61_90"); // 90
    expect(bucketOf("2026-08-08", asOf)).toBe("days_over_90"); // 91
    expect(bucketOf(undefined, asOf)).toBe("no_due_date");
    expect(daysOverdue("2026-10-08", asOf)).toBe(30);
  });

  it("counts days across daylight saving changes as calendar days", () => {
    expect(daysOverdue("2026-03-29", "2026-03-30")).toBe(1);
    expect(bucketOf("2026-03-29", "2026-03-30")).toBe("days_1_30");
    expect(daysOverdue("2026-10-25", "2026-11-24")).toBe(30);
    expect(bucketOf("2026-10-25", "2026-11-24")).toBe("days_1_30");
    expect(bucketOf("2026-10-24", "2026-11-24")).toBe("days_31_60");
  });

  function item(overrides: Partial<OpenItem> & Pick<OpenItem, "id">): OpenItem {
    return {
      party: { id: 1, name: "Musterfirma GmbH" },
      currency: "EUR",
      gross: "100",
      outstanding: "100.00",
      quality: "exact",
      dueDate: "2026-11-07",
      ...overrides,
    };
  }

  it("sums outstanding per bucket and currency, keeping approximate and unknown parts visible", () => {
    const core = buildAging(
      [
        item({ id: 1, outstanding: "0.10", dueDate: "2026-11-01" }),
        item({ id: 2, outstanding: "0.20", dueDate: "2026-10-20" }),
        item({
          id: 3,
          currency: "USD",
          gross: "100.00",
          outstanding: "100.00",
          quality: "approximate",
          dueDate: "2026-11-02",
          party: { id: 3 },
        }),
        item({
          id: 4,
          currency: "USD",
          gross: "50",
          outstanding: undefined,
          quality: "unknown",
          dueDate: "2026-11-03",
          party: { id: 3 },
        }),
        item({ id: 5, dueDate: undefined, party: { name: "Ohne Kontakt" } }),
        item({ id: 6, dueDate: "2026-12-01", party: undefined }),
      ],
      asOf,
      10,
    );
    const bucket = (name: (typeof AGING_BUCKETS)[number]) =>
      core.buckets.find((entry) => entry.bucket === name);
    expect(core.buckets.map((entry) => entry.bucket)).toEqual([...AGING_BUCKETS]);
    expect(bucket("days_1_30")).toEqual({
      bucket: "days_1_30",
      label: "1–30 days overdue (überfällig)",
      count: 4,
      lines: [
        { currency: "EUR", count: 2, outstanding: { amount: "0.30", currency: "EUR" } },
        {
          currency: "USD",
          count: 2,
          outstanding: { amount: "100.00", currency: "USD" },
          approximate: { count: 1, outstanding: { amount: "100.00", currency: "USD" } },
          unknown: { count: 1, gross: { amount: "50.00", currency: "USD" } },
        },
      ],
    });
    expect(bucket("days_31_60")).toMatchObject({ count: 0, lines: [] });
    expect(bucket("no_due_date")?.count).toBe(1);
    expect(bucket("not_due")?.count).toBe(1);
    expect(core.totals.count).toBe(6);
    expect(core.totals.lines[0]).toEqual({
      currency: "EUR",
      count: 4,
      outstanding: { amount: "200.30", currency: "EUR" },
    });
    expect(core.totals.overdue.map((line) => [line.currency, line.count])).toEqual([
      ["EUR", 2],
      ["USD", 2],
    ]);
  });

  it("ranks parties by outstanding within each currency and caps per currency", () => {
    const core = buildAging(
      [
        item({ id: 1, party: { id: 10, name: "A" }, outstanding: "50.00", dueDate: "2026-10-01" }),
        item({ id: 2, party: { id: 10, name: "A" }, outstanding: "60.00", dueDate: "2026-11-20" }),
        item({ id: 3, party: { id: 11, name: "B" }, outstanding: "200.00" }),
        item({ id: 4, party: { id: 12, name: "C" }, outstanding: "5.00", quality: "approximate" }),
        item({ id: 5, party: { id: 12, name: "C" }, outstanding: undefined, quality: "unknown" }),
        item({ id: 6, currency: "USD", party: { id: 10, name: "A" }, outstanding: "1.00" }),
      ],
      asOf,
      2,
    );
    expect(core.top).toEqual([
      {
        party: { id: 11, name: "B" },
        line: {
          currency: "EUR",
          outstanding: { amount: "200.00", currency: "EUR" },
          count: 1,
          oldestDueDate: "2026-11-07",
        },
      },
      {
        party: { id: 10, name: "A" },
        line: {
          currency: "EUR",
          outstanding: { amount: "110.00", currency: "EUR" },
          count: 2,
          oldestDueDate: "2026-10-01",
          maxDaysOverdue: 37,
        },
      },
      {
        party: { id: 10, name: "A" },
        line: {
          currency: "USD",
          outstanding: { amount: "1.00", currency: "USD" },
          count: 1,
          oldestDueDate: "2026-11-07",
        },
      },
    ]);
    const all = buildAging(
      [
        item({ id: 4, party: { id: 12, name: "C" }, outstanding: "5.00", quality: "approximate" }),
        item({
          id: 5,
          party: { id: 12, name: "C" },
          outstanding: undefined,
          quality: "unknown",
          dueDate: undefined,
        }),
      ],
      asOf,
      5,
    );
    expect(all.top[0]?.line).toEqual({
      currency: "EUR",
      outstanding: { amount: "5.00", currency: "EUR" },
      count: 2,
      approximate: true,
      unknownCount: 1,
      oldestDueDate: "2026-11-07",
    });
  });
});

describe("change instants", () => {
  it("reads sevDesk timestamps with offset, Z, Berlin wall time or Unix seconds", () => {
    expect(instantOf("2026-02-19T14:14:21+01:00")).toBe(Date.parse("2026-02-19T13:14:21Z"));
    expect(instantOf("2026-07-01T10:00:00+0200")).toBe(Date.parse("2026-07-01T08:00:00Z"));
    expect(instantOf("2026-07-01T08:00:00Z")).toBe(Date.parse("2026-07-01T08:00:00Z"));
    expect(instantOf("2026-07-01 10:00:00")).toBe(Date.parse("2026-07-01T08:00:00Z"));
    expect(instantOf("2026-01-15T10:00")).toBe(Date.parse("2026-01-15T09:00:00Z"));
    expect(instantOf(1_767_225_600)).toBe(1_767_225_600_000);
    expect(instantOf("1767225600")).toBe(1_767_225_600_000);
    expect(instantOf(null)).toBeUndefined();
    expect(instantOf("")).toBeUndefined();
    expect(instantOf(undefined)).toBeUndefined();
  });

  it("refuses unreadable timestamps instead of skipping them", () => {
    for (const value of [
      "yesterday",
      "2026-13-01T00:00:00Z",
      "2026-02-19T25:00:00Z",
      {},
      Number.NaN,
    ]) {
      expect(() => instantOf(value)).toThrow(SevdeskError);
    }
    expect(() => instantOf("2026-02-19T10:61:00Z")).toThrow(/unexpected format/);
  });

  it("resolves Berlin wall times with the offset in force at that hour on DST days", () => {
    // 2026-03-29: 02:00 CET becomes 03:00 CEST.
    expect(instantOf("2026-03-29T01:30:00")).toBe(Date.parse("2026-03-29T00:30:00Z"));
    expect(instantOf("2026-03-29T12:00:00")).toBe(Date.parse("2026-03-29T10:00:00Z"));
    expect(formatBerlinInstant(Date.parse("2026-03-29T10:00:00Z"))).toBe(
      "2026-03-29T12:00:00+02:00",
    );
    // A time inside the spring gap resolves to the hour after it.
    expect(formatBerlinInstant(instantOf("2026-03-29T02:30:00") ?? 0)).toBe(
      "2026-03-29T03:30:00+02:00",
    );
    // 2026-10-25: 03:00 CEST becomes 02:00 CET.
    expect(instantOf("2026-10-25T01:00:00")).toBe(Date.parse("2026-10-24T23:00:00Z"));
    expect(instantOf("2026-10-25T12:00:00")).toBe(Date.parse("2026-10-25T11:00:00Z"));
    expect(parseSince("2026-10-25T12:00")).toBe(Date.parse("2026-10-25T11:00:00Z"));
    expect(parseSince("2026-03-29T12:00")).toBe(Date.parse("2026-03-29T10:00:00Z"));
  });

  it("reads since as a Berlin day start or a date-time", () => {
    expect(parseSince("2026-01-15")).toBe(Date.parse("2026-01-14T23:00:00Z"));
    expect(parseSince("2026-07-15")).toBe(Date.parse("2026-07-14T22:00:00Z"));
    expect(parseSince(" 2026-11-01T08:00:00+01:00 ")).toBe(Date.parse("2026-11-01T07:00:00Z"));
    expect(() => parseSince("last week")).toThrow(/since must be a date/);
    expect(() => parseSince("2026-02-30")).toThrow(SevdeskError);
  });

  it("writes instants in Berlin time with the right offset in winter and summer", () => {
    expect(formatBerlinInstant(Date.parse("2026-02-19T13:14:21Z"))).toBe(
      "2026-02-19T14:14:21+01:00",
    );
    expect(formatBerlinInstant(Date.parse("2026-07-01T08:00:00.999Z"))).toBe(
      "2026-07-01T10:00:00+02:00",
    );
    // 2026-03-29: clocks jump from 02:00 to 03:00 Berlin time.
    expect(formatBerlinInstant(Date.parse("2026-03-29T01:00:00Z"))).toBe(
      "2026-03-29T03:00:00+02:00",
    );
  });
});
