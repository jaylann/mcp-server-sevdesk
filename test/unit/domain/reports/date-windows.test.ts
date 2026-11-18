import { describe, expect, it } from "vitest";

import {
  type DateRange,
  type DateWindowFetch,
  scanDateWindows,
} from "../../../../src/domain/reports/date-windows.js";
import { type ScanPage, shiftDays } from "../../../../src/domain/reports/shared.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";

interface Row {
  readonly id: number;
  readonly date: string;
}

/**
 * A dated list as sevDesk serves it (D-100, recorded 2026-11-18): newest date first, and rows of
 * one date in an order that depends on the page (synthetic: on `limit` and `offset`; the trial
 * showed one page of 1,000 and pages of 5 in different orders, the pages of 5 missing 12 rows and
 * repeating 12). Every request is recorded.
 */
function datedList(rows: readonly Row[], options: { readonly withTotal?: boolean } = {}) {
  const requests: { range: DateRange; offset: number; limit: number }[] = [];
  const tie = (limit: number, offset: number) => (row: Row) =>
    Math.imul(row.id ^ Math.imul(limit * 31 + offset, 0x9e3779b1), 0x85ebca6b) >>> 0;
  const fetch: DateWindowFetch<Row> = (range, offset, limit) => {
    requests.push({ range, offset, limit });
    const order = tie(limit, offset);
    const matching = rows
      .filter((row) => row.date >= range.from && row.date <= range.to)
      .sort((a, b) => b.date.localeCompare(a.date) || order(a) - order(b));
    const items = matching.slice(offset, offset + limit);
    const total = options.withTotal === false ? undefined : matching.length;
    const nextOffset = offset + items.length;
    const page: ScanPage<Row> = {
      items,
      received: items.length,
      total,
      hasMore: items.length > 0 && (total === undefined || nextOffset < total),
      nextOffset,
    };
    return Promise.resolve(page);
  };
  return { fetch, requests };
}

/** `count` rows spread over the days from `from` on, `perDay` per day, ids from `firstId`. */
function spread(from: string, count: number, perDay: number, firstId = 1): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    date: shiftDays(from, Math.floor(index / perDay)),
  }));
}

const YEAR: DateRange = { from: "2026-01-01", to: "2026-12-31" };
const options = (max = 10_000) => ({ max, noun: "vouchers" });

function idsOnce(items: readonly Row[]): boolean {
  return new Set(items.map((row) => row.id)).size === items.length;
}

describe("scanDateWindows", () => {
  it("reads a range that fits one page with one request, as before", async () => {
    const rows = spread("2026-03-01", 400, 5);
    const list = datedList(rows);
    const scan = await scanDateWindows(list.fetch, YEAR, (row) => row.id, options());
    expect(list.requests).toEqual([{ range: YEAR, offset: 0, limit: 1000 }]);
    expect(scan).toMatchObject({ scanned: 400, total: 400, truncated: false, pagedRanges: [] });
    expect(scan.items).toHaveLength(400);
  });

  it("splits a range with more than one page into date windows, each read as one page", async () => {
    // 2,500 rows over 250 days, ten per day: every date is shared, so page boundaries cut ties.
    const rows = spread("2026-01-01", 2500, 10);
    const list = datedList(rows);
    const scan = await scanDateWindows(list.fetch, YEAR, (row) => row.id, options());
    expect(scan.items).toHaveLength(2500);
    expect(idsOnce(scan.items)).toBe(true);
    expect(scan).toMatchObject({ scanned: 2500, total: 2500, truncated: false, pagedRanges: [] });
    // Never past the first page of a query: no offset, and no read of more than one page.
    expect(list.requests.every((request) => request.offset === 0)).toBe(true);
    const reads = list.requests.filter((request) => request.limit === 1000);
    const counts = list.requests.filter((request) => request.limit === 1);
    // The first page (set aside), then three windows of up to 1,000 rows, each counted first:
    // January to 2 April, 3 April to 2 July, and the rest of the year (rows end on 7 September).
    expect(reads).toHaveLength(4);
    expect(counts).toHaveLength(4);
    // The windows read cover the year without overlap, in date order.
    const windows = reads.slice(1).map((request) => request.range);
    expect(windows[0]?.from).toBe("2026-01-01");
    expect(windows.at(-1)?.to).toBe("2026-12-31");
    for (const [index, window] of windows.entries()) {
      const next = windows[index + 1];
      if (next !== undefined) expect(next.from).toBe(shiftDays(window.to, 1));
    }
  });

  it("would skip and repeat rows if it paged with offset (the simulation is sevDesk's trap)", async () => {
    // Seven a day: the page boundaries at 1,000 and 2,000 fall inside a day.
    const rows = spread("2026-01-01", 2500, 7);
    const list = datedList(rows);
    const paged: Row[] = [];
    for (let offset = 0; offset < 2500; offset += 1000) {
      paged.push(...(await list.fetch(YEAR, offset, 1000)).items);
    }
    expect(paged).toHaveLength(2500);
    expect(idsOnce(paged)).toBe(false);
  });

  it("reads a day with more than one page page by page, keeps each row once and names the day", async () => {
    const busy = spread("2026-06-30", 1500, 1500, 10_000);
    const rows = [...spread("2026-01-01", 300, 3), ...busy];
    // The busy day's two pages come in different orders: the second repeats rows of the first.
    const list = datedList(rows);
    const scan = await scanDateWindows(list.fetch, YEAR, (row) => row.id, options());
    expect(scan.pagedRanges).toEqual(["2026-06-30"]);
    expect(scan.truncated).toBe(false);
    expect(idsOnce(scan.items)).toBe(true);
    expect(scan.items.filter((row) => row.date !== "2026-06-30")).toHaveLength(300);
    expect(scan.items.filter((row) => row.date === "2026-06-30").length).toBeLessThan(1500);
    // Only that day was read with an offset.
    const offsets = list.requests.filter((request) => request.offset > 0);
    expect(offsets.map((request) => request.range)).toEqual([
      { from: "2026-06-30", to: "2026-06-30" },
    ]);
  });

  it("stops at the row cap in date order, without counting what follows", async () => {
    const rows = spread("2026-01-01", 2500, 10);
    const list = datedList(rows);
    const scan = await scanDateWindows(list.fetch, YEAR, (row) => row.id, options(1500));
    expect(scan.truncated).toBe(true);
    expect(scan.scanned).toBe(1500);
    expect(idsOnce(scan.items)).toBe(true);
    expect(scan.pagedRanges).toEqual([]);
    // The second half of the year was never counted: reading stopped in the first.
    expect(list.requests.some((request) => request.range.from === "2026-07-03")).toBe(false);
  });

  it("never pages with a cap of one page: a busy day only truncates", async () => {
    const list = datedList(spread("2026-03-31", 1500, 1500));
    const scan = await scanDateWindows(list.fetch, YEAR, (row) => row.id, options(1000));
    expect(scan).toMatchObject({ scanned: 1000, truncated: true, pagedRanges: [] });
    expect(list.requests.every((request) => request.offset === 0)).toBe(true);
  });

  it("reads a list without a count to its end and says it was paged", async () => {
    const short = datedList(spread("2026-03-01", 400, 5), { withTotal: false });
    const one = await scanDateWindows(short.fetch, YEAR, (row) => row.id, options());
    expect(short.requests).toHaveLength(1);
    expect(one).toMatchObject({ scanned: 400, total: undefined, pagedRanges: [] });

    const long = datedList(spread("2026-03-01", 1200, 5), { withTotal: false });
    const paged = await scanDateWindows(long.fetch, YEAR, (row) => row.id, options());
    expect(paged.pagedRanges).toEqual(["2026-01-01 to 2026-12-31"]);
    expect(paged.scanned).toBe(1200);
  });

  it("skips windows counted empty and reports progress after each kept read", async () => {
    // Everything in the first half of the year: the second half is counted, never read.
    const rows = spread("2026-01-01", 1800, 20);
    const list = datedList(rows);
    const progress: (number | undefined)[][] = [];
    const scan = await scanDateWindows(list.fetch, YEAR, (row) => row.id, {
      ...options(),
      alreadyScanned: 7,
      onProgress: (read, total) => {
        progress.push([read, total]);
      },
    });
    expect(scan.items).toHaveLength(1800);
    expect(
      list.requests.some((request) => request.range.from === "2026-07-02" && request.limit > 1),
    ).toBe(false);
    expect(progress.at(-1)).toEqual([1807, 1807]);
  });

  it("stops with sevDesk's aborted error when the call is cancelled", async () => {
    const list = datedList(spread("2026-01-01", 2500, 10));
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanDateWindows(list.fetch, YEAR, (row) => row.id, {
        ...options(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SevdeskError);
    expect(list.requests).toEqual([]);
  });
});
