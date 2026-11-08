/**
 * sevDesk's CSV exports (`GET /Export/invoiceCsv`, `creditNoteCsv`, `voucherListCsv`,
 * `transactionsCsv`, `contactListCsv`) as files, for spreadsheets or a tax adviser.
 *
 * Request: `download=true` makes sevDesk answer the raw file instead of JSON (D-012), and the
 * required `sevQuery` object goes out flattened into bracket keys (`sevQuery[objectName]=SevQuery`,
 * `sevQuery[modelName]=Invoice`, `sevQuery[limit]=…`, `sevQuery[filter][startDate]=…`). The spec
 * types the date filters as date-times, but they take Unix seconds (D-018): measured live on
 * `/Export/invoiceCsv` on 2026-11-08, Unix seconds filter exactly to the day (7 of 88 rows: that
 * day's invoices), while an ISO date-time and `dd.mm.yyyy` both return no rows. The other exports
 * take the same `sevQuery` form; the date column of every file is checked after the download as
 * a cheap safety net ({@link checkCsvPeriod}).
 *
 * Answer (live probe 2026-11-08): `text/csv; charset=UTF-8`, UTF-8 with a byte order mark, `;` as
 * separator, a quoted German header row, LF line ends; 15 columns for invoices, 14 for vouchers,
 * 6 for transactions, 38 for contacts. The bytes are kept exactly as sent. Should sevDesk answer
 * JSON anyway (`{filename, mimetype, base64Encoded, content}`, the spec's form without
 * `download`), the base64 content is decoded instead.
 *
 * The file content is sevDesk data (names, purposes): it is written to disk only, never returned
 * to the model.
 */
import { toSevdeskDate, toUnixSeconds } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import type { QueryValue, SevdeskClient } from "../../sevdesk/types.js";

export const CSV_EXPORT_KINDS = [
  "invoices",
  "credit_notes",
  "vouchers",
  "transactions",
  "contacts",
] as const;
export type CsvExportKind = (typeof CSV_EXPORT_KINDS)[number];

interface CsvExportSpec {
  readonly path: string;
  /** `sevQuery[modelName]`. */
  readonly modelName: string;
  /** Whether the export takes a date range. */
  readonly dated: boolean;
  /** Trusted noun for messages. */
  readonly noun: string;
}

/** Spec tag `Export`, one entry per CSV endpoint. */
export const CSV_EXPORTS: Readonly<Record<CsvExportKind, CsvExportSpec>> = {
  invoices: { path: "/Export/invoiceCsv", modelName: "Invoice", dated: true, noun: "invoices" },
  credit_notes: {
    path: "/Export/creditNoteCsv",
    modelName: "CreditNote",
    dated: true,
    noun: "credit notes",
  },
  vouchers: { path: "/Export/voucherListCsv", modelName: "Voucher", dated: true, noun: "vouchers" },
  transactions: {
    path: "/Export/transactionsCsv",
    modelName: "CheckAccountTransaction",
    dated: true,
    noun: "transactions",
  },
  contacts: {
    path: "/Export/contactListCsv",
    modelName: "Contact",
    dated: false,
    noun: "contacts",
  },
};

/** Most rows one export asks for (`sevQuery[limit]`; sevDesk's page maximum, D-019). */
export const MAX_CSV_ROWS = 1_000;
/** Largest CSV accepted: 20 MiB. */
export const MAX_CSV_BYTES = 20 * 1024 * 1024;

export interface CsvExportParams {
  readonly kind: CsvExportKind;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit: number;
}

/** The flattened query of an export (see the module doc). */
export function csvExportQuery(params: CsvExportParams): Record<string, QueryValue> {
  const spec = CSV_EXPORTS[params.kind];
  const query: Record<string, QueryValue> = {
    download: "true",
    "sevQuery[objectName]": "SevQuery",
    "sevQuery[modelName]": spec.modelName,
    "sevQuery[limit]": params.limit,
  };
  if (params.from !== undefined) {
    query["sevQuery[filter][startDate]"] = csvFilterDate(params.from, "start");
  }
  if (params.to !== undefined) query["sevQuery[filter][endDate]"] = csvFilterDate(params.to, "end");
  return query;
}

/** Ways to write a `sevQuery[filter]` date (`unix` seconds, ISO `YYYY-MM-DD`, `dd.mm.yyyy`). */
export type CsvFilterDateFormat = "unix" | "iso" | "german";

/**
 * How the export's date filter is sent: Unix seconds, verified for `/Export/invoiceCsv` on
 * 2026-11-08 (ISO and `dd.mm.yyyy` returned no rows). Kept in one place; every export with a
 * range still checks the file's date column afterwards ({@link checkCsvPeriod}).
 */
export const CSV_FILTER_DATE_FORMAT: CsvFilterDateFormat = "unix";

/** A filter date in `format` (default {@link CSV_FILTER_DATE_FORMAT}). */
export function csvFilterDate(
  date: string,
  edge: "start" | "end",
  format: CsvFilterDateFormat = CSV_FILTER_DATE_FORMAT,
): string | number {
  switch (format) {
    case "unix":
      return toUnixSeconds(date, edge);
    case "iso":
      return date;
    case "german":
      return toSevdeskDate(date);
  }
}

export interface CsvExport {
  readonly bytes: Uint8Array;
  /** As sevDesk sent it, e.g. `text/csv; charset=UTF-8`. */
  readonly contentType: string | undefined;
  /** Whether the file starts with a UTF-8 byte order mark. */
  readonly bom: boolean;
  /** Data rows (records after the header), counted outside quoted fields. */
  readonly rows: number;
  /** With a date range: the file's dates checked against it (see {@link checkCsvPeriod}). */
  readonly periodCheck?: CsvPeriodCheck | undefined;
}

/** What the date column of an exported file says about the requested range. */
export interface CsvPeriodCheck {
  /** The column checked (one of {@link CSV_DATE_COLUMNS}); absent when none was found. */
  readonly column?: string | undefined;
  /** Rows whose date lies outside the range. */
  readonly rowsOutsidePeriod: number;
  /** Rows that could not be checked (no date column, or no readable date in it). */
  readonly rowsUnchecked: number;
  /** True only when every row was checked and lies inside the range. */
  readonly verified: boolean;
}

/**
 * The date column per export (German headers as the live probe saw them), first match wins,
 * compared trimmed and case-insensitively. Credit notes were not probed: the candidates are a
 * guess, and without a match the rows count as unchecked.
 */
export const CSV_DATE_COLUMNS: Readonly<Record<CsvExportKind, readonly string[]>> = {
  invoices: ["Rechnungs-Datum", "Rechnungsdatum"],
  credit_notes: ["Gutschrifts-Datum", "Gutschriftsdatum", "Datum"],
  vouchers: ["Datum", "Belegdatum"],
  transactions: ["Bezahldatum", "Buchungsdatum", "Datum"],
  contacts: [],
};

/**
 * Runs one CSV export and returns the file. Throws a local `validation` error for a date range on
 * contacts or a limit outside 1–{@link MAX_CSV_ROWS}, and `unexpected_response` when the answer is
 * neither CSV nor the JSON form with base64 content.
 */
export async function exportCsv(
  client: SevdeskClient,
  params: CsvExportParams,
  signal?: AbortSignal,
): Promise<CsvExport> {
  const spec = CSV_EXPORTS[params.kind];
  if (!spec.dated && (params.from !== undefined || params.to !== undefined)) {
    throw invalid(`the ${spec.noun} export takes no date range; leave out from and to.`);
  }
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_CSV_ROWS) {
    throw invalid(`limit must be a whole number from 1 to ${String(MAX_CSV_ROWS)}.`);
  }
  if (params.from !== undefined && params.to !== undefined && params.from > params.to) {
    throw invalid("from is after to.");
  }
  const answer = await client.download({
    method: "GET",
    path: spec.path,
    query: csvExportQuery(params),
    maxBytes: MAX_CSV_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });
  const file = isJson(answer.body, answer.contentType)
    ? decodeJsonExport(answer.body)
    : { bytes: answer.body, contentType: answer.contentType };
  const ranged = params.from !== undefined || params.to !== undefined;
  return {
    bytes: file.bytes,
    contentType: file.contentType,
    bom: hasBom(file.bytes),
    rows: countCsvRows(file.bytes),
    ...(ranged ? { periodCheck: checkCsvPeriod(file.bytes, params) } : {}),
  };
}

/**
 * Checks the rows of an exported file against the requested range by its date column
 * ({@link CSV_DATE_COLUMNS}; dates as `dd.mm.yyyy` or `YYYY-MM-DD`, a time after them is
 * ignored). Never returns sevDesk text: the column is reported by our own name for it.
 */
export function checkCsvPeriod(
  bytes: Uint8Array,
  params: Pick<CsvExportParams, "kind" | "from" | "to">,
): CsvPeriodCheck {
  const records = parseCsv(new TextDecoder().decode(hasBom(bytes) ? bytes.subarray(3) : bytes));
  const [header = [], ...rows] = records;
  const names = header.map((name) => name.trim().toLowerCase());
  const column = CSV_DATE_COLUMNS[params.kind].find((candidate) =>
    names.includes(candidate.toLowerCase()),
  );
  if (column === undefined) {
    return { rowsOutsidePeriod: 0, rowsUnchecked: rows.length, verified: false };
  }
  const index = names.indexOf(column.toLowerCase());
  let outside = 0;
  let unchecked = 0;
  for (const row of rows) {
    const date = csvDate(row[index]);
    if (date === undefined) unchecked += 1;
    else if (
      (params.from !== undefined && date < params.from) ||
      (params.to !== undefined && date > params.to)
    ) {
      outside += 1;
    }
  }
  return {
    column,
    rowsOutsidePeriod: outside,
    rowsUnchecked: unchecked,
    verified: outside === 0 && unchecked === 0,
  };
}

/** `YYYY-MM-DD` of a cell holding `dd.mm.yyyy` or `YYYY-MM-DD` (optionally with a time). */
function csvDate(cell: string | undefined): string | undefined {
  const text = cell?.trim() ?? "";
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s|$)/.exec(text);
  if (german !== null) {
    const [, day = "", month = "", year = ""] = german;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/.exec(text);
  return iso?.[1];
}

/**
 * Splits CSV text into records of fields: `;` separates fields, `"` quotes them (`""` inside is
 * a quote), LF or CRLF ends a record outside quotes; empty lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"' && text.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ";") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      if (record.length > 1 || record[0] !== "") records.push(record);
      record = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** File name of a saved export: `<kind>[_<from>][_<to>].csv` (ASCII, from our own values). */
export function csvFilename(params: CsvExportParams): string {
  const parts = [params.kind, params.from, params.to].filter(
    (part): part is string => part !== undefined,
  );
  return `${parts.join("_")}.csv`;
}

function invalid(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message: `Invalid request: ${message}` });
}

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function isJson(bytes: Uint8Array, contentType: string | undefined): boolean {
  if (contentType?.toLowerCase().includes("json") === true) return true;
  const start = hasBom(bytes) ? 3 : 0;
  return bytes[start] === 0x7b; // "{"
}

/** The spec's JSON form: `{objects: {filename, mimetype, base64Encoded, content}}`. */
function decodeJsonExport(body: Uint8Array): {
  bytes: Uint8Array;
  contentType: string | undefined;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw unexpectedFile();
  }
  const objects =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["objects"]
      : undefined;
  const file = Array.isArray(objects) ? (objects as unknown[])[0] : objects;
  if (typeof file !== "object" || file === null) throw unexpectedFile();
  const record = file as Record<string, unknown>;
  const content = record["content"];
  const mimetype = typeof record["mimetype"] === "string" ? record["mimetype"] : undefined;
  if (typeof content !== "string") throw unexpectedFile();
  const encoded = record["base64Encoded"];
  const base64 = encoded === true || encoded === "1" || encoded === 1 || encoded === "true";
  if (base64 && !/^[A-Za-z0-9+/=\s]*$/.test(content)) throw unexpectedFile();
  const bytes = base64
    ? new Uint8Array(Buffer.from(content, "base64"))
    : new TextEncoder().encode(content);
  return { bytes, contentType: mimetype };
}

function unexpectedFile(): SevdeskError {
  return new SevdeskError({
    kind: "unexpected_response",
    message: "sevDesk returned the export in an unexpected format (neither CSV nor JSON).",
  });
}

/**
 * Data rows of a CSV: records ended by LF (CRLF counts once) outside double-quoted fields, minus
 * the header; a last record without a line end counts too. An empty file has 0 rows.
 */
export function countCsvRows(bytes: Uint8Array): number {
  let records = 0;
  let quoted = false;
  let pending = false;
  for (const byte of bytes) {
    if (byte === 0x22) quoted = !quoted;
    if (byte === 0x0a && !quoted) {
      records += 1;
      pending = false;
    } else if (byte !== 0x0d) {
      pending = true;
    }
  }
  if (pending) records += 1;
  return Math.max(0, records - 1);
}
