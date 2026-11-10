/**
 * Calendar periods for the prompts: months (`YYYY-MM`) and quarters (`YYYY-Qn`) as day ranges and
 * labels. Pure functions on validated values; "today" comes from the caller (Europe/Berlin).
 */

/** A month or a quarter, with its first and last day (`YYYY-MM-DD`). */
export interface Period {
  readonly year: number;
  /** 1–12 for a month, undefined for a quarter. */
  readonly month?: number;
  /** 1–4 for a quarter, undefined for a month. */
  readonly quarter?: number;
  /** `2026-10` or `2026-Q3`. */
  readonly key: string;
  /** `October 2026` or `Q3 2026 (July–September)`. */
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** `YYYY-MM`, years 2000–2099. */
export const MONTH_PATTERN = /^20\d\d-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` or `YYYY-Qn` (q in either case), years 2000–2099. */
export const PERIOD_PATTERN = /^20\d\d-(0[1-9]|1[0-2]|[Qq][1-4])$/;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

/** The month `year`-`month` (1–12). */
export function monthPeriod(year: number, month: number): Period {
  return {
    year,
    month,
    key: `${String(year)}-${pad(month)}`,
    label: `${monthName(month)} ${String(year)}`,
    from: `${String(year)}-${pad(month)}-01`,
    to: `${String(year)}-${pad(month)}-${pad(lastDay(year, month))}`,
  };
}

/** The quarter `year`-Q`quarter` (1–4). */
export function quarterPeriod(year: number, quarter: number): Period {
  const first = (quarter - 1) * 3 + 1;
  const last = first + 2;
  return {
    year,
    quarter,
    key: `${String(year)}-Q${String(quarter)}`,
    label: `Q${String(quarter)} ${String(year)} (${monthName(first)}–${monthName(last)})`,
    from: `${String(year)}-${pad(first)}-01`,
    to: `${String(year)}-${pad(last)}-${pad(lastDay(year, last))}`,
  };
}

/** Parses a value that matched {@link PERIOD_PATTERN} (or {@link MONTH_PATTERN}). */
export function parsePeriod(value: string): Period {
  const year = Number(value.slice(0, 4));
  const rest = value.slice(5);
  return /^[Qq]/.test(rest)
    ? quarterPeriod(year, Number(rest.slice(1)))
    : monthPeriod(year, Number(rest));
}

/** The month before the one `today` (`YYYY-MM-DD`) lies in. */
export function previousMonth(today: string): Period {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? monthPeriod(year - 1, 12) : monthPeriod(year, month - 1);
}

/** The quarter before the one `today` (`YYYY-MM-DD`) lies in. */
export function previousQuarter(today: string): Period {
  const year = Number(today.slice(0, 4));
  const quarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  return quarter === 1 ? quarterPeriod(year - 1, 4) : quarterPeriod(year, quarter - 1);
}
