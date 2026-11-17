/**
 * The schedule of a recurring invoice template (Abo-Rechnung, invoice type WKR): the intervals
 * this server offers, the rules a new schedule must follow, the run dates a preview lists, and the
 * reading of the schedule sevDesk stored.
 *
 * What sevDesk does (spec/deviations.md D-111, D-014; recorded 2026-11-16 and 2026-11-17):
 * `accountIntervall` is stored as any string sent (`monthly` too) and never checked, so the server
 * offers a closed set and sends one ISO-8601 form per interval: the form of the spec's
 * `recurringInterval` enum for recurring vouchers (`P0Y1M0W`, `P0Y3M0W`, `P0Y6M0W`, `P1Y0M0W`),
 * all four of which sevDesk's generation understands. The web app stores its own forms (`P0Y1M`
 * for monthly, `P0Y0M1W` for 7 days), so the reader takes any ISO-8601 duration and describes the
 * ones that are not among the four. `accountStartDate` gives the first run
 * and sets `accountNextInvoice` to the same date; `accountNextInvoice` sent alone is ignored, and
 * the `recurring…` fields of the voucher model are dropped. Dates read back as ISO date-times,
 * with the time of day for templates made in the web app.
 *
 * Automatic generation and automatic sending are not in the plain record: a read with
 * {@link TEMPLATE_SETTINGS_EMBED} adds them (D-132), and {@link readStoredSchedule} reads them.
 *
 * Rules decided here (each refusal says why):
 * - The first run is today or later and at most a year ahead. A start in the past is accepted by
 *   sevDesk, which then catches up (recorded 2026-11-17, D-111): with generation on and a start
 *   three months back, it created one draft per missed period, one a minute, four in all, which no
 *   preview lists.
 * - The first run falls on day 1 to 28 of a month, and every later run on the same day. How
 *   sevDesk moves a run into a month without that day is not recorded; PHP-style month arithmetic
 *   (31 January plus one month is 3 March) would skip February.
 * - The end date, when given, is on or after the start and at most ten years after it.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import { parseUpstream, zBerlinDate, zOptionalInt, zText } from "../../sevdesk/schema.js";
import { cleanText, compact } from "../common.js";
import { describeInterval } from "../vouchers.js";

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
  const runDay = checkStartDate(startDate, today);
  if (endDate !== undefined) checkEndDate(endDate, startDate, "the start date");
  // Only the schedule: callers pass all of a tool's arguments.
  const { interval } = input;
  return endDate === undefined
    ? { interval, startDate, wire: INTERVALS[interval].wire, runDay }
    : { interval, startDate, endDate, wire: INTERVALS[interval].wire, runDay };
}

/**
 * Checks a first run (a new template's start, or a changed one) against the rules of the module
 * comment and returns its day of the month. Throws `validation` errors with the caller's dates.
 */
export function checkStartDate(startDate: string, today: string): number {
  if (startDate < today) {
    refuse(
      `The start date ${startDate} is in the past (today is ${today} in Berlin). sevDesk would ` +
        "then catch up and create an invoice for every period since that date, one a minute, " +
        "which no preview shows. Give today or a later date as startDate.",
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
  return runDay;
}

/**
 * Checks an end date against the first run it follows: on or after `from` and at most ten years
 * after it. `fromLabel` names `from` in the message ("the start date", "the next run"); both are
 * trusted.
 */
export function checkEndDate(endDate: string, from: string, fromLabel: string): void {
  if (endDate < from) {
    refuse(`The end date ${endDate} is before ${fromLabel} ${from}.`);
  }
  const last = addMonths(from, MAX_RUN_YEARS * 12);
  if (endDate > last) {
    refuse(
      `The end date ${endDate} is more than ${String(MAX_RUN_YEARS)} years after ${fromLabel} ` +
        `${from} (the latest is ${last}). Leave endDate out for a template that runs until it ` +
        "is ended.",
    );
  }
}

/**
 * The schedule a stored template follows from `firstRun` (its next run, or a new start date) on,
 * for listing run dates. Unlike {@link checkSchedule} it checks nothing: a template made in the
 * web app may run on day 29–31, which {@link runDates} then moves to a shorter month's last day.
 */
export function scheduleFrom(
  interval: RecurringInterval,
  firstRun: string,
  endDate: string | undefined,
): Schedule {
  const base = { interval, startDate: firstRun, wire: INTERVALS[interval].wire };
  const runDay = dayOf(firstRun);
  return endDate === undefined ? { ...base, runDay } : { ...base, endDate, runDay };
}

/** Whether the schedule's run day exists in every month (see the module comment). */
export function runDayFitsEveryMonth(schedule: Schedule): boolean {
  return schedule.runDay <= LAST_START_DAY;
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

/**
 * Whether the last run falls on the end date itself. Whether sevDesk still runs a template on its
 * end date is not recorded, so that run may not happen.
 */
export function endsOnRun(schedule: Schedule): boolean {
  return schedule.endDate !== undefined && runDates(schedule, MAX_RUNS).at(-1) === schedule.endDate;
}

/**
 * The interval an ISO-8601 duration of years, months, weeks and days stands for, in any spelling
 * (`P1M`, `P0Y1M` as the web app stores it, `P0Y1M0W` as this server sends it, `P0Y12M`); none
 * for another duration (`P0Y2M`, `P14D`) or text that is no duration.
 */
export function intervalOf(duration: string): RecurringInterval | undefined {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(duration.trim());
  if (match === null || Number(match[3] ?? "0") !== 0 || Number(match[4] ?? "0") !== 0) {
    return undefined;
  }
  const months = Number(match[1] ?? "0") * 12 + Number(match[2] ?? "0");
  return RECURRING_INTERVALS.find((interval) => INTERVALS[interval].months === months);
}

// ---------------------------------------------------------------------------------------------
// The stored schedule
// ---------------------------------------------------------------------------------------------

/**
 * Status 50, "Deactivated recurring invoice" (D-112): an ended template. sevDesk keeps every
 * schedule field at 50 (recorded 2026-11-17), so its next run is no run that will happen.
 */
export const ENDED_STATUS = 50;

/**
 * The `embed` value that adds automatic generation and automatic sending to a template record,
 * by id and on every row of `GET /Invoice?invoiceType=WKR` (D-132). Neither is in the plain
 * record.
 */
export const TEMPLATE_SETTINGS_EMBED = "propertyAutoGenerateRecurringInvoice,autoSendConfiguration";

/**
 * How a template's automatic generation ("Automatische Generierung") reads (D-132): `on` for the
 * stored "1"; `off` for `null` (never set, the default) and "" (switched off); `unrecorded` for
 * any other value, such as the "0" a `PUT` with that string stores, whose meaning is not recorded.
 */
const AUTO_GENERATE_STATES = ["on", "off", "unrecorded"] as const;
type AutoGenerateState = (typeof AUTO_GENERATE_STATES)[number];

/** The schedule fields of a stored template (lenient, like every upstream read). */
const storedRecordSchema = z.object({
  status: zOptionalInt,
  accountIntervall: zText,
  accountStartDate: zBerlinDate,
  accountNextInvoice: zBerlinDate,
  accountEndDate: zBerlinDate,
  accountLastInvoice: zBerlinDate,
  // Only with TEMPLATE_SETTINGS_EMBED; missing from the record otherwise (D-132).
  propertyAutoGenerateRecurringInvoice: z.unknown().optional(),
  autoSendConfiguration: z.unknown().optional(),
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
  every: z
    .string()
    .optional()
    .describe('The interval in words ("every 1 month", "every 2 weeks"), when it is a duration.'),
  startDate: z.string().optional().describe("First run (accountStartDate), YYYY-MM-DD."),
  nextRun: z.string().optional().describe("Next run (accountNextInvoice), YYYY-MM-DD."),
  runTime: z
    .string()
    .optional()
    .describe(
      "Time of day (HH:MM, Berlin) stored with the next run, when it is not 00:00: a template " +
        "made in the web app runs at the time it was saved at.",
    ),
  endDate: z.string().optional().describe("No run after this date (accountEndDate), YYYY-MM-DD."),
  lastRun: z
    .string()
    .optional()
    .describe("When sevDesk last created an invoice from it (accountLastInvoice), YYYY-MM-DD."),
  ended: z
    .literal(true)
    .optional()
    .describe(
      "Set when the template is ended (status 50): sevDesk creates no invoice from it, even " +
        "with automatic generation on, and nextRun is only the date it kept, not a coming run.",
    ),
  autoGenerate: z
    .enum(AUTO_GENERATE_STATES)
    .optional()
    .describe(
      "Automatische Generierung: on, sevDesk creates a draft invoice on every run date; off, it " +
        "creates nothing by itself; unrecorded, a stored value whose meaning is not recorded " +
        "(see autoGenerateValue). Missing when it was not read.",
    ),
  autoGenerateValue: z
    .string()
    .optional()
    .describe("The stored value when autoGenerate is unrecorded, e.g. 0."),
  autoSendConfigured: z
    .boolean()
    .optional()
    .describe(
      "Whether automatic sending (Automatisches Versenden) is on: sevDesk then finalizes, " +
        "e-mails and enshrines every invoice it creates. This server never sets it. Missing when " +
        "it was not read.",
    ),
  autoSendType: z
    .string()
    .optional()
    .describe("How automatic sending sends, when it is on: its sendType (VM is e-mail)."),
});

export type StoredSchedule = z.output<typeof storedScheduleSchema>;

/** The one field of an automatic sending configuration that is read (D-132). */
const autoSendConfigurationSchema = z.object({ sendType: zText });

/**
 * The schedule of one raw `Invoice` record: a template as `GET /Invoice/{id}` returns it, or a row
 * of `GET /Invoice?invoiceType=WKR`. The interval is untrusted text, cleaned, and read as one of
 * the four intervals in any spelling or else described; dates (with or without a time of day)
 * become Berlin calendar days. Automatic generation and sending are read only when the record
 * carries them (read with {@link TEMPLATE_SETTINGS_EMBED}); of the sending configuration only its
 * `sendType` is kept, never its ids or texts. A record that does not fit is an
 * `unexpected_response` error.
 */
export function readStoredSchedule(raw: unknown): StoredSchedule {
  const record = parseUpstream(storedRecordSchema, raw, "a recurring invoice template");
  const interval = cleanText(record.accountIntervall, 50);
  return compact({
    interval,
    intervalKey: interval === undefined ? undefined : intervalOf(interval),
    every: interval === undefined ? undefined : describeInterval(interval),
    startDate: record.accountStartDate,
    nextRun: record.accountNextInvoice,
    runTime: storedRunTime(raw),
    endDate: record.accountEndDate,
    lastRun: record.accountLastInvoice,
    ended: record.status === ENDED_STATUS ? true : undefined,
    ...readAutoGenerate(record.propertyAutoGenerateRecurringInvoice),
    ...readAutoSend(record.autoSendConfiguration),
  });
}

const BERLIN_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * The Berlin time of day of a stored next run that carries one other than 00:00 (an ISO
 * date-time, as a template made in the web app stores it, D-111); `undefined` for midnight, a
 * bare date or anything that is not a date-time.
 */
function storedRunTime(raw: unknown): string | undefined {
  const value =
    typeof raw === "object" && raw !== null && "accountNextInvoice" in raw
      ? raw.accountNextInvoice
      : undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return undefined;
  const time = BERLIN_TIME.format(moment);
  return time === "00:00" ? undefined : time;
}

function readAutoSend(value: unknown): {
  autoSendConfigured?: boolean;
  autoSendType?: string | undefined;
} {
  // JSON has no undefined: a missing key was not read; null is "off".
  if (value === undefined) return {};
  if (value === null) return { autoSendConfigured: false };
  const parsed = autoSendConfigurationSchema.safeParse(value);
  return {
    autoSendConfigured: true,
    autoSendType: parsed.success ? cleanText(parsed.data.sendType, 10) : undefined,
  };
}

function readAutoGenerate(value: unknown): {
  autoGenerate?: AutoGenerateState;
  autoGenerateValue?: string | undefined;
} {
  if (value === undefined) return {};
  if (value === null || value === "") return { autoGenerate: "off" };
  if (value === "1" || value === 1) return { autoGenerate: "on" };
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? cleanText(String(value), 20)
      : undefined;
  return { autoGenerate: "unrecorded", autoGenerateValue: text };
}

/**
 * Whether the stored schedule shows the first run already made (D-111). With generation on and the
 * first run today, sevDesk creates the first draft 30–40 s after the save, and a slow read-back can
 * come later than that. sevDesk then sets the next run one interval on and the last run to the
 * moment of generation, on or after the start date: the schedule as asked, one run later.
 */
function firstRunMade(asked: Schedule, stored: StoredSchedule): boolean {
  return (
    stored.lastRun !== undefined &&
    stored.lastRun >= asked.startDate &&
    stored.nextRun === addMonths(asked.startDate, INTERVALS[asked.interval].months)
  );
}

/**
 * Trusted notes on every way the stored schedule differs from the one sent (empty when it is as
 * asked, a first run sevDesk already made included). Stored dates were parsed into `YYYY-MM-DD`;
 * the stored interval is upstream text and is not repeated here (the output carries it).
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
  if (stored.nextRun !== asked.startDate && !firstRunMade(asked, stored)) {
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

/**
 * Trusted notes on automatic generation and automatic sending as stored, against what was sent:
 * generation on or off (`askedOn`), sending never configured. A stored value is named only when it
 * is the recorded "0"; any other unexpected value is pointed to, not repeated.
 */
export function settingsDifferences(askedOn: boolean, stored: StoredSchedule): string[] {
  const notes: string[] = [];
  const check = "Check the template in the sevDesk web app before its first run.";
  const sent = askedOn ? "It was sent as on (1)." : "It was left off.";
  switch (stored.autoGenerate) {
    case undefined:
      notes.push(
        "sevDesk did not return automatic generation (Automatische Generierung), so it could " +
          `not be checked. ${check}`,
      );
      break;
    case "on":
      if (!askedOn) {
        notes.push(
          "sevDesk stored automatic generation (Automatische Generierung) as on although it was " +
            "left off: it creates a draft invoice from the template on every run date. Switch it " +
            "off in the sevDesk web app if that is not wanted.",
        );
      }
      break;
    case "off":
      if (askedOn) {
        notes.push(
          "sevDesk stored automatic generation (Automatische Generierung) as off, not on as " +
            "sent, so it creates nothing from the template by itself. Switch it on for the " +
            "template in the sevDesk web app.",
        );
      }
      break;
    case "unrecorded":
      notes.push(
        stored.autoGenerateValue === "0"
          ? "sevDesk stored automatic generation (Automatische Generierung) as 0, a value whose " +
              `meaning is not recorded. ${sent} ${check}`
          : "sevDesk stored an unexpected value for automatic generation (Automatische " +
              `Generierung, see schedule.autoGenerateValue). ${sent} ${check}`,
      );
      break;
  }
  if (stored.autoSendConfigured === undefined) {
    notes.push(
      "sevDesk did not return automatic sending (Automatisches Versenden), so it could not be " +
        `checked. ${check}`,
    );
  } else if (stored.autoSendConfigured) {
    notes.push(
      "sevDesk has automatic sending (Automatisches Versenden) on for the template, which this " +
        "server never sets: sevDesk then finalizes every invoice it creates from it, e-mails it " +
        "to the customer and enshrines it within about two minutes of the run, before anyone has " +
        "seen it. Switch automatic sending off in the sevDesk web app unless that is wanted.",
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
