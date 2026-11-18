/**
 * Reading a dated sevDesk list without paging across page boundaries (#154, #162).
 *
 * sevDesk sorts its lists by one field (vouchers by voucher date; invoices, credit notes and
 * orders by creation time) and leaves rows that tie on it in an order that depends on the page
 * size (spec/deviations.md D-146). On the trial account (2026-11-18, probe
 * `read-voucher-paging-order`, spec/deviations.md D-100), 56 vouchers read as one page of 1,000
 * and in pages of 5 came back in different orders, and the pages of 5 missed 12 vouchers and gave
 * 12 others twice, with and without `embed=document`. The documented `orderByVoucherNumber` still
 * lost one; the generic `orderBy[0][field]` was ignored. So a list read page by page with
 * `offset` can skip rows, and a skipped voucher makes a booked receipt look unbooked.
 *
 * {@link scanDateWindows} therefore reads a date range so that every request is the first page of
 * its own query: one page when the range fits; otherwise the range is halved, each half counted
 * (`limit` 1, sevDesk's `total`), until each part fits into one page, and every part is read as a
 * single page. Only a single day with more rows than a page cannot be split: it is read in pages
 * as before and named in `pagedRanges`, and the result says that rows of that day may be missing.
 * Rows are kept once per id across all reads, as a guard.
 */
import {
  daysBetween,
  REPORT_PAGE_SIZE,
  type ScanOptions,
  type ScanPage,
  shiftDays,
  throwIfAborted,
} from "./shared.js";

/** An inclusive range of calendar days (`YYYY-MM-DD`). */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** What {@link scanDateWindows} read. */
export interface WindowedScan<T> {
  /** Every row once (by id), in the order read: date windows ascending. */
  readonly items: T[];
  /** sevDesk rows of the kept reads (count requests and a split page are not included). */
  readonly scanned: number;
  /** sevDesk's count for the whole range, from the first request. */
  readonly total: number | undefined;
  /** True when the row cap (`max`) stopped reading while rows may have been left. */
  readonly truncated: boolean;
  /**
   * Ranges read in more than one page: a day with more rows than one page, or a list that gave
   * no usable count. sevDesk's order is not stable between pages, so rows of these ranges may be
   * missing. `YYYY-MM-DD`, or `YYYY-MM-DD to YYYY-MM-DD`; empty normally.
   */
  readonly pagedRanges: readonly string[];
}

/** One page of the list filtered to `range` (sevDesk's date filter plus the local re-check). */
export type DateWindowFetch<T> = (
  range: DateRange,
  offset: number,
  limit: number,
) => Promise<ScanPage<T>>;

function rangeLabel(range: DateRange): string {
  return range.from === range.to ? range.from : `${range.from} to ${range.to}`;
}

/**
 * Reads `range` of a dated list in windows that each fit one page ({@link REPORT_PAGE_SIZE}
 * rows), see the module comment. `fetchPage` reads one page of one window; `idOf` keys the
 * dedupe. The cap and progress behave as in `scanPages`: requests ask for at most `max − read`
 * rows, `truncated` is set when the cap stopped reading, and progress is reported after every
 * kept read. Windows are read in date order and splitting is lazy (a half is counted only when
 * it is its turn), so reading stops at the cap without counting the rest. A window is not split
 * when what is left of the cap fits one page: its first page is kept and the scan is truncated.
 *
 * Request bound: a range that fits costs one request, as a plain read did. Otherwise the first
 * page is set aside, each split costs two count requests (`limit` 1), and every window that is
 * not split is read once: with S splits, at most 3·S + 2 requests. A window is split only while
 * it holds more than one page; windows of one halving level are disjoint, and every split window
 * but the one being read was read in full, so a level has at most ⌊max / 1,000⌋ + 1 splits, over
 * at most ⌈log₂ D⌉ levels for a range of D days. With the default cap of 10,000 rows and a year
 * (D = 366): S ≤ 9 · 11 = 99, so at most 299 requests in the worst case; rows spread evenly need
 * far fewer (2,500 rows spread over a year: 11 requests, four of them reads). A day with more than one page adds one request
 * per further page, as before.
 */
export async function scanDateWindows<T>(
  fetchPage: DateWindowFetch<T>,
  range: DateRange,
  idOf: (item: T) => number | undefined,
  options: ScanOptions,
): Promise<WindowedScan<T>> {
  const base = options.alreadyScanned ?? 0;
  const items: T[] = [];
  const seen = new Set<number>();
  const pagedRanges: string[] = [];
  const state: { scanned: number; truncated: boolean; total: number | undefined } = {
    scanned: 0,
    truncated: false,
    total: undefined,
  };

  const fetch = (window: DateRange, offset: number, limit: number): Promise<ScanPage<T>> => {
    throwIfAborted(options.signal);
    return fetchPage(window, offset, limit);
  };

  async function keep(page: ScanPage<T>): Promise<void> {
    state.scanned += page.received;
    for (const item of page.items) {
      const id = idOf(item);
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      items.push(item);
    }
    await options.onProgress?.(
      base + state.scanned,
      state.total === undefined ? undefined : base + state.total,
      `Read ${base + state.scanned} ${options.noun}.`,
    );
  }

  /** Whether rows follow `page`; a short page without a count ends the list. */
  const moreAfter = (page: ScanPage<T>, limit: number): boolean =>
    page.hasMore && page.received > 0 && !(page.total === undefined && page.received < limit);

  /**
   * The rest of a window that has to be read in pages (from `offset` on). The window counts as
   * paged once a second page is actually read; a cap that stops before it is only `truncated`.
   */
  async function pageOn(window: DateRange, offset: number): Promise<void> {
    let next = offset;
    for (;;) {
      const limit = Math.min(REPORT_PAGE_SIZE, options.max - state.scanned);
      if (limit <= 0) {
        state.truncated = true;
        return;
      }
      const page = await fetch(window, next, limit);
      if (next === offset) pagedRanges.push(rangeLabel(window));
      await keep(page);
      next = page.nextOffset;
      if (!moreAfter(page, limit)) return;
    }
  }

  async function split(window: DateRange): Promise<void> {
    const middle = shiftDays(window.from, Math.floor(daysBetween(window.from, window.to) / 2));
    const left = { from: window.from, to: middle };
    const right = { from: shiftDays(middle, 1), to: window.to };
    await read(left, (await fetch(left, 0, 1)).total);
    if (state.truncated) return;
    await read(right, (await fetch(right, 0, 1)).total);
  }

  /** Reads `window`, whose row count is `count` when it was counted. */
  async function read(window: DateRange, count: number | undefined): Promise<void> {
    if (state.truncated || count === 0) return;
    if (count !== undefined && count > REPORT_PAGE_SIZE && window.from < window.to) {
      await split(window);
      return;
    }
    const limit = Math.min(REPORT_PAGE_SIZE, options.max - state.scanned);
    if (limit <= 0) {
      state.truncated = true;
      return;
    }
    const page = await fetch(window, 0, limit);
    if (window === range) state.total = page.total;
    if (!moreAfter(page, limit)) {
      await keep(page);
      return;
    }
    if (
      limit < REPORT_PAGE_SIZE ||
      (limit === options.max - state.scanned && page.received >= limit)
    ) {
      // The cap, not the page size, ends reading: what was left of it fits this page. Splitting
      // could read no more rows; it would only trade this page's rows (sevDesk lists the newest
      // dates first, D-100) for the oldest ones, at the cost of a count per split.
      await keep(page);
      state.truncated = true;
      return;
    }
    if (window.from < window.to && page.total !== undefined && page.total > REPORT_PAGE_SIZE) {
      // Set this page aside: its rows are read again, each part as a page of its own.
      await split(window);
      return;
    }
    await keep(page);
    await pageOn(window, page.nextOffset);
  }

  await read(range, undefined);
  return {
    items,
    scanned: state.scanned,
    total: state.total,
    truncated: state.truncated,
    pagedRanges,
  };
}
