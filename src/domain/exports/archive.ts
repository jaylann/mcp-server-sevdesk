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
 *   contact's two invoices of 130), and `[filter][startAmount]`/`[endAmount]` on vouchers (exactly
 *   the two vouchers of 49 between 123 and 124 EUR gross). The other combinations are not
 *   recorded, so they are not offered.
 * - One PDF per document, named `YYYY-MM-DD_Rechnung_<number>_<hash>.pdf`. **Drafts are
 *   included**, with a label in parentheses after the kind and no number
 *   (`YYYY-MM-DD_Rechnung(<label>)__<hash>.pdf`); voucher entries carry date, label, description
 *   and hash the same way. {@link isDraftEntry} counts them, so the tool can say so.
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

/** Most documents one archive asks for (`sevQuery[limit]`; sevDesk's page maximum, D-019). */
export const MAX_ARCHIVE_DOCUMENTS = 1_000;
/**
 * Largest archive accepted: 100 MiB, as for the DATEV ZIP. A rendered invoice was 138 KB on the
 * trial account, so about 700 invoices fit; a longer period is exported in parts.
 */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export interface ArchiveParams {
  readonly subject: ArchiveSubject;
  /** Inclusive Berlin days. */
  readonly from: string;
  readonly to: string;
  readonly limit: number;
  /** Invoices only: the customer contact's id. */
  readonly contactId?: number | undefined;
  /** Vouchers only: gross amount range, exact decimal strings in EUR. */
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
  /** Entries in the ZIP (one per document). */
  readonly entries: number;
  /** Entries whose name ends in `.pdf`. */
  readonly pdfEntries: number;
  /** Entries named like drafts ({@link isDraftEntry}). */
  readonly draftEntries: number;
}

/**
 * Checks the arguments locally (nothing is sent on a mistake): the period, the limit, and that
 * each filter is one recorded for the subject.
 */
export function checkArchiveParams(params: ArchiveParams): void {
  if (params.from > params.to) throw invalid("from is after to.");
  if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_ARCHIVE_DOCUMENTS) {
    throw invalid(`limit must be a whole number from 1 to ${String(MAX_ARCHIVE_DOCUMENTS)}.`);
  }
  if (params.contactId !== undefined && params.subject !== "invoices") {
    throw invalid(
      "contactId filters invoices only; sevDesk's contact filter on the voucher archive is " +
        "unverified, so it is not sent.",
    );
  }
  const amounts = params.minAmount !== undefined || params.maxAmount !== undefined;
  if (amounts && params.subject !== "vouchers") {
    throw invalid(
      "minAmount and maxAmount filter vouchers only; sevDesk's amount filter on the invoice " +
        "archive is unverified, so it is not sent.",
    );
  }
}

/**
 * Asks sevDesk for the archive (a side-effect GET: needs a `write`-tier client, never retried)
 * and checks the answer: the JSON form is decoded (and refused without content), anything else
 * must be a ZIP-like media type and a readable ZIP. Throws `unexpected_response` otherwise;
 * nothing has been saved then.
 */
export async function exportArchive(
  client: SevdeskClient,
  params: ArchiveParams,
  signal?: AbortSignal,
): Promise<DocumentArchive> {
  checkArchiveParams(params);
  const answer = await client.download({
    method: "GET",
    path: ARCHIVE_EXPORTS[params.subject].path,
    query: archiveQuery(params),
    sideEffect: true,
    maxBytes: MAX_ARCHIVE_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });
  const type = mediaType(answer.contentType);
  const bytes =
    type?.endsWith("json") === true || answer.body[0] === 0x7b
      ? decodeJsonArchive(answer.body)
      : answer.body;
  if (type !== undefined && !type.endsWith("json") && !ZIP_TYPES.has(type)) {
    throw notAZip(`sevDesk answered with the media type ${safeType(type)}, not a ZIP`);
  }
  const entries = looksLikeZip(bytes) ? listZipEntries(bytes) : undefined;
  if (entries === undefined) throw notAZip("the answer is not a readable ZIP archive");
  return {
    bytes,
    entries: entries.length,
    pdfEntries: entries.filter((entry) => /\.pdf$/i.test(entry.name)).length,
    draftEntries: entries.filter((entry) => isDraftEntry(entry)).length,
  };
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
