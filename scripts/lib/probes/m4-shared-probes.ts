/**
 * Helpers shared by the M4 probe modules (vouchers, banking, reports, e-invoices): generated test
 * files, the uploads and records the probes create, account lookups and read-back comparisons.
 * No probe lives here.
 *
 * Everything a probe creates carries the run tag (voucher description and supplier, transaction
 * purpose and counterparty, contact names) and is registered for the cleanup list. What the probes
 * send is deterministic for one run: fixed amounts, dates derived from the run's `today`, files
 * generated with fixed metadata.
 */
import { AFRelationship, PDFDocument, PDFName, StandardFonts } from "pdf-lib";

import { rowsOf } from "../fixture-plan.js";
import {
  berlinMidnight,
  createdId,
  germanDate,
  type HttpResult,
  type ProbeContext,
  type ProbeOutcome,
  refId,
  type Row,
  str,
  type TestData,
} from "./core.js";

export function data(ctx: ProbeContext): TestData {
  if (ctx.data === undefined) throw new Error("This probe needs write mode (--allow-writes).");
  return ctx.data;
}

export function inconclusive(finding: string): ProbeOutcome {
  return { verdict: "inconclusive", finding };
}

/** Unix seconds of 12:00 Europe/Berlin on `date` (what the payment tools send, D-056). */
export function berlinNoon(date: string): number {
  return berlinMidnight(date) + 12 * 3600;
}

/** 12:00 Europe/Berlin on `date` as an ISO date-time in UTC (`…T11:00:00.000Z` in winter). */
export function isoNoon(date: string): string {
  return new Date(berlinNoon(date) * 1000).toISOString();
}

/** `YYYY-MM-DD` → `YYYYMMDD` (CII date format 102). */
export function compactDate(date: string): string {
  return date.replace(/-/g, "");
}

/** The run tag without spaces, for file names and references. */
export function slug(tag: string): string {
  return tag.replace(/[^A-Za-z0-9-]+/g, "-");
}

/** Scalar fields that differ between two reads of one record (`update` and `ignore` skipped). */
export function changedFields(
  before: Row | undefined,
  after: Row | undefined,
  ignore: readonly string[] = [],
): string {
  const skip = new Set(["update", ...ignore]);
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: string[] = [];
  for (const key of [...keys].sort()) {
    if (skip.has(key)) continue;
    const a = JSON.stringify(before?.[key] ?? null);
    const b = JSON.stringify(after?.[key] ?? null);
    if (a !== b) changes.push(`${key}: ${a} → ${b}`);
  }
  return changes.join("; ");
}

/** The keys of an answer's object, or of its first row. */
export function keysOf(objects: unknown): string[] {
  const first = Array.isArray(objects) ? (objects[0] as unknown) : objects;
  return first !== null && typeof first === "object" ? Object.keys(first) : [];
}

/** A short description of an answer's `objects`: list or object, and its keys. */
export function shapeOf(objects: unknown): string {
  if (Array.isArray(objects)) {
    const keys = keysOf(objects);
    return `a list of ${objects.length}${keys.length > 0 ? ` of objects with keys ${keys.join(", ")}` : ""}`;
  }
  if (objects !== null && typeof objects === "object") {
    return `an object with keys ${Object.keys(objects).join(", ") || "(none)"}`;
  }
  return objects === null ? "null" : objects === undefined ? "nothing" : typeof objects;
}

/** `ok`, or the refusal with sevDesk's message. */
export function outcomeOf(result: HttpResult): string {
  return result.ok
    ? "ok"
    : `refused (${String(result.status ?? result.kind)}: ${result.message ?? "no message"})`;
}

/** The first row of an answer's `objects` (object or list). */
export function firstRow(objects: unknown): Row | undefined {
  return objects === undefined || objects === null ? undefined : rowsOf(objects)[0];
}

/** Whether a GET by id says the record is gone (404/400, or an empty list). */
export function isGone(result: HttpResult): boolean {
  return (
    (!result.ok && (result.status === 400 || result.status === 404)) ||
    (result.ok && Array.isArray(result.objects) && result.objects.length === 0)
  );
}

// ---------------------------------------------------------------------------------------------
// Generated files
// ---------------------------------------------------------------------------------------------

/** Fixed metadata dates, so a generated PDF has the same bytes in every run with the same text. */
const FILE_DATE = new Date(Date.UTC(2026, 0, 1));

/** A one-page A4 PDF with the given lines (Helvetica), deterministic for the same input. */
export async function tinyPdf(
  lines: readonly string[],
  attachment?: { readonly name: string; readonly xml: string; readonly xmp: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(lines[0] ?? "probe");
  doc.setProducer("mcp-server-sevdesk API probe");
  doc.setCreator("mcp-server-sevdesk API probe");
  doc.setCreationDate(FILE_DATE);
  doc.setModificationDate(FILE_DATE);
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((line, index) => {
    page.drawText(line, { x: 56, y: 780 - index * 18, size: 12, font });
  });
  if (attachment !== undefined) {
    await doc.attach(new TextEncoder().encode(attachment.xml), attachment.name, {
      mimeType: "text/xml",
      description: "Factur-X invoice",
      creationDate: FILE_DATE,
      modificationDate: FILE_DATE,
      afRelationship: AFRelationship.Alternative,
    });
    const metadata = doc.context.stream(attachment.xmp, { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(metadata));
  }
  return doc.save({ useObjectStreams: false });
}

/** A valid 1×1 PNG. */
export const TINY_PNG: Uint8Array = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

/** A multipart body with one `file` part (the field `uploadTempFile` reads, D-011). */
function fileForm(bytes: Uint8Array, fileName: string, type: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), fileName);
  return form;
}

/** `POST /Voucher/Factory/uploadTempFile` with one file; the token sevDesk answers, if any. */
export async function uploadTempFile(
  ctx: ProbeContext,
  bytes: Uint8Array,
  fileName: string,
  type: string,
): Promise<{ readonly result: HttpResult; readonly token: string | undefined }> {
  const result = await ctx.http.write("POST", "/Voucher/Factory/uploadTempFile", {
    tier: "write",
    form: fileForm(bytes, fileName, type),
  });
  const token = firstRow(result.objects)?.["filename"];
  return { result, token: typeof token === "string" && token !== "" ? token : undefined };
}

/**
 * The shape of an upload answer without its values: keys, the token's pattern (hex runs shown as
 * `<n hex>`), media types, page count, and the preview's type and size (B6: stripped by the tools).
 */
export function describeUpload(objects: unknown): string {
  const row = firstRow(objects);
  if (row === undefined) return `answer ${shapeOf(objects)}`;
  const token = row["filename"];
  const content = row["content"];
  const contentShape = Array.isArray(content)
    ? `a list of ${content.length} (${[...new Set(content.map((item) => (typeof item === "string" ? `string of ${item.length}` : typeof item)))].join(", ")})`
    : typeof content === "string"
      ? `a string of ${content.length} characters`
      : content === null || content === undefined
        ? "absent"
        : typeof content;
  return (
    `keys ${Object.keys(row).join(", ")}; filename ${typeof token === "string" ? `"${tokenPattern(token)}"` : JSON.stringify(token ?? null)}, ` +
    `mimeType ${str(row, "mimeType") || "none"}, originMimeType ${str(row, "originMimeType") || "none"}, pages ${str(row, "pages") || "none"}, ` +
    `contentHash ${typeof row["contentHash"] === "string" ? `"${tokenPattern(row["contentHash"])}"` : JSON.stringify(row["contentHash"] ?? null)}, content ${contentShape}, ` +
    `isEInvoice ${Object.hasOwn(row, "isEInvoice") ? JSON.stringify(row["isEInvoice"]) : "absent"}`
  );
}

/** `f019…0681.pdf` → `<32 hex>.pdf`: the pattern of a token, never its value. */
export function tokenPattern(value: string): string {
  return value.replace(/[0-9a-fA-F]{8,}/g, (run) => `<${run.length} hex>`).slice(0, 80);
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

/**
 * The first active offline bank account (type `offline`, Verrechnungskonto). sevDesk refuses
 * hand-made transactions on it (422 "You can only create transactions on online
 * checkaccounts", recorded 2026-11-08); `bookAmount` without a transaction creates one (D-071).
 */
export async function offlineAccount(ctx: ProbeContext): Promise<number | undefined> {
  const row = await ctx.read.first(
    "/CheckAccount",
    undefined,
    (item) => str(item, "status") !== "0" && str(item, "type") === "offline",
  );
  const id = Number(row?.["id"]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** A bank account the probes may create transactions on, or why there is none. */
export interface ImportAccount {
  readonly id: number | undefined;
  /** For findings: the account created, or sevDesk's refusal. */
  readonly note: string;
}

const importAccountCache = new WeakMap<object, Promise<ImportAccount>>();

/**
 * A tagged file-import bank account (`POST /CheckAccount/Factory/fileImportAccount`, import type
 * CSV, default booking account), created once per run and registered for cleanup. sevDesk lets
 * transactions be created by hand only on such "online" accounts.
 */
export function importAccount(ctx: ProbeContext): Promise<ImportAccount> {
  let cached = importAccountCache.get(ctx.read);
  if (cached === undefined) {
    cached = createImportAccount(ctx);
    importAccountCache.set(ctx.read, cached);
  }
  return cached;
}

async function createImportAccount(ctx: ProbeContext): Promise<ImportAccount> {
  const result = await ctx.http.write("POST", "/CheckAccount/Factory/fileImportAccount", {
    tier: "write",
    body: { name: `${data(ctx).tag} Import`, importType: "CSV" },
  });
  const id = createdId(result.objects);
  if (id === undefined) {
    return { id, note: `fileImportAccount ${outcomeOf(result)}` };
  }
  data(ctx).register("CheckAccount", id, "file-import bank account (delete it in the web app)");
  const row = await ctx.read.byId("CheckAccount", id);
  return {
    id,
    note: `file-import account ${id} (type ${str(row, "type") || "?"}, importType ${str(row, "importType") || "?"}, accountingNumber ${str(row, "accountingNumber") || "none"})`,
  };
}

/** Booking accounts (AccountDatev ids) the voucher probes use, from ReceiptGuidance. */
export interface BookingAccounts {
  /** An expense account that takes tax rule 9 at 19 % (SKR04 6815 Bürobedarf preferred). */
  readonly expense: number | undefined;
  /** A revenue account that takes tax rule 1 at 19 % (SKR04 4400 preferred). */
  readonly revenue: number | undefined;
  /** What was found, for findings. */
  readonly note: string;
}

const accountCache = new WeakMap<object, Promise<BookingAccounts>>();

/** {@link BookingAccounts} of the run's account (read once per run). */
export function bookingAccounts(ctx: ProbeContext): Promise<BookingAccounts> {
  let cached = accountCache.get(ctx.read);
  if (cached === undefined) {
    cached = loadBookingAccounts(ctx);
    accountCache.set(ctx.read, cached);
  }
  return cached;
}

async function loadBookingAccounts(ctx: ProbeContext): Promise<BookingAccounts> {
  const result = await ctx.http.get("/ReceiptGuidance/forAllAccounts");
  const rows = result.ok && result.objects !== undefined ? rowsOf(result.objects) : [];
  const allows = (row: Row, rule: number, rate: string, type: string) =>
    Array.isArray(row["allowedReceiptTypes"]) &&
    (row["allowedReceiptTypes"] as unknown[]).includes(type) &&
    Array.isArray(row["allowedTaxRules"]) &&
    (row["allowedTaxRules"] as Row[]).some(
      (item) =>
        Number(item["id"]) === rule &&
        Array.isArray(item["taxRates"]) &&
        (item["taxRates"] as unknown[]).includes(rate),
    );
  const pick = (preferred: string, rule: number, type: string) => {
    const fits = rows.filter((row) => allows(row, rule, "NINETEEN", type));
    const row = fits.find((item) => str(item, "accountNumber") === preferred) ?? fits[0];
    const id = Number(row?.["accountDatevId"]);
    return {
      id: Number.isSafeInteger(id) && id > 0 ? id : undefined,
      label:
        row === undefined
          ? "none"
          : `${str(row, "accountNumber")} (id ${str(row, "accountDatevId")})`,
    };
  };
  const expense = pick("6815", 9, "EXPENSE");
  const revenue = pick("4400", 1, "REVENUE");
  return {
    expense: expense.id,
    revenue: revenue.id,
    note: result.ok
      ? `${rows.length} guidance rows; expense account ${expense.label}, revenue account ${revenue.label}`
      : `ReceiptGuidance unreadable (${outcomeOf(result)})`,
  };
}

// ---------------------------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------------------------

export interface VoucherOptions {
  /** Expense (`C`, rule 9, default) or revenue (`D`, rule 1). */
  readonly kind?: "expense" | "revenue";
  /** 50 draft (default) or 100 open. */
  readonly status?: 50 | 100;
  /** Gross 119.00 with `net: false` (default), or net 100.00 with `net: true`. */
  readonly net?: boolean;
  /** Gross amount when `net` is false (default 119). */
  readonly gross?: number;
  readonly taxRuleId?: string;
  /** AccountDatev id; default from {@link bookingAccounts}. */
  readonly accountDatevId?: number;
  /** An uploaded file's token and where it goes (B5/D-026). */
  readonly file?: {
    readonly token: string;
    readonly placement: "top-level" | "inside-voucher" | "first";
  };
  /** Short label in the description (Belegnummer), after the tag. */
  readonly label: string;
}

/** One voucher position as the probes send it. */
export function voucherPosition(
  tag: string,
  accountDatevId: number,
  options: { readonly net: boolean; readonly amount: number; readonly label: string },
): Record<string, unknown> {
  return {
    objectName: "VoucherPos",
    mapAll: true,
    accountDatev: { id: accountDatevId, objectName: "AccountDatev" },
    taxRate: 19,
    net: options.net,
    ...(options.net ? { sumNet: options.amount } : { sumGross: options.amount }),
    comment: `${tag} ${options.label}`,
    isAsset: false,
  };
}

/**
 * The `saveVoucher` body: keys in the order `voucher`, `voucherPosSave`, `voucherPosDelete`,
 * `filename` (B5/D-026), or with the file token inside `voucher` or first, as asked.
 */
/**
 * The `voucher` header the probes send (without a file token): dates of today, no supplier
 * contact, the tagged supplier name and Belegnummer, status, tax rule, direction.
 */
function voucherHeader(
  ctx: ProbeContext,
  options: Omit<VoucherOptions, "file">,
): Record<string, unknown> {
  const tag = data(ctx).tag;
  const revenue = options.kind === "revenue";
  return {
    objectName: "Voucher",
    mapAll: true,
    voucherDate: germanDate(ctx.today),
    deliveryDate: germanDate(ctx.today),
    supplier: null,
    supplierName: `${tag} ${revenue ? "Kunde" : "Lieferant"}`,
    description: `${tag} ${options.label}`,
    status: options.status ?? 50,
    taxRule: { id: options.taxRuleId ?? (revenue ? "1" : "9"), objectName: "TaxRule" },
    creditDebit: revenue ? "D" : "C",
    voucherType: "VOU",
    currency: "EUR",
  };
}

/**
 * `saveVoucher` of an existing voucher with its header as the probes created it, a new status and
 * `voucherPosSave`/`voucherPosDelete` null (positions untouched), like the finalize tool sends it.
 * Tier `write` only for status 50, else `commit` (the client's rule).
 */
export function saveVoucherStatus(
  ctx: ProbeContext,
  id: number,
  options: Omit<VoucherOptions, "file"> & { readonly status: 50 | 100 },
  override: Readonly<Record<string, unknown>> = {},
): Promise<HttpResult> {
  return ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
    tier: options.status === 50 ? "write" : "commit",
    body: {
      voucher: { ...voucherHeader(ctx, options), id, ...override },
      voucherPosSave: null,
      voucherPosDelete: null,
    },
  });
}

function voucherBody(
  ctx: ProbeContext,
  accountDatevId: number,
  options: VoucherOptions,
): Record<string, unknown> {
  const tag = data(ctx).tag;
  const net = options.net ?? false;
  const voucher: Record<string, unknown> = {
    ...voucherHeader(ctx, options),
    ...(options.file?.placement === "inside-voucher" ? { filename: options.file.token } : {}),
  };
  const positions = [
    voucherPosition(tag, accountDatevId, {
      net,
      amount: net ? 100 : (options.gross ?? 119),
      label: `${options.label} position`,
    }),
  ];
  if (options.file?.placement === "first") {
    return {
      filename: options.file.token,
      voucher,
      voucherPosSave: positions,
      voucherPosDelete: null,
    };
  }
  return {
    voucher,
    voucherPosSave: positions,
    voucherPosDelete: null,
    ...(options.file?.placement === "top-level" ? { filename: options.file.token } : {}),
  };
}

/** Creates a tagged voucher with `saveVoucher` and registers it; `id` undefined when refused. */
export async function createVoucher(
  ctx: ProbeContext,
  options: VoucherOptions,
): Promise<{
  readonly id: number | undefined;
  readonly result: HttpResult;
  readonly why?: string;
}> {
  const accounts = await bookingAccounts(ctx);
  const accountDatevId =
    options.accountDatevId ?? (options.kind === "revenue" ? accounts.revenue : accounts.expense);
  if (accountDatevId === undefined) {
    return {
      id: undefined,
      result: { ok: false, status: undefined, message: "no booking account" },
      why: `no ${options.kind ?? "expense"} booking account for rule ${options.kind === "revenue" ? 1 : 9} at 19 % (${accounts.note})`,
    };
  }
  // The client needs `commit` for a saveVoucher that is not a draft (status 50).
  const result = await ctx.http.write("POST", "/Voucher/Factory/saveVoucher", {
    tier: (options.status ?? 50) === 50 ? "write" : "commit",
    body: voucherBody(ctx, accountDatevId, options),
  });
  const id = createdId(result.objects, "voucher");
  if (id !== undefined) {
    data(ctx).register(
      "Voucher",
      id,
      (options.status ?? 50) === 100 ? "open voucher (status 100)" : "draft voucher (deletable)",
    );
  }
  return { id, result };
}

/** Why a voucher could not be created, for inconclusive findings. */
export function voucherFailure(created: {
  readonly result: HttpResult;
  readonly why?: string;
}): string {
  return created.why ?? `saveVoucher ${outcomeOf(created.result)}`;
}

/** Positions of a voucher (`GET /VoucherPos?voucher[id]=…`), only its own rows. */
export async function voucherPositions(ctx: ProbeContext, voucherId: number): Promise<Row[]> {
  const page = await ctx.read.page(
    "/VoucherPos",
    { "voucher[id]": voucherId, "voucher[objectName]": "Voucher" },
    100,
  );
  return page.rows.filter((row) => refId(row, "voucher") === voucherId);
}

/** `id (net …, sumNet …, sumGross …)` for each position. */
export function describePositions(rows: readonly Row[]): string {
  return (
    rows
      .map(
        (row) =>
          `${str(row, "id")} (net ${str(row, "net")}, sumNet ${str(row, "sumNet")}, sumTax ${str(row, "sumTax")}, sumGross ${str(row, "sumGross")})`,
      )
      .join(", ") || "none"
  );
}

/** Voucher fields the probes report after a change. */
export function voucherState(row: Row | undefined): string {
  return (
    `status ${str(row, "status") || "?"}, sumNet ${str(row, "sumNet")}, sumGross ${str(row, "sumGross")}, ` +
    `paidAmount ${JSON.stringify(row?.["paidAmount"] ?? null)}, payDate ${str(row, "payDate") || "none"}`
  );
}

/** `PUT /Voucher/{id}/bookAmount` on a check account, optionally linking a transaction. */
export function bookVoucher(
  ctx: ProbeContext,
  voucherId: number,
  options: {
    readonly checkAccount: number;
    readonly amount: number;
    readonly date: number | string;
    readonly type: "N" | "FULL_PAYMENT";
    readonly transaction?: number;
  },
): Promise<HttpResult> {
  return ctx.http.write("PUT", `/Voucher/${voucherId}/bookAmount`, {
    tier: "commit",
    body: {
      amount: options.amount,
      date: options.date,
      type: options.type,
      checkAccount: { id: options.checkAccount, objectName: "CheckAccount" },
      ...(options.transaction === undefined
        ? {}
        : {
            checkAccountTransaction: {
              id: options.transaction,
              objectName: "CheckAccountTransaction",
            },
          }),
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

/** Transactions of one check account (up to 1,000), only its own rows. */
export async function transactionsOf(ctx: ProbeContext, accountId: number): Promise<Row[]> {
  const page = await ctx.read.page(
    "/CheckAccountTransaction",
    { "checkAccount[id]": accountId, "checkAccount[objectName]": "CheckAccount" },
    1000,
  );
  return page.rows.filter((row) => refId(row, "checkAccount") === accountId);
}

/** `id (amount …, status …, valueDate …, entryDate …)`. */
export function describeTransaction(row: Row | undefined): string {
  if (row === undefined) return "none";
  return (
    `${str(row, "id")} (amount ${str(row, "amount")}, status ${str(row, "status")}, ` +
    `valueDate ${str(row, "valueDate") || "none"}, entryDate ${str(row, "entryDate") || "none"})`
  );
}

/**
 * Creates a tagged transaction on a check account (`POST /CheckAccountTransaction`, status 100)
 * and registers it. Dates are ISO date-times of 12:00 Berlin, so either reading keeps the day.
 * Only online accounts take it (see {@link importAccount}).
 */
export async function createTransaction(
  ctx: ProbeContext,
  accountId: number,
  options: {
    readonly amount: number;
    readonly label: string;
    readonly valueDate?: string;
    readonly entryDate?: string;
  },
): Promise<{ readonly id: number | undefined; readonly result: HttpResult }> {
  const tag = data(ctx).tag;
  const result = await ctx.http.write("POST", "/CheckAccountTransaction", {
    tier: "write",
    body: {
      objectName: "CheckAccountTransaction",
      mapAll: true,
      valueDate: isoNoon(options.valueDate ?? ctx.today),
      entryDate: isoNoon(options.entryDate ?? options.valueDate ?? ctx.today),
      amount: options.amount,
      paymtPurpose: `${tag} ${options.label}`,
      payeePayerName: `${tag} Gegenpartei`,
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

/** The `CheckAccountTransactionLog` entries of one transaction (D-057). */
export async function transactionLog(
  ctx: ProbeContext,
  transactionId: number,
): Promise<{ readonly rows: Row[]; readonly result: HttpResult }> {
  const page = await ctx.read.page(
    "/CheckAccountTransactionLog",
    {
      "checkAccountTransaction[id]": transactionId,
      "checkAccountTransaction[objectName]": "CheckAccountTransaction",
    },
    100,
  );
  return { rows: page.rows, result: page.result };
}

/**
 * A log entry without values: its keys, `amountPaid`, the status move and which references it
 * holds (`key → objectName id`).
 */
export function describeLogEntry(row: Row): string {
  const refs = Object.entries(row)
    .filter(
      ([key, value]) =>
        key !== "sevClient" &&
        value !== null &&
        typeof value === "object" &&
        typeof (value as Row)["objectName"] === "string",
    )
    .map(
      ([key, value]) => `${key} → ${str(value as Row, "objectName")} ${str(value as Row, "id")}`,
    );
  return (
    `amountPaid ${str(row, "amountPaid") || "none"}, status ${str(row, "fromStatus") || "?"} → ${str(row, "toStatus") || "?"}, ` +
    `refs: ${refs.join(", ") || "none"}`
  );
}
