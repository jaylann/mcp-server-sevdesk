/**
 * Date conversions between the server's canonical `YYYY-MM-DD` calendar dates and sevDesk's wire
 * formats: documents take `dd.mm.yyyy`, filters and exports take Unix seconds, responses carry ISO
 * date-times with an offset. sevDesk is a German product, so calendar dates are anchored to
 * Europe/Berlin (DST-aware via `Intl`), never to the host's time zone.
 */
import { SevdeskError } from "./errors.js";

/** The time zone all calendar dates are interpreted in. */
const SEVDESK_TIME_ZONE = "Europe/Berlin";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GERMAN_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const ISO_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const UNIX_SECONDS = /^\d{1,12}$/;

const berlinFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: SEVDESK_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Whether `value` is a real calendar date written as `YYYY-MM-DD` (years 1000–9999). */
export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== undefined;
}

/**
 * `"2026-11-07"` → `"07.11.2026"`, the format sevDesk documents expect (invoiceDate,
 * deliveryDate, voucherDate, …). Throws a `validation` error for anything but a real date.
 */
export function toSevdeskDate(date: string): string {
  const { year, month, day } = requireIsoDate(date);
  return `${pad(day)}.${pad(month)}.${String(year)}`;
}

/**
 * Unix seconds of the start (`"start"`, default) or the last second (`"end"`) of a calendar day
 * in Europe/Berlin, for sevDesk's date filters (`startDate`/`endDate`) and exports. DST-correct:
 * a day is 23 or 25 hours long on transition days.
 */
export function toUnixSeconds(date: string, edge: "start" | "end" = "start"): number {
  const calendar = requireIsoDate(date);
  if (edge === "start") return berlinMidnightUtcMs(calendar) / 1000;
  const next = new Date(Date.UTC(calendar.year, calendar.month - 1, calendar.day + 1));
  const nextDay: CalendarDate = {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
  return berlinMidnightUtcMs(nextDay) / 1000 - 1;
}

/**
 * The Europe/Berlin calendar date (`YYYY-MM-DD`) of a sevDesk date value. Accepts ISO date-times
 * with offset (`"2024-04-08T00:00:00+02:00"`) or without (read as Berlin wall time), plain ISO
 * dates, Unix seconds (as number or digit string) and `dd.mm.yyyy`. `null`, `undefined` and `""`
 * give `undefined`; anything else is an `unexpected_response` error.
 */
export function toBerlinDate(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return berlinDateOf(value * 1000);
    throw unrecognizedDate();
  }
  if (typeof value !== "string") throw unrecognizedDate();

  const text = value.trim();
  if (UNIX_SECONDS.test(text)) return berlinDateOf(Number(text) * 1000);

  const german = GERMAN_DATE.exec(text);
  if (german !== null) {
    const iso = `${german[3] ?? ""}-${german[2] ?? ""}-${german[1] ?? ""}`;
    if (isIsoDate(iso)) return iso;
    throw unrecognizedDate();
  }

  if (isIsoDate(text)) return text;

  const dateTime = ISO_DATE_TIME.exec(text);
  if (dateTime !== null) {
    const [, datePart = "", hours = "", minutes = "", seconds = "00", offset] = dateTime;
    if (!isIsoDate(datePart) || Number(hours) > 23 || Number(minutes) > 59) {
      throw unrecognizedDate();
    }
    if (Number(seconds) > 59) throw unrecognizedDate();
    if (offset === undefined) return datePart;
    const normalizedOffset = /^z$/i.test(offset)
      ? "Z"
      : offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    const ms = Date.parse(`${datePart}T${hours}:${minutes}:${seconds}${normalizedOffset}`);
    if (Number.isNaN(ms)) throw unrecognizedDate();
    return berlinDateOf(ms);
  }

  throw unrecognizedDate();
}

/** The Europe/Berlin calendar date (`YYYY-MM-DD`) of an instant given in epoch milliseconds. */
export function berlinDateOf(epochMs: number): string {
  const parts = berlinWallTime(epochMs);
  return `${String(parts.year)}-${pad(parts.month)}-${pad(parts.day)}`;
}

function parseIsoDate(value: string): CalendarDate | undefined {
  const match = ISO_DATE.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  return { year, month, day };
}

function requireIsoDate(value: string): CalendarDate {
  const parsed = parseIsoDate(value);
  if (parsed !== undefined) return parsed;
  throw new SevdeskError({
    kind: "validation",
    message: "Invalid request: a date must be a real calendar date written as YYYY-MM-DD.",
  });
}

function unrecognizedDate(): SevdeskError {
  return new SevdeskError({
    kind: "unexpected_response",
    message:
      "sevDesk returned a date in an unexpected format: expected an ISO date-time, " +
      "a Unix timestamp or dd.mm.yyyy.",
  });
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** UTC epoch milliseconds of 00:00 Berlin time on `date`. Midnight never falls into a DST gap. */
function berlinMidnightUtcMs(date: CalendarDate): number {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day);
  const firstGuess = wallAsUtc - berlinOffsetMs(wallAsUtc);
  // The offset at the first guess can differ from the one at `wallAsUtc` near a transition.
  return wallAsUtc - berlinOffsetMs(firstGuess);
}

/** Berlin's UTC offset in milliseconds at the given instant (+1 h in winter, +2 h in summer). */
function berlinOffsetMs(epochMs: number): number {
  const wholeSecond = Math.floor(epochMs / 1000) * 1000;
  const wall = berlinWallTime(wholeSecond);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return wallAsUtc - wholeSecond;
}

interface WallTime extends CalendarDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function berlinWallTime(epochMs: number): WallTime {
  const values: Record<string, number> = {};
  for (const part of berlinFormat.formatToParts(epochMs)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values["year"] ?? Number.NaN,
    month: values["month"] ?? Number.NaN,
    day: values["day"] ?? Number.NaN,
    hour: values["hour"] ?? Number.NaN,
    minute: values["minute"] ?? Number.NaN,
    second: values["second"] ?? Number.NaN,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
