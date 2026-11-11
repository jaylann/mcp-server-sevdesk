/**
 * "What changed since T" (sevDesk has no webhooks): records of the chosen collections whose last
 * update is at or after `since`, as compact rows (id, type, number/name, status, update time).
 *
 * Filters. The spec documents `updateAfter={timestamp}` ("updated last after timestamp") in the
 * filter tables of the Contact, Invoice, Order and Voucher tags; it is sent there as Unix seconds,
 * one second before `since` so that "after" includes `since` itself. CreditNote and
 * CheckAccountTransaction document no such filter, so their rows are read and checked here.
 * sevDesk ignores filters it does not understand (measured by the sevdesk-rs project), so every
 * row is checked here in any case; when a page shows that sevDesk did not apply the filter, the
 * scan switches to full pages. A scan reads at most {@link CHANGE_SCAN_MAX_ROWS} rows per subject
 * and call; `nextOffset` (sevDesk rows) continues it. Invoices are read with `showAll=true`,
 * because sevDesk's default list hides reminders (D-049).
 *
 * Counts. `total` is exact and given only when one call checked every row. While more rows
 * follow, sevDesk's count for the widened filter is given as `totalAtMost`, an upper bound.
 *
 * Deleted records cannot be seen: sevDesk's lists only return records that still exist.
 */
import { z } from "zod";

import { isIsoDate, toUnixSeconds } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { parseUpstream, zBerlinDate, zId, zOptionalInt, zText } from "../../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../../sevdesk/types.js";
import { cleanText, compact } from "../common.js";
import { parseContactRecord, toContactDto } from "../contacts.js";
import { contactLink, creditNoteLink, invoiceLink, orderLink, voucherLink } from "../links.js";
import { statusByCode, type StatusObjectType } from "../reference-data.js";
import { voucherKindFromCreditDebit } from "../vouchers.js";
import {
  invalidReportRequest,
  REPORT_PAGE_SIZE,
  REPORT_SOURCE,
  type ReportRunOptions,
  throwIfAborted,
} from "./shared.js";

export const CHANGE_SUBJECTS = [
  "contacts",
  "invoices",
  "credit_notes",
  "orders",
  "vouchers",
  "transactions",
] as const;
type ChangeSubject = (typeof CHANGE_SUBJECTS)[number];

/** Rows one call reads per subject at most. */
export const CHANGE_SCAN_MAX_ROWS = 5_000;

const NAME_MAX = 300;
const NUMBER_MAX = 200;

// ---------------------------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------------------------

const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const UNIX_SECONDS = /^\d{1,12}$/;

/**
 * Epoch milliseconds of a sevDesk timestamp: ISO date-time with offset (as recorded, e.g.
 * `2026-02-19T14:14:21+01:00`), without offset (read as Berlin wall time), or Unix seconds.
 * `null`/""/missing give `undefined`; anything else is an `unexpected_response` error.
 */
export function instantOf(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value === "string") {
    const text = value.trim();
    if (UNIX_SECONDS.test(text)) return Number(text) * 1000;
    const ms = parseDateTime(text);
    if (ms !== undefined) return ms;
  }
  throw new SevdeskError({
    kind: "unexpected_response",
    message: "sevDesk returned an update time in an unexpected format.",
  });
}

function parseDateTime(text: string): number | undefined {
  const match = DATE_TIME.exec(text);
  if (match === null) return undefined;
  const [, date = "", hours = "", minutes = "", seconds = "00", offset] = match;
  if (!isIsoDate(date) || Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    return undefined;
  }
  if (offset === undefined) {
    const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
    return berlinWallTimeToEpoch(
      Date.UTC(year, month - 1, day, Number(hours), Number(minutes), Number(seconds)),
    );
  }
  const normalized = /^z$/i.test(offset) ? "Z" : offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(`${date}T${hours}:${minutes}:${seconds}${normalized}`);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The `since` input as epoch milliseconds: `YYYY-MM-DD` is the start of that day in Berlin; a
 * date-time takes its offset, or Berlin time without one. Throws a local `validation` error.
 */
export function parseSince(since: string): number {
  const text = since.trim();
  if (isIsoDate(text)) return toUnixSeconds(text, "start") * 1000;
  const ms = parseDateTime(text);
  if (ms === undefined) {
    throw invalidReportRequest(
      "since must be a date (YYYY-MM-DD) or an ISO 8601 date-time such as " +
        "2026-11-01T08:00:00+01:00.",
    );
  }
  return ms;
}

const berlinParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Berlin wall-clock fields of an instant, and that wall time read as if it were UTC. */
function berlinWall(ms: number): {
  readonly field: (name: string) => string;
  readonly wallUtc: number;
} {
  const parts: Record<string, string> = {};
  for (const part of berlinParts.formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const field = (name: string): string => parts[name] ?? "00";
  const wallUtc = Date.UTC(
    Number(field("year")),
    Number(field("month")) - 1,
    Number(field("day")),
    Number(field("hour")),
    Number(field("minute")),
    Number(field("second")),
  );
  return { field, wallUtc };
}

/** Berlin's UTC offset in milliseconds at an instant (+1 h in winter, +2 h in summer). */
function berlinOffsetMs(ms: number): number {
  const wholeMs = Math.floor(ms / 1000) * 1000;
  return berlinWall(wholeMs).wallUtc - wholeMs;
}

/**
 * The instant of a Berlin wall-clock time, given as that wall time read as UTC milliseconds. The
 * offset is the one in force at that time of day, so on the days clocks change (last Sunday of
 * March and of October) times before and after the change get +01:00 and +02:00 correctly. A
 * time inside the spring gap resolves to the hour after it.
 */
function berlinWallTimeToEpoch(wallUtc: number): number {
  const firstGuess = wallUtc - berlinOffsetMs(wallUtc);
  return wallUtc - berlinOffsetMs(firstGuess);
}

/** An instant as ISO 8601 in Berlin time with its offset, e.g. `2026-11-07T09:30:00+01:00`. */
export function formatBerlinInstant(ms: number): string {
  const wholeMs = Math.floor(ms / 1000) * 1000;
  const { field, wallUtc } = berlinWall(wholeMs);
  const offsetMinutes = Math.round((wallUtc - wholeMs) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${field("year")}-${field("month")}-${field("day")}T${field("hour")}:${field("minute")}:` +
    `${field("second")}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

const changeRowSchema = z.object({
  id: z.number().int(),
  type: z
    .string()
    .optional()
    .describe("Document type (RE, SR, AN, AB, LI, …) or voucher kind (expense/revenue)."),
  number: z
    .string()
    .optional()
    .describe("Document number, voucher number (description) or customer number."),
  name: z.string().optional().describe("Contact name, supplier or counterparty."),
  status: z.object({ code: z.number().int(), label: z.string() }).optional(),
  date: z.string().optional().describe("Document date or value date, YYYY-MM-DD."),
  updatedAt: z
    .string()
    .describe("Last change in sevDesk (creation time if sevDesk has none), ISO 8601, Berlin."),
  link: z.string().optional().describe("Opens the record in the sevDesk web app."),
});

type ChangeRow = z.output<typeof changeRowSchema>;

const timestampsSchema = z.object({
  id: zId,
  create: z.unknown().optional(),
  update: z.unknown().optional(),
  status: zOptionalInt,
});

interface ParsedRow {
  readonly row: Omit<ChangeRow, "updatedAt">;
  readonly changedMs: number | undefined;
}

type RowDetails = Omit<ChangeRow, "updatedAt" | "id" | "status">;

interface SubjectSpec {
  readonly path: string;
  readonly query: Readonly<Record<string, QueryValue>>;
  /** True when the spec documents `updateAfter` for this collection. */
  readonly serverFilter: boolean;
  /** Trusted plural for messages. */
  readonly noun: string;
  readonly statusType: StatusObjectType;
  /** Trusted description of one record, for parse errors. */
  readonly what: string;
  /** Number, name, type, date and link of a raw row (parsed leniently, text sanitized). */
  readonly details: (raw: unknown, id: number, status: number | undefined) => RowDetails;
}

const invoiceFields = z.object({
  invoiceNumber: zText,
  invoiceType: zText,
  invoiceDate: zBerlinDate,
});
const creditNoteFields = z.object({ creditNoteNumber: zText, creditNoteDate: zBerlinDate });
const orderFields = z.object({ orderNumber: zText, orderType: zText, orderDate: zBerlinDate });
const voucherFields = z.object({
  description: zText,
  voucherDate: zBerlinDate,
  creditDebit: zText,
  supplierName: zText,
  supplierNameAtSave: zText,
});
const transactionFields = z.object({ payeePayerName: zText, valueDate: zBerlinDate });

/** A document type code such as RE or AN, upper case. */
function typeCode(value: string | undefined): string | undefined {
  return cleanText(value, 10)?.toUpperCase();
}

const SUBJECT_SPECS: Readonly<Record<ChangeSubject, SubjectSpec>> = {
  contacts: {
    path: "/Contact",
    // Without depth=1 sevDesk lists organisations only (spec, getContacts).
    query: { depth: "1" },
    serverFilter: true,
    noun: "contacts",
    statusType: "contact",
    what: "a contact",
    details: (raw, id) => {
      const contact = toContactDto(parseContactRecord(raw));
      return { number: contact.customerNumber, name: contact.displayName, link: contactLink(id) };
    },
  },
  invoices: {
    path: "/Invoice",
    // sevDesk's default invoice list leaves reminders (MA) out (D-049), so a reminder created or
    // changed since `since` was never reported and no paging could find it. `showAll=true`
    // returns invoices of all types; the row's `type` says which it is (review 2026-11, round 3).
    query: { showAll: "true" },
    serverFilter: true,
    noun: "invoices",
    statusType: "invoice",
    what: "an invoice",
    details: (raw, id, status) => {
      const fields = parseUpstream(invoiceFields, raw, "an invoice");
      const type = typeCode(fields.invoiceType);
      return {
        type,
        number: cleanText(fields.invoiceNumber, NUMBER_MAX),
        date: fields.invoiceDate,
        link:
          type === undefined || status === undefined ? undefined : invoiceLink(id, type, status),
      };
    },
  },
  credit_notes: {
    path: "/CreditNote",
    query: {},
    serverFilter: false,
    noun: "credit notes",
    statusType: "creditNote",
    what: "a credit note",
    details: (raw, id, status) => {
      const fields = parseUpstream(creditNoteFields, raw, "a credit note");
      return {
        number: cleanText(fields.creditNoteNumber, NUMBER_MAX),
        date: fields.creditNoteDate,
        link: status === undefined ? undefined : creditNoteLink(id, status),
      };
    },
  },
  orders: {
    path: "/Order",
    query: {},
    serverFilter: true,
    noun: "orders",
    statusType: "order",
    what: "an order",
    details: (raw, id, status) => {
      const fields = parseUpstream(orderFields, raw, "an order");
      const type = typeCode(fields.orderType);
      return {
        type,
        number: cleanText(fields.orderNumber, NUMBER_MAX),
        date: fields.orderDate,
        link: type === undefined || status === undefined ? undefined : orderLink(id, type, status),
      };
    },
  },
  vouchers: {
    path: "/Voucher",
    query: {},
    serverFilter: true,
    noun: "vouchers",
    statusType: "voucher",
    what: "a voucher",
    details: (raw, id) => {
      const fields = parseUpstream(voucherFields, raw, "a voucher");
      return {
        type: voucherKindFromCreditDebit(fields.creditDebit),
        number: cleanText(fields.description, NUMBER_MAX),
        name: cleanText(fields.supplierName ?? fields.supplierNameAtSave, NAME_MAX),
        date: fields.voucherDate,
        link: voucherLink(id),
      };
    },
  },
  transactions: {
    path: "/CheckAccountTransaction",
    query: {},
    serverFilter: false,
    noun: "transactions",
    statusType: "transaction",
    what: "a bank transaction",
    details: (raw) => {
      const fields = parseUpstream(transactionFields, raw, "a bank transaction");
      return {
        name: cleanText(fields.payeePayerName, NAME_MAX),
        date: fields.valueDate,
      };
    },
  },
};

function parseRow(spec: SubjectSpec, raw: unknown): ParsedRow {
  const base = parseUpstream(timestampsSchema, raw, spec.what);
  const status =
    base.status === undefined
      ? undefined
      : {
          code: base.status,
          label: statusByCode(spec.statusType, base.status)?.label ?? "unknown",
        };
  const details = spec.details(raw, base.id, base.status);
  const changedMs = instantOf(base.update) ?? instantOf(base.create);
  return { row: compact({ id: base.id, ...details, status }), changedMs };
}

// ---------------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------------

const subjectChangesSchema = z.object({
  subject: z.enum(CHANGE_SUBJECTS),
  filteredBy: z
    .enum(["sevdesk", "this_server"])
    .describe(
      "sevdesk: sevDesk's documented updateAfter filter was sent (and rows re-checked here); " +
        "this_server: no documented filter, rows were read and checked here.",
    ),
  items: z.array(changeRowSchema).describe("Changed records, newest first within this page."),
  total: z
    .number()
    .int()
    .optional()
    .describe(
      "All changed records of this subject: exact, given only when this call checked every row.",
    ),
  totalAtMost: z
    .number()
    .int()
    .optional()
    .describe(
      "Upper bound when the exact total is not known: sevDesk's count for its filter, which " +
        "starts one second before since and so may include records this report leaves out.",
    ),
  rowsScanned: z.number().int().describe("sevDesk rows examined for this page."),
  hasMore: z.boolean().describe("More rows may follow: page with offset = nextOffset."),
  nextOffset: z
    .number()
    .int()
    .optional()
    .describe("offset plus rowsScanned (sevDesk rows, not matches)."),
  scanCapped: z
    .boolean()
    .optional()
    .describe(`True when ${CHANGE_SCAN_MAX_ROWS} rows were examined without reaching the end.`),
  withoutTimestamp: z
    .number()
    .int()
    .optional()
    .describe("Rows without an update or creation time (cannot be judged; not included)."),
});

type SubjectChanges = z.output<typeof subjectChangesSchema>;

export const changesReportSchema = z.object({
  source: z.string().describe("How the numbers were made."),
  since: z.string().describe("The start instant used, ISO 8601 in Berlin time."),
  subjects: z.array(subjectChangesSchema),
  recordsScanned: z.number().int().describe("sevDesk rows examined across all subjects."),
  notes: z.array(z.string()),
});

export type ChangesReport = z.output<typeof changesReportSchema>;

export interface ChangesParams {
  readonly since: string;
  readonly subjects: readonly ChangeSubject[];
  /** Changed records to return per subject. */
  readonly limit: number;
  /** sevDesk row offset; only with exactly one subject. */
  readonly offset: number;
  /** Rows examined per subject; defaults to {@link CHANGE_SCAN_MAX_ROWS}. */
  readonly maxRowsPerSubject?: number | undefined;
}

/** Records changed at or after `since` for each subject, in the order given. */
export async function changedSince(
  client: SevdeskClient,
  params: ChangesParams,
  options: ReportRunOptions = {},
): Promise<ChangesReport> {
  const sinceMs = parseSince(params.since);
  const subjects = [...new Set(params.subjects)];
  if (subjects.length === 0) throw invalidReportRequest("name at least one subject.");
  if (params.offset > 0 && subjects.length !== 1) {
    throw invalidReportRequest(
      "offset pages one subject at a time: pass exactly one subject together with offset.",
    );
  }
  const results: SubjectChanges[] = [];
  let scanned = 0;
  for (const subject of subjects) {
    const result = await scanSubject(client, subject, sinceMs, params, {
      ...options,
      base: scanned,
    });
    scanned += result.rowsScanned;
    results.push(result);
  }

  const serverSide = subjects.filter((subject) => SUBJECT_SPECS[subject].serverFilter);
  const local = subjects.filter((subject) => !SUBJECT_SPECS[subject].serverFilter);
  const notes = [
    "A record counts as changed when its last update (or its creation, if sevDesk has no " +
      "update time) is at or after since. Deleted records do not appear: sevDesk only lists " +
      "records that still exist.",
  ];
  if (serverSide.length > 0) {
    notes.push(
      `sevDesk filtered ${serverSide.map(nounOf).join(", ")} with its documented updateAfter ` +
        "filter; every row was checked here again.",
    );
  }
  if (local.length > 0) {
    notes.push(
      `${capitalize(local.map(nounOf).join(" and "))} have no documented change filter in ` +
        `sevDesk: their rows were read and checked here, up to ` +
        `${params.maxRowsPerSubject ?? CHANGE_SCAN_MAX_ROWS} rows per call; continue with ` +
        "nextOffset while hasMore.",
    );
  }
  return {
    source: REPORT_SOURCE,
    since: formatBerlinInstant(sinceMs),
    subjects: results,
    recordsScanned: scanned,
    notes,
  };
}

/** Trusted one-line summary: counts per subject only. */
export function changesSentence(report: ChangesReport): string {
  const parts = report.subjects.map((result) => {
    const more = result.hasMore ? "+" : "";
    return `${result.items.length}${more} ${nounOf(result.subject)}`;
  });
  const anyMore = report.subjects.some((result) => result.hasMore);
  return (
    `Changed since ${report.since}: ${parts.join(", ")}; ${report.recordsScanned} sevDesk ` +
    `rows examined.${anyMore ? " '+' means more may follow: page with nextOffset." : ""}`
  );
}

function nounOf(subject: ChangeSubject): string {
  return SUBJECT_SPECS[subject].noun;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function scanSubject(
  client: SevdeskClient,
  subject: ChangeSubject,
  sinceMs: number,
  params: ChangesParams,
  options: ReportRunOptions & { readonly base: number },
): Promise<SubjectChanges> {
  const spec = SUBJECT_SPECS[subject];
  const maxRows = params.maxRowsPerSubject ?? CHANGE_SCAN_MAX_ROWS;
  const query: Record<string, QueryValue> = { ...spec.query };
  if (spec.serverFilter) query["updateAfter"] = Math.floor(sinceMs / 1000) - 1;

  const kept: { row: ParsedRow["row"]; changedMs: number }[] = [];
  let position = params.offset;
  let total: number | undefined;
  let ended = false;
  let capped = false;
  let allMatched = true;
  let withoutTimestamp = 0;
  // While sevDesk applies the filter, `limit` rows are enough; otherwise read full pages.
  let pageSize = spec.serverFilter ? params.limit : REPORT_PAGE_SIZE;
  for (;;) {
    throwIfAborted(options.signal);
    const scanned = position - params.offset;
    if (scanned >= maxRows) {
      capped = true;
      break;
    }
    const page = await client.list(spec.path, query, {
      limit: Math.min(pageSize, maxRows - scanned),
      offset: position,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    total = page.total ?? total;
    if (page.items.length === 0) {
      ended = true;
      break;
    }
    let filled = false;
    for (const raw of page.items) {
      position += 1;
      const parsed = parseRow(spec, raw);
      if (parsed.changedMs === undefined) {
        withoutTimestamp += 1;
        allMatched = false;
      } else if (parsed.changedMs >= sinceMs) {
        kept.push({ row: parsed.row, changedMs: parsed.changedMs });
      } else {
        allMatched = false;
      }
      if (kept.length >= params.limit) {
        filled = true;
        break;
      }
    }
    await options.onProgress?.(
      options.base + position - params.offset,
      undefined,
      `Examined ${position - params.offset} ${spec.noun}.`,
    );
    if (filled) break;
    if (total !== undefined && position >= total) {
      ended = true;
      break;
    }
    if (!allMatched) pageSize = REPORT_PAGE_SIZE;
  }

  const rowsScanned = position - params.offset;
  const hasMore = !ended && (total === undefined || position < total);
  // Exact only when this call checked every row from the start. sevDesk's own count is for the
  // filter sent, which starts one second before `since` (and sevDesk may ignore the filter), so
  // it can include records this report rejects on a later page: it was published as `total`
  // while every row seen so far matched (review 2026-11, round 3). It is an upper bound.
  const knownTotal = params.offset === 0 && !hasMore ? kept.length : undefined;
  const upperBound =
    knownTotal === undefined && spec.serverFilter && allMatched && total !== undefined
      ? total
      : undefined;
  kept.sort((a, b) => b.changedMs - a.changedMs);
  return {
    subject,
    filteredBy: spec.serverFilter ? "sevdesk" : "this_server",
    items: kept.map(({ row, changedMs }) => ({
      ...row,
      updatedAt: formatBerlinInstant(changedMs),
    })),
    ...(knownTotal === undefined ? {} : { total: knownTotal }),
    ...(upperBound === undefined ? {} : { totalAtMost: upperBound }),
    rowsScanned,
    hasMore,
    ...(hasMore ? { nextOffset: position } : {}),
    ...(capped && hasMore ? { scanCapped: true } : {}),
    ...(withoutTimestamp > 0 ? { withoutTimestamp } : {}),
  };
}
