/**
 * Shared machinery of the report tools (Auswertungen): the capped, cancellable page scan every
 * aggregate runs on, calendar-day arithmetic, and the trusted wording that marks every report as
 * computed here from sevDesk records rather than taken from sevDesk's own reports.
 *
 * Reports read sevDesk's lists through the exported domain list functions (`listInvoices`,
 * `listVouchers`, …), so rows are parsed, sanitized and mapped exactly as in the list tools; the
 * scan only pages, counts, caps and reports progress.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";

/** Hard cap of sevDesk rows one report reads; hitting it is reported as `truncated`. */
export const REPORT_SCAN_MAX = 10_000;
/** Rows per request while scanning (sevDesk's maximum page size). */
export const REPORT_PAGE_SIZE = 1_000;

/** Stated in every report's output. */
export const REPORT_SOURCE =
  "Computed by this server from sevDesk records (exact decimals, per currency, never " +
  "converted); not one of sevDesk's own reports.";

/** Progress callback of a report: rows read so far, sevDesk's count if known, trusted text. */
type ReportProgress = (
  done: number,
  total: number | undefined,
  message: string,
) => Promise<void> | void;

/**
 * A time budget for the one-request-per-document steps of a report (position reads, documents
 * fetched by id). Once `now()` reaches `at`, no further read is started; what was read is
 * returned as an explicitly truncated report. HTTP deployments set it, because the HTTP router
 * stops every request after 120 s and a stopped report returns nothing at all, while the client's
 * pacing (4 requests per second by default) cannot read more than a few hundred documents in that
 * time (review 2026-11, round 3). Over stdio there is no deadline and no budget.
 */
export interface ReportDeadline {
  /** Epoch milliseconds after which no new per-document read starts. */
  readonly at: number;
  /** Clock in epoch milliseconds (`Date.now`; tests pass a fake one). */
  readonly now: () => number;
}

/**
 * How long a report in an HTTP deployment starts per-document reads: 90 s of the router's 120 s,
 * which leaves room for the reads in flight, the contact lookups of the ZM and the response.
 */
export const HTTP_REPORT_BUDGET_MS = 90_000;

/** Whether `deadline` has passed (never without one). */
export function deadlineReached(deadline: ReportDeadline | undefined): boolean {
  return deadline !== undefined && deadline.now() >= deadline.at;
}

export interface ReportRunOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ReportProgress | undefined;
  /** No per-document read starts after it (HTTP deployments); see {@link ReportDeadline}. */
  readonly deadline?: ReportDeadline | undefined;
}

/** One page as the domain list functions describe it. */
export interface ScanPage<T> {
  readonly items: readonly T[];
  /** sevDesk rows consumed for this page (may exceed `items` when rows were filtered). */
  readonly received: number;
  readonly total: number | undefined;
  readonly hasMore: boolean;
  /** Where the next page starts (`offset + received`). */
  readonly nextOffset: number;
}

export interface ScanResult<T> {
  readonly items: T[];
  /** sevDesk rows read. */
  readonly scanned: number;
  /** sevDesk's count for the query, when reported. */
  readonly total: number | undefined;
  /** True when the cap stopped the scan while sevDesk reported (or could not rule out) more. */
  readonly truncated: boolean;
}

export interface ScanOptions extends ReportRunOptions {
  /** Most rows to read; at least 1. */
  readonly max: number;
  /** Trusted plural for progress messages, e.g. "invoices". */
  readonly noun: string;
  /** Rows already read by earlier scans of the same report (progress counts continue). */
  readonly alreadyScanned?: number;
}

/**
 * Reads a list page by page from offset 0 until sevDesk reports no more rows or `max` rows were
 * read. Requests ask for at most `max − read` rows, so the cap is exact for lists that return what
 * they are asked for; a list that filters while it reads (transactions) can overshoot by one page.
 * Checks `signal` before every page and reports progress after each.
 */
export async function scanPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<ScanPage<T>>,
  options: ScanOptions,
): Promise<ScanResult<T>> {
  const items: T[] = [];
  const base = options.alreadyScanned ?? 0;
  let offset = 0;
  let scanned = 0;
  let total: number | undefined;
  for (;;) {
    throwIfAborted(options.signal);
    const remaining = options.max - scanned;
    if (remaining <= 0) return { items, scanned, total, truncated: true };
    const page = await fetchPage(offset, Math.min(REPORT_PAGE_SIZE, remaining));
    total = page.total ?? total;
    scanned += page.received;
    items.push(...page.items);
    offset = page.nextOffset;
    await options.onProgress?.(
      base + scanned,
      total === undefined ? undefined : base + total,
      `Read ${base + scanned} ${options.noun}.`,
    );
    if (!page.hasMore || page.received === 0) return { items, scanned, total, truncated: false };
  }
}

/** Throws sevDesk's `aborted` error when the call was cancelled. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
  }
}

/** A local `validation` error (nothing is sent to sevDesk). */
export function invalidReportRequest(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message: `Invalid request: ${message}` });
}

// ---------------------------------------------------------------------------------------------
// Calendar days (YYYY-MM-DD, no time zone involved)
// ---------------------------------------------------------------------------------------------

function utcDay(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** `YYYY-MM-DD` plus whole days. */
export function shiftDays(date: string, days: number): string {
  return new Date(utcDay(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to` (positive when `to` is later). DST plays no role. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

/** `2026-11` for `2026-11-07`. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** `2026-Q4` for `2026-11-07`. */
export function quarterOf(date: string): string {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
}

// ---------------------------------------------------------------------------------------------
// Output parts
// ---------------------------------------------------------------------------------------------

/** Coverage fields every scanning report returns. */
export const coverageOutputShape = {
  source: z.string().describe("How the numbers were made: computed here, not a sevDesk report."),
  recordsScanned: z.number().int().describe("sevDesk rows read for this report."),
  truncated: z
    .boolean()
    .describe(
      `True when the cap of ${REPORT_SCAN_MAX} rows stopped reading: totals are then incomplete.`,
    ),
  notes: z
    .array(z.string())
    .describe("Caveats that apply to these numbers (approximations, exclusions)."),
};

/** "1 invoice" / "3 invoices". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ---------------------------------------------------------------------------------------------
// Tax reports (VAT summary, profit and loss): wording for incomplete reads
// ---------------------------------------------------------------------------------------------

/** What the tax reports say about themselves when not everything was read. */
interface TaxReportCompleteness {
  readonly truncated: boolean;
  readonly timeBudgetReached?: boolean | undefined;
  readonly positionsIncomplete: number;
}

/** The trusted "Incomplete: …" ending of a tax report's summary sentence ("" when complete). */
export function incompleteSuffix(coverage: TaxReportCompleteness): string {
  if (!coverage.truncated) return "";
  if (coverage.timeBudgetReached === true) {
    return " Incomplete: the time budget stopped reading; use a shorter period.";
  }
  if (coverage.positionsIncomplete > 0) {
    return " Incomplete: not every position could be read (see the notes).";
  }
  return " Incomplete: a cap stopped reading.";
}

/**
 * Trusted notes of a tax report for the two ways of reading too little that are not a cap: the
 * time budget of an HTTP deployment and documents whose positions could not all be read.
 */
export function incompleteTaxReportNotes(input: {
  readonly timedOut: boolean;
  /** Documents whose positions were read, and how many the report wanted to read. */
  readonly documentsScanned: number;
  readonly documentsToScan: number;
  readonly positionsIncomplete: number;
}): string[] {
  const notes: string[] = [];
  if (input.timedOut) {
    notes.push(
      "This server stopped reading documents when its time budget for one report ran out " +
        `(positions of ${String(input.documentsScanned)} of ${String(input.documentsToScan)} ` +
        "documents read; a request over HTTP must answer within two minutes): the figures are " +
        "incomplete. Use a shorter period (a month instead of a quarter or year).",
    );
  }
  if (input.positionsIncomplete > 0) {
    notes.push(
      `The positions of ${plural(input.positionsIncomplete, "document")} could not all be read ` +
        "(coverage.positionsIncompleteDocuments). Their totals were split over the positions " +
        "that were read, so amounts may sit under the wrong rate or account: the figures are " +
        "incomplete. Check these documents by hand.",
    );
  }
  return notes;
}
