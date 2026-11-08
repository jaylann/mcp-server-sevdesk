/**
 * M4 probes for tax reports and exports: the keys of `GET /SevClient` (taxation regime, DATEV
 * export configuration, client id), `GET /AccountDatev` paging and filters for a cache, voucher
 * positions and their booking account, the CSV exports (`download=true`), and the DATEV CSV
 * export job with its progress and download info.
 *
 * Values from `/SevClient` never reach a finding except booleans, `0`/`1` flags and short codes
 * under code-like keys. The export job is a POST (`write` tier; the spec's GET answers 500) and
 * never carries an enshrine flag; the presigned download link is reduced to its host. Setting a fake DATEV export
 * configuration is opt-in and refused unless the account looks like a fresh trial.
 */
import { readCappedBody } from "../../../src/sevdesk/client.js";
import {
  DEFAULT_MAX_EXISTING_RECORDS,
  maxExistingRecords,
  RUN_TAG_PREFIX,
  trialCheck,
} from "../live-env.js";
import {
  addDays,
  berlinMidnight,
  germanDate,
  type HttpResult,
  type ProbeContext,
  type ProbeDefinition,
  refId,
  type Row,
  str,
} from "./core.js";
import { changedFields, firstRow, inconclusive, outcomeOf, shapeOf } from "./m4-shared-probes.js";

// ---------------------------------------------------------------------------------------------
// /SevClient
// ---------------------------------------------------------------------------------------------

/** Keys whose short code values may be shown (e.g. `chartOfAccounts: skr04`). */
const CODE_KEY =
  /type|mode|scope|chart|status|kind|method|system|region|version|regime|taxation|settlement|ist|soll/i;
const CODE_VALUE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
/** Keys that may hold the taxation regime or the DATEV export configuration. */
const CANDIDATE_KEY =
  /tax|vat|ist|soll|settlement|accounting|datev|export|fiscal|year|consultant|berater|mandant|client|chart|revenue|profit/i;

/** A value as the finding may show it: booleans, flags and short codes, else only its shape. */
export function describeValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number")
    return Number.isInteger(value) && Math.abs(value) < 1000 ? String(value) : "number";
  if (typeof value === "string") {
    if (value === "") return '""';
    if (value === "0" || value === "1") return JSON.stringify(value);
    if (/^\d+$/.test(value)) return `digits(${value.length})`;
    if (CODE_KEY.test(key) && CODE_VALUE.test(value)) return JSON.stringify(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date-time";
    return `string(${value.length})`;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return `{${Object.keys(value).join(",")}}`;
  }
  return Array.isArray(value) ? `list(${value.length})` : typeof value;
}

async function sevClient(ctx: ProbeContext): Promise<{ row: Row | undefined; result: HttpResult }> {
  const result = await ctx.http.get("/SevClient");
  return { row: result.ok ? firstRow(result.objects) : undefined, result };
}

// ---------------------------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------------------------

/** What a CSV body looks like: encoding, separator, header columns and row count (no data). */
export function describeCsv(bytes: Uint8Array): string {
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const utf16Bom =
    (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (utf16Bom) return "UTF-16 (byte-order mark)";
  const body = utf8Bom ? bytes.subarray(3) : bytes;
  const nonAscii = body.filter((byte) => byte >= 0x80).length;
  let text: string;
  let encoding: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    encoding =
      nonAscii === 0
        ? `ASCII only${utf8Bom ? " with a UTF-8 byte-order mark" : " (encoding cannot be told)"}`
        : `UTF-8${utf8Bom ? " with a byte-order mark" : " without a byte-order mark"} (${nonAscii} non-ASCII bytes)`;
  } catch {
    text = new TextDecoder("windows-1252").decode(body);
    encoding = `not UTF-8: Windows-1252/ISO-8859-1 (${nonAscii} non-ASCII bytes)`;
  }
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? "";
  const lineBreak = text.includes("\r\n") ? "CRLF" : "LF";
  const counts = [";", ",", "\t"].map((separator) => ({
    separator,
    count: header.split(separator).length - 1,
  }));
  const best = counts.reduce((a, b) => (b.count > a.count ? b : a));
  const separator = best.count === 0 ? undefined : best.separator;
  const columns =
    separator === undefined
      ? [header]
      : header.split(separator).map((column) => column.trim().replace(/^"(.*)"$/, "$1"));
  const quoted = /^"/.test(header) ? "quoted" : "unquoted";
  const rows = lines.slice(1).filter((line) => line.trim() !== "").length;
  return (
    `${encoding}; separator ${separator === undefined ? "none found" : JSON.stringify(separator)}, ${quoted} header, ${lineBreak} line breaks; ` +
    `${columns.length} columns: ${columns.join(" | ")}; ${rows} data lines`
  );
}

const CSV_EXPORTS = [
  { path: "/Export/invoiceCsv", model: "Invoice" },
  { path: "/Export/voucherListCsv", model: "Voucher" },
  { path: "/Export/transactionsCsv", model: "CheckAccountTransaction" },
  { path: "/Export/contactListCsv", model: "Contact" },
] as const;

function sevQuery(model: string, limit = 10) {
  return {
    "sevQuery[limit]": limit,
    "sevQuery[modelName]": model,
    "sevQuery[objectName]": "SevQuery",
  };
}

/** The separator of a CSV header line: the most frequent of `;`, `,` and tab. */
function separatorOf(header: string): string {
  const counts = [";", ",", "\t"].map((separator) => ({
    separator,
    count: header.split(separator).length - 1,
  }));
  return counts.reduce((a, b) => (b.count > a.count ? b : a)).separator;
}

/**
 * The records of a CSV text, quote-aware: separators, quotes (`""`) and line breaks inside a
 * quoted field stay in the field. Blank lines are dropped.
 */
function csvRecords(text: string, separator: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === separator) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((row) => !(row.length === 1 && row[0] === ""));
}

// ---------------------------------------------------------------------------------------------
// DATEV export job
// ---------------------------------------------------------------------------------------------

/** Polling of the export progress; tests shorten the delay. */
export const EXPORT_POLL = { delayMs: 2_000, attempts: 30 };

/** Largest export ZIP the probe downloads. */
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

/** `2026-11-15T10:00:00+01:00` → `9999-99-99T99:99:99+99:99`: the format, never the value. */
export function valueFormat(value: unknown): string {
  if (typeof value === "number") {
    return value > 1e12 ? "Unix milliseconds (number)" : "Unix seconds (number)";
  }
  if (typeof value !== "string") return JSON.stringify(value ?? null);
  if (/^\d{9,10}$/.test(value)) return "Unix seconds (string)";
  return value.replace(/\d/g, "9");
}

/** A string answer, or the first string member of an object answer (job ids, hashes). */
function stringAnswer(objects: unknown, keys: readonly string[]): string | undefined {
  if (typeof objects === "string" && objects !== "") return objects;
  const row = firstRow(objects);
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** File names in a ZIP's central directory (no decompression). */
export function zipEntries(bytes: Uint8Array): { name: string; size: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end === -1) return [];
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: { name: string; size: number }[] = [];
  for (let index = 0; index < count && offset + 46 <= bytes.length; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, size });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** A file name with long digit runs (consultant and client numbers) masked. */
export function maskDigits(name: string): string {
  return name.replace(/\d{5,}/g, (run) => "#".repeat(run.length));
}

/** Downloads the presigned export link without credentials; never reports the link itself. */
async function downloadExport(link: string, scrub: (text: string) => string): Promise<string> {
  try {
    const response = await fetch(link, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return `download answered HTTP ${response.status}`;
    }
    const bytes = await readCappedBody(
      response,
      MAX_EXPORT_BYTES,
      (received) => new Error(`larger than ${MAX_EXPORT_BYTES} bytes (${received})`),
    );
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const entries = zip ? zipEntries(bytes) : [];
    return (
      `download without credentials: HTTP ${response.status}, Content-Type ${response.headers.get("content-type") ?? "none"}, ` +
      `${bytes.length} bytes, ${zip ? `a ZIP with ${entries.length} entries: ${entries.map((entry) => `${scrub(maskDigits(entry.name))} (${entry.size} bytes)`).join(", ") || "none"}` : "not a ZIP"}`
    );
  } catch (error) {
    // Never the message: it could carry the presigned URL.
    return `download failed (${error instanceof Error ? error.name : "error"})`;
  }
}

/** Invoices and contacts not created by this tooling (like `foreignRecordCounts`). */
async function foreignCounts(ctx: ProbeContext): Promise<{ invoices: number; contacts: number }> {
  const count = async (path: string, query: Record<string, number>, field: string) => {
    const page = await ctx.read.page(path, query, 1000);
    const foreign = page.rows.filter((row) => !str(row, field).startsWith(RUN_TAG_PREFIX)).length;
    return foreign + Math.max(0, (page.total ?? page.rows.length) - page.rows.length);
  };
  return {
    invoices: await count("/Invoice", {}, "header"),
    contacts: await count("/Contact", { depth: 1 }, "name"),
  };
}

/** The host of a link (never the path or the query), `none` or `not a URL`. */
function hostOf(link: string): string {
  if (link === "") return "none";
  try {
    return new URL(link).host;
  } catch {
    return "not a URL";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const M4_REPORT_PROBES: readonly ProbeDefinition[] = [
  {
    id: "read-sevclient-keys",
    title: "Keys of GET /SevClient: taxation regime, DATEV export config, client id",
    mode: "read",
    question:
      "Which keys does GET /SevClient answer, which of them could hold the Ist/Soll taxation (cash vs accrual) and the DATEV export configuration (accountant number, client number, fiscal year start), and where is the client id? (Values only for booleans, 0/1 flags and short codes.)",
    deviations: ["D-067", "D-024", "NEW"],
    async run(ctx) {
      const { row, result } = await sevClient(ctx);
      if (row === undefined) {
        return {
          verdict: "observed",
          finding: `GET /SevClient: ${outcomeOf(result)}, ${shapeOf(result.objects)}.`,
        };
      }
      const keys = Object.keys(row);
      const candidates = keys.filter((key) => CANDIDATE_KEY.test(key));
      return {
        verdict: "observed",
        finding:
          `${Array.isArray(result.objects) ? `A list of ${result.objects.length}` : "One object"} with ${keys.length} keys. ` +
          `Candidates for the regime and the DATEV config: ${candidates.map((key) => `${key}=${describeValue(key, row[key])}`).join(", ") || "none"}. ` +
          `Client id: ${Object.hasOwn(row, "id") ? `key id (${describeValue("id", row["id"])})` : "no id key"}. ` +
          `All keys: ${keys.map((key) => `${key}=${describeValue(key, row[key])}`).join(", ")}.`,
        deviations: { "D-067": "informs", "D-024": "informs" },
      };
    },
  },
  {
    id: "read-account-datev-paging",
    title: "GET /AccountDatev: totals, paging and filters for a cache",
    mode: "read",
    question:
      "How many AccountDatev rows does the account have (countAll), do limit/offset page, and which filters does GET /AccountDatev honor (deactivated, hidden, deprecated, expenseAccount, revenueAccount, assetAccount, number)?",
    deviations: ["D-024", "D-035", "NEW"],
    async run(ctx) {
      const first = await ctx.read.page("/AccountDatev", undefined, 1000);
      if (!first.result.ok)
        return { verdict: "observed", finding: `Refused: ${outcomeOf(first.result)}.` };
      const rows = [...first.rows];
      for (
        let offset = 1000;
        first.total !== undefined && offset < Math.min(first.total, 5000);
        offset += 1000
      ) {
        const next = await ctx.http.get("/AccountDatev", { limit: 1000, offset, countAll: true });
        if (!next.ok || !Array.isArray(next.objects) || next.objects.length === 0) break;
        rows.push(...(next.objects as Row[]));
      }
      const ids = new Set(rows.map((row) => str(row, "id")));
      const small = await ctx.http.get("/AccountDatev", { limit: 5, offset: 0 });
      const shifted = await ctx.http.get("/AccountDatev", { limit: 5, offset: 5 });
      const idsOf = (result: HttpResult) =>
        Array.isArray(result.objects) ? (result.objects as Row[]).map((row) => str(row, "id")) : [];
      const pagingWorks =
        idsOf(small).length === 5 && idsOf(shifted).every((id) => !idsOf(small).includes(id));
      const totalRaw = (first.result.json as { total?: unknown } | undefined)?.total;
      const filterNotes: string[] = [];
      const probeNumber = str(
        rows.find((row) => str(row, "number") !== ""),
        "number",
      );
      const filters: { key: string; value: string | number; local: (row: Row) => boolean }[] = [
        ...[
          "deactivated",
          "hidden",
          "deprecated",
          "expenseAccount",
          "revenueAccount",
          "assetAccount",
        ].map((key) => ({ key, value: 1, local: (row: Row) => str(row, key) === "1" })),
        {
          key: "number",
          value: probeNumber,
          local: (row: Row) => str(row, "number") === probeNumber,
        },
      ];
      for (const filter of filters) {
        const total = await ctx.read.total("/AccountDatev", { [filter.key]: filter.value });
        const expected = rows.filter(filter.local).length;
        filterNotes.push(
          `${filter.key}=${String(filter.value)}: total ${String(total)} (local count ${expected}: ${total === expected && expected !== rows.length ? "honored" : total === rows.length || total === first.total ? "ignored" : "differs"})`,
        );
      }
      const flags = ["deactivated", "hidden", "deprecated"].map(
        (key) => `${key}=1 on ${rows.filter((row) => str(row, key) === "1").length}`,
      );
      return {
        verdict: "observed",
        finding:
          `countAll total ${JSON.stringify(totalRaw ?? null)} (${typeof totalRaw}); read ${rows.length} rows (${ids.size} distinct ids) in pages of 1000; ` +
          `limit=5 offset=0/5: ${pagingWorks ? "different rows (paging works)" : "overlapping or short pages"}. Flags: ${flags.join(", ")}. ` +
          `Filters: ${filterNotes.join("; ")}.`,
        deviations: { "D-035": "informs" },
      };
    },
  },
  {
    id: "read-voucher-pos-account-datev",
    title: "GET /VoucherPos of a voucher: accountDatev and embed",
    mode: "read",
    question:
      "Do the positions from GET /VoucherPos?voucher[id]=…&voucher[objectName]=Voucher carry accountDatev (Update 2.0) or accountingType (D-045), and does embed=accountDatev expand the account (number, name)?",
    deviations: ["D-045", "NEW"],
    async run(ctx) {
      const vouchers = await ctx.read.page("/Voucher", undefined, 100);
      const voucher =
        vouchers.rows.find((row) => str(row, "description").startsWith(RUN_TAG_PREFIX)) ??
        vouchers.rows[0];
      if (voucher === undefined) return inconclusive("No voucher in the account.");
      const id = Number(voucher["id"]);
      const query = { "voucher[id]": id, "voucher[objectName]": "Voucher" };
      const plain = (await ctx.read.page("/VoucherPos", query, 100)).rows.filter(
        (row) => refId(row, "voucher") === id,
      );
      const embedded = (
        await ctx.read.page("/VoucherPos", { ...query, embed: "accountDatev" }, 100)
      ).rows;
      const position = plain[0];
      if (position === undefined) return inconclusive(`Voucher ${id} has no positions.`);
      const account = embedded[0]?.["accountDatev"];
      const expanded =
        account !== null && typeof account === "object" && Object.keys(account).length > 2;
      return {
        verdict: Object.hasOwn(position, "accountDatev") ? "observed" : "contradicted",
        finding:
          `Voucher ${id} (${plain.length} positions): accountDatev ${Object.hasOwn(position, "accountDatev") ? JSON.stringify(position["accountDatev"]) : "absent"}, ` +
          `accountingType ${Object.hasOwn(position, "accountingType") ? JSON.stringify(position["accountingType"]) : "absent"}, ` +
          `estimatedAccountingType ${JSON.stringify(position["estimatedAccountingType"] ?? null)}; position keys ${Object.keys(position).join(", ")}. ` +
          `embed=accountDatev: ${expanded ? `expanded (keys ${Object.keys(account).join(", ")}; number ${str(account as Row, "number")})` : "not expanded"}.`,
        deviations: { "D-045": "informs" },
      };
    },
  },
  {
    id: "read-export-csv",
    title: "CSV exports with download=true: type, encoding, separator, header",
    mode: "read",
    question:
      "What do GET /Export/invoiceCsv, voucherListCsv, transactionsCsv and contactListCsv answer with download=true and a minimal sevQuery (sevQuery[limit], [modelName], [objectName]=SevQuery): Content-Type, encoding (UTF-8 or Windows-1252, BOM), separator and header columns (no data rows); and what does invoiceCsv answer without download?",
    deviations: ["D-012", "NEW"],
    async run(ctx) {
      const lines: string[] = [];
      let raw = 0;
      for (const item of CSV_EXPORTS) {
        const result = await ctx.http.get(item.path, { download: "true", ...sevQuery(item.model) });
        if (!result.ok || result.bytes === undefined) {
          lines.push(`${item.path}: ${outcomeOf(result)}`);
          continue;
        }
        if (result.json !== undefined) {
          lines.push(`${item.path}: JSON despite download=true (${shapeOf(result.objects)})`);
          continue;
        }
        raw += 1;
        lines.push(
          `${item.path}: Content-Type ${result.contentType ?? "none"}, ${result.bytes.length} bytes, ${ctx.scrubber.scrubText(describeCsv(result.bytes))}`,
        );
      }
      const json = await ctx.http.get("/Export/invoiceCsv", sevQuery("Invoice"));
      const row = firstRow(json.objects);
      lines.push(
        `/Export/invoiceCsv without download: ${json.ok ? `${shapeOf(json.objects)}; mimetype ${str(row, "mimetype") || str(row, "mimeType") || "none"}, base64Encoded ${str(row, "base64Encoded") || str(row, "base64encoded") || "none"}` : outcomeOf(json)}`,
      );
      return {
        verdict: raw === CSV_EXPORTS.length ? "confirmed" : raw === 0 ? "contradicted" : "observed",
        finding: `${lines.join(". ")}.`,
      };
    },
  },
  {
    id: "read-export-csv-date-filter",
    title: "Date filters on the invoice CSV export",
    mode: "read",
    question:
      "Does GET /Export/invoiceCsv (download=true) filter by sevQuery[filter][startDate]/[endDate] for a one-day window, and in which form: Unix seconds, ISO date-time or dd.mm.yyyy? (Counts of data rows against the unfiltered export and the invoices of that day, plus the format of the date column's first value; no data.)",
    deviations: ["D-012", "D-046", "NEW"],
    async run(ctx) {
      const invoices = await ctx.read.page("/Invoice", undefined, 1000);
      const perDay = new Map<string, number>();
      for (const row of invoices.rows) {
        const day = str(row, "invoiceDate").slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      if (perDay.size === 0) return inconclusive("No invoices with an invoice date.");
      // The day with the fewest invoices (the earliest on a tie): a window that excludes most.
      const [day, expected] = [...perDay.entries()].sort(
        ([a, x], [b, y]) => x - y || (a < b ? -1 : 1),
      )[0] ?? ["", 0];
      const next = addDays(day, 1);
      const csv = async (filter?: readonly [string | number, string | number]) => {
        const result = await ctx.http.get("/Export/invoiceCsv", {
          download: "true",
          ...sevQuery("Invoice", 1000),
          ...(filter === undefined
            ? {}
            : { "sevQuery[filter][startDate]": filter[0], "sevQuery[filter][endDate]": filter[1] }),
        });
        if (!result.ok || result.bytes === undefined || result.json !== undefined) {
          return { note: result.ok ? `not a CSV (${shapeOf(result.objects)})` : outcomeOf(result) };
        }
        const text = new TextDecoder().decode(result.bytes);
        const records = csvRecords(text, separatorOf(text.split(/\r?\n/, 1)[0] ?? ""));
        const header = records[0] ?? [];
        const column = header.findIndex((name) => /datum|date/i.test(name));
        return {
          rows: Math.max(0, records.length - 1),
          column: column === -1 ? undefined : header[column],
          first: column === -1 ? undefined : records[1]?.[column],
        };
      };
      const all = await csv();
      if (all.rows === undefined)
        return { verdict: "observed", finding: `Unfiltered export: ${all.note}.` };
      const start = berlinMidnight(day);
      const end = berlinMidnight(next) - 1;
      const variants = [
        { label: "Unix seconds", filter: [start, end] as const },
        {
          label: "ISO date-time",
          filter: [
            new Date(start * 1000).toISOString(),
            new Date(end * 1000).toISOString(),
          ] as const,
        },
        { label: "dd.mm.yyyy", filter: [germanDate(day), germanDate(day)] as const },
      ];
      const notes: string[] = [];
      let filtering = 0;
      for (const variant of variants) {
        const answer = await csv(variant.filter);
        if (answer.rows === undefined) {
          notes.push(`${variant.label}: ${answer.note}`);
          continue;
        }
        const filters = answer.rows < all.rows;
        if (filters) filtering += 1;
        notes.push(
          `${variant.label}: ${answer.rows} rows (${filters ? (answer.rows === expected ? "filters, matches the day" : "filters, but not to the day's count") : "no filtering"}` +
            `${answer.first === undefined ? "" : `; first date ${valueFormat(answer.first)}`})`,
        );
      }
      return {
        verdict: "observed",
        finding:
          `Window ${day} (${expected} of ${invoices.rows.length} invoices in GET /Invoice by invoiceDate, all statuses). ` +
          `Without filter: ${all.rows} data rows; date column ${all.column === undefined ? "none found" : JSON.stringify(ctx.scrubber.scrubText(all.column))}, ` +
          `first value format ${valueFormat(all.first)}. ${notes.join("; ")}. ${filtering} of 3 forms filter.`,
        deviations: { "D-046": "informs" },
      };
    },
  },
  {
    id: "write-export-datev-config",
    title: "Setting a fake DATEV export configuration (trial only)",
    mode: "write",
    optIn: true,
    question:
      "Does PUT /SevClient/{id}/updateExportConfig {accountantNumber 1001, accountantClientNumber 1, accountingYearBegin = 1 January of this year} answer, and which /SevClient keys change? Runs only with --only, and only on an account that looks like a fresh trial.",
    deviations: ["NEW", "D-067"],
    async run(ctx) {
      const counts = await foreignCounts(ctx);
      const refusal = trialCheck(counts, maxExistingRecordsSafe());
      if (refusal !== undefined) return inconclusive(`Not run: ${refusal}`);
      const before = await sevClient(ctx);
      const id = Number(before.row?.["id"]);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return inconclusive(`GET /SevClient gave no client id (${outcomeOf(before.result)}).`);
      }
      const year = ctx.today.slice(0, 4);
      const yearBegin = berlinMidnight(`${year}-01-01`);
      const sent = {
        accountantNumber: 1001,
        accountantClientNumber: 1,
        accountingYearBegin: yearBegin,
      };
      const result = await ctx.http.write("PUT", `/SevClient/${id}/updateExportConfig`, {
        tier: "write",
        body: sent,
      });
      const after = await sevClient(ctx);
      const changed = Object.keys({ ...before.row, ...after.row })
        .filter((key) => key !== "update")
        .filter(
          (key) =>
            JSON.stringify(before.row?.[key] ?? null) !== JSON.stringify(after.row?.[key] ?? null),
        )
        .map((key) => {
          const value = after.row?.[key];
          const ours = Object.values(sent).some((item) => String(item) === String(value));
          return `${key} (${ours ? `now ${JSON.stringify(value)}, a value we sent` : describeValue(key, value)})`;
        });
      return {
        verdict: "observed",
        finding:
          `updateExportConfig ${outcomeOf(result)}, answer ${shapeOf(result.objects)}; /SevClient keys changed: ${changed.join(", ") || "none"}. ` +
          "The fake configuration stays on the trial account (change it in the web app if needed).",
      };
    },
  },
  {
    id: "write-export-datev-csv",
    title: "DATEV CSV export job: job id, progress, download info, side effects",
    mode: "write",
    question:
      'Does POST /Export/createDatevCsvZipExportJob?startDate&endDate (Unix seconds, last 31 days)&scope=EXTCD (never enshrineDocuments; the GET the spec declares answers 500 "wrong HTTP Type"; on a 4xx the same parameters go once more as a JSON body) answer a job id, do /Progress/generateDownloadHash and /Progress/getProgress report it done, what does /ExportJob/jobDownloadInfo answer (link host, expiry format, file name pattern), does the presigned link download a ZIP without credentials, and does an exported invoice or voucher read differently afterwards? Without a DATEV configuration: which error?',
    deviations: ["D-012", "D-023", "NEW"],
    async run(ctx) {
      const invoice = await ctx.read.first(
        "/Invoice",
        undefined,
        (row) => str(row, "status") !== "100",
      );
      const voucher = await ctx.read.first(
        "/Voucher",
        undefined,
        (row) => str(row, "status") !== "50",
      );
      const invoiceBefore =
        invoice === undefined ? undefined : await ctx.read.byId("Invoice", Number(invoice["id"]));
      const voucherBefore =
        voucher === undefined ? undefined : await ctx.read.byId("Voucher", Number(voucher["id"]));

      const startDate = berlinMidnight(addDays(ctx.today, -30));
      const endDate = berlinMidnight(addDays(ctx.today, 1)) - 1;
      // A GET answers 500 "called with wrong HTTP Type" (recorded 2026-11-08): the job is a POST.
      // Never with enshrineDocuments.
      const range = { startDate, endDate, scope: "EXTCD" };
      const path = "/Export/createDatevCsvZipExportJob";
      let job = await ctx.http.write("POST", path, { tier: "write", query: range });
      let sentAs = "query parameters";
      const attempts: string[] = [];
      if (!job.ok && job.status !== undefined && job.status >= 400 && job.status < 500) {
        // A 4xx started no job, so the same parameters go once more as a JSON body.
        attempts.push(`POST with query parameters ${outcomeOf(job)}`);
        job = await ctx.http.write("POST", path, { tier: "write", body: range });
        sentAs = "a JSON body";
      }
      const jobId = job.ok ? stringAnswer(job.objects, ["id", "jobId"]) : undefined;
      if (jobId === undefined) {
        return {
          verdict: "observed",
          finding:
            `${attempts.map((attempt) => `${attempt}; `).join("")}POST with ${sentAs} ` +
            `${job.ok ? `answered no job id (${shapeOf(job.objects)})` : outcomeOf(job)}.`,
          deviations: { "D-023": "informs" },
        };
      }
      const lines = [
        `${attempts.map((attempt) => `${attempt}; `).join("")}POST with ${sentAs}: job id ${valueFormat(jobId)} (answer ${shapeOf(job.objects)})`,
      ];

      const hashAnswer = await ctx.http.get("/Progress/generateDownloadHash", { jobId });
      const hash = hashAnswer.ok
        ? stringAnswer(hashAnswer.objects, ["hash", "progressHash"])
        : undefined;
      lines.push(
        `generateDownloadHash: ${hashAnswer.ok ? `${shapeOf(hashAnswer.objects)}${hash === undefined ? "" : `, hash ${hash.length} characters`}` : outcomeOf(hashAnswer)}`,
      );
      let progressNote = "not polled (no hash)";
      if (hash !== undefined) {
        let polls = 0;
        let last: Row | undefined;
        for (; polls < EXPORT_POLL.attempts; polls += 1) {
          const progress = await ctx.http.get("/Progress/getProgress", { hash });
          last = progress.ok ? firstRow(progress.objects) : undefined;
          const current = Number(last?.["current"]);
          const total = Number(last?.["total"]);
          if (!progress.ok || (Number.isFinite(total) && total > 0 && current >= total)) break;
          await sleep(EXPORT_POLL.delayMs);
        }
        progressNote = `getProgress after ${polls + 1} polls: ${last === undefined ? "no answer" : `current ${str(last, "current")}, total ${str(last, "total")}, keys ${Object.keys(last).join(", ")}`}`;
      }
      lines.push(progressNote);

      const info = await ctx.http.get("/ExportJob/jobDownloadInfo", { jobId });
      const infoRow = info.ok ? firstRow(info.objects) : undefined;
      const link = str(infoRow, "link");
      const host = hostOf(link);
      const expiry = infoRow?.["linkExpireDate"];
      const expiryMs =
        typeof expiry === "number"
          ? expiry * 1000
          : typeof expiry === "string"
            ? Date.parse(expiry)
            : Number.NaN;
      const days = Number.isFinite(expiryMs)
        ? `, about ${Math.round((expiryMs / 1000 - ctx.nowSeconds) / 86_400)} days after the run's start`
        : "";
      lines.push(
        `jobDownloadInfo: ${info.ok ? `${shapeOf(info.objects)}; link host ${host}; linkExpireDate format ${valueFormat(expiry)}${days}; filename "${ctx.scrubber.scrubText(maskDigits(str(infoRow, "filename")))}"` : outcomeOf(info)}`,
      );
      if (link !== "" && host !== "not a URL") {
        lines.push(await downloadExport(link, (text) => ctx.scrubber.scrubText(text)));
      }

      const invoiceAfter =
        invoice === undefined ? undefined : await ctx.read.byId("Invoice", Number(invoice["id"]));
      const voucherAfter =
        voucher === undefined ? undefined : await ctx.read.byId("Voucher", Number(voucher["id"]));
      lines.push(
        `Invoice ${invoice === undefined ? "(none finalized)" : str(invoice, "id")} afterwards: ${invoice === undefined ? "–" : changedFields(invoiceBefore, invoiceAfter) || "unchanged"}; ` +
          `voucher ${voucher === undefined ? "(none open)" : str(voucher, "id")}: ${voucher === undefined ? "–" : changedFields(voucherBefore, voucherAfter) || "unchanged"}`,
      );
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-023": "informs" },
      };
    },
  },
];

/** The record limit for the trial check; the default when the variable is invalid. */
function maxExistingRecordsSafe(): number {
  try {
    return maxExistingRecords(process.env);
  } catch {
    return DEFAULT_MAX_EXISTING_RECORDS;
  }
}
