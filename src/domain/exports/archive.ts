/**
 * sevDesk's document archives: every invoice PDF (`GET /Export/invoiceZip`) or every voucher
 * receipt (`GET /Export/voucherZip`) of a period as one ZIP, e.g. for the tax adviser or a tax
 * audit (Betriebsprüfung). Recorded live on the trial account on 2026-11-16 (D-101):
 *
 * - Only `download=true` gives the file: the raw ZIP with `Content-Type: application/zip;
 *   charset=UTF-8'` (a stray apostrophe, so the type is parsed leniently). Without it sevDesk
 *   answers JSON `{filename, mimetype, base64Encoded, content}` with `content: null`, also when
 *   documents match.
 * - The query is the flattened `sevQuery` of the CSV exports (`sevQuery[objectName]=SevQuery`,
 *   `[modelName]`, `[limit]`, `[filter][startDate|endDate]` in Unix seconds, D-012). Recorded
 *   filters: `[filter][contact][id]` with `[contact][objectName]=Contact` on invoices (exactly that
 *   contact's two invoices of 130), and `[filter][startAmount]`/`[endAmount]` on both (vouchers:
 *   decimal bounds, inclusive; invoices: 110 entries for an amount range 111 listed invoices
 *   fall into). The contact filter on vouchers is not recorded, so it is not offered.
 * - One PDF per document, named `YYYY-MM-DD_Rechnung_<number>_<hash>.pdf`. **Drafts are
 *   included**, with a label in parentheses after the kind and no number
 *   (`YYYY-MM-DD_Rechnung(<label>)__<hash>.pdf`); voucher entries carry date, label, description
 *   and hash the same way. {@link isDraftEntry} counts them, so the tool can say so.
 * - **Fewer entries than documents is normal:** a voucher archive holds only vouchers with a
 *   receipt file (13 entries for 53 listed vouchers), and an invoice archive held one invoice
 *   fewer than the list (130 of 131, 110 of 111; which one is unknown). So the entry count only
 *   hints at whether sevDesk stopped at `sevQuery[limit]` ({@link mayBeTruncated}); whether it
 *   stops there at all is not recorded (only an empty archive was asked for with two limits).
 * - **Nothing matched:** sevDesk still answers a ZIP, with one entry `readme.txt` ("Es wurden keine
 *   Dateien hochgeladen, daher ist diese ZIP leer."). That entry is never counted as a document
 *   ({@link isPlaceholderEntry}); an archive without documents is not saved.
 * - **Slow:** sevDesk renders the whole ZIP before answering: 30 s for 110 invoices (21 MB), 46 s
 *   for 25 (a first call), 63 s for 130 (24.6 MB); about 1 s for 13 small receipts. The request
 *   therefore gets its own time budget ({@link ARCHIVE_TIMEOUT_MS}) instead of
 *   `SEVDESK_TIMEOUT_MS` (30 s by default), and a timeout says to export a shorter period.
 * - Nothing changes on any document: a draft kept status, `sendDate`, `sendType` and `update`
 *   (unlike `getPdf` without `preventSendBy`, D-023). It is still requested as a side effect with
 *   the `write` tier (`resolveGetSafety` recognizes both endpoints): sevDesk renders every PDF of
 *   the period, a heavy job, and the request must never be retried. It has no enshrine flag; the
 *   query comes from a fixed key list.
 *
 * The ZIP is checked (magic bytes and a readable central directory, `listZipEntries`) and handed
 * out as is; its entry names are sevDesk data and are only counted, never returned.
 */
import { toUnixSeconds } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import type { QueryValue, SevdeskClient } from "../../sevdesk/types.js";
import { compare } from "../money.js";
import { looksLikeZip } from "./datev.js";
import { listZipEntries, type ZipEntry } from "./zip.js";

export const ARCHIVE_SUBJECTS = ["invoices", "vouchers"] as const;
export type ArchiveSubject = (typeof ARCHIVE_SUBJECTS)[number];

interface ArchiveSpec {
  readonly path: string;
  /** `sevQuery[modelName]`. */
  readonly modelName: string;
  /** Trusted noun for messages. */
  readonly noun: string;
}

/** The two archive endpoints (spec `exportInvoiceZip`, `exportVoucherZip`). */
export const ARCHIVE_EXPORTS: Readonly<Record<ArchiveSubject, ArchiveSpec>> = {
  invoices: { path: "/Export/invoiceZip", modelName: "Invoice", noun: "invoices" },
  vouchers: { path: "/Export/voucherZip", modelName: "Voucher", noun: "vouchers" },
};

/**
 * Most documents one archive may ask for (`sevQuery[limit]`; sevDesk's page maximum, D-019).
 * Whether sevDesk stops at the limit is not recorded (D-101).
 */
export const MAX_ARCHIVE_DOCUMENTS = 1_000;
/**
 * The limit an archive asks for when the caller gives none: 500 invoices fit both budgets, at the
 * recorded 0.5 s and 140–190 KB per rendered invoice (D-101) about 4 minutes of
 * {@link ARCHIVE_TIMEOUT_MS} and 70–95 MB of {@link MAX_ARCHIVE_BYTES}. 1,000 invoices would need
 * about 8 minutes and up to 190 MB, so a default of {@link MAX_ARCHIVE_DOCUMENTS} would fail on a
 * busy year after minutes of rendering.
 */
export const DEFAULT_ARCHIVE_DOCUMENTS = 500;
/**
 * Largest archive accepted: 100 MiB, as for the DATEV ZIP. A rendered invoice was 138 KB on the
 * trial account, so about 700 invoices fit; a longer period is exported in parts.
 */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
/**
 * Time sevDesk gets to render and send one archive: 5 minutes. The slowest recorded archive (130
 * invoices, 24.6 MB) took 63 s, so this leaves about four times that, roughly a quarter of a
 * small business's invoices. Larger archives are exported in shorter periods. (A remote server
 * still ends every request after 120 s, `docs/remote/operations.md`.)
 */
export const ARCHIVE_TIMEOUT_MS = 300_000;

export interface ArchiveParams {
  readonly subject: ArchiveSubject;
  /** Inclusive Berlin days. */
  readonly from: string;
  readonly to: string;
  readonly limit: number;
  /** Invoices only: the customer contact's id. */
  readonly contactId?: number | undefined;
  /** Amount range in EUR (inclusive), exact decimal strings, as sevDesk's amount filter reads it. */
  readonly minAmount?: string | undefined;
  readonly maxAmount?: string | undefined;
}

/**
 * The query of an archive export, from a fixed key list (so no enshrine or other flag can be
 * sent): `download=true`, the `sevQuery` frame with an explicit limit, the period in Unix seconds
 * and the recorded filters.
 */
export function archiveQuery(params: ArchiveParams): Record<string, QueryValue> {
  const spec = ARCHIVE_EXPORTS[params.subject];
  return {
    download: "true",
    "sevQuery[objectName]": "SevQuery",
    "sevQuery[modelName]": spec.modelName,
    "sevQuery[limit]": params.limit,
    "sevQuery[filter][startDate]": toUnixSeconds(params.from, "start"),
    "sevQuery[filter][endDate]": toUnixSeconds(params.to, "end"),
    ...(params.contactId === undefined
      ? {}
      : {
          "sevQuery[filter][contact][id]": params.contactId,
          "sevQuery[filter][contact][objectName]": "Contact",
        }),
    ...(params.minAmount === undefined
      ? {}
      : { "sevQuery[filter][startAmount]": params.minAmount }),
    ...(params.maxAmount === undefined ? {} : { "sevQuery[filter][endAmount]": params.maxAmount }),
  };
}

/** An archive as sevDesk sent it, checked. */
export interface DocumentArchive {
  readonly bytes: Uint8Array;
  /** Documents in the ZIP: its entries without sevDesk's `readme.txt` placeholder. */
  readonly entries: number;
  /** Entries whose name ends in `.pdf`. */
  readonly pdfEntries: number;
  /** Entries named like drafts ({@link isDraftEntry}). */
  readonly draftEntries: number;
}

/** Share of the limit by which the file count may fall short and still count as cut. */
const TRUNCATION_SLACK = 0.02;

/**
 * Whether sevDesk may have stopped at `limit`: the ZIP holds at least `limit` minus a slack of
 * 2 % (at least 1) files. The limit applies to the documents sevDesk selects, the ZIP holds files,
 * and the two differ: an invoice archive held one invoice fewer than the list (D-101), so an
 * archive cut at the limit can hold a few files less than the limit. Counting files cannot see a
 * cut voucher archive whose vouchers mostly lack a receipt file, so `false` is no proof that every
 * document is in it; the result says so for vouchers. (A count of the matching documents
 * beforehand would settle it, but `GET /Invoice` and `GET /Voucher` take no amount filter, and
 * their date filter is another parameter whose bounds the list tools re-check locally
 * (`documentDateFilter`), so their `total` is not known to match what the archive selects.)
 */
export function mayBeTruncated(entries: number, limit: number): boolean {
  if (entries === 0) return false;
  return entries >= limit - Math.max(1, Math.ceil(limit * TRUNCATION_SLACK));
}

/**
 * Checks the arguments locally (nothing is sent on a mistake): the period, the limit, the amount
 * range (compared as exact decimals: sevDesk would answer an inverted range with its empty ZIP),
 * and that each filter is one recorded for the subject.
 */
export function checkArchiveParams(params: ArchiveParams): void {
  if (params.from > params.to) throw invalid("from is after to.");
  if (
    params.minAmount !== undefined &&
    params.maxAmount !== undefined &&
    compare(params.minAmount, params.maxAmount) > 0
  ) {
    throw invalid("minAmount is above maxAmount.");
  }
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_ARCHIVE_DOCUMENTS) {
    throw invalid(`limit must be a whole number from 1 to ${String(MAX_ARCHIVE_DOCUMENTS)}.`);
  }
  if (params.contactId !== undefined && params.subject !== "invoices") {
    throw invalid(
      "contactId filters invoices only; sevDesk's contact filter on the voucher archive is " +
        "unverified, so it is not sent.",
    );
  }
}

/**
 * Asks sevDesk for the archive (a side-effect GET: needs a `write`-tier client, never retried)
 * and checks the answer: the JSON form is decoded (and refused without content), anything else
 * must be a ZIP-like media type and a readable ZIP. Throws `unexpected_response` otherwise, and
 * `timeout` (with the remedy) when sevDesk takes longer than {@link ARCHIVE_TIMEOUT_MS}; nothing
 * has been saved then.
 */
export async function exportArchive(
  client: SevdeskClient,
  params: ArchiveParams,
  signal?: AbortSignal,
): Promise<DocumentArchive> {
  checkArchiveParams(params);
  let answer: { body: Uint8Array; contentType: string | undefined };
  try {
    answer = await client.download({
      method: "GET",
      path: ARCHIVE_EXPORTS[params.subject].path,
      query: archiveQuery(params),
      sideEffect: true,
      maxBytes: MAX_ARCHIVE_BYTES,
      timeoutMs: ARCHIVE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "timeout") {
      throw new SevdeskError({
        kind: "timeout",
        message:
          `sevDesk did not finish the archive of ${ARCHIVE_EXPORTS[params.subject].noun} within ` +
          `${String(ARCHIVE_TIMEOUT_MS / 60_000)} minutes (it renders every PDF first). Nothing ` +
          "changed in sevDesk and nothing was saved: export a shorter period, for example one " +
          "month, or fewer documents.",
        cause: error,
      });
    }
    throw error;
  }
  const type = mediaType(answer.contentType);
  const bytes =
    type?.endsWith("json") === true || answer.body[0] === 0x7b
      ? decodeJsonArchive(answer.body)
      : answer.body;
  if (type !== undefined && !type.endsWith("json") && !ZIP_TYPES.has(type)) {
    throw notAZip(`sevDesk answered with the media type ${safeType(type)}, not a ZIP`);
  }
  const listed = looksLikeZip(bytes) ? listZipEntries(bytes) : undefined;
  if (listed === undefined) throw notAZip("the answer is not a readable ZIP archive");
  const documents = listed.filter((entry) => !isPlaceholderEntry(entry));
  return {
    bytes,
    entries: documents.length,
    pdfEntries: documents.filter((entry) => /\.pdf$/i.test(entry.name)).length,
    draftEntries: documents.filter((entry) => isDraftEntry(entry)).length,
  };
}

/**
 * Whether an entry is sevDesk's placeholder for "nothing matched": `readme.txt` at the top of the
 * ZIP (recorded: the only entry, 62 bytes, "Es wurden keine Dateien hochgeladen, daher ist diese
 * ZIP leer."). It is never a document.
 */
export function isPlaceholderEntry(entry: Pick<ZipEntry, "name">): boolean {
  return entry.name.toLowerCase() === "readme.txt";
}

/** Media types accepted for the raw ZIP (sevDesk sends `application/zip`). */
const ZIP_TYPES: ReadonlySet<string> = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "application/octet-stream",
  "binary/octet-stream",
]);

/**
 * The `type/subtype` of a `Content-Type` header, lower case, without parameters and without stray
 * quotes or apostrophes (sevDesk sends `application/zip; charset=UTF-8'`); `undefined` when absent.
 */
export function mediaType(header: string | undefined): string | undefined {
  const type = header?.split(";")[0]?.replace(/["']/g, "").trim().toLowerCase();
  return type === undefined || type === "" ? undefined : type;
}

/** A media type for an error message: only `type/subtype` characters, at most 60. */
function safeType(type: string): string {
  return /^[a-z0-9.+-]{1,30}\/[a-z0-9.+-]{1,30}$/.test(type) ? type : "(unreadable)";
}

/**
 * Whether an entry is named like a draft: after the date and the document kind comes a label in
 * parentheses (`2026-11-16_Rechnung(<label>)__<hash>.pdf`, D-101). sevDesk's label was seven
 * letters, presumably "Entwurf"; any label in that place counts.
 */
export function isDraftEntry(entry: Pick<ZipEntry, "name">): boolean {
  const name = entry.name.split("/").pop() ?? "";
  return /^\d{4}-\d{2}-\d{2}_[^_()]*\([^()_]{1,40}\)_/.test(name);
}

/** File name of a saved archive: `<subject>_<from>_<to>.zip` (ASCII, from our own values). */
export function archiveFilename(params: Pick<ArchiveParams, "subject" | "from" | "to">): string {
  return `${params.subject}_${params.from}_${params.to}.zip`;
}

/**
 * The spec's JSON form `{objects: {filename, mimetype, base64Encoded, content}}`: the base64
 * content decoded, or an error when there is none (what sevDesk answers without `download`).
 */
function decodeJsonArchive(body: Uint8Array): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw notAZip("the answer is neither a ZIP nor readable JSON");
  }
  const objects =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["objects"]
      : undefined;
  const file = Array.isArray(objects) ? (objects as unknown[])[0] : objects;
  const content =
    typeof file === "object" && file !== null
      ? (file as Record<string, unknown>)["content"]
      : undefined;
  if (typeof content !== "string" || content === "" || !/^[A-Za-z0-9+/=\s]*$/.test(content)) {
    throw notAZip("sevDesk answered the export description without the file (content empty)");
  }
  return new Uint8Array(Buffer.from(content, "base64"));
}

function notAZip(reason: string): SevdeskError {
  return new SevdeskError({
    kind: "unexpected_response",
    message: `The document archive could not be used: ${reason}. Nothing was saved.`,
  });
}

function invalid(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message: `Invalid request: ${message}` });
}
