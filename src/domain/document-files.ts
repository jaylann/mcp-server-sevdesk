/**
 * Document files: the PDFs of invoices, credit notes and orders and the e-invoice XML (XRechnung)
 * of invoices, fetched from sevDesk **without side effects** and validated before anything else
 * sees them.
 *
 * Safety invariants:
 * - Every `getPdf` call carries `preventSendBy` (B1, spec/deviations.md D-023): without it sevDesk
 *   marks an invoice or credit note as sent and commits an order. The client forces the flag as
 *   well; it is passed here explicitly so the intent is visible and tested at this layer too.
 * - `download` is never sent: the documented and community-recorded response is the JSON envelope
 *   `{objects: {filename, mimetype, base64Encoded, content}}` (D-001; the spec spells the keys
 *   `mimeType`/`base64encoded`, D-072), which is what is parsed.
 * - Files are capped at {@link MAX_DOCUMENT_FILE_BYTES} decoded bytes, must start with the magic
 *   bytes of their type (`%PDF-`, `<`), and their file name is reduced to a safe basename. Anything
 *   else is an `unexpected_response` error, never a silently "fixed" file.
 * - The bytes leave this module only as bytes. Callers hand them to MCP clients as resource
 *   contents or write them to disk; they are never put into text the model reads.
 */
import { Buffer } from "node:buffer";

import { z } from "zod";

import { sanitizeUntrusted } from "../safety/fence.js";
import { expectSingle } from "../sevdesk/envelope.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath } from "../sevdesk/paths.js";
import { parseUpstream, zBool01, zOptionalString } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";

/** The document files this server can fetch. */
export const DOCUMENT_FILE_KINDS = [
  "invoice_pdf",
  "credit_note_pdf",
  "order_pdf",
  "invoice_xml",
] as const;
export type DocumentFileKind = (typeof DOCUMENT_FILE_KINDS)[number];

type DocumentMimeType = "application/pdf" | "application/xml";

/**
 * Largest decoded file accepted: 20 MB. Real invoice PDFs are a few hundred kB; anything this big
 * is not a document sevDesk rendered, and it would have to travel base64-encoded through MCP.
 */
export const MAX_DOCUMENT_FILE_BYTES = 20 * 1024 * 1024;

/** Longest file name produced by {@link safeFilename}, extension included. */
export const MAX_FILENAME_LENGTH = 100;

interface DocumentFileSpec {
  readonly endpoint: "Invoice" | "CreditNote" | "Order";
  readonly action: "getPdf" | "getXml";
  /** First segment of the resource URI: `sevdesk://<collection>/<id>/<format>`. */
  readonly collection: "invoices" | "credit-notes" | "orders";
  readonly format: "pdf" | "xml";
  readonly mimeType: DocumentMimeType;
  /** Trusted noun for messages: "invoice", "credit note", "order". */
  readonly noun: string;
  /** Stem of the fallback file name, e.g. `invoice` → `invoice-12.pdf`. */
  readonly fallbackStem: string;
}

/** How each kind is fetched and addressed. */
export const DOCUMENT_FILE_SPECS: Readonly<Record<DocumentFileKind, DocumentFileSpec>> = {
  invoice_pdf: {
    endpoint: "Invoice",
    action: "getPdf",
    collection: "invoices",
    format: "pdf",
    mimeType: "application/pdf",
    noun: "invoice",
    fallbackStem: "invoice",
  },
  credit_note_pdf: {
    endpoint: "CreditNote",
    action: "getPdf",
    collection: "credit-notes",
    format: "pdf",
    mimeType: "application/pdf",
    noun: "credit note",
    fallbackStem: "credit-note",
  },
  order_pdf: {
    endpoint: "Order",
    action: "getPdf",
    collection: "orders",
    format: "pdf",
    mimeType: "application/pdf",
    noun: "order",
    fallbackStem: "order",
  },
  invoice_xml: {
    endpoint: "Invoice",
    action: "getXml",
    collection: "invoices",
    format: "xml",
    mimeType: "application/xml",
    noun: "invoice",
    fallbackStem: "invoice",
  },
};

/** A fetched, validated document file. */
export interface DocumentFile {
  readonly kind: DocumentFileKind;
  readonly id: number;
  /** The MCP resource URI that serves this file, e.g. `sevdesk://invoices/12/pdf`. */
  readonly uri: string;
  /** Safe basename with the canonical extension (see {@link safeFilename}). */
  readonly filename: string;
  readonly mimeType: DocumentMimeType;
  readonly bytes: Uint8Array;
}

/** `sevdesk://<collection>/<id>/<format>` for one document file. */
export function documentFileUri(kind: DocumentFileKind, id: number): string {
  const spec = DOCUMENT_FILE_SPECS[kind];
  return `sevdesk://${spec.collection}/${id}/${spec.format}`;
}

/** The RFC 6570 URI template of a kind, e.g. `sevdesk://invoices/{id}/pdf`. */
export function documentFileUriTemplate(kind: DocumentFileKind): string {
  const spec = DOCUMENT_FILE_SPECS[kind];
  return `sevdesk://${spec.collection}/{id}/${spec.format}`;
}

/**
 * Fetches one document file. `id` must already be a valid sevDesk id (the path builder rejects
 * anything else with a local `validation` error before sending). Throws {@link SevdeskError}:
 * `not_found` for a missing document or an invoice without e-invoice XML, `unexpected_response`
 * for a body that is not the documented shape, not the declared type or too large.
 */
export async function fetchDocumentFile(
  client: SevdeskClient,
  kind: DocumentFileKind,
  id: number,
  signal?: AbortSignal,
): Promise<DocumentFile> {
  const spec = DOCUMENT_FILE_SPECS[kind];
  const path = sevdeskPath(spec.endpoint, id, spec.action);
  const fetched =
    spec.action === "getPdf"
      ? await fetchPdf(client, spec, id, path, signal)
      : await fetchXml(client, id, path, signal);
  return {
    kind,
    id,
    uri: documentFileUri(kind, id),
    filename: safeFilename(fetched.filename, `${spec.fallbackStem}-${id}`, spec.format),
    mimeType: spec.mimeType,
    bytes: fetched.bytes,
  };
}

interface FetchedBytes {
  readonly filename: string | undefined;
  readonly bytes: Uint8Array;
}

/**
 * `getPdf` record inside `objects` (wrapped per D-001). Lenient like every upstream schema;
 * `content` is required. sevDesk sends `mimetype` and `base64Encoded` (recorded 2026-11-07), the
 * spec says `mimeType` and `base64encoded` (D-072): both spellings are read, the recorded one wins.
 */
const pdfRecordSchema = z
  .object({
    filename: zOptionalString,
    mimetype: zOptionalString,
    mimeType: zOptionalString,
    base64Encoded: zBool01.optional(),
    base64encoded: zBool01.optional(),
    content: z.string(),
  })
  .transform(({ mimetype, mimeType, base64Encoded, base64encoded, ...rest }) => ({
    ...rest,
    mimeType: mimetype ?? mimeType,
    base64encoded: base64Encoded ?? base64encoded,
  }));

const PDF_MAGIC = "%PDF-";
const ACCEPTED_PDF_TYPES: ReadonlySet<string> = new Set(["application/pdf", "application/x-pdf"]);

async function fetchPdf(
  client: SevdeskClient,
  spec: DocumentFileSpec,
  id: number,
  path: string,
  signal: AbortSignal | undefined,
): Promise<FetchedBytes> {
  const what = `the PDF of ${spec.noun} ${id}`;
  const payload = await client.request({
    method: "GET",
    path,
    // B1 / D-023: without it sevDesk marks the document as sent (orders: commits them).
    query: { preventSendBy: true },
    ...(signal === undefined ? {} : { signal }),
  });
  const single = expectSingle(payload, `PDF for ${spec.noun} ${id}`);
  const record = parseUpstream(pdfRecordSchema, single, what);

  if (record.base64encoded === false) {
    throw unexpected(`sevDesk returned ${what} without base64 encoding, which is not supported.`);
  }
  if (record.mimeType !== undefined && !ACCEPTED_PDF_TYPES.has(mediaTypeEssence(record.mimeType))) {
    throw unexpected(`sevDesk declared ${what} with a media type other than application/pdf.`);
  }
  const bytes = decodeBase64(record.content, what);
  if (!startsWithAscii(bytes, PDF_MAGIC)) {
    throw unexpected(`sevDesk returned ${what}, but the content is not a PDF file.`);
  }
  return { filename: record.filename, bytes };
}

async function fetchXml(
  client: SevdeskClient,
  id: number,
  path: string,
  signal: AbortSignal | undefined,
): Promise<FetchedBytes> {
  const what = `the e-invoice XML of invoice ${id}`;
  let payload: unknown;
  try {
    payload = await client.request({
      method: "GET",
      path,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    // sevDesk refuses getXml for invoices that are not (complete) e-invoices. getXml has no
    // parameter besides the id, so a rejection sevDesk sends is about the invoice itself.
    if (
      error instanceof SevdeskError &&
      error.kind === "validation" &&
      error.status !== undefined
    ) {
      throw noXml(id, error);
    }
    throw error;
  }

  if (isEmptyPayload(payload)) {
    throw noXml(id);
  }
  if (typeof payload !== "string") {
    throw unexpected(`sevDesk returned ${what} in an unexpected format: expected XML text.`);
  }
  const xml = payload.startsWith(BYTE_ORDER_MARK) ? payload.slice(1) : payload;
  const start = xml.trimStart().slice(0, 32).toLowerCase();
  if (!start.startsWith("<") || start.startsWith("<html") || start.startsWith("<!doctype html")) {
    throw unexpected(`sevDesk returned ${what}, but the content is not XML.`);
  }
  // Cheap upper bound first (UTF-8 needs at most 3 bytes per UTF-16 code unit), then exact.
  if (xml.length > MAX_DOCUMENT_FILE_BYTES) {
    throw tooLarge(what);
  }
  const bytes = new TextEncoder().encode(xml);
  if (bytes.byteLength > MAX_DOCUMENT_FILE_BYTES) {
    throw tooLarge(what);
  }
  return { filename: undefined, bytes };
}

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

function isEmptyPayload(payload: unknown): boolean {
  return (
    payload === null ||
    payload === undefined ||
    payload === false ||
    (typeof payload === "string" && payload.trim() === "") ||
    (Array.isArray(payload) && payload.length === 0)
  );
}

/**
 * The invoice has no e-invoice XML. A `not_found` error with trusted text; the upstream status,
 * message and exception id (if sevDesk refused the request) are kept for logs.
 */
function noXml(id: number, cause?: SevdeskError): SevdeskError {
  const status = cause?.status === undefined ? "" : ` (sevDesk answered HTTP ${cause.status})`;
  return new SevdeskError({
    kind: "not_found",
    message:
      `sevDesk has no e-invoice XML for invoice ${id}${status}. XML exists only for invoices ` +
      "marked as e-invoices (E-Rechnung: XRechnung/ZUGFeRD) with complete e-invoice data, and " +
      "only once they are finalized: a draft e-invoice gets its XML after finalizing. Other " +
      "invoices only have a PDF.",
    ...(cause === undefined
      ? {}
      : {
          cause,
          ...(cause.status === undefined ? {} : { status: cause.status }),
          ...(cause.upstreamMessage === undefined
            ? {}
            : { upstreamMessage: cause.upstreamMessage }),
          ...(cause.exceptionUuid === undefined ? {} : { exceptionUuid: cause.exceptionUuid }),
          ...(cause.method === undefined ? {} : { method: cause.method }),
          ...(cause.path === undefined ? {} : { path: cause.path }),
        }),
  });
}

/** Standard base64 (MIME line breaks tolerated), optional padding. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_WHITESPACE = /[\r\n\t ]+/g;

/**
 * Decodes base64 after checking the alphabet and the decoded size, so neither garbage nor an
 * oversized payload is ever decoded. `what` is trusted text naming the file for messages.
 */
function decodeBase64(text: string, what: string): Uint8Array {
  // Bound the work before scanning: the decoded size is about 3/4 of the encoded length.
  if (text.length > Math.ceil((MAX_DOCUMENT_FILE_BYTES * 4) / 3) * 2) {
    throw tooLarge(what);
  }
  const compact = text.replace(BASE64_WHITESPACE, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  if (
    compact.length === 0 ||
    !BASE64.test(compact) ||
    compact.length % 4 === 1 ||
    (padding > 0 && compact.length % 4 !== 0)
  ) {
    throw unexpected(`sevDesk returned ${what}, but its content is not valid base64.`);
  }
  const size = Math.floor((compact.length * 3) / 4) - padding;
  if (size > MAX_DOCUMENT_FILE_BYTES) {
    throw tooLarge(what);
  }
  return Buffer.from(compact, "base64");
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.byteLength < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

/** `application/PDF; charset=…` → `application/pdf`. */
function mediaTypeEssence(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

const GERMAN_LETTERS: Readonly<Record<string, string>> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "Ae",
  Ö: "Oe",
  Ü: "Ue",
  ß: "ss",
};
const GERMAN_LETTER = /[äöüÄÖÜß]/g;
const COMBINING_MARKS = /\p{M}/gu;
const UNSAFE_RUNS = /[^A-Za-z0-9._-]+/g;
const EDGE_PUNCTUATION_START = /^[._-]+/;
const EDGE_PUNCTUATION_END = /[._-]+$/;
/** Names Windows reserves for devices, with or without an extension. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

/**
 * Reduces an untrusted file name from sevDesk to a safe basename that ends in `.<extension>`:
 *
 * - only the last path segment counts (`/` and `\` separate), invisible characters are removed;
 * - German umlauts are transliterated (`ü` → `ue`), other accents dropped, and every run of
 *   characters outside `[A-Za-z0-9._-]` becomes `_`, so no path separators, control characters,
 *   spaces, quotes or shell metacharacters survive;
 * - leading and trailing dots, underscores and hyphens are removed (no hidden files, no names
 *   that read like command-line options), repeated dots collapse;
 * - the extension is the canonical lower-case one, appended when missing;
 * - at most {@link MAX_FILENAME_LENGTH} characters; a Windows device name or nothing usable
 *   yields `<fallbackStem>.<extension>`.
 */
export function safeFilename(
  raw: string | undefined,
  fallbackStem: string,
  extension: "pdf" | "xml" | "png" | "jpg" | "csv" | "zip",
): string {
  const lastSegment = (raw ?? "").split(/[/\\]/).pop() ?? "";
  let stem = sanitizeUntrusted(lastSegment, 1_000)
    .replace(GERMAN_LETTER, (letter) => GERMAN_LETTERS[letter] ?? "_")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(UNSAFE_RUNS, "_")
    .replace(/\.{2,}/g, ".")
    .replace(EDGE_PUNCTUATION_END, "")
    .replace(new RegExp(`\\.${extension}$`, "i"), "")
    .replace(EDGE_PUNCTUATION_START, "")
    .replace(EDGE_PUNCTUATION_END, "");
  stem = stem
    .slice(0, MAX_FILENAME_LENGTH - extension.length - 1)
    .replace(EDGE_PUNCTUATION_END, "");
  if (stem === "" || WINDOWS_DEVICE.test(stem)) {
    stem = fallbackStem;
  }
  return `${stem}.${extension}`;
}

function unexpected(message: string): SevdeskError {
  return new SevdeskError({ kind: "unexpected_response", message });
}

function tooLarge(what: string): SevdeskError {
  const limit = MAX_DOCUMENT_FILE_BYTES / (1024 * 1024);
  return unexpected(
    `sevDesk returned ${what} with more than ${limit} MB, the limit of this server.`,
  );
}
