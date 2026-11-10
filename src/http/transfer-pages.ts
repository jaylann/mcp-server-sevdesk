/**
 * Pages and responses of remote file transfer (`transfer-routes.ts`): the upload form, the upload
 * receipt, the message pages, and the download response. They share the approval pages' frame
 * (`renderPage`: one nonce-allowed style block, no script, strict CSP via `htmlResponse`).
 *
 * The upload page shows trusted values only (purpose, accepted kinds, size limit, reference,
 * expiry, account): the model cannot put text on it. The one value a user chose, the uploaded
 * file's name, is shown cleaned and escaped on the receipt. Downloads are always attachments
 * under a sandboxing CSP: a file is never rendered on this origin (XML could run XHTML script).
 */
import {
  escapeHtml,
  formatPageTime,
  renderMessagePage,
  renderPage,
} from "../safety/approval-page.js";
import type { OutputFileKind } from "../safety/file-access.js";
import type { LocalFileKind } from "../safety/local-files.js";
import { megabytes, MIME_TYPES, type ServedDownload } from "../safety/transfer-store.js";
import type { UploadPurpose } from "../safety/transfer-types.js";
import { pageResponse, type PageText } from "./approval-pages.js";

/** Prefix of the upload pages, `/uploads/<id>`. */
export const UPLOADS_PREFIX = "/uploads/";
/** Prefix of the download links, `/files/<id>`. */
export const FILES_PREFIX = "/files/";

/** Trusted page texts. */
export const TRANSFER_TEXT = {
  uploadNotFound: {
    title: "Upload page not found",
    message:
      "This upload page is unknown, has expired, or belongs to another sevDesk account. Ask " +
      "your assistant for a new upload link.",
  },
  uploadExpired: {
    title: "Upload page expired",
    message: "This upload page is no longer valid. Ask your assistant for a new upload link.",
  },
  alreadyUploaded: {
    title: "Already uploaded",
    message:
      "A file was already uploaded on this page. To send another file, ask your assistant for a " +
      "new upload link.",
  },
  receiving: {
    title: "Upload in progress",
    message: "A file is being received for this page. Reload the page in a moment.",
  },
  wrongKind: {
    title: "File type not accepted",
    message:
      "This page does not accept this type of file. The type is checked by the file's content, " +
      "not by its name. Go back and choose another file.",
  },
  empty: { title: "Empty file", message: "The chosen file is empty. Go back and choose another." },
  badForm: {
    title: "Bad request",
    message: "The upload could not be read. Use the form on the upload page to send one file.",
  },
  lengthRequired: {
    title: "Size missing",
    message:
      "The upload did not state its size. Use the form on the upload page in a current browser.",
  },
  foreignPost: {
    title: "Request refused",
    message: "The upload did not come from this server's own page. Open the upload link again.",
  },
  csrf: {
    title: "Request refused",
    message: "The upload could not be verified. Reload the upload page and try again.",
  },
  signedOut: {
    title: "Sign in again",
    message:
      "Your sign-in has ended. Open the upload link again, sign in, and choose the file again.",
  },
  limited: {
    title: "Too many uploads",
    message: "Too many uploads from this network. Wait a minute, then try again.",
  },
  busy: {
    title: "Server busy",
    message: "Other uploads are being received right now. Try again in a moment.",
  },
  busyAccount: {
    title: "Upload in progress",
    message:
      "Another upload of this sevDesk account is being received right now. Wait until it has " +
      "finished, then try again.",
  },
  storageFull: {
    title: "No space for the file",
    message:
      "The server has no room for this file right now: this sevDesk account, or all accounts " +
      "together, hold too many files. Try again once older uploads and download links have " +
      "expired.",
  },
  failed: {
    title: "Upload failed",
    message: "The file could not be stored. Try again in a moment.",
  },
  fileNotFound: {
    title: "File not found",
    message:
      "This download link is unknown, has expired, or belongs to another sevDesk account. Ask " +
      "your assistant to create the file again.",
  },
  fileExpired: {
    title: "Download link expired",
    message: "This download link is no longer valid. Ask your assistant to create the file again.",
  },
  fileExhausted: {
    title: "Download link used up",
    message:
      "This download link was already used as often as it allows. Ask your assistant to create " +
      "the file again.",
  },
} as const satisfies Readonly<Record<string, PageText>>;

/** "File too large" with the page's limit. */
export function tooLargeText(maxBytes: number): PageText {
  return {
    title: "File too large",
    message: `The file is larger than this page accepts (${megabytes(maxBytes)}). Go back and choose a smaller file.`,
  };
}

/** A message page without links (the transfer pages have no list to go back to). */
export function transferMessage(
  status: number,
  text: PageText,
  headers?: Readonly<Record<string, string>>,
): Response {
  return pageResponse(
    status,
    (nonce) => renderMessagePage(text.title, text.message, nonce),
    headers,
  );
}

const KIND_LABELS: Readonly<Record<LocalFileKind, string>> = {
  pdf: "PDF",
  png: "PNG",
  jpeg: "JPEG",
  xml: "XML",
};

/** What the file picker offers per kind. */
const KIND_ACCEPT: Readonly<Record<LocalFileKind, string>> = {
  pdf: ".pdf,application/pdf",
  png: ".png,image/png",
  jpeg: ".jpg,.jpeg,image/jpeg",
  xml: ".xml,application/xml,text/xml",
};

const PURPOSE_TEXT: Readonly<Record<UploadPurpose, { title: string; noun: string }>> = {
  receipt: { title: "Upload a receipt", noun: "a receipt" },
  einvoice: { title: "Upload an e-invoice", noun: "an e-invoice (XRechnung or ZUGFeRD)" },
};

/** `PDF, PNG or JPEG`. */
export function kindList(kinds: readonly LocalFileKind[]): string {
  const labels = kinds.map((kind) => KIND_LABELS[kind]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} or ${labels.at(-1) ?? ""}`;
}

/** What the upload form shows. Every value is trusted (from the ticket, not the model). */
export interface UploadPageModel {
  readonly accountId: string;
  readonly purpose: UploadPurpose;
  readonly kinds: readonly LocalFileKind[];
  readonly maxBytes: number;
  readonly reference: string;
  /** ISO 8601. */
  readonly expiresAt: string;
  readonly formAction: string;
  readonly csrf: string;
}

/** The upload form: one file, sent as `multipart/form-data` with the CSRF tag. */
export function renderUploadPage(model: UploadPageModel, nonce: string): string {
  const purpose = PURPOSE_TEXT[model.purpose];
  const accept = model.kinds.map((kind) => KIND_ACCEPT[kind]).join(",");
  const body = `<h1>${escapeHtml(purpose.title)}</h1>
<p class="lead">Your AI assistant asked for ${escapeHtml(purpose.noun)} for sevDesk account
<strong>${escapeHtml(model.accountId)}</strong>. Choose the file here: it goes to this server only,
and only the assistant connection that asked for it can use it.</p>
<dl class="facts">
<dt>Accepted</dt><dd>${escapeHtml(kindList(model.kinds))} (checked by content)</dd>
<dt>Largest file</dt><dd>${escapeHtml(megabytes(model.maxBytes))}</dd>
<dt>Use before</dt><dd>${escapeHtml(formatPageTime(model.expiresAt))}</dd>
</dl>
<form method="post" action="${escapeHtml(model.formAction)}" enctype="multipart/form-data" class="upload">
<input type="hidden" name="csrf" value="${escapeHtml(model.csrf)}">
<label for="file">File</label>
<input type="file" id="file" name="file" accept="${escapeHtml(accept)}" required>
<button type="submit" class="approve">Upload</button>
</form>
<p class="reference">Reference: <strong>${escapeHtml(model.reference)}</strong> (your assistant names the same code)</p>
<p class="small">This page takes one file. After uploading, go back to your assistant and tell it the
file is there.</p>`;
  return renderPage(purpose.title, body, nonce, UPLOAD_STYLE);
}

/** What the receipt shows after an upload. */
export interface UploadReceiptModel {
  /** The cleaned file name (escaped here). */
  readonly name: string;
  readonly kind: LocalFileKind;
  readonly size: number;
  readonly reference: string;
  /** ISO 8601: until when the assistant can use the file. */
  readonly expiresAt: string;
}

/** The page after a successful upload (and when the upload page is opened again). */
export function renderUploadReceipt(model: UploadReceiptModel, nonce: string): string {
  const body = `<h1>File received</h1>
<p class="lead">The server received <strong>${escapeHtml(model.name)}</strong>
(${escapeHtml(KIND_LABELS[model.kind])}, ${escapeHtml(megabytes(model.size))}). Go back to your
assistant and tell it the upload is done. It can use the file until
${escapeHtml(formatPageTime(model.expiresAt))}.</p>
<p class="reference">Reference: <strong>${escapeHtml(model.reference)}</strong></p>`;
  return renderPage("File received", body, nonce, UPLOAD_STYLE);
}

/** `Content-Type` of a download (CSV is UTF-8 text). */
function contentType(kind: OutputFileKind): string {
  return kind === "csv" ? `${MIME_TYPES.csv}; charset=utf-8` : MIME_TYPES[kind];
}

/**
 * `attachment; filename="<ASCII>"; filename*=UTF-8''<percent-encoded>`: never `inline`. The ASCII
 * fallback keeps `[A-Za-z0-9._-]` only; control characters are dropped before encoding.
 */
export function contentDisposition(filename: string): string {
  const cleaned = printable(filename);
  const ascii =
    cleaned
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^[._-]+/, "")
      .slice(0, 150) || "download";
  const encoded = encodeURIComponent(cleaned.slice(0, 150)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded || ascii}`;
}

/** `text` without control characters (C0, DEL, C1) and lone surrogates (they break encoding). */
function printable(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const loneSurrogate = code >= 0xd800 && code <= 0xdfff;
    if (!control && !loneSurrogate) result += char;
  }
  return result;
}

/** The bytes of a download link, as an attachment that no browser renders on this origin. */
export function downloadResponse(file: ServedDownload): Response {
  return new Response(file.bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType(file.kind),
      "Content-Disposition": contentDisposition(file.filename),
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": "no-store, no-transform",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Accept-Ranges": "none",
    },
  });
}

/** Added to the shared page style on the upload pages. */
const UPLOAD_STYLE = `.facts { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 1rem 1.25rem; margin: 1rem 0 1.5rem; }
form.upload { display: block; margin: 0 0 1.5rem; }
input[type="file"] { font: inherit; display: block; width: 100%; box-sizing: border-box;
  padding: 0.6rem 0; margin: 0 0 0.75rem; }
`;
