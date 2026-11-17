/**
 * The schedule of a recurring invoice template (Abo-Rechnung, invoice type WKR): the intervals
 * this server offers, the rules a new schedule must follow, the run dates a preview lists, and the
 * reading of the schedule sevDesk stored.
 *
 * What sevDesk does (spec/deviations.md D-111, D-014; recorded 2026-11-16): `accountIntervall` is
 * stored as any string sent (`monthly` too) and never checked, so the server offers a closed set
 * and sends one ISO-8601 form per interval: the form of the spec's `recurringInterval` enum for
 * recurring vouchers (`P0Y1M0W`, `P0Y3M0W`, `P0Y6M0W`, `P1Y0M0W`), the first two of which are
 * recorded as stored on WKR templates. `accountStartDate` gives the first run and sets
 * `accountNextInvoice` to the same date; `accountNextInvoice` sent alone is ignored, and the
 * `recurring…` fields of the voucher model are dropped. Dates read back as ISO date-times.
 *
 * Rules decided here (each refusal says why):
 * - The first run is today or later and at most a year ahead. A start in the past was accepted
 *   by sevDesk, and it may then create every invoice due since that date at once, which no
 *   preview lists.
 * - The first run falls on day 1 to 28 of a month, and every later run on the same day. How
 *   sevDesk moves a run into a month without that day is not recorded; PHP-style month arithmetic
 *   (31 January plus one month is 3 March) would skip February.
 * - The end date, when given, is on or after the start and at most ten years after it.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import { parseUpstream, zBerlinDate, zText } from "../../sevdesk/schema.js";
import { cleanText, compact } from "../common.js";

/** The intervals a template can have, as the tool takes them. */
export const RECURRING_INTERVALS = ["monthly", "quarterly", "half_yearly", "yearly"] as const;
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number];

/** The `accountIntervall` values this server sends, one per interval (see the module comment). */
export const INTERVAL_WIRE_FORMS = ["P0Y1M0W", "P0Y3M0W", "P0Y6M0W", "P1Y0M0W"] as const;
type IntervalWire = (typeof INTERVAL_WIRE_FORMS)[number];

interface IntervalInfo {
  readonly months: number;
  readonly wire: IntervalWire;
  /** How a preview names the interval. */
  readonly en: string;
  readonly de: string;
}

export const INTERVALS: Readonly<Record<RecurringInterval, IntervalInfo>> = {
  monthly: { months: 1, wire: "P0Y1M0W", en: "monthly", de: "monatlich" },
  quarterly: { months: 3, wire: "P0Y3M0W", en: "quarterly", de: "vierteljährlich" },
  half_yearly: { months: 6, wire: "P0Y6M0W", en: "half-yearly", de: "halbjährlich" },
  yearly: { months: 12, wire: "P1Y0M0W", en: "yearly", de: "jährlich" },
};

/** The last day of a month a template may start on (see the module comment). */
const LAST_START_DAY = 28;
/** How far ahead the first run may be. */
const MAX_LEAD_MONTHS = 12;
/** How long a template with an end date may run. */
const MAX_RUN_YEARS = 10;
/** The most runs a schedule within the bounds has (monthly for ten years, both ends included). */
const MAX_RUNS = MAX_RUN_YEARS * 12 + 1;

/** A schedule as the tool takes it; dates are `YYYY-MM-DD` (Europe/Berlin). */
export interface ScheduleInput {
  readonly interval: RecurringInterval;
  readonly startDate: string;
  readonly endDate?: string | undefined;
}

/** A schedule that passed {@link checkSchedule}. */
export interface Schedule extends ScheduleInput {
  /** The `accountIntervall` value sent. */
  readonly wire: IntervalWire;
  /** The day of the month every run falls on (1–28). */
  readonly runDay: number;
}

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

/**
 * Checks a new schedule against the rules of the module comment, `today` being Berlin's
 * `YYYY-MM-DD`. Throws `validation` errors (trusted text: only the caller's own dates); nothing is
 * read or sent.
 */
export function checkSchedule(input: ScheduleInput, today: string): Schedule {
  const { startDate, endDate } = input;
  if (startDate < today) {
    refuse(
      `The start date ${startDate} is in the past (today is ${today} in Berlin). sevDesk may ` +
        "then create every invoice due since that date at once, which no preview shows. Give " +
        "today or a later date as startDate.",
    );
  }
  const latest = addMonths(today, MAX_LEAD_MONTHS);
  if (startDate > latest) {
    refuse(
      `The start date ${startDate} is more than a year ahead (the latest is ${latest}). Create ` +
        "the template closer to its first run.",
    );
  }
  const runDay = dayOf(startDate);
  if (runDay > LAST_START_DAY) {
    refuse(
      `The start date ${startDate} falls on day ${String(runDay)} of the month. Recurring ` +
        `invoices start on day 1 to ${String(LAST_START_DAY)}, so that every month has the run ` +
        "day: how sevDesk moves a run into a shorter month is not recorded, and it could skip a " +
        `month. Start on the ${String(LAST_START_DAY)}th or on the 1st of the next month instead.`,
    );
  }
  if (endDate !== undefined) {
    if (endDate < startDate) {
      refuse(`The end date ${endDate} is before the start date ${startDate}.`);
    }
    const last = addMonths(startDate, MAX_RUN_YEARS * 12);
    if (endDate > last) {
      refuse(
        `The end date ${endDate} is more than ${String(MAX_RUN_YEARS)} years after the start ` +
          `date ${startDate} (the latest is ${last}). Leave endDate out for a template that runs ` +
          "until it is ended.",
      );
    }
  }
  // Only the schedule: callers pass all of a tool's arguments.
  const { interval } = input;
  return endDate === undefined
    ? { interval, startDate, wire: INTERVALS[interval].wire, runDay }
    : { interval, startDate, endDate, wire: INTERVALS[interval].wire, runDay };
}

/**
 * The first `max` run dates: the start date, then one interval after another on the same day of
 * the month, up to and including the end date. Runs never fall on days 29–31 (see
 * {@link checkSchedule}), so no month lacks the run day.
 */
export function runDates(schedule: Schedule, max: number): string[] {
  const { months } = INTERVALS[schedule.interval];
  const dates: string[] = [];
  for (let run = 0; dates.length < max; run += 1) {
    const date = addMonths(schedule.startDate, run * months);
    if (schedule.endDate !== undefined && date > schedule.endDate) break;
    dates.push(date);
  }
  return dates;
}

/** How many runs fall on or before the end date; `undefined` without an end date. */
export function runCount(schedule: Schedule): number | undefined {
  return schedule.endDate === undefined ? undefined : runDates(schedule, MAX_RUNS).length;
}

/** The interval an ISO-8601 duration stands for, in any spelling (`P1M`, `P0Y1M0W`); else none. */
export function intervalOf(duration: string): RecurringInterval | undefined {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?$/.exec(duration.trim());
  if (match === null || Number(match[3] ?? "0") !== 0) return undefined;
  const months = Number(match[1] ?? "0") * 12 + Number(match[2] ?? "0");
  return RECURRING_INTERVALS.find((interval) => INTERVALS[interval].months === months);
}

// ---------------------------------------------------------------------------------------------
// The stored schedule
// ---------------------------------------------------------------------------------------------

/** The schedule fields of a stored template (lenient, like every upstream read). */
const storedRecordSchema = z.object({
  accountIntervall: zText,
  accountStartDate: zBerlinDate,
  accountNextInvoice: zBerlinDate,
  accountEndDate: zBerlinDate,
  accountLastInvoice: zBerlinDate,
});

/** The schedule sevDesk stored for a template (tool output). */
export const storedScheduleSchema = z.object({
  interval: z
    .string()
    .optional()
    .describe("accountIntervall as sevDesk stored it, an ISO-8601 duration such as P0Y1M0W."),
  intervalKey: z
    .enum(RECURRING_INTERVALS)
    .optional()
    .describe("The interval it stands for, when it is one this server offers."),
  startDate: z.string().optional().describe("First run (accountStartDate), YYYY-MM-DD."),
  nextRun: z.string().optional().describe("Next run (accountNextInvoice), YYYY-MM-DD."),
  endDate: z.string().optional().describe("No run after this date (accountEndDate), YYYY-MM-DD."),
  lastRun: z
    .string()
    .optional()
    .describe("When sevDesk last created an invoice from it (accountLastInvoice), YYYY-MM-DD."),
});

export type StoredSchedule = z.output<typeof storedScheduleSchema>;

/**
 * The schedule of one raw `Invoice` record (a template as `GET /Invoice/{id}` returns it). The
 * interval is untrusted text, cleaned; dates become Berlin calendar days. A record that does not
 * fit is an `unexpected_response` error.
 */
export function readStoredSchedule(raw: unknown): StoredSchedule {
  const record = parseUpstream(storedRecordSchema, raw, "a recurring invoice template");
  const interval = cleanText(record.accountIntervall, 50);
  return compact({
    interval,
    intervalKey: interval === undefined ? undefined : intervalOf(interval),
    startDate: record.accountStartDate,
    nextRun: record.accountNextInvoice,
    endDate: record.accountEndDate,
    lastRun: record.accountLastInvoice,
  });
}

/**
 * Trusted notes on every way the stored schedule differs from the one sent (empty when it is as
 * asked). Stored dates were parsed into `YYYY-MM-DD`; the stored interval is upstream text and is
 * not repeated here (the output carries it).
 */
export function scheduleDifferences(asked: Schedule, stored: StoredSchedule): string[] {
  const notes: string[] = [];
  const none = "none";
  if (stored.interval !== asked.wire) {
    notes.push(
      `sevDesk stored another interval than the ${asked.wire} that was sent (see ` +
        `schedule.interval), so the template may not run ${INTERVALS[asked.interval].en}. Check ` +
        "it in sevDesk.",
    );
  }
  if (stored.startDate !== asked.startDate) {
    notes.push(
      `sevDesk stored the start date ${stored.startDate ?? none} instead of ${asked.startDate}. ` +
        "Check the template in sevDesk before its first run.",
    );
  }
  if (stored.nextRun !== asked.startDate) {
    notes.push(
      stored.nextRun === undefined
        ? "sevDesk stored no next run date, so the template may never run. Check it in sevDesk."
        : `sevDesk set the next run to ${stored.nextRun}, not to the start date ` +
            `${asked.startDate}. Check the template in sevDesk before its first run.`,
    );
  }
  if (stored.endDate !== asked.endDate) {
    notes.push(
      `sevDesk stored the end date ${stored.endDate ?? none} instead of ` +
        `${asked.endDate ?? none}. Check the template in sevDesk.`,
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------------------------

function dayOf(date: string): number {
  return Number(date.slice(8, 10));
}

/**
 * `YYYY-MM-DD` plus whole months, kept on the same day of the month; a day the target month lacks
 * becomes its last day (never reached by a checked schedule, whose runs fall on days 1–28).
 */
export function addMonths(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${String(targetYear)}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
