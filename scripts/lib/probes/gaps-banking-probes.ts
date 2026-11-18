/**
 * Probes for the competitor-gap issues: hand-made bank and cash transactions, the account
 * factories and private-transaction rules (#88), the hash sevDesk keeps for a receipt file (#92),
 * the invoice and voucher ZIP archives and the DATEV XML job (#95), and sevDesk's own receipt
 * recognition `createVoucherFromFile` (#96). Three probes re-check facts first recorded by one-off
 * checks (#135): the factories' `accountingNumber` refusals (D-119), the answer of a hand-made
 * transaction (D-071, D-096) and how rules store their texts (D-099, D-130); they report
 * `confirmed` or `contradicted` and clean up in a `finally`, also when a step fails.
 *
 * Safety:
 * - Everything a probe creates carries the run tag (names, purposes, counterparties, voucher texts)
 *   and is registered for the cleanup list; the probes delete what they can (rules, accounts,
 *   transactions, draft vouchers) and say so in the list.
 * - Four probes are opt-in (`--only`) and run last because they cannot be undone: the cash-register
 *   probe (sevDesk keeps every row `bookAmount` books on the Kasse, and `resetToOpen` adds a
 *   counter-entry instead of deleting it, D-095, D-096), enshrining ONE transaction the probe
 *   created itself, the DATEV XML export job (it may mark documents as exported), and
 *   `createVoucherFromFile`. No other enshrine request is sent and nothing is e-mailed; the one
 *   invoice `write-export-invoice-zip` finalizes is enshrined by the trial account itself, which
 *   enshrines invoices when they are finalized (D-023, D-059).
 * - The ZIP exports are sent as side-effect GETs (`write` tier), since nobody has recorded whether
 *   they mark documents as sent the way `getPdf` without `preventSendBy` does. They first check
 *   with `limit` 1 and filters that should match nothing that sevDesk honours the filters, and
 *   stop when it does not.
 * - Exported files never reach the report: only entry names reduced to a pattern
 *   ({@link entryPattern}), sizes, counts, hosts and formats. The presigned link of the XML job is
 *   fetched only through {@link downloadPresignedExport} (https, sevDesk's recorded export host,
 *   no redirects, no credentials) and is never written anywhere.
 * - Hashes are compared, never printed.
 */
import { createHash } from "node:crypto";

import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { downloadPresignedExport } from "../../../src/sevdesk/export-download.js";
import {
  addDays,
  berlinMidnight,
  createdId,
  diffState,
  germanDate,
  type HttpResult,
  type ProbeContext,
  type ProbeDefinition,
  type ProbeOutcome,
  type Query,
  refId,
  type Row,
  sendState,
  str,
} from "./core.js";
import { EXPORT_POLL, hostOf, stringAnswer, valueFormat, zipEntries } from "./m4-reports-probes.js";
import {
  berlinNoon,
  bookVoucher,
  createVoucher,
  data,
  describeTransaction,
  firstRow,
  importAccount,
  inconclusive,
  isGone,
  isoNoon,
  keysOf,
  outcomeOf,
  type RecordedCheck,
  recordedOutcome,
  shapeOf,
  slug,
  tinyPdf,
  tokenPattern,
  transactionsOf,
  uploadTempFile,
  voucherFailure,
  voucherState,
  withCleanup,
} from "./m4-shared-probes.js";

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** Polling of sevDesk's receipt recognition; tests shorten the delay. */
export const RECOGNITION_POLL = { delayMs: 3_000, attempts: 20 };

/** Largest ZIP answer accepted from the export endpoints (base64 JSON or raw). */
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A tagged transaction with this purpose and counterparty suffix (both after the run tag). */
async function postTransaction(
  ctx: ProbeContext,
  accountId: number,
  options: {
    readonly amount: number;
    readonly purpose: string;
    readonly counterpart?: string;
  },
): Promise<{ readonly id: number | undefined; readonly result: HttpResult }> {
  const tag = data(ctx).tag;
  const result = await ctx.http.write("POST", "/CheckAccountTransaction", {
    // A new bank transaction needs commit (`minimumWriteTier`, D-096, D-098).
    tier: "commit",
    body: {
      objectName: "CheckAccountTransaction",
      mapAll: true,
      valueDate: isoNoon(ctx.today),
      entryDate: isoNoon(ctx.today),
      amount: options.amount,
      paymtPurpose: `${tag} ${options.purpose}`,
      payeePayerName: `${tag} ${options.counterpart ?? "Gegenpartei"}`,
      checkAccount: { id: accountId, objectName: "CheckAccount" },
      status: 100,
    },
  });
  const id = createdId(result.objects, "checkAccountTransaction");
  if (id !== undefined) {
    data(ctx).register("CheckAccountTransaction", id, "status 100 (deletable in the web app)");
  }
  return { id, result };
}

/** How {@link transactionStatus} marks a row whose `deletedAt` is set (a soft delete, D-096). */
const SOFT_DELETED = "soft-deleted (deletedAt set)";

/** `status …` of a transaction (plus {@link SOFT_DELETED}), `gone`, or the refusal. */
async function transactionStatus(ctx: ProbeContext, id: number): Promise<string> {
  const result = await ctx.http.get(`/CheckAccountTransaction/${id}`);
  if (isGone(result)) return "gone";
  if (!result.ok) return outcomeOf(result);
  const row = firstRow(result.objects);
  return `status ${str(row, "status")}${str(row, "deletedAt") === "" ? "" : `, ${SOFT_DELETED}`}`;
}

/** Whether a note of {@link transactionStatus} or {@link deleteTransaction} ends deleted. */
function endsDeleted(note: string): boolean {
  return note.endsWith("gone") || note.endsWith(SOFT_DELETED);
}

/** `DELETE /CheckAccountTransaction/{id}` (commit: it changes the account), then its state. */
async function deleteTransaction(ctx: ProbeContext, id: number): Promise<string> {
  const deleted = await ctx.http.write("DELETE", `/CheckAccountTransaction/${id}`, {
    tier: "commit",
  });
  const after = await transactionStatus(ctx, id);
  if (endsDeleted(after)) {
    data(ctx).mark("CheckAccountTransaction", id, "deleted by the probe (soft delete)");
  }
  return `DELETE ${outcomeOf(deleted)}${deleted.ok ? `, answer ${shapeOf(deleted.objects)}` : ""}; afterwards ${after}`;
}

/** `PUT /CheckAccountTransaction/{id}` with a status (commit). */
function setTransactionStatus(ctx: ProbeContext, id: number, status: 100 | 300) {
  return ctx.http.write("PUT", `/CheckAccountTransaction/${id}`, {
    tier: "commit",
    body: { status },
  });
}

/** The first active cash register (type `register`). */
async function cashRegister(ctx: ProbeContext): Promise<number | undefined> {
  const row = await ctx.read.first(
    "/CheckAccount",
    undefined,
    (item) => str(item, "status") !== "0" && str(item, "type") === "register",
  );
  const id = Number(row?.["id"]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Lists rows sevDesk booked on the cash register in the cleanup list. They stay in the cash book:
 * they are booked at status 400, only rows at 100 can be deleted (D-096), and a reset adds a
 * counter-entry instead of deleting the row (D-095).
 */
function registerCashRows(ctx: ProbeContext, rows: readonly Row[], how: string): void {
  for (const row of rows) {
    const id = Number(row["id"]);
    if (Number.isSafeInteger(id) && id > 0) {
      data(ctx).register("CheckAccountTransaction", id, `permanent cash-book entry (${how})`);
    }
  }
}

/** The balance sevDesk reports for today (`getBalanceAtDate`), or the refusal. */
async function balance(ctx: ProbeContext, accountId: number): Promise<string> {
  const result = await ctx.http.get(`/CheckAccount/${accountId}/getBalanceAtDate`, {
    date: ctx.today,
  });
  if (!result.ok) return outcomeOf(result);
  return typeof result.objects === "string" || typeof result.objects === "number"
    ? String(result.objects)
    : shapeOf(result.objects);
}

/**
 * The exact sum of decimal amount strings as sevDesk sends them (`"-11.9"`, `"500"`), in cents
 * with BigInt, rendered like `511.90`; `not summable` when one has more than two decimals or is
 * not a number.
 */
export function centsText(amounts: readonly string[]): string {
  let cents = 0n;
  for (const amount of amounts) {
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
    if (match === null) return "not summable";
    const value = BigInt(match[2] ?? "0") * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
    cents += match[1] === "-" ? -value : value;
  }
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${String(absolute / 100n)}.${String(absolute % 100n).padStart(2, "0")}`;
}

/** Creates a tagged contact of its own (not the run's shared one) and registers it. */
async function ownContact(ctx: ProbeContext, suffix: string): Promise<number | string> {
  const result = await ctx.http.write("POST", "/Contact", {
    tier: "write",
    body: {
      name: `${data(ctx).tag} ${suffix}`,
      category: { id: 3, objectName: "Category" },
      status: 1000,
    },
  });
  const id = createdId(result.objects);
  if (id === undefined) return `the contact was ${outcomeOf(result)}`;
  data(ctx).register("Contact", id, "active (can be deleted in the web app)");
  return id;
}

/** A tagged receipt PDF with fixed amounts (100.00 + 19 % = 119.00). */
function receiptPdf(ctx: ProbeContext, label: string): Promise<Uint8Array> {
  return tinyPdf([
    `${data(ctx).tag} ${label}`,
    "Test receipt of the sevDesk MCP API probe (trial account).",
    "Bürobedarf 100,00 EUR + 19 % USt 19,00 EUR = 119,00 EUR",
  ]);
}

/** An open (status 100) or draft tagged expense voucher with an uploaded receipt. */
async function voucherWithReceipt(
  ctx: ProbeContext,
  options: { readonly label: string; readonly status: 50 | 100; readonly gross: number },
): Promise<{ readonly id: number | undefined; readonly note: string }> {
  const upload = await uploadTempFile(
    ctx,
    await receiptPdf(ctx, options.label),
    `${slug(data(ctx).tag)}-${options.label.replace(/\W+/g, "-")}.pdf`,
    "application/pdf",
  );
  if (upload.token === undefined) {
    return { id: undefined, note: `upload ${outcomeOf(upload.result)}` };
  }
  const created = await createVoucher(ctx, {
    label: options.label,
    status: options.status,
    gross: options.gross,
    file: { token: upload.token, placement: "top-level" },
  });
  return created.id === undefined
    ? { id: undefined, note: voucherFailure(created) }
    : { id: created.id, note: `voucher ${created.id}` };
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

/** Fields of a check account that may tell its kind (bank connection, import, register). */
const ACCOUNT_KIND_FIELDS = [
  "type",
  "importType",
  "bankServer",
  "autoSyncTransactions",
  "lastSync",
  "autoMapTransactions",
  "baseAccount",
  "defaultAccount",
  "status",
] as const;

/** A field of a check account as a finding may show it: codes and flags, else only the shape. */
export function accountField(key: string, value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value !== "string") return Array.isArray(value) ? "list" : "object";
  if (value === "") return '""';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date-time";
  if (/^(?:iban|bic|name|balance)$/i.test(key)) return "set";
  return /^[A-Za-z0-9_.-]{1,24}$/.test(value) ? JSON.stringify(value) : `string(${value.length})`;
}

/** `type=…, importType=…, …` of the kind fields. */
function accountKind(row: Row): string {
  return ACCOUNT_KIND_FIELDS.map((key) => `${key}=${accountField(key, row[key])}`).join(", ");
}

// ---------------------------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------------------------

interface FileHashes {
  readonly "SHA-256": string;
  readonly MD5: string;
  readonly "SHA-1": string;
}

/** SHA-256, MD5 and SHA-1 of `bytes`, lower-case hex. */
export function hashesOf(bytes: Uint8Array): FileHashes {
  const hex = (algorithm: string) => createHash(algorithm).update(bytes).digest("hex");
  return { "SHA-256": hex("sha256"), MD5: hex("md5"), "SHA-1": hex("sha1") };
}

/**
 * Which of `hashes` a value sevDesk sent equals (case-insensitive), or its shape. Never the value
 * itself.
 */
export function hashMatch(value: unknown, hashes: FileHashes, of: string): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value !== "string") return `a ${typeof value}`;
  if (value === "") return '""';
  const lower = value.toLowerCase();
  const hit = Object.entries(hashes).find(([, hash]) => hash === lower);
  if (hit !== undefined) return `the ${hit[0]} of ${of}`;
  return `none of SHA-256/MD5/SHA-1 of ${of} (${/^[0-9a-f]+$/i.test(value) ? `${value.length} hex characters` : `${value.length} characters`})`;
}

/** Keys of a row whose name mentions a hash. */
function hashKeys(row: Row | undefined): string[] {
  return Object.keys(row ?? {}).filter((key) => /hash|checksum|md5|sha/i.test(key));
}

/** The bytes of a `{filename, mimetype, base64Encoded, content}` answer, when it has content. */
function envelopeBytes(objects: unknown): Uint8Array | undefined {
  const row = firstRow(objects);
  const content = row?.["content"];
  if (typeof content !== "string" || content === "") return undefined;
  return Uint8Array.from(Buffer.from(content, "base64"));
}

// ---------------------------------------------------------------------------------------------
// ZIP archives
// ---------------------------------------------------------------------------------------------

/** Words an export entry name may keep (generic labels, never names or numbers). */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "rechnung",
  "rechnungen",
  "gutschrift",
  "gutschriften",
  "storno",
  "mahnung",
  "beleg",
  "belege",
  "belegbild",
  "belegbilder",
  "document",
  "documents",
  "dokument",
  "dokumente",
  "invoice",
  "invoices",
  "voucher",
  "vouchers",
  "receipt",
  "receipts",
  "pdf",
  "xml",
  "zip",
  "csv",
  "png",
  "jpg",
  "jpeg",
  "extf",
  "buchungsstapel",
  "stamm",
  "bitte",
  "entpacken",
  "datev",
  "export",
  "hex",
  "bis",
  "ausgang",
  "eingang",
  "ausgangsrechnung",
  "eingangsrechnung",
  "index",
  "manifest",
]);

/**
 * An export entry name as the report may show it: the run tag as `<tag>`, hex runs as `<n hex>`,
 * every digit as `#`, and every word of three or more letters that is not a generic label as `<n>` (its
 * length). Customer names, document numbers and dates never survive.
 */
export function entryPattern(name: string, tag: string): string {
  const mask = (part: string) =>
    tokenPattern(part)
      // Every digit, except the length inside a `<n hex>` marker of tokenPattern.
      .replace(/(?<!<\d*)\d+(?!\d* hex>)/g, (run) => "#".repeat(run.length))
      .replace(/(?<![A-Za-zÄÖÜäöüß])[A-Za-zÄÖÜäöüß]+(?![A-Za-zÄÖÜäöüß])/g, (word) =>
        GENERIC_WORDS.has(word.toLowerCase()) || word.length < 3 ? word : `<${word.length}>`,
      );
  return name
    .split(tag)
    .map((part) => part.split(slug(tag)).map(mask).join("<tag>"))
    .join("<tag>")
    .slice(0, 120);
}

/** Entries, sizes and extensions of a ZIP, with names reduced to patterns. */
function describeZip(bytes: Uint8Array, tag: string): string {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return `not a ZIP (${bytes.length} bytes)`;
  const entries = zipEntries(bytes);
  const extensions = new Map<string, number>();
  for (const entry of entries) {
    const extension = /\.([A-Za-z0-9]{1,5})$/.exec(entry.name)?.[1]?.toLowerCase() ?? "(none)";
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
  }
  const shown = entries
    .slice(0, 20)
    .map((entry) => `${entryPattern(entry.name, tag)} (${entry.size} bytes)`);
  return (
    `a ZIP of ${bytes.length} bytes with ${entries.length} entries` +
    (extensions.size === 0
      ? ""
      : ` (${[...extensions].map(([extension, count]) => `${count} ${extension}`).join(", ")})`) +
    (shown.length === 0
      ? ""
      : `: ${shown.join(", ")}${entries.length > shown.length ? `, and ${entries.length - shown.length} more` : ""}`)
  );
}

/** One call of a ZIP export endpoint and what it answered (never the file). */
interface ZipAnswer {
  readonly note: string;
  /** Entries of the ZIP; `undefined` when there was no ZIP. */
  readonly entries: number | undefined;
}

/** A ZIP export GET (side effect, `write`), described without its content. */
async function zipExport(ctx: ProbeContext, path: string, query: Query): Promise<ZipAnswer> {
  const result = await ctx.http.get(path, query, { tier: "write", maxBytes: MAX_ZIP_BYTES });
  const tag = data(ctx).tag;
  if (!result.ok) return { note: outcomeOf(result), entries: undefined };
  if (result.json === undefined) {
    const bytes = result.bytes ?? new Uint8Array();
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    return {
      note: `raw body, Content-Type ${result.contentType ?? "none"}: ${describeZip(bytes, tag)}`,
      entries: zip ? zipEntries(bytes).length : undefined,
    };
  }
  const row = firstRow(result.objects);
  const content = row?.["content"];
  const bytes = envelopeBytes(result.objects);
  const zip = bytes !== undefined && bytes[0] === 0x50 && bytes[1] === 0x4b;
  return {
    note:
      `JSON ${shapeOf(result.objects)}; filename ${typeof row?.["filename"] === "string" ? `"${entryPattern(row["filename"], tag)}"` : JSON.stringify(row?.["filename"] ?? null)}, ` +
      `mimetype ${str(row, "mimetype") || str(row, "mimeType") || "none"}, base64Encoded ${str(row, "base64Encoded") || "none"}, ` +
      `content ${typeof content === "string" ? `${content.length} characters` : JSON.stringify(content ?? null)}` +
      (bytes === undefined ? "" : `, decoded: ${describeZip(bytes, tag)}`),
    entries: zip ? zipEntries(bytes).length : undefined,
  };
}

/**
 * `sevQuery[…]` parameters of a ZIP export. Filter keys name nested fields with `/`
 * (`contact/id` → `sevQuery[filter][contact][id]`).
 */
export function sevQuery(
  model: "Invoice" | "Voucher",
  limit: number,
  filter: Readonly<Record<string, string | number>>,
): Query {
  return {
    "sevQuery[limit]": limit,
    "sevQuery[modelName]": model,
    "sevQuery[objectName]": "SevQuery",
    ...Object.fromEntries(
      Object.entries(filter).map(([key, value]) => [
        `sevQuery[filter]${key
          .split("/")
          .map((part) => `[${part}]`)
          .join("")}`,
        value,
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Document state snapshots
// ---------------------------------------------------------------------------------------------

/** Keys whose values a change report may show (statuses, dates, send types). */
const SAFE_CHANGE_KEYS: ReadonlySet<string> = new Set([
  "status",
  "sendDate",
  "sendType",
  "enshrined",
  "update",
  "payDate",
  "paidAmount",
]);

/**
 * The keys whose values differ between two reads (`update` included): `a → b` for
 * {@link SAFE_CHANGE_KEYS}, `changed` for every other key (its values may be account data).
 */
function changedFieldsMap(before: Row | undefined, after: Row | undefined): Record<string, string> {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: Record<string, string> = {};
  for (const key of [...keys].sort()) {
    if (JSON.stringify(before?.[key] ?? null) === JSON.stringify(after?.[key] ?? null)) continue;
    changes[key] = SAFE_CHANGE_KEYS.has(key)
      ? `${str(before, key) || "(empty)"} → ${str(after, key) || "(empty)"}`
      : "changed";
  }
  return changes;
}

/** Rows of a document list (up to 1,000) by id. */
async function snapshot(
  ctx: ProbeContext,
  path: "/Invoice" | "/Voucher",
): Promise<Map<string, Row>> {
  const page = await ctx.read.page(path, undefined, 1000);
  return new Map(page.rows.map((row) => [str(row, "id"), row]));
}

/**
 * What changed between two snapshots: per changed row the keys, with values only for
 * {@link SAFE_CHANGE_KEYS}; rows that appeared or disappeared are counted.
 */
export function snapshotChanges(
  before: ReadonlyMap<string, Row>,
  after: ReadonlyMap<string, Row>,
): string {
  const changed: string[] = [];
  for (const [id, row] of before) {
    const later = after.get(id);
    if (later === undefined) continue;
    const keys = [...new Set([...Object.keys(row), ...Object.keys(later)])]
      .filter((key) => JSON.stringify(row[key] ?? null) !== JSON.stringify(later[key] ?? null))
      .sort();
    if (keys.length === 0) continue;
    changed.push(
      `${id}: ${keys
        .map((key) =>
          SAFE_CHANGE_KEYS.has(key)
            ? `${key} ${str(row, key) || "(empty)"} → ${str(later, key) || "(empty)"}`
            : key,
        )
        .join(", ")}`,
    );
  }
  const gone = [...before.keys()].filter((id) => !after.has(id)).length;
  const added = [...after.keys()].filter((id) => !before.has(id)).length;
  const parts = [
    changed.length === 0
      ? `none of ${before.size} changed`
      : `${changed.length} of ${before.size} changed: ${changed.slice(0, 8).join("; ")}${changed.length > 8 ? `; and ${changed.length - 8} more` : ""}`,
  ];
  if (added > 0) parts.push(`${added} new`);
  if (gone > 0) parts.push(`${gone} gone`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------------------------
// Export jobs
// ---------------------------------------------------------------------------------------------

/**
 * Starts an export job with a POST (`write`; the query form first, once more as a JSON body after a
 * 4xx, which started nothing), follows its progress, reads the download info and downloads the
 * ZIP through {@link downloadPresignedExport}. Returns the lines for the finding and the number of
 * ZIP entries.
 */
async function runExportJob(
  ctx: ProbeContext,
  path: string,
  query: Query,
): Promise<{ readonly lines: string[]; readonly entries: number | undefined }> {
  const lines: string[] = [];
  let job = await ctx.http.write("POST", path, { tier: "write", query });
  let sentAs = "query parameters";
  if (!job.ok && job.status !== undefined && job.status >= 400 && job.status < 500) {
    lines.push(`POST with query parameters ${outcomeOf(job)}`);
    job = await ctx.http.write("POST", path, { tier: "write", body: query });
    sentAs = "a JSON body";
  }
  const jobId = job.ok ? stringAnswer(job.objects, ["id", "jobId"]) : undefined;
  if (jobId === undefined) {
    lines.push(
      `POST with ${sentAs} ${job.ok ? `answered no job id (${shapeOf(job.objects)})` : outcomeOf(job)}`,
    );
    return { lines, entries: undefined };
  }
  lines.push(`POST with ${sentAs}: job id ${valueFormat(jobId)}`);
  const hashAnswer = await ctx.http.get("/Progress/generateDownloadHash", { jobId });
  const hash = hashAnswer.ok
    ? stringAnswer(hashAnswer.objects, ["progressHash", "hash"])
    : undefined;
  let progress = hash === undefined ? `no progress hash (${outcomeOf(hashAnswer)})` : "";
  if (hash !== undefined) {
    let polls = 0;
    let last: Row | undefined;
    for (; polls < EXPORT_POLL.attempts; polls += 1) {
      const answer = await ctx.http.get("/Progress/getProgress", { hash });
      last = answer.ok ? firstRow(answer.objects) : undefined;
      const current = Number(last?.["current"]);
      const total = Number(last?.["total"]);
      const failed = last?.["failure"] === true || last?.["failure"] === "1";
      if (!answer.ok || failed || (Number.isFinite(total) && total > 0 && current >= total)) break;
      await sleep(EXPORT_POLL.delayMs);
    }
    progress = `getProgress after ${polls + 1} polls: ${last === undefined ? "no answer" : `current ${str(last, "current")}, total ${str(last, "total")}, failure ${str(last, "failure") || "none"}, errors ${Array.isArray(last["errors"]) ? last["errors"].length : str(last, "errors") || "none"}`}`;
  }
  lines.push(progress);
  const info = await ctx.http.get("/ExportJob/jobDownloadInfo", { jobId });
  const infoRow = info.ok ? firstRow(info.objects) : undefined;
  const link = str(infoRow, "link");
  lines.push(
    `jobDownloadInfo: ${info.ok ? `keys ${keysOf(info.objects).join(", ")}; link host ${hostOf(link)}; linkExpireDate format ${valueFormat(infoRow?.["linkExpireDate"])}; filename "${entryPattern(str(infoRow, "filename"), data(ctx).tag)}"` : outcomeOf(info)}`,
  );
  if (link === "") return { lines, entries: undefined };
  try {
    const download = await downloadPresignedExport(link);
    const zip = download.bytes[0] === 0x50 && download.bytes[1] === 0x4b;
    lines.push(
      `download without credentials: Content-Type ${download.contentType ?? "none"}, ${describeZip(download.bytes, data(ctx).tag)}`,
    );
    return { lines, entries: zip ? zipEntries(download.bytes).length : undefined };
  } catch (error) {
    // The downloader's messages never contain the link.
    lines.push(
      `download refused or failed: ${error instanceof SevdeskError ? error.message : "error"}`,
    );
    return { lines, entries: undefined };
  }
}

// ---------------------------------------------------------------------------------------------
// Re-checks of facts recorded by one-off checks (2026-11-16/17)
// ---------------------------------------------------------------------------------------------

/**
 * The body of `write-check-account-number-refusals`: per factory the two refusals D-119 recorded,
 * a number in use (`inUse`, the run's own import account's) and 3321, which sevDesk does not allow.
 * An account a factory creates anyway goes into `unexpected`, which the cleanup archives.
 */
async function accountNumberRefusals(
  ctx: ProbeContext,
  account: { readonly id: number; readonly note: string },
  inUse: number,
  unexpected: number[],
): Promise<ProbeOutcome> {
  const tag = data(ctx).tag;
  const refusals = [
    {
      label: `in use (${inUse})`,
      number: inUse,
      name: "belegt",
      pattern: /^The given account number is already used\b/,
    },
    {
      label: "3321 (not allowed)",
      number: 3321,
      name: "ungueltig",
      pattern: /^The given account number 3321 is invalid\b/,
    },
  ];
  const checks: RecordedCheck[] = [];
  for (const factory of ["clearingAccount", "fileImportAccount"] as const) {
    for (const refusal of refusals) {
      const result = await ctx.http.write("POST", `/CheckAccount/Factory/${factory}`, {
        tier: "write",
        body: {
          name: `${tag} Nummer ${refusal.name}`,
          ...(factory === "fileImportAccount" ? { importType: "CSV" } : {}),
          accountingNumber: refusal.number,
        },
      });
      const id = createdId(result.objects);
      if (id !== undefined) {
        unexpected.push(id);
        data(ctx).register("CheckAccount", id, "account created despite the number (archived)");
      }
      checks.push({
        fact: `${factory} with a number ${refusal.label} is refused with 422`,
        holds:
          id === undefined && result.status === 422 && refusal.pattern.test(result.message ?? ""),
        seen: id === undefined ? outcomeOf(result) : `created account ${id}`,
      });
    }
  }
  return recordedOutcome(checks, `The number in use is that of ${account.note}`);
}

/** Keys whose values differ between two reads of a row (`update` and `ignore` skipped). */
function changedKeys(
  before: Row | undefined,
  after: Row | undefined,
  ignore: readonly string[],
): string[] {
  const skip = new Set(["update", ...ignore]);
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((key) => !skip.has(key))
    .filter((key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null))
    .sort();
}

/**
 * The body of `write-transaction-create-answer`: two rows on the file-import account (with and
 * without a purpose), each compared with D-071's answer and soft-deleted as D-096 says. Created
 * rows go into `own` for the cleanup.
 */
async function transactionCreateAnswer(
  ctx: ProbeContext,
  account: { readonly id: number; readonly note: string },
  own: number[],
): Promise<ProbeOutcome> {
  const tag = data(ctx).tag;
  const checks: RecordedCheck[] = [];
  for (const withPurpose of [true, false]) {
    const label = withPurpose ? "with paymtPurpose" : "without paymtPurpose";
    const purpose = `${tag} Antwortform`;
    const result = await ctx.http.write("POST", "/CheckAccountTransaction", {
      tier: "commit",
      body: {
        objectName: "CheckAccountTransaction",
        mapAll: true,
        valueDate: isoNoon(ctx.today),
        entryDate: isoNoon(ctx.today),
        amount: -12.34,
        ...(withPurpose ? { paymtPurpose: purpose } : {}),
        // The counterparty carries the tag also on the row without a purpose.
        payeePayerName: `${tag} Gegenpartei`,
        checkAccount: { id: account.id, objectName: "CheckAccount" },
        status: 100,
      },
    });
    const id = createdId(result.objects, "checkAccountTransaction");
    if (id === undefined) {
      checks.push({ fact: `POST ${label} creates a row`, holds: false, seen: outcomeOf(result) });
      continue;
    }
    own.push(id);
    data(ctx).register("CheckAccountTransaction", id, "status 100 (deletable in the web app)");
    const answer: unknown = result.objects;
    const answerRow =
      answer !== null && typeof answer === "object" && !Array.isArray(answer)
        ? (answer as Row)
        : undefined;
    const read = await ctx.http.get(`/CheckAccountTransaction/${id}`);
    const getRow = firstRow(read.objects);
    const onlyAnswer = Object.keys(answerRow ?? {}).filter(
      (key) => !Object.hasOwn(getRow ?? {}, key),
    );
    const onlyGet = Object.keys(getRow ?? {}).filter((key) => !Object.hasOwn(answerRow ?? {}, key));
    checks.push({
      fact: `POST ${label} answers objects as one object, the new row with the keys of a GET row (deletedAt, restoredAt included)`,
      holds:
        answerRow !== undefined &&
        str(answerRow, "id") === String(id) &&
        getRow !== undefined &&
        onlyAnswer.length === 0 &&
        onlyGet.length === 0 &&
        Object.hasOwn(answerRow, "deletedAt") &&
        Object.hasOwn(answerRow, "restoredAt"),
      seen:
        answerRow === undefined
          ? `objects ${shapeOf(answer)}`
          : `one object; keys ${onlyAnswer.length + onlyGet.length === 0 ? "the same as the GET row's" : `only in the answer: ${onlyAnswer.join(", ") || "none"}, only in GET: ${onlyGet.join(", ") || "none"}`}`,
    });
    const valueDate = str(answerRow, "valueDate");
    checks.push({
      fact: `the answer ${label} has amount "-12.34" (a string), status 100 and valueDate 12:00 Berlin on the day sent`,
      holds:
        answerRow?.["amount"] === "-12.34" &&
        str(answerRow, "status") === "100" &&
        valueDate.startsWith(`${ctx.today}T12:00:00`) &&
        /[+-]\d{2}:\d{2}$/.test(valueDate),
      seen: `amount ${JSON.stringify(answerRow?.["amount"] ?? null)}, status ${JSON.stringify(answerRow?.["status"] ?? null)}, valueDate ${JSON.stringify(answerRow?.["valueDate"] ?? null)}`,
    });
    const storedPurpose = answerRow?.["paymtPurpose"];
    checks.push({
      fact: withPurpose
        ? "the answer has the paymtPurpose as sent"
        : "the answer without a purpose has paymtPurpose null",
      holds: withPurpose
        ? storedPurpose === purpose
        : answerRow !== undefined &&
          Object.hasOwn(answerRow, "paymtPurpose") &&
          storedPurpose === null,
      seen:
        typeof storedPurpose === "string"
          ? `a text of ${storedPurpose.length} characters, ${storedPurpose === purpose ? "the text sent" : "another text"}`
          : `paymtPurpose ${storedPurpose === undefined ? "absent" : JSON.stringify(storedPurpose)}`,
    });
    checks.push({
      fact: `a GET by id of the row ${label} answers an array of one`,
      holds: read.ok && Array.isArray(read.objects) && read.objects.length === 1,
      seen: !read.ok
        ? outcomeOf(read)
        : Array.isArray(read.objects)
          ? `a list of ${read.objects.length}`
          : shapeOf(read.objects),
    });

    const deleted = await ctx.http.write("DELETE", `/CheckAccountTransaction/${id}`, {
      tier: "commit",
    });
    const afterRead = await ctx.http.get(`/CheckAccountTransaction/${id}`);
    const afterRow = afterRead.ok ? firstRow(afterRead.objects) : undefined;
    const deletedAt = str(afterRow, "deletedAt");
    if (deletedAt !== "") {
      data(ctx).mark("CheckAccountTransaction", id, "deleted by the probe (soft delete)");
    } else if (isGone(afterRead)) {
      data(ctx).mark("CheckAccountTransaction", id, "deleted by the probe");
    }
    const changed = changedKeys(getRow, afterRow, ["deletedAt"]);
    checks.push({
      fact: `DELETE of the row ${label} answers [null] and only sets deletedAt (restoredAt null, the row stays readable by id)`,
      holds:
        deleted.ok &&
        Array.isArray(deleted.objects) &&
        deleted.objects.length === 1 &&
        deleted.objects[0] === null &&
        afterRow !== undefined &&
        deletedAt !== "" &&
        afterRow["restoredAt"] === null &&
        changed.length === 0,
      seen:
        `DELETE ${outcomeOf(deleted)}${deleted.ok ? `, answer ${JSON.stringify(deleted.objects ?? null)}` : ""}; afterwards ` +
        (afterRow === undefined
          ? isGone(afterRead)
            ? "gone"
            : outcomeOf(afterRead)
          : `readable, deletedAt ${deletedAt === "" ? "not set" : "set"}, restoredAt ${JSON.stringify(afterRow["restoredAt"] ?? null)}, other changes: ${changed.join(", ") || "none"}`),
    });
  }
  return recordedOutcome(checks, `On ${account.note}`);
}

/** The page size the rule-storage probe reads the rule list with. */
const RULE_PAGE = 1000;

/** Whether one page of the rule list holds every rule of the account. */
function listsEveryRule(page: {
  readonly rows: readonly Row[];
  readonly total: number | undefined;
}): boolean {
  return (
    page.rows.length < RULE_PAGE || (page.total !== undefined && page.total <= page.rows.length)
  );
}

/** What a stored rule text is, compared with the text sent; never the text itself. */
function storedText(row: Row | undefined, key: string, sent: string): string {
  if (row === undefined) return "rule not listed";
  const value = row[key];
  if (typeof value !== "string")
    return `${key} ${value === undefined ? "absent" : JSON.stringify(value)}`;
  const relation =
    value === sent
      ? "the text sent"
      : value === sent.trim()
        ? "the text sent, trimmed"
        : sent.startsWith(value)
          ? "its first characters"
          : "another text";
  return `${value.length} characters stored for ${sent.length} sent, ${relation}`;
}

/**
 * The body of `write-private-transaction-rule-storage`. Every rule it creates goes into `own`;
 * the cleanup deletes them.
 */
async function ruleStorage(ctx: ProbeContext, own: number[]): Promise<ProbeOutcome> {
  const tag = data(ctx).tag;
  const create = async (body: Readonly<Record<string, string>>) => {
    const result = await ctx.http.write("POST", "/PrivateTransactionRule", {
      // A rule makes sevDesk mark imports private: commit, as the rule tools (#131).
      tier: "commit",
      body: { objectName: "PrivateTransactionRule", ...body },
    });
    const id = createdId(result.objects);
    if (id !== undefined) {
      own.push(id);
      data(ctx).register("PrivateTransactionRule", id, "rule (deleted at the end of the probe)");
    }
    return { id, result };
  };
  // Two leading spaces and one trailing, as recorded.
  const spaced = `  ${tag} Leerzeichen `;
  const first = await create({ counterpartName: spaced });
  const duplicate = await create({ counterpartName: spaced });
  const full = `${tag} Zweck 255 `.padEnd(255, "x");
  const long = `${tag} Zweck 256 `.padEnd(256, "y");
  const kept = await create({ paymentPurpose: full });
  const cut = await create({ paymentPurpose: long });

  // No read by id is recorded: the stored texts come from the list.
  const list = await ctx.read.page("/PrivateTransactionRule", undefined, RULE_PAGE);
  if (!list.result.ok) {
    return inconclusive(
      `The rules were created, but GET /PrivateTransactionRule ${outcomeOf(list.result)}.`,
    );
  }
  const listed = (id: number | undefined) =>
    id === undefined ? undefined : list.rows.find((row) => str(row, "id") === String(id));
  // The list's order is not recorded: on an account with more rules than one page, a new rule
  // missing from the page says nothing about how sevDesk stored it.
  const missing = [first, duplicate, kept, cut].filter(
    (rule) => rule.id !== undefined && listed(rule.id) === undefined,
  ).length;
  if (missing > 0 && !listsEveryRule(list)) {
    return inconclusive(
      `${missing} of the new rules are not among the first ${RULE_PAGE} of the account's rules (total ${list.total ?? "unknown"}), so their stored texts could not be read.`,
    );
  }
  const checks: RecordedCheck[] = [
    {
      fact: "a counterpartName with two leading spaces and one trailing is stored exactly as sent",
      holds: str(listed(first.id), "counterpartName") === spaced,
      seen:
        first.id === undefined
          ? outcomeOf(first.result)
          : storedText(listed(first.id), "counterpartName", spaced),
    },
    {
      fact: "a second rule with the same counterpartName is stored as a second row",
      holds:
        duplicate.id !== undefined &&
        duplicate.id !== first.id &&
        listed(first.id) !== undefined &&
        str(listed(duplicate.id), "counterpartName") === spaced,
      seen:
        duplicate.id === undefined
          ? outcomeOf(duplicate.result)
          : `${duplicate.id === first.id ? "the same id" : "another id"}; listed: first ${listed(first.id) !== undefined}, second ${listed(duplicate.id) !== undefined}`,
    },
    {
      fact: "a paymentPurpose of 255 characters is stored in full",
      holds: str(listed(kept.id), "paymentPurpose") === full,
      seen:
        kept.id === undefined
          ? outcomeOf(kept.result)
          : storedText(listed(kept.id), "paymentPurpose", full),
    },
    {
      fact: "a paymentPurpose of 256 characters is accepted and stored cut to 255",
      holds: cut.result.ok && str(listed(cut.id), "paymentPurpose") === long.slice(0, 255),
      seen:
        cut.id === undefined
          ? outcomeOf(cut.result)
          : storedText(listed(cut.id), "paymentPurpose", long),
    },
  ];
  return recordedOutcome(checks, "", [
    `The list had ${list.rows.length} rule(s) (total ${list.total ?? "none"})`,
  ]);
}

/**
 * Archives accounts a factory created against the record (`DELETE /CheckAccount/{id}` archives,
 * D-097: an account cannot be deleted through the API).
 */
async function archiveAccounts(ctx: ProbeContext, ids: readonly number[]): Promise<string[]> {
  const notes: string[] = [];
  for (const id of ids) {
    const deleted = await ctx.http.write("DELETE", `/CheckAccount/${id}`, { tier: "write" });
    const after = await ctx.http.get(`/CheckAccount/${id}`);
    const archived = str(firstRow(after.objects), "status") === "0";
    if (isGone(after)) data(ctx).mark("CheckAccount", id, "deleted by the probe");
    else if (archived) data(ctx).mark("CheckAccount", id, "archived by the probe (DELETE, D-097)");
    notes.push(
      `account ${id} ${isGone(after) ? "deleted" : archived ? "archived" : `left (DELETE ${outcomeOf(deleted)})`}`,
    );
  }
  return notes;
}

/**
 * Deletes the rules of `own` (commit) and confirms with one list read that none is listed. A rule
 * missing from the list counts as deleted only when its DELETE answered 2xx or the page holds every
 * rule: on a longer list it may just be on a later page.
 */
async function deleteRules(ctx: ProbeContext, own: readonly number[]): Promise<string[]> {
  if (own.length === 0) return [];
  const answers = new Map<number, HttpResult>();
  for (const id of own) {
    answers.set(
      id,
      await ctx.http.write("DELETE", `/PrivateTransactionRule/${id}`, { tier: "commit" }),
    );
  }
  const after = await ctx.read.page("/PrivateTransactionRule", undefined, RULE_PAGE);
  const listed = new Set(after.rows.map((row) => str(row, "id")));
  return own.map((id) => {
    const answer = answers.get(id);
    const unlisted = after.result.ok && !listed.has(String(id));
    const gone = unlisted && (answer?.ok === true || listsEveryRule(after));
    if (gone) data(ctx).mark("PrivateTransactionRule", id, "deleted by the probe");
    const list = !after.result.ok
      ? outcomeOf(after.result)
      : unlisted
        ? `not among the first ${RULE_PAGE} of ${after.total ?? "more"} rules`
        : "still shows it";
    return `rule ${id} ${gone ? "deleted" : `not confirmed deleted (DELETE ${answer === undefined ? "not sent" : outcomeOf(answer)}, list ${list})`}`;
  });
}

// ---------------------------------------------------------------------------------------------
// The one enshrine call
// ---------------------------------------------------------------------------------------------

/**
 * `PUT /CheckAccountTransaction/{id}/enshrine` (commit). The only enshrine request of any probe;
 * only the opt-in probe `write-transaction-enshrine` calls it, and only for a transaction it created
 * itself in the same run.
 */
function enshrineOwnTransaction(ctx: ProbeContext, id: number): Promise<HttpResult> {
  return ctx.http.write("PUT", `/CheckAccountTransaction/${id}/enshrine`, { tier: "commit" });
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

export const GAPS_BANKING_PROBES: readonly ProbeDefinition[] = [
  {
    id: "write-check-account-factories",
    title: "Clearing account, PUT and DELETE of accounts, creating a cash register",
    mode: "write",
    question:
      "Does POST /CheckAccount/Factory/clearingAccount create a tagged clearing account without an accountingNumber (else with 3320), and how does it read back (type, importType, accountingNumber)? Does it take a hand-made transaction? What does PUT /CheckAccount/{id} with a new name answer and change? Does DELETE /CheckAccount/{id} delete the empty clearing account, and what does it do to a second tagged file-import account that holds one transaction (refused, or the transaction gone too)? Can a cash register be created at all (POST /CheckAccount with type register)?",
    deviations: ["D-097", "D-024", "D-071"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const lines: string[] = [];

      // 1. Clearing account.
      let clearing = await ctx.http.write("POST", "/CheckAccount/Factory/clearingAccount", {
        tier: "write",
        body: { name: `${tag} Verrechnung` },
      });
      let sent = "without accountingNumber";
      if (!clearing.ok && clearing.status !== undefined && clearing.status < 500) {
        lines.push(`clearingAccount without accountingNumber: ${outcomeOf(clearing)}`);
        clearing = await ctx.http.write("POST", "/CheckAccount/Factory/clearingAccount", {
          tier: "write",
          body: { name: `${tag} Verrechnung`, accountingNumber: 3320 },
        });
        sent = "with accountingNumber 3320";
      }
      const clearingId = createdId(clearing.objects);
      if (clearingId === undefined) {
        lines.push(`clearingAccount ${sent}: ${outcomeOf(clearing)}`);
      } else {
        data(ctx).register(
          "CheckAccount",
          clearingId,
          "clearing account (delete it in the web app)",
        );
        const row = await ctx.read.byId("CheckAccount", clearingId);
        lines.push(
          `clearingAccount ${sent}: ${clearingId}, answer keys ${keysOf(clearing.objects).join(", ")}; reads back ${row === undefined ? "nothing" : `${accountKind(row)}, accountingNumber ${accountField("accountingNumber", row["accountingNumber"])}`}`,
        );
        const posted = await postTransaction(ctx, clearingId, { amount: 5, purpose: "clearing" });
        lines.push(
          `POST /CheckAccountTransaction on it: ${posted.id === undefined ? outcomeOf(posted.result) : `accepted (${await deleteTransaction(ctx, posted.id)})`}`,
        );
        const put = await ctx.http.write("PUT", `/CheckAccount/${clearingId}`, {
          tier: "write",
          body: { name: `${tag} Verrechnung umbenannt` },
        });
        const renamed = await ctx.read.byId("CheckAccount", clearingId);
        lines.push(
          `PUT /CheckAccount/${clearingId} {name}: ${outcomeOf(put)}, answer ${shapeOf(put.objects)}; changed: ${Object.keys(changedFieldsMap(row, renamed)).join(", ") || "nothing"}`,
        );
        const deleted = await ctx.http.write("DELETE", `/CheckAccount/${clearingId}`, {
          tier: "write",
        });
        const after = await ctx.http.get(`/CheckAccount/${clearingId}`);
        if (isGone(after)) data(ctx).mark("CheckAccount", clearingId, "deleted by the probe");
        lines.push(
          `DELETE of the empty clearing account: ${outcomeOf(deleted)}${deleted.ok ? `, answer ${shapeOf(deleted.objects)}` : ""}; afterwards ${isGone(after) ? "gone" : `still there (status ${str(firstRow(after.objects), "status")})`}`,
        );
      }

      // 2. A second file-import account with one transaction.
      const imported = await ctx.http.write("POST", "/CheckAccount/Factory/fileImportAccount", {
        tier: "write",
        body: { name: `${tag} Import Delete`, importType: "CSV" },
      });
      const importId = createdId(imported.objects);
      if (importId === undefined) {
        lines.push(`second fileImportAccount: ${outcomeOf(imported)}`);
      } else {
        data(ctx).register(
          "CheckAccount",
          importId,
          "file-import bank account (delete it in the web app)",
        );
        const transaction = await postTransaction(ctx, importId, {
          amount: 7,
          purpose: "account delete",
        });
        const deleted = await ctx.http.write("DELETE", `/CheckAccount/${importId}`, {
          tier: "write",
        });
        const after = await ctx.http.get(`/CheckAccount/${importId}`);
        const accountGone = isGone(after);
        const transactionAfter =
          transaction.id === undefined
            ? "none created"
            : await transactionStatus(ctx, transaction.id);
        let note =
          `DELETE of file-import account ${importId} holding transaction ${transaction.id ?? `(${outcomeOf(transaction.result)})`}: ` +
          `${outcomeOf(deleted)}; account ${accountGone ? "gone" : "still there"}, transaction ${transactionAfter}`;
        if (accountGone) {
          data(ctx).mark("CheckAccount", importId, "deleted by the probe");
          if (transaction.id !== undefined && transactionAfter === "gone") {
            data(ctx).mark("CheckAccountTransaction", transaction.id, "deleted with its account");
          }
        } else if (transaction.id !== undefined) {
          note += `; cleanup: transaction ${await deleteTransaction(ctx, transaction.id)}`;
          const again = await ctx.http.write("DELETE", `/CheckAccount/${importId}`, {
            tier: "write",
          });
          const gone = isGone(await ctx.http.get(`/CheckAccount/${importId}`));
          if (gone) data(ctx).mark("CheckAccount", importId, "deleted by the probe");
          note += `; DELETE of the then empty account ${outcomeOf(again)}, ${gone ? "gone" : "still there"}`;
        }
        lines.push(note);
      }

      // 3. A cash register through the API.
      const register = await ctx.http.write("POST", "/CheckAccount", {
        tier: "write",
        body: {
          objectName: "CheckAccount",
          mapAll: true,
          name: `${tag} Kasse`,
          type: "register",
          currency: "EUR",
          status: 100,
        },
      });
      const registerId = createdId(register.objects);
      if (registerId === undefined) {
        lines.push(`POST /CheckAccount with type register: ${outcomeOf(register)}`);
      } else {
        data(ctx).register("CheckAccount", registerId, "cash register (delete it in the web app)");
        const row = await ctx.read.byId("CheckAccount", registerId);
        const deleted = await ctx.http.write("DELETE", `/CheckAccount/${registerId}`, {
          tier: "write",
        });
        const gone = isGone(await ctx.http.get(`/CheckAccount/${registerId}`));
        if (gone) data(ctx).mark("CheckAccount", registerId, "deleted by the probe");
        lines.push(
          `POST /CheckAccount with type register: created ${registerId} (${row === undefined ? "unreadable" : accountKind(row)}); DELETE ${outcomeOf(deleted)}, ${gone ? "gone" : "still there"}`,
        );
      }
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-024": "informs", "D-071": "informs" },
      };
    },
  },
  {
    id: "write-check-account-number-refusals",
    title: "The account factories' two accountingNumber refusals (422)",
    mode: "write",
    question:
      'Do both account factories still refuse an accountingNumber as recorded in D-119 (#109)? With the booking account number of the run\'s tagged file-import account, POST /CheckAccount/Factory/clearingAccount and /fileImportAccount each answer 422 "The given account number is already used"; with 3321 each answers 422 "The given account number 3321 is invalid". An account a factory creates anyway is archived again (DELETE, D-097), also when a later step fails.',
    deviations: ["D-119", "D-097"],
    async run(ctx) {
      const imported = await importAccount(ctx);
      if (imported.id === undefined) return inconclusive(imported.note);
      const account = { id: imported.id, note: imported.note };
      const inUse = Number(
        str(await ctx.read.byId("CheckAccount", account.id), "accountingNumber"),
      );
      if (!Number.isSafeInteger(inUse) || inUse <= 0) {
        return inconclusive(`${imported.note} reads no booking account number to reuse.`);
      }
      const unexpected: number[] = [];
      return withCleanup(
        () => accountNumberRefusals(ctx, account, inUse, unexpected),
        () => archiveAccounts(ctx, unexpected),
      );
    },
  },
  {
    id: "write-transaction-delete",
    title: "DELETE /CheckAccountTransaction on a file-import account: unbooked, private, booked",
    mode: "write",
    question:
      "On the tagged file-import account: does DELETE /CheckAccountTransaction/{id} delete an unbooked row (status 100), a private one (300) and a booked one (400, linked to a tagged open voucher with bookAmount), with which answer shape or refusal? If the booked row is deleted, what happens to the voucher's payment? Booked rows still there are unlinked with resetToOpen on the voucher and deleted then.",
    deviations: ["D-096", "D-071", "D-076"],
    async run(ctx) {
      const imported = await importAccount(ctx);
      if (imported.id === undefined) return inconclusive(imported.note);
      const account = imported.id;
      const lines: string[] = [];

      const open = await postTransaction(ctx, account, { amount: -3, purpose: "delete unbooked" });
      lines.push(
        open.id === undefined
          ? `unbooked: ${outcomeOf(open.result)}`
          : `unbooked ${open.id}: ${await deleteTransaction(ctx, open.id)}`,
      );

      const privateRow = await postTransaction(ctx, account, {
        amount: -4,
        purpose: "delete private",
      });
      if (privateRow.id === undefined) {
        lines.push(`private: ${outcomeOf(privateRow.result)}`);
      } else {
        const marked = await setTransactionStatus(ctx, privateRow.id, 300);
        const deletion = await deleteTransaction(ctx, privateRow.id);
        let note = `private ${privateRow.id} (status 300 ${outcomeOf(marked)}, now ${await transactionStatus(ctx, privateRow.id)}): ${deletion}`;
        if (!endsDeleted(deletion)) {
          // Only status 100 can be deleted (D-096): back to 100 first.
          const back = await setTransactionStatus(ctx, privateRow.id, 100);
          note += `; cleanup: status 100 ${outcomeOf(back)}, ${await deleteTransaction(ctx, privateRow.id)}`;
        }
        lines.push(note);
      }

      const voucher = await createVoucher(ctx, { label: "delete booked", status: 100, gross: 15 });
      const booked = await postTransaction(ctx, account, { amount: -15, purpose: "delete booked" });
      if (voucher.id === undefined || booked.id === undefined) {
        lines.push(
          `booked: could not prepare (${voucher.id === undefined ? voucherFailure(voucher) : outcomeOf(booked.result)})`,
        );
      } else {
        const payment = await bookVoucher(ctx, voucher.id, {
          checkAccount: account,
          amount: -15,
          date: berlinNoon(ctx.today),
          type: "FULL_PAYMENT",
          transaction: booked.id,
        });
        if (payment.ok)
          data(ctx).mark(
            "Voucher",
            voucher.id,
            "open voucher, paid via a transaction (resettable)",
          );
        const status = await transactionStatus(ctx, booked.id);
        const deletion = await deleteTransaction(ctx, booked.id);
        const voucherAfter = await ctx.read.byId("Voucher", voucher.id);
        let note = `booked ${booked.id} (bookAmount ${outcomeOf(payment)}, then ${status}): ${deletion}; voucher ${voucher.id} afterwards ${voucherState(voucherAfter)}`;
        if (!endsDeleted(deletion)) {
          const reset = await ctx.http.write("PUT", `/Voucher/${voucher.id}/resetToOpen`, {
            tier: "commit",
          });
          if (reset.ok) data(ctx).mark("Voucher", voucher.id, "open voucher (payment reset)");
          note += `; cleanup: resetToOpen ${outcomeOf(reset)}, transaction ${await transactionStatus(ctx, booked.id)}, ${await deleteTransaction(ctx, booked.id)}`;
        }
        lines.push(note);
      }
      return {
        verdict: "observed",
        finding: `On ${imported.note}. ${lines.join(". ")}.`,
        deviations: { "D-071": "informs", "D-076": "informs" },
      };
    },
  },
  {
    id: "write-transaction-create-answer",
    title: "The answer of POST /CheckAccountTransaction, and DELETE on a file-import account",
    mode: "write",
    question:
      'Do the facts of D-071 and D-096 recorded on 2026-11-17 (#118) still hold? On the tagged file-import account, POST /CheckAccountTransaction (mapAll, both dates 12:00 Berlin as UTC ISO, amount -12.34, status 100), once with a tagged paymtPurpose and once without: 2xx with objects as one object, the new row itself with the keys of a GET row (deletedAt and restoredAt included), amount the string "-12.34", status 100, valueDate 12:00 Berlin on the day sent, paymtPurpose null when none was sent; a GET by id answers an array of one (D-001). DELETE of each row answers [null] and only sets deletedAt: the row stays readable by id, unchanged otherwise, restoredAt null. Both rows are deleted at the end, also when a step fails.',
    deviations: ["D-071", "D-096"],
    async run(ctx) {
      const imported = await importAccount(ctx);
      if (imported.id === undefined) return inconclusive(imported.note);
      const account = { id: imported.id, note: imported.note };
      const own: number[] = [];
      return withCleanup(
        () => transactionCreateAnswer(ctx, account, own),
        async () => {
          const notes: string[] = [];
          for (const id of own) {
            if (endsDeleted(await transactionStatus(ctx, id))) continue;
            notes.push(`transaction ${id}: ${await deleteTransaction(ctx, id)}`);
          }
          return notes;
        },
      );
    },
  },
  {
    id: "write-private-transaction-rule",
    title: "PrivateTransactionRule: list, create, what a rule matches, delete",
    mode: "write",
    question:
      "What do GET and POST /PrivateTransactionRule and DELETE /PrivateTransactionRule/{id} answer? With two tagged rules (counterpartName only, paymentPurpose only) and five tagged open transactions on the file-import account (exact counterpart, counterpart that contains the rule's text, exact purpose, purpose that contains it, neither): which transactions turn private (300) when the rules are created, does a matching transaction created afterwards turn private, and does deleting the rules set them back? Every rule is deleted and every private transaction set back to 100 at the end.",
    deviations: ["D-099", "D-076", "D-024"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const imported = await importAccount(ctx);
      if (imported.id === undefined) return inconclusive(imported.note);
      const account = imported.id;
      const lines: string[] = [];
      const listBefore = await ctx.http.get("/PrivateTransactionRule", { limit: 100, offset: 0 });
      lines.push(
        `GET before: ${listBefore.ok ? shapeOf(listBefore.objects) : outcomeOf(listBefore)}`,
      );

      const transactions = [
        { label: "exact counterpart", counterpart: "Privatregel", purpose: "rule A" },
        { label: "counterpart containing it", counterpart: "Privatregel GmbH", purpose: "rule B" },
        { label: "exact purpose", counterpart: "Gegenpartei", purpose: "Privatzweck" },
        {
          label: "purpose containing it",
          counterpart: "Gegenpartei",
          purpose: "Privatzweck November",
        },
        { label: "neither", counterpart: "Gegenpartei", purpose: "rule E" },
      ];
      const ids: { label: string; id: number }[] = [];
      for (const item of transactions) {
        const created = await postTransaction(ctx, account, {
          amount: -9.99,
          purpose: item.purpose,
          counterpart: item.counterpart,
        });
        if (created.id === undefined) {
          lines.push(`${item.label}: ${outcomeOf(created.result)}`);
        } else {
          ids.push({ label: item.label, id: created.id });
        }
      }

      const rules: number[] = [];
      for (const body of [
        { objectName: "PrivateTransactionRule", counterpartName: `${tag} Privatregel` },
        { objectName: "PrivateTransactionRule", paymentPurpose: `${tag} Privatzweck` },
      ]) {
        // A rule needs commit: sevDesk marks imports private by it (`minimumWriteTier`, #131).
        const created = await ctx.http.write("POST", "/PrivateTransactionRule", {
          tier: "commit",
          body,
        });
        const id = createdId(created.objects);
        if (id !== undefined) {
          rules.push(id);
          data(ctx).register(
            "PrivateTransactionRule",
            id,
            "rule (deleted at the end of the probe)",
          );
        }
        lines.push(
          `POST rule on ${Object.keys(body)
            .filter((key) => key !== "objectName")
            .join(
              ", ",
            )}: ${outcomeOf(created)}${created.ok ? `, answer ${shapeOf(created.objects)}` : ""}`,
        );
      }
      const statuses = async () =>
        (
          await Promise.all(
            ids.map(async (item) => `${item.label} ${await transactionStatus(ctx, item.id)}`),
          )
        ).join(", ");
      lines.push(`after creating the rules: ${await statuses()}`);
      const later = await postTransaction(ctx, account, {
        amount: -9.99,
        purpose: "rule F",
        counterpart: "Privatregel",
      });
      if (later.id !== undefined)
        ids.push({ label: "exact counterpart, created after", id: later.id });
      lines.push(
        `created after the rules (exact counterpart): ${later.id === undefined ? outcomeOf(later.result) : await transactionStatus(ctx, later.id)}`,
      );
      const listAfter = await ctx.http.get("/PrivateTransactionRule", { limit: 100, offset: 0 });
      lines.push(
        `GET with the rules: ${listAfter.ok ? shapeOf(listAfter.objects) : outcomeOf(listAfter)}`,
      );

      for (const id of rules) {
        const deleted = await ctx.http.write("DELETE", `/PrivateTransactionRule/${id}`, {
          tier: "commit",
        });
        if (deleted.ok) data(ctx).mark("PrivateTransactionRule", id, "deleted by the probe");
        lines.push(
          `DELETE rule ${id}: ${outcomeOf(deleted)}${deleted.ok ? `, answer ${shapeOf(deleted.objects)}` : ""}`,
        );
      }
      lines.push(`after deleting the rules: ${await statuses()}`);

      const resets: string[] = [];
      for (const item of ids) {
        if ((await transactionStatus(ctx, item.id)) !== "status 300") continue;
        const reset = await setTransactionStatus(ctx, item.id, 100);
        resets.push(`${item.id} ${outcomeOf(reset)}`);
      }
      lines.push(`cleanup back to 100: ${resets.join(", ") || "nothing private"}`);
      return {
        verdict: "observed",
        finding: `On ${imported.note}. ${lines.join(". ")}.`,
        deviations: { "D-076": "informs", "D-024": "informs" },
      };
    },
  },
  {
    id: "write-private-transaction-rule-storage",
    title: "How PrivateTransactionRule stores texts: spaces, duplicates, the 255-character cut",
    mode: "write",
    question:
      "Do the rule-storage facts of D-099 and D-130 recorded on 2026-11-17 (#122) still hold? POST /PrivateTransactionRule (commit) stores a tagged counterpartName with two leading spaces and one trailing exactly as sent; a second rule with the same counterpartName is stored as a second row (another id, both listed); a paymentPurpose of 255 characters is stored in full, and one of 256 characters is accepted with 2xx and stored cut to its first 255. The stored texts are read from GET /PrivateTransactionRule (limit 1000; no read by id is recorded) and compared, never shown. Every rule is deleted at the end (commit), also when a step fails.",
    deviations: ["D-099", "D-130"],
    async run(ctx) {
      const own: number[] = [];
      return withCleanup(
        () => ruleStorage(ctx, own),
        () => deleteRules(ctx, own),
      );
    },
  },
  {
    id: "write-receipt-hash",
    title: "The hash sevDesk keeps for a receipt file",
    mode: "write",
    question:
      "For a generated receipt PDF: does the uploadTempFile answer's contentHash equal the SHA-256, MD5 or SHA-1 of the uploaded bytes, does a second upload of the same bytes get the same token and hash, does the draft voucher saved with it carry a hash, and does GET /Document/{id} (the voucher's document) and its list row carry a contentHash equal to one of them? Does GET /Document/{id}/download give the same bytes back, and does deleting the draft voucher delete its Document? (Hashes are compared, never shown.)",
    deviations: ["D-100", "D-011", "D-024", "D-026"],
    async run(ctx) {
      const bytes = await receiptPdf(ctx, "hash");
      const hashes = hashesOf(bytes);
      const name = `${slug(data(ctx).tag)}-hash.pdf`;
      const lines: string[] = [];
      const first = await uploadTempFile(ctx, bytes, name, "application/pdf");
      if (first.token === undefined)
        return inconclusive(`uploadTempFile ${outcomeOf(first.result)}.`);
      const firstRowAnswer = firstRow(first.result.objects);
      lines.push(
        `upload (${bytes.length} bytes): contentHash is ${hashMatch(firstRowAnswer?.["contentHash"], hashes, "the uploaded bytes")}; token "${tokenPattern(first.token)}"; hash keys ${hashKeys(firstRowAnswer).join(", ") || "none"}`,
      );
      const second = await uploadTempFile(ctx, bytes, name, "application/pdf");
      const secondHash = firstRow(second.result.objects)?.["contentHash"];
      lines.push(
        `same bytes again: ${second.result.ok ? `token ${second.token === first.token ? "the same" : "a new one"}, contentHash ${secondHash === firstRowAnswer?.["contentHash"] ? "the same" : "different"}` : outcomeOf(second.result)}`,
      );

      const voucher = await createVoucher(ctx, {
        label: "hash",
        file: { token: first.token, placement: "top-level" },
      });
      if (voucher.id === undefined) {
        return { verdict: "observed", finding: `${lines.join(". ")}. ${voucherFailure(voucher)}.` };
      }
      const row = await ctx.read.byId("Voucher", voucher.id);
      const documentId = Number((row?.["document"] as Row | null | undefined)?.["id"]);
      lines.push(
        `draft voucher ${voucher.id}: hash keys ${hashKeys(row).join(", ") || "none"}; document ${Number.isSafeInteger(documentId) ? documentId : JSON.stringify(row?.["document"] ?? null)}`,
      );
      if (Number.isSafeInteger(documentId) && documentId > 0) {
        const document = await ctx.read.byId("Document", documentId);
        lines.push(
          `GET /Document/${documentId}: contentHash is ${hashMatch(document?.["contentHash"], hashes, "the uploaded bytes")}; filesize ${str(document, "filesize") || "none"} (uploaded ${bytes.length}); hash keys ${hashKeys(document).join(", ") || "none"}; mimeType ${str(document, "mimeType") || "none"}, extension ${str(document, "extension") || "none"}`,
        );
        const list = await ctx.read.page("/Document", undefined, 1000);
        const listed = list.rows.find((item) => str(item, "id") === String(documentId));
        lines.push(
          `in GET /Document: ${listed === undefined ? "not among the first 1000 rows" : `contentHash is ${hashMatch(listed["contentHash"], hashes, "the uploaded bytes")}`}`,
        );
        const download = await ctx.http.get(`/Document/${documentId}/download`);
        const downloaded = download.ok ? envelopeBytes(download.objects) : undefined;
        lines.push(
          `GET /Document/${documentId}/download: ${download.ok ? (downloaded === undefined ? `no content (${shapeOf(download.objects)})` : `${downloaded.length} bytes, ${hashesOf(downloaded)["SHA-256"] === hashes["SHA-256"] ? "the uploaded bytes" : "different bytes"}; the Document's contentHash is ${hashMatch(document?.["contentHash"], hashesOf(downloaded), "the downloaded bytes")}`) : outcomeOf(download)}`,
        );
      }
      const deleted = await ctx.http.write("DELETE", `/Voucher/${voucher.id}`, { tier: "write" });
      if (isGone(await ctx.http.get(`/Voucher/${voucher.id}`))) {
        data(ctx).mark("Voucher", voucher.id, "deleted by the probe");
      }
      lines.push(
        `DELETE of the draft voucher ${outcomeOf(deleted)}${Number.isSafeInteger(documentId) && documentId > 0 ? `; its Document afterwards ${isGone(await ctx.http.get(`/Document/${documentId}`)) ? "gone" : "still there"}` : ""}`,
      );
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-011": "informs", "D-024": "informs" },
      };
    },
  },
  {
    id: "write-export-invoice-zip",
    title: "GET /Export/invoiceZip: answer, filters, entry names, side effects",
    mode: "write",
    question:
      "What does GET /Export/invoiceZip answer with sevQuery (modelName Invoice, objectName SevQuery, limit, filter[contact], filter[startDate]/[endDate] as Unix seconds), without download (JSON with base64 content?) and with download=true (raw ZIP?), what are the ZIP's entry names (as patterns) and sizes, are drafts included, and does it change any invoice, above all a draft (status, sendDate, sendType, enshrined, as getPdf without preventSendBy does, D-023)? First a check with download=true, limit 1 and a contact without invoices (the JSON form answers content null, D-101): when that exports anything, the filters are ignored and the probe stops.",
    deviations: ["D-012", "D-023", "D-101"],
    async run(ctx) {
      const contact = await ownContact(ctx, "ZIP");
      if (typeof contact === "string") return inconclusive(`Could not prepare: ${contact}.`);
      const lines: string[] = [];
      const window = {
        startDate: berlinMidnight(addDays(ctx.today, -30)),
        endDate: berlinMidnight(addDays(ctx.today, 1)) - 1,
      };
      const filter = { "contact/id": contact, "contact/objectName": "Contact", ...window };
      const before = await snapshot(ctx, "/Invoice");
      const check = await zipExport(ctx, "/Export/invoiceZip", {
        download: "true",
        ...sevQuery("Invoice", 1, filter),
      });
      lines.push(`Filter check (contact without invoices, limit 1): ${check.note}`);
      if (check.entries !== undefined && check.entries > 0) {
        return {
          verdict: "observed",
          finding: `${lines.join(". ")}. The filters are ignored: stopped. Invoices afterwards: ${snapshotChanges(before, await snapshot(ctx, "/Invoice"))}.`,
          deviations: { "D-023": "informs", "D-012": "informs" },
        };
      }
      const draft = await data(ctx).draft("Invoice", {
        fields: { contact: { id: contact, objectName: "Contact" } },
      });
      const final = await data(ctx).draft("Invoice", {
        fields: { contact: { id: contact, objectName: "Contact" } },
      });
      const finalized =
        final.id === undefined ? undefined : await data(ctx).finalize("Invoice", final.id);
      if (draft.id === undefined)
        return inconclusive(`The draft invoice was ${outcomeOf(draft.result)}.`);
      lines.push(
        `Draft ${draft.id}, finalized ${final.id ?? "none"} (${finalized === undefined ? outcomeOf(final.result) : outcomeOf(finalized)}) for that contact`,
      );
      const draftBefore = sendState(await ctx.read.byId("Invoice", draft.id));
      const middle = await snapshot(ctx, "/Invoice");
      const json = await zipExport(ctx, "/Export/invoiceZip", sevQuery("Invoice", 10, filter));
      lines.push(`Without download: ${json.note}`);
      const raw = await zipExport(ctx, "/Export/invoiceZip", {
        download: "true",
        ...sevQuery("Invoice", 10, filter),
      });
      lines.push(`With download=true: ${raw.note}`);
      const draftAfter = sendState(await ctx.read.byId("Invoice", draft.id));
      lines.push(
        `Draft ${draft.id} afterwards: ${diffState(draftBefore, draftAfter) || "unchanged (status, sendDate, sendType, update)"}; all invoices: ${snapshotChanges(middle, await snapshot(ctx, "/Invoice"))}`,
      );
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-023": "informs", "D-012": "informs" },
      };
    },
  },
  {
    id: "write-export-voucher-zip",
    title: "GET /Export/voucherZip: answer, filters, entry names, side effects",
    mode: "write",
    question:
      "What does GET /Export/voucherZip answer with sevQuery (modelName Voucher, limit, filter[startDate]/[endDate] as Unix seconds, filter[startAmount]/[endAmount]), without download and with download=true, which entries does the ZIP hold for a tagged draft and a tagged open voucher with a receipt (names as patterns, sizes), and does it change any voucher (status, enshrined, update)? First a check with download=true, limit 1 and a window in January 2000: when that exports anything, the filters are ignored and the probe stops.",
    deviations: ["D-012", "D-023", "D-101"],
    async run(ctx) {
      const lines: string[] = [];
      const before = await snapshot(ctx, "/Voucher");
      const old = {
        startDate: berlinMidnight("2000-01-01"),
        endDate: berlinMidnight("2000-02-01") - 1,
      };
      const check = await zipExport(ctx, "/Export/voucherZip", {
        download: "true",
        ...sevQuery("Voucher", 1, old),
      });
      lines.push(`Filter check (January 2000, limit 1): ${check.note}`);
      if (check.entries !== undefined && check.entries > 0) {
        return {
          verdict: "observed",
          finding: `${lines.join(". ")}. The filters are ignored: stopped. Vouchers afterwards: ${snapshotChanges(before, await snapshot(ctx, "/Voucher"))}.`,
          deviations: { "D-023": "informs", "D-012": "informs" },
        };
      }
      const draft = await voucherWithReceipt(ctx, {
        label: "zip draft",
        status: 50,
        gross: 123.45,
      });
      const open = await voucherWithReceipt(ctx, { label: "zip open", status: 100, gross: 123.45 });
      lines.push(`Draft: ${draft.note}; open: ${open.note}`);
      if (draft.id === undefined && open.id === undefined)
        return inconclusive(`${lines.join(". ")}.`);
      const middle = await snapshot(ctx, "/Voucher");
      const filter = {
        startDate: berlinMidnight(ctx.today),
        endDate: berlinMidnight(addDays(ctx.today, 1)) - 1,
        startAmount: 123,
        endAmount: 124,
      };
      const json = await zipExport(ctx, "/Export/voucherZip", sevQuery("Voucher", 10, filter));
      lines.push(`Without download: ${json.note}`);
      const raw = await zipExport(ctx, "/Export/voucherZip", {
        download: "true",
        ...sevQuery("Voucher", 10, filter),
      });
      lines.push(`With download=true: ${raw.note}`);
      lines.push(
        `All vouchers afterwards: ${snapshotChanges(middle, await snapshot(ctx, "/Voucher"))}`,
      );
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-023": "informs", "D-012": "informs" },
      };
    },
  },
  {
    id: "write-cash-register-transaction",
    title:
      "Cash register: hand-made transaction, cash sale and cash expense through bookAmount (irreversible)",
    mode: "write",
    optIn: true,
    question:
      "Opt-in and irreversible (the cash book keeps what this books: bookAmount on the Kasse books rows at status 400, resetToOpen adds counter-entries instead of deleting them, D-095, and only rows at status 100 can be deleted, D-096): on the account's cash register (Kasse, type register), is POST /CheckAccountTransaction refused (with which status and message), and if it is accepted, can the row be deleted again? Do a tagged open revenue voucher booked +23.80 and an expense voucher booked −11.90 on the register without a transaction create a transaction each (amount sign, status, dates), how does getBalanceAtDate move, and does resetToOpen on the vouchers delete those transactions again (D-071 left cash registers unmeasured)?",
    deviations: ["D-071", "D-060", "D-095"],
    async run(ctx) {
      const register = await cashRegister(ctx);
      if (register === undefined) {
        return inconclusive(
          "No active cash register (type register): create a Kasse with a positive opening balance in the web app first.",
        );
      }
      const lines: string[] = [];
      const posted = await postTransaction(ctx, register, { amount: 10, purpose: "Kasse POST" });
      if (posted.id === undefined) {
        lines.push(
          `POST /CheckAccountTransaction on register ${register}: ${outcomeOf(posted.result)}`,
        );
      } else {
        const row = await ctx.read.byId("CheckAccountTransaction", posted.id);
        lines.push(
          `POST /CheckAccountTransaction on register ${register}: accepted, ${describeTransaction(row)}; ${await deleteTransaction(ctx, posted.id)}`,
        );
      }
      const balanceBefore = await balance(ctx, register);
      const bookings: { voucher: number; amount: number; label: string }[] = [];
      for (const item of [
        { kind: "revenue", gross: 23.8, amount: 23.8, label: "cash sale" },
        { kind: "expense", gross: 11.9, amount: -11.9, label: "cash expense" },
      ] as const) {
        const created = await createVoucher(ctx, {
          label: item.label,
          kind: item.kind,
          status: 100,
          gross: item.gross,
        });
        if (created.id === undefined) {
          lines.push(`${item.label}: ${voucherFailure(created)}`);
          continue;
        }
        const before = new Set((await transactionsOf(ctx, register)).map((row) => str(row, "id")));
        const booked = await bookVoucher(ctx, created.id, {
          checkAccount: register,
          amount: item.amount,
          date: berlinNoon(ctx.today),
          type: "FULL_PAYMENT",
        });
        const made = (await transactionsOf(ctx, register)).filter(
          (row) => !before.has(str(row, "id")),
        );
        registerCashRows(ctx, made, `${item.label} of voucher ${created.id}`);
        if (booked.ok) {
          bookings.push({ voucher: created.id, amount: item.amount, label: item.label });
          data(ctx).mark("Voucher", created.id, "open voucher, paid in cash (resettable)");
        }
        const voucher = await ctx.read.byId("Voucher", created.id);
        lines.push(
          `${item.label} (voucher ${created.id}, ${item.amount} FULL_PAYMENT): ${outcomeOf(booked)}; voucher ${voucherState(voucher)}; ` +
            `new register transactions ${made.map(describeTransaction).join(", ") || "none"}` +
            (made[0] === undefined
              ? ""
              : ` (payeePayerName ${made[0]["payeePayerName"] === null ? "null" : "set"}, paymtPurpose ${made[0]["paymtPurpose"] === null ? "null" : "set"})`),
        );
      }
      const balanceBooked = await balance(ctx, register);
      for (const booking of bookings) {
        const before = new Set((await transactionsOf(ctx, register)).map((row) => str(row, "id")));
        const reset = await ctx.http.write("PUT", `/Voucher/${booking.voucher}/resetToOpen`, {
          tier: "commit",
        });
        const after = await transactionsOf(ctx, register);
        const left = after.filter((row) => before.has(str(row, "id")));
        // On a register the reset books a counter-entry instead of deleting (D-095).
        const added = after.filter((row) => !before.has(str(row, "id")));
        registerCashRows(ctx, added, `counter-entry of the reset of voucher ${booking.voucher}`);
        if (reset.ok) data(ctx).mark("Voucher", booking.voucher, "open voucher (payment reset)");
        lines.push(
          `resetToOpen on the ${booking.label} voucher ${booking.voucher}: ${outcomeOf(reset)}; register transactions kept ${left.length} of ${before.size}, new ${added.map(describeTransaction).join(", ") || "none"}`,
        );
      }
      lines.push(
        `getBalanceAtDate(today): before the bookings ${balanceBefore}, after them ${balanceBooked}, after the resets ${await balance(ctx, register)}`,
      );
      return {
        verdict: "observed",
        finding: `Register ${register}. ${lines.join(". ")}.`,
        deviations: { "D-071": "informs", "D-060": "informs" },
      };
    },
  },
  {
    id: "write-voucher-from-file",
    title: "createVoucherFromFile: sevDesk's own receipt recognition",
    mode: "write",
    optIn: true,
    question:
      "Opt-in and irreversible in part (the voucher sevDesk creates stays on the trial account; it can be deleted only while it is a draft): what does POST /Voucher/Factory/createVoucherFromFile answer for a generated tagged receipt PDF sent as multipart (field creditDebit C, file part voucher, as lippoliv/paperlessngx-to-sevdesk does; once more with the file part named file after a 4xx)? Does it create a draft voucher or only a suggestion, which fields does sevDesk fill (supplier, date, Belegnummer, sums, positions, document), and how long does the recognition take (polled every few seconds)?",
    deviations: ["D-024", "D-103"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const number = `${slug(tag)}-R1`;
      const bytes = await tinyPdf([
        `${tag} Lieferant GmbH`,
        "Musterstraße 1, 10115 Berlin",
        `Rechnung Nr. ${number}`,
        `Rechnungsdatum: ${germanDate(ctx.today)}`,
        "Bürobedarf 100,00 EUR",
        "zzgl. 19 % USt 19,00 EUR",
        "Gesamtbetrag 119,00 EUR",
      ]);
      const knownIds = new Set(
        (await ctx.read.page("/Voucher", undefined, 1000)).rows.map((row) => str(row, "id")),
      );
      const lines: string[] = [];
      const send = (field: "voucher" | "file") => {
        const form = new FormData();
        form.append("creditDebit", "C");
        form.append(
          field,
          new Blob([bytes], { type: "application/pdf" }),
          `${slug(tag)}-recognition.pdf`,
        );
        return ctx.http.write("POST", "/Voucher/Factory/createVoucherFromFile", {
          tier: "write",
          form,
        });
      };
      const started = Date.now();
      let result = await send("voucher");
      let field = "voucher";
      if (
        !result.ok &&
        result.status !== undefined &&
        result.status >= 400 &&
        result.status < 500
      ) {
        lines.push(`file part "voucher": ${outcomeOf(result)}`);
        result = await send("file");
        field = "file";
      }
      lines.push(
        `file part "${field}": ${outcomeOf(result)}${result.ok ? `, answer ${shapeOf(result.objects)}${firstRow(result.objects)?.["objectName"] === undefined ? "" : ` (objectName ${str(firstRow(result.objects), "objectName")})`}` : ""}`,
      );
      const newIds = (await ctx.read.page("/Voucher", undefined, 1000)).rows
        .map((row) => Number(row["id"]))
        .filter((id) => Number.isSafeInteger(id) && !knownIds.has(String(id)));
      const id = createdId(result.objects, "voucher") ?? newIds[0];
      if (id === undefined) {
        return {
          verdict: "observed",
          finding: `${lines.join(". ")}. No new voucher in GET /Voucher.`,
          deviations: { "D-024": "informs" },
        };
      }
      data(ctx).register("Voucher", id, "voucher from createVoucherFromFile (see the report)");
      lines.push(`new vouchers in the list: ${newIds.length}`);
      const recognised = (row: Row | undefined) =>
        Number(str(row, "sumGross")) > 0 && str(row, "supplierName") !== "";
      let row = await ctx.read.byId("Voucher", id);
      const firstRead = row;
      let polls = 1;
      while (!recognised(row) && polls < RECOGNITION_POLL.attempts) {
        await sleep(RECOGNITION_POLL.delayMs);
        row = await ctx.read.byId("Voucher", id);
        polls += 1;
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      const positions = (
        await ctx.read.page(
          "/VoucherPos",
          { "voucher[id]": id, "voucher[objectName]": "Voucher" },
          100,
        )
      ).rows.filter((item) => refId(item, "voucher") === id);
      const supplier = str(row, "supplierName");
      const description = str(row, "description");
      const status = str(row, "status");
      data(ctx).mark(
        "Voucher",
        id,
        status === "50"
          ? "draft voucher from createVoucherFromFile (deletable)"
          : `voucher status ${status} from createVoucherFromFile`,
      );
      lines.push(
        `voucher ${id} ${recognised(row) ? `recognised after ${polls} reads (about ${seconds} s)` : `not recognised after ${polls} reads (about ${seconds} s)`}: ` +
          `status ${status || "?"}, voucherType ${str(row, "voucherType") || "none"}, creditDebit ${str(row, "creditDebit") || "none"}, ` +
          `supplierName ${supplier === "" ? "empty" : supplier.includes(tag) ? "the PDF's supplier" : "set, not the PDF's supplier"}, ` +
          `supplier ${row?.["supplier"] === null || row?.["supplier"] === undefined ? "none" : "a contact"}, ` +
          `voucherDate ${str(row, "voucherDate").slice(0, 10) === ctx.today ? "the PDF's date" : valueFormat(row?.["voucherDate"] ?? null)}, ` +
          `description ${description === "" ? "empty" : description.includes(number) ? "the PDF's Rechnung Nr." : "set, not the PDF's number"}, ` +
          `sumNet ${str(row, "sumNet") || "none"}, sumTax ${str(row, "sumTax") || "none"}, sumGross ${str(row, "sumGross") || "none"}, ` +
          `taxRule ${JSON.stringify(row?.["taxRule"] ?? null)}, document ${row?.["document"] === null || row?.["document"] === undefined ? "none" : "set"}; ` +
          `positions ${positions.length}${positions[0] === undefined ? "" : ` (first: sumGross ${str(positions[0], "sumGross")}, taxRate ${str(positions[0], "taxRate")}, accountDatev ${JSON.stringify(positions[0]["accountDatev"] ?? null)})`}; ` +
          `fields that changed after the first read: ${Object.keys(changedFieldsMap(firstRead, row)).join(", ") || "none"}; voucher keys ${Object.keys(row ?? {}).join(", ")}`,
      );
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-024": "informs" },
      };
    },
  },
  {
    id: "write-export-datev-xml",
    title: "DATEV XML export job: start, progress, ZIP entries, exported marks",
    mode: "write",
    optIn: true,
    question:
      "Opt-in and irreversible (sevDesk may mark the exported documents as exported, which cannot be undone): does POST /Export/createDatevXmlZipExportJob?startDate&endDate (Unix seconds, last 31 days)&scope=EX (no enshrine flag; the spec has none for this job) start a job, do the progress and jobDownloadInfo answers match the CSV job (D-077), which host does the link name, what does the ZIP hold (entry names as patterns, sizes, a receipt image of a tagged open voucher with a receipt), does any invoice or voucher change (status, enshrined, update, any other key), and does a second job with includeExportedDocuments=false export fewer entries (documents marked as exported)?",
    deviations: ["D-023", "D-077", "D-102"],
    async run(ctx) {
      const lines: string[] = [];
      const voucher = await voucherWithReceipt(ctx, {
        label: "datev xml",
        status: 100,
        gross: 59.5,
      });
      lines.push(`Prepared ${voucher.note}`);
      const invoicesBefore = await snapshot(ctx, "/Invoice");
      const vouchersBefore = await snapshot(ctx, "/Voucher");
      const range = {
        startDate: berlinMidnight(addDays(ctx.today, -30)),
        endDate: berlinMidnight(addDays(ctx.today, 1)) - 1,
        scope: "EX",
      };
      const path = "/Export/createDatevXmlZipExportJob";
      const first = await runExportJob(ctx, path, range);
      lines.push(`First job: ${first.lines.join("; ")}`);
      lines.push(
        `Invoices afterwards: ${snapshotChanges(invoicesBefore, await snapshot(ctx, "/Invoice"))}; vouchers: ${snapshotChanges(vouchersBefore, await snapshot(ctx, "/Voucher"))}`,
      );
      if (first.entries === undefined) {
        return {
          verdict: "observed",
          finding: `${lines.join(". ")}.`,
          deviations: { "D-023": "informs", "D-077": "informs" },
        };
      }
      const second = await runExportJob(ctx, path, { ...range, includeExportedDocuments: false });
      lines.push(`Second job with includeExportedDocuments=false: ${second.lines.join("; ")}`);
      lines.push(
        `Entries: ${first.entries} → ${second.entries ?? "no ZIP"}${second.entries !== undefined && second.entries < first.entries ? " (fewer: the first job marked documents as exported)" : second.entries === first.entries ? " (the same: nothing visibly marked)" : ""}`,
      );
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
        deviations: { "D-023": "informs", "D-077": "informs" },
      };
    },
  },
  {
    id: "write-transaction-enshrine",
    title: "Enshrining ONE tagged transaction (irreversible)",
    mode: "write",
    optIn: true,
    question:
      "Opt-in and irreversible (festschreiben): on ONE tagged transaction of −20 the probe creates on the file-import account, is PUT /CheckAccountTransaction/{id}/enshrine refused at status 100 (which message)? After booking a tagged open voucher (gross 20) on it (status 400), what does enshrine answer, what changes on the transaction and the voucher, is a second enshrine accepted (idempotent, D-059), and can the transaction still be deleted, set back to 100, booked with a second voucher, or reset through resetToOpen on the voucher (D-060: code 322)? Without a booking it enshrines the transaction as private (300) instead. No other record is enshrined.",
    deviations: ["D-059", "D-060", "D-071", "D-098"],
    async run(ctx) {
      const imported = await importAccount(ctx);
      if (imported.id === undefined) return inconclusive(imported.note);
      const account = imported.id;
      const transaction = await postTransaction(ctx, account, { amount: -20, purpose: "enshrine" });
      if (transaction.id === undefined) {
        return inconclusive(`The transaction was ${outcomeOf(transaction.result)}.`);
      }
      const id = transaction.id;
      const lines: string[] = [];
      let before = await ctx.read.byId("CheckAccountTransaction", id);
      let enshrined = await enshrineOwnTransaction(ctx, id);
      lines.push(`enshrine at status 100: ${outcomeOf(enshrined)}`);

      let voucher: number | undefined;
      let voucherBefore: Row | undefined;
      if (!enshrined.ok) {
        const created = await createVoucher(ctx, { label: "enshrine", status: 100, gross: 20 });
        const booked =
          created.id === undefined
            ? undefined
            : await bookVoucher(ctx, created.id, {
                checkAccount: account,
                amount: -20,
                date: berlinNoon(ctx.today),
                type: "FULL_PAYMENT",
                transaction: id,
              });
        if (created.id !== undefined && booked?.ok === true) {
          voucher = created.id;
          data(ctx).mark("Voucher", created.id, "open voucher, paid via the enshrined transaction");
        }
        lines.push(
          `booking voucher ${created.id ?? `(${voucherFailure(created)})`} on it: ${booked === undefined ? "not tried" : outcomeOf(booked)}; transaction ${await transactionStatus(ctx, id)}`,
        );
        if (booked?.ok !== true) {
          const marked = await setTransactionStatus(ctx, id, 300);
          lines.push(`no booking: marked private instead (${outcomeOf(marked)})`);
        }
        before = await ctx.read.byId("CheckAccountTransaction", id);
        voucherBefore = voucher === undefined ? undefined : await ctx.read.byId("Voucher", voucher);
        enshrined = await enshrineOwnTransaction(ctx, id);
        lines.push(
          `enshrine at status ${str(before, "status") || "?"}: ${outcomeOf(enshrined)}${enshrined.ok ? `, answer ${shapeOf(enshrined.objects)}` : ""}`,
        );
      }
      if (!enshrined.ok) {
        return {
          verdict: "observed",
          finding: `Transaction ${id} on ${imported.note}. ${lines.join(". ")}.`,
        };
      }
      data(ctx).mark(
        "CheckAccountTransaction",
        id,
        "ENSHRINED by the opt-in probe (cannot be undone)",
      );
      const after = await ctx.read.byId("CheckAccountTransaction", id);
      const voucherAfter =
        voucher === undefined ? undefined : await ctx.read.byId("Voucher", voucher);
      lines.push(
        `transaction changed: ${
          Object.entries(changedFieldsMap(before, after))
            .map(([key, change]) =>
              key === "enshrined"
                ? `enshrined ${valueFormat(before?.[key] ?? null)} → ${valueFormat(after?.[key] ?? null)}`
                : `${key} ${change}`,
            )
            .join(", ") || "nothing"
        }` +
          (voucher === undefined
            ? ""
            : `; voucher ${voucher} changed: ${Object.keys(changedFieldsMap(voucherBefore, voucherAfter)).join(", ") || "nothing"}`),
      );
      const again = await enshrineOwnTransaction(ctx, id);
      lines.push(`second enshrine: ${outcomeOf(again)}`);
      const back = await setTransactionStatus(ctx, id, 100);
      lines.push(`PUT status 100: ${outcomeOf(back)}, then ${await transactionStatus(ctx, id)}`);
      const other = await createVoucher(ctx, { label: "enshrine other", status: 100, gross: 20 });
      const rebook =
        other.id === undefined
          ? undefined
          : await bookVoucher(ctx, other.id, {
              checkAccount: account,
              amount: -20,
              date: berlinNoon(ctx.today),
              type: "FULL_PAYMENT",
              transaction: id,
            });
      if (other.id !== undefined && rebook?.ok === true) {
        data(ctx).mark("Voucher", other.id, "open voucher, paid via the enshrined transaction");
      }
      lines.push(
        `booking ${voucher === undefined ? "a" : "a second"} voucher ${other.id ?? `(${voucherFailure(other)})`} on it: ${rebook === undefined ? "not tried" : outcomeOf(rebook)}`,
      );
      if (voucher !== undefined) {
        const reset = await ctx.http.write("PUT", `/Voucher/${voucher}/resetToOpen`, {
          tier: "commit",
        });
        if (reset.ok) data(ctx).mark("Voucher", voucher, "open voucher (payment reset)");
        lines.push(
          `resetToOpen on voucher ${voucher}: ${outcomeOf(reset)}; voucher ${voucherState(await ctx.read.byId("Voucher", voucher))}; transaction ${await transactionStatus(ctx, id)}`,
        );
      }
      lines.push(`DELETE: ${await deleteTransaction(ctx, id)}`);
      return {
        verdict: "observed",
        finding: `Transaction ${id} on ${imported.note}. ${lines.join(". ")}.`,
        deviations: { "D-059": "informs", "D-060": "informs" },
      };
    },
  },
  {
    id: "read-check-account-kinds",
    title: "Which check account fields tell file-import, offline, register and online accounts",
    mode: "read",
    question:
      "Which fields of GET /CheckAccount tell a file-import account (type online, importType CSV/MT940) from a real online bank account (bankServer, autoSyncTransactions, lastSync) and from offline accounts, clearing accounts and cash registers? Per kind the values of type, importType, bankServer, autoSyncTransactions, lastSync, autoMapTransactions, baseAccount, defaultAccount and status (codes and flags only), and the keys of a row.",
    deviations: ["D-097", "D-071"],
    async run(ctx) {
      const page = await ctx.read.page("/CheckAccount", undefined, 100);
      if (!page.result.ok)
        return { verdict: "observed", finding: `Refused: ${outcomeOf(page.result)}.` };
      if (page.rows.length === 0) return inconclusive("The account has no check accounts.");
      const kinds = new Map<string, number>();
      for (const row of page.rows) {
        const kind = accountKind(row);
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      const connected = page.rows.filter(
        (row) =>
          str(row, "type") === "online" &&
          str(row, "importType") === "" &&
          str(row, "bankServer") !== "",
      ).length;
      return {
        verdict: "observed",
        finding:
          `${page.rows.length} accounts in ${kinds.size} kinds: ${[...kinds].map(([kind, count]) => `${count} × {${kind}}`).join("; ")}. ` +
          `${connected === 0 ? "No account looks bank-connected (online without importType, with a bankServer)" : `${connected} look bank-connected (online without importType, with a bankServer)`}. ` +
          `Row keys: ${Object.keys(page.rows[0] ?? {}).join(", ")}.`,
        deviations: { "D-071": "informs" },
      };
    },
  },
  {
    id: "read-transaction-soft-delete",
    title: "Soft-deleted transactions and archived accounts in lists and balances",
    mode: "read",
    question:
      "DELETE /CheckAccountTransaction/{id} only sets deletedAt (D-096) and DELETE /CheckAccount/{id} only archives (status 0, D-097). Does GET /CheckAccountTransaction (without a filter, and per active account) still list rows with deletedAt set, does it list rows of accounts GET /CheckAccount no longer shows, and does getBalanceAtDate(today) of an active account count its soft-deleted rows (sum of all listed amounts against the sum without them)? (Ids, statuses and counts only.)",
    deviations: ["D-096", "D-097"],
    async run(ctx) {
      const accounts = await ctx.read.page("/CheckAccount", undefined, 100);
      if (!accounts.result.ok) {
        return { verdict: "observed", finding: `Refused: ${outcomeOf(accounts.result)}.` };
      }
      const active = new Set(accounts.rows.map((row) => str(row, "id")));
      const all = await ctx.read.page("/CheckAccountTransaction", undefined, 1000);
      if (!all.result.ok) {
        return { verdict: "observed", finding: `Refused: ${outcomeOf(all.result)}.` };
      }
      const deletedOf = (rows: readonly Row[]) =>
        rows.filter((row) => str(row, "deletedAt") !== "");
      const deleted = deletedOf(all.rows);
      const orphaned = all.rows.filter((row) => !active.has(String(refId(row, "checkAccount"))));
      const lines = [
        `GET /CheckAccountTransaction without a filter: ${all.rows.length} rows (total ${String(all.total)}), ` +
          `${deleted.length} with deletedAt (${deleted.map((row) => `${str(row, "id")} status ${str(row, "status")}`).join(", ") || "none"}), ` +
          `${orphaned.length} of accounts not in GET /CheckAccount`,
      ];
      for (const id of [...active].slice(0, 10)) {
        const rows = await transactionsOf(ctx, Number(id));
        const gone = deletedOf(rows);
        const sum = (items: readonly Row[]) => centsText(items.map((row) => str(row, "amount")));
        const kept = rows.filter((row) => str(row, "deletedAt") === "");
        lines.push(
          `account ${id}: ${rows.length} rows, ${gone.length} with deletedAt; sum of all ${sum(rows)}, without the deleted ${sum(kept)}; getBalanceAtDate ${await balance(ctx, Number(id))}`,
        );
      }
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}.`,
      };
    },
  },
  {
    id: "read-document-hash",
    title: "contentHash of existing documents against their downloaded bytes",
    mode: "read",
    question:
      "For up to three rows of GET /Document: does contentHash equal the SHA-256, MD5 or SHA-1 of the bytes GET /Document/{id}/download returns, and which other keys of the row mention a hash? (Hashes are compared, never shown; the files are not kept.)",
    deviations: ["D-100", "D-024"],
    async run(ctx) {
      const page = await ctx.read.page("/Document", undefined, 100);
      if (!page.result.ok)
        return { verdict: "observed", finding: `Refused: ${outcomeOf(page.result)}.` };
      const rows = page.rows.slice(0, 3);
      if (rows.length === 0)
        return inconclusive("No documents in the account (upload a receipt first).");
      const lines: string[] = [];
      for (const row of rows) {
        const id = str(row, "id");
        const download = await ctx.http.get(`/Document/${id}/download`);
        const bytes = download.ok ? envelopeBytes(download.objects) : undefined;
        lines.push(
          `Document ${id} (${str(row, "extension") || "no extension"}, filesize ${str(row, "filesize") || "none"}): ` +
            (bytes === undefined
              ? `download ${download.ok ? `without content (${shapeOf(download.objects)})` : outcomeOf(download)}; contentHash ${row["contentHash"] === undefined ? "absent" : row["contentHash"] === null ? "null" : "set"}`
              : `${bytes.length} bytes; contentHash is ${hashMatch(row["contentHash"], hashesOf(bytes), "the downloaded bytes")}`),
        );
      }
      return {
        verdict: "observed",
        finding: `${lines.join(". ")}. Hash keys of a row: ${hashKeys(rows[0]).join(", ") || "none"}.`,
        deviations: { "D-024": "informs" },
      };
    },
  },
];
