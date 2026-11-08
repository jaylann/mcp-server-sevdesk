/**
 * The DATEV export (DATEV-Export, Buchungsstapel as CSV in a ZIP) through sevDesk's export job.
 * Recorded live on the trial account (opt-in DATEV probe run, 2026-11-08):
 *
 * 1. `POST /Export/createDatevCsvZipExportJob` with the query `startDate`/`endDate` (Unix seconds),
 *    `scope` (letters E earnings, X expenditure, T transactions, C cash register, D assets),
 *    optional `exportByPaydate` and `includeDocumentImages`, no body → `objects` = the job id (a
 *    UUID string). The spec declares a GET; sevDesk refuses it with 500 "Function
 *    createDatevCsvZipExportJob was called with wrong HTTP Type". **Never `enshrineDocuments`**:
 *    that flag enshrines (festschreiben, irreversible) every exported document; the query is built
 *    from a fixed key list, and the HTTP client refuses the flag below the commit tier anyway
 *    (D-023).
 * 2. `GET /Progress/generateDownloadHash?jobId` → `{progressHash}`, then
 *    `GET /Progress/getProgress?hash` → `{percent, current, errors, total, failure}` until
 *    `current` reaches `total` (4 polls on a small account). `failure` or `errors` mean the job
 *    failed.
 * 3. `GET /ExportJob/jobDownloadInfo?jobId` → `{jobId, linkExpireDate, link, filename}`; the link
 *    is a presigned S3 URL valid for about 7 days, downloaded by `src/sevdesk/export-download.ts`
 *    and never shown; the file name looks like
 *    `BITTE-ENTPACKEN_Buchungsstapel_<accountant>_<client>_<from>_bis_<to>.zip`.
 *
 * Without the DATEV settings (accountant number, client number, start of the fiscal year) the job
 * start fails with 500 "Call to a member function getIso() on null", so they are checked first:
 * `GET /SevClient` carries them as `accountantNumber`, `accountantClientNumber` and
 * `accountingYearBegin` (`null` when not set). An exported invoice and voucher read back unchanged
 * (no visible "exported" mark).
 */
import { z } from "zod";

import { toBerlinDate, toUnixSeconds } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { realSleep, type Sleep } from "../../sevdesk/pacing.js";
import { parseUpstream, zText } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";

export const DATEV_SCOPE_KEYS = [
  "earnings",
  "expenditure",
  "transactions",
  "cash_register",
  "assets",
] as const;
export type DatevScopeKey = (typeof DATEV_SCOPE_KEYS)[number];

/** Spec `exportDatevCSV` → `scope`: one letter per included model, in this order. */
const SCOPE_LETTERS: Readonly<Record<DatevScopeKey, string>> = {
  earnings: "E",
  expenditure: "X",
  transactions: "T",
  cash_register: "C",
  assets: "D",
};

/** Labels for previews. */
export const SCOPE_LABELS: Readonly<Record<DatevScopeKey, string>> = {
  earnings: "Einnahmen (earnings)",
  expenditure: "Ausgaben (expenditure)",
  transactions: "Kontoumsätze (transactions)",
  cash_register: "Kasse (cash register)",
  assets: "Anlagen (assets)",
};

/** The `scope` parameter for a set of keys, e.g. "EXTCD" (always in the spec's order). */
export function scopeParameter(keys: readonly DatevScopeKey[]): string {
  return DATEV_SCOPE_KEYS.filter((key) => keys.includes(key))
    .map((key) => SCOPE_LETTERS[key])
    .join("");
}

/** Path of the job start (POST). */
export const DATEV_JOB_PATH = "/Export/createDatevCsvZipExportJob";
export const DATEV_HASH_PATH = "/Progress/generateDownloadHash";
export const DATEV_PROGRESS_PATH = "/Progress/getProgress";
export const DATEV_DOWNLOAD_INFO_PATH = "/ExportJob/jobDownloadInfo";

/** A sevDesk job id or progress hash: letters, digits, `-` and `_` only. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

// ---------------------------------------------------------------------------------------------
// DATEV settings
// ---------------------------------------------------------------------------------------------

/** The DATEV settings of the account (`GET /SevClient`). */
export interface DatevExportConfig {
  /** Beraternummer, when set. */
  readonly accountantNumber?: string | undefined;
  /** Mandantennummer, when set. */
  readonly accountantClientNumber?: string | undefined;
  /** Start of the fiscal year (Wirtschaftsjahresbeginn), YYYY-MM-DD, when set. */
  readonly accountingYearBegin?: string | undefined;
  /** Readable names of the settings that are missing; empty when the export can run. */
  readonly missing: readonly string[];
}

const exportConfigSchema = z.object({
  accountantNumber: zText.catch(undefined),
  accountantClientNumber: zText.catch(undefined),
  accountingYearBegin: z.unknown().optional(),
});

/** A setting value: digits only (anything else counts as missing and stays out of previews). */
function digits(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text !== undefined && /^\d{1,12}$/.test(text) && !/^0+$/.test(text) ? text : undefined;
}

/**
 * Reads the DATEV settings from `GET /SevClient` (read fresh: the user may just have set them).
 * Throws `unexpected_response` when the answer has no object.
 */
export async function readDatevExportConfig(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<DatevExportConfig> {
  const payload = await client.request({
    method: "GET",
    path: "/SevClient",
    ...(signal === undefined ? {} : { signal }),
  });
  const row: unknown = Array.isArray(payload) ? (payload as unknown[])[0] : payload;
  if (typeof row !== "object" || row === null) throw unexpected("the account settings");
  const record = parseUpstream(exportConfigSchema, row, "the account settings");
  let yearBegin: string | undefined;
  try {
    yearBegin = toBerlinDate(record.accountingYearBegin);
  } catch {
    yearBegin = undefined;
  }
  const accountantNumber = digits(record.accountantNumber);
  const accountantClientNumber = digits(record.accountantClientNumber);
  const missing = [
    accountantNumber === undefined ? "accountant number (Beraternummer)" : undefined,
    accountantClientNumber === undefined ? "client number (Mandantennummer)" : undefined,
    yearBegin === undefined ? "start of the fiscal year (Wirtschaftsjahresbeginn)" : undefined,
  ].filter((name): name is string => name !== undefined);
  return { accountantNumber, accountantClientNumber, accountingYearBegin: yearBegin, missing };
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

export interface DatevJobParams {
  /** Inclusive Berlin days. */
  readonly from: string;
  readonly to: string;
  readonly scope: readonly DatevScopeKey[];
  /** Only paid documents whose pay date lies in the period (sevDesk's `exportByPaydate`). */
  readonly exportByPaydate?: boolean | undefined;
  readonly includeDocumentImages?: boolean | undefined;
}

/**
 * The query of the job start. Built from a fixed list of keys, so `enshrineDocuments` (or any
 * other flag) can never be sent; booleans go out as `true`/`false` like the spec's examples.
 */
export function datevJobQuery(params: DatevJobParams): Record<string, string | number> {
  return {
    startDate: toUnixSeconds(params.from, "start"),
    endDate: toUnixSeconds(params.to, "end"),
    scope: scopeParameter(params.scope),
    ...(params.exportByPaydate === undefined
      ? {}
      : { exportByPaydate: params.exportByPaydate ? "true" : "false" }),
    includeDocumentImages: params.includeDocumentImages === true ? "true" : "false",
  };
}

/**
 * Starts the export job (`POST`, query only) and returns its id. A write: the caller's client
 * must be tier-scoped; never retried (the client retries no POST).
 */
export async function startDatevExportJob(
  client: SevdeskClient,
  params: DatevJobParams,
  signal?: AbortSignal,
): Promise<string> {
  const payload = await client.request({
    method: "POST",
    path: DATEV_JOB_PATH,
    query: datevJobQuery(params),
    ...(signal === undefined ? {} : { signal }),
  });
  const id = tokenOf(payload, ["id", "jobId"]);
  if (id === undefined) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        "sevDesk accepted the DATEV export request but answered without a readable job id. " +
        MAY_HAVE_STARTED,
    });
  }
  return id;
}

/** Trusted sentence for failures after the job start was sent. */
export const MAY_HAVE_STARTED =
  "The export job may have started in sevDesk: check there (Export → DATEV) before repeating.";

/**
 * The first start of a fiscal year (Wirtschaftsjahr, from sevDesk's `accountingYearBegin`) that
 * lies after `from` and on or before `to`, i.e. where the period crosses into a new fiscal year;
 * `undefined` when it lies within one fiscal year. DATEV booking batches belong to one fiscal
 * year each.
 */
export function fiscalYearStartWithin(
  from: string,
  to: string,
  accountingYearBegin: string,
): string | undefined {
  const monthDay = accountingYearBegin.slice(5);
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year += 1) {
    const start = `${String(year).padStart(4, "0")}-${monthDay}`;
    if (start > from && start <= to) return start;
  }
  return undefined;
}

/** A string token from a payload that is the token itself, an object, or a one-element array. */
function tokenOf(payload: unknown, keys: readonly string[]): string | undefined {
  const value = firstObject(payload);
  let token: unknown = value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    token = keys.map((key) => record[key]).find((member) => member !== undefined);
  }
  return typeof token === "string" && TOKEN_PATTERN.test(token.trim()) ? token.trim() : undefined;
}

function firstObject(payload: unknown): unknown {
  return Array.isArray(payload) ? (payload as unknown[])[0] : payload;
}

function unexpected(what: string): SevdeskError {
  return new SevdeskError({
    kind: "unexpected_response",
    message: `sevDesk returned ${what} in an unexpected format.`,
  });
}

/** `getProgress`: `{percent, current, errors, total, failure}` (recorded). */
const progressSchema = z.object({
  current: z.coerce.number().catch(0),
  total: z.coerce.number().catch(0),
  errors: z.unknown().optional(),
  failure: z.unknown().optional(),
});

const downloadInfoSchema = z.object({
  filename: zText.catch(undefined),
  link: zText.catch(undefined),
  linkExpireDate: z.unknown().optional(),
});

/** Download info of a finished job; `link` is a secret (see `export-download.ts`). */
export interface DatevDownloadInfo {
  readonly link: string;
  /** sevDesk's file name, untrusted: only through {@link exportFilename}. */
  readonly filename?: string | undefined;
  /** When the link expires, YYYY-MM-DD (Berlin). */
  readonly expires?: string | undefined;
}

/** How long and how often the job is polled. */
export interface DatevPollOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?:
    | ((done: number, total: number | undefined, message: string) => Promise<void> | void)
    | undefined;
  /** Longest total wait for the job, ms; default {@link DATEV_MAX_WAIT_MS}. */
  readonly maxWaitMs?: number | undefined;
  /** Injected for tests; defaults to a real timer. */
  readonly sleep?: Sleep | undefined;
}

/** Longest the export job is waited for: 3 minutes. */
const DATEV_MAX_WAIT_MS = 180_000;
/** Polling backoff: 1 s, doubling up to 8 s. */
const POLL_FIRST_MS = 1_000;
const POLL_MAX_MS = 8_000;

/**
 * Waits for the job and returns its download info: progress through the hash endpoints while
 * they answer (reported via `onProgress`; a reported failure ends the wait with an error), then
 * `jobDownloadInfo` until it has a link. Polls with backoff for at most `maxWaitMs` of sleeping in
 * total, then fails with a `timeout` error naming the job id, so the user fetches the export in
 * sevDesk instead of starting another one.
 */
export async function waitForDatevExport(
  client: SevdeskClient,
  jobId: string,
  options: DatevPollOptions = {},
): Promise<DatevDownloadInfo> {
  const sleep = options.sleep ?? realSleep;
  const maxWait = options.maxWaitMs ?? DATEV_MAX_WAIT_MS;
  const withSignal = options.signal === undefined ? {} : { signal: options.signal };
  let waited = 0;
  let delay = POLL_FIRST_MS;
  const pause = async (): Promise<void> => {
    if (waited + delay > maxWait) throw notReady(jobId, maxWait);
    try {
      await sleep(delay, options.signal);
    } catch {
      throw new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
    }
    waited += delay;
    delay = Math.min(delay * 2, POLL_MAX_MS);
  };

  // Progress (optional per the spec): an unreadable hash or progress skips to the download info.
  const hash = await optional(async () =>
    tokenOf(
      await client.request({
        method: "GET",
        path: DATEV_HASH_PATH,
        query: { jobId },
        ...withSignal,
      }),
      ["progressHash", "hash"],
    ),
  );
  if (hash !== undefined) {
    for (;;) {
      const progress = await optional(async () =>
        parseUpstream(
          progressSchema,
          firstObject(
            await client.request({
              method: "GET",
              path: DATEV_PROGRESS_PATH,
              query: { hash },
              ...withSignal,
            }),
          ) ?? {},
          "the export progress",
        ),
      );
      if (progress === undefined) break;
      if (reportsFailure(progress.failure) || reportsFailure(progress.errors)) {
        throw new SevdeskError({
          kind: "server",
          message:
            `sevDesk reported that the DATEV export job ${jobId} failed. Check the DATEV ` +
            "settings and the documents of the period in sevDesk, then try again.",
        });
      }
      const total = progress.total > 0 ? progress.total : undefined;
      await options.onProgress?.(
        progress.current,
        total,
        `DATEV export: ${String(progress.current)} of ${String(total ?? "?")}.`,
      );
      if (total === undefined || progress.current >= total) break;
      await pause();
    }
  }

  for (;;) {
    const info = await optional(async () =>
      parseUpstream(
        downloadInfoSchema,
        firstObject(
          await client.request({
            method: "GET",
            path: DATEV_DOWNLOAD_INFO_PATH,
            query: { jobId },
            ...withSignal,
          }),
        ) ?? {},
        "the export download info",
      ),
    );
    const link = info?.link?.trim();
    if (link !== undefined && link !== "") {
      return { link, filename: info?.filename, expires: expiryOf(info?.linkExpireDate) };
    }
    await pause();
  }
}

/** Whether a `failure`/`errors` member reports a failure (true, a non-empty list or text). */
function reportsFailure(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (value === "0" || value === "" || value === "false") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function expiryOf(value: unknown): string | undefined {
  try {
    return toBerlinDate(value);
  } catch {
    return undefined;
  }
}

/**
 * Runs a read that may fail while the job is still running: a `SevdeskError` other than a
 * cancellation or an auth failure gives `undefined` (try again later); anything else is
 * rethrown.
 */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted" && error.kind !== "auth") {
      return undefined;
    }
    throw error;
  }
}

function notReady(jobId: string, maxWait: number): SevdeskError {
  return new SevdeskError({
    kind: "timeout",
    message:
      `The DATEV export job ${jobId} did not finish within ${String(Math.round(maxWait / 1000))} ` +
      "seconds. It keeps running in sevDesk: download it there (Export → DATEV) instead of " +
      "starting another one.",
  });
}

/** Whether `bytes` start like a ZIP archive (local file header or an empty archive). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

/** Our own file name of an export: `DATEV_<from>_<to>_<scope>.zip`. */
export function datevFilename(params: DatevJobParams): string {
  return `DATEV_${params.from}_${params.to}_${scopeParameter(params.scope)}.zip`;
}

const MAX_FILENAME = 150;
/** Accents left over after NFKD (é → e). */
const COMBINING_MARKS = /\p{M}+/gu;
/** Names Windows reserves for devices (a ZIP may be copied there). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/**
 * A safe ZIP file name from sevDesk's (untrusted) `filename`: its last path segment reduced to
 * ASCII letters, digits, `.`, `_` and `-` (other runs become `_`), no leading dots, at most 150
 * characters, ending in `.zip`; `fallback` when nothing usable is left.
 */
export function exportFilename(raw: string | undefined, fallback: string): string {
  const last = (raw ?? "").split(/[/\\]/).pop() ?? "";
  const stem = last
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .replace(/\.zip$/i, "")
    .replace(/[._-]+$/, "")
    .slice(0, MAX_FILENAME - 4)
    .replace(/[._-]+$/, "");
  return stem === "" || WINDOWS_DEVICE.test(stem) ? fallback : `${stem}.zip`;
}
