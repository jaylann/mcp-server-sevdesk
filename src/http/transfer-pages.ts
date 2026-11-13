/**
 * Pages and responses of remote file transfer (`transfer-routes.ts`): the upload form, the upload
 * receipt, the message pages, and the download response. They share the frame of all pages
 * (`renderFrame`: one nonce-allowed style block, no script, strict CSP via `htmlResponse`).
 *
 * The upload page shows trusted values only (purpose, accepted kinds, size limit, reference,
 * expiry, account): the model cannot put text on it. The one value a user chose, the uploaded
 * file's name, is shown cleaned and escaped on the receipt. Downloads are always attachments
 * under a sandboxing CSP: a file is never rendered on this origin (XML could run XHTML script).
 */
import { facts, pageTime, reference } from "../pages/components.js";
import type { PageContext, RenderContext } from "../pages/context.js";
import { renderFrame } from "../pages/frame.js";
import { markup } from "../pages/html.js";
import { icon } from "../pages/icons.js";
import { renderMessagePage, toneForStatus } from "../pages/message.js";
import type { PageMessage } from "../pages/text/index.js";
import { formatPageTime } from "../safety/approval-page.js";
import type { OutputFileKind } from "../safety/file-access.js";
import type { LocalFileKind } from "../safety/local-files.js";
import { megabytes, MIME_TYPES, type ServedDownload } from "../safety/transfer-store.js";
import type { UploadBatchState, UploadPurpose } from "../safety/transfer-types.js";
import { pageResponse } from "./approval-pages.js";

/** Prefix of the upload pages, `/uploads/<id>`. */
export const UPLOADS_PREFIX = "/uploads/";
/** Prefix of the download links, `/files/<id>`. */
export const FILES_PREFIX = "/files/";

/** A message page without links (the transfer pages have no list to go back to). */
export function transferMessage(
  page: PageContext,
  status: number,
  text: PageMessage,
  headers?: Readonly<Record<string, string>>,
): Response {
  return pageResponse(
    page,
    status,
    (ctx) => renderMessagePage(text, ctx, { tone: toneForStatus(status) }),
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

/** `PDF, PNG or JPEG`, with the page's word for "or". */
export function kindList(kinds: readonly LocalFileKind[], or = "or"): string {
  const labels = kinds.map((kind) => KIND_LABELS[kind]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} ${or} ${labels.at(-1) ?? ""}`;
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

/**
 * The upload form: one file, sent as `multipart/form-data` with the CSRF tag. The file field is
 * the drop zone itself (the stylesheet gives the native control the room), so dragging a file
 * onto it works without script and the browser shows the chosen file's name.
 */
export function renderUploadPage(model: UploadPageModel, ctx: RenderContext): string {
  const t = ctx.t.upload;
  const purpose = t[model.purpose];
  const accept = model.kinds.map((kind) => KIND_ACCEPT[kind]).join(",");
  const limits = facts(
    [
      { label: t.accepted, value: t.byContent(kindList(model.kinds, t.or)), long: false },
      { label: t.largest, value: megabytes(model.maxBytes) },
      { label: t.useBefore, value: formatPageTime(model.expiresAt) },
    ],
    { plain: true },
  );
  const account = markup`<strong>${model.accountId}</strong>`;
  const code = reference(model.reference);
  const body = markup`<h1>${purpose.title}</h1>
<p class="lead">${t.lead(purpose.noun, account)}</p>
<section class="sheet">
${limits}
<form method="post" action="${model.formAction}" enctype="multipart/form-data" class="upload">
<input type="hidden" name="csrf" value="${model.csrf}">
<label for="file" class="field">${t.file}</label>
<input type="file" id="file" name="file" accept="${accept}" required>
<p class="hint">${t.dropHint}</p>
<button type="submit" class="btn btn-ink">${icon("upload")}${t.submit}</button>
</form>
</section>
<p class="fine after"><span class="ref-line">${ctx.t.approval.reference} ${code}</span> ${ctx.t.approval.sameCode} ${t.fine}</p>`;
  return renderFrame({ title: purpose.title, body }, ctx);
}

/** A batch's progress and native multi-file form. Every file name is escaped by `markup`. */
export function renderUploadBatch(
  model: {
    readonly batch: UploadBatchState;
    readonly accountId: string;
    readonly csrf: string;
    readonly maxTotalBytes: number;
    readonly error?: PageMessage;
  },
  ctx: RenderContext,
): string {
  const { batch } = model;
  const t = ctx.t.upload;
  const b = t.batch;
  const pending = batch.slots.filter((slot) => slot.status === "pending");
  const remaining = pending.length;
  const accept = batch.kinds.map((kind) => KIND_ACCEPT[kind]).join(",");
  const limits = facts(
    [
      { label: t.accepted, value: t.byContent(kindList(batch.kinds, t.or)) },
      { label: t.largest, value: megabytes(batch.maxBytes) },
      { label: b.total, value: megabytes(model.maxTotalBytes) },
      { label: t.useBefore, value: formatPageTime(batch.expiresAt) },
    ],
    { plain: true },
  );
  const progress = batch.slots.map(
    (slot, index) => markup`<li class="row"><div class="row-main">
<p class="row-title"><strong>${slot.file?.name ?? b.slot(index + 1)}</strong> — ${b[slot.status]}</p>
${slot.file === undefined ? markup`` : markup`<p class="row-meta">${KIND_LABELS[slot.file.kind]}, ${megabytes(slot.file.size)} · ${t.useBefore} ${pageTime(slot.expiresAt)}</p>`}
</div></li>`,
  );
  const form =
    remaining === 0
      ? markup`<p>${b.closed}</p>`
      : markup`
<h2>${b.remaining(remaining)}</h2>
${limits}
<form method="post" action="${UPLOADS_PREFIX}${batch.id}" enctype="multipart/form-data" class="upload">
<input type="hidden" name="csrf" value="${model.csrf}">
<input type="hidden" name="slots" value="${pending.map((slot) => slot.id).join(",")}">
<label for="file" class="field">${b.files}</label>
<input type="file" id="file" name="file" accept="${accept}" multiple required>
<p class="hint">${b.hint}</p>
<button type="submit" class="btn btn-ink">${icon("upload")}${t.submit}</button>
</form>`;
  const error =
    model.error === undefined
      ? markup``
      : markup`<div class="callout" role="alert"><div><h2>${model.error.title}</h2><p>${model.error.message}</p></div></div>`;
  const body = markup`<h1>${b.title}</h1>
<p class="lead">${b.lead(batch.count, markup`<strong>${model.accountId}</strong>`)}</p>
<section class="sheet">${error}${form}<section class="next"><h2>${b.progress}</h2><ul>${progress}</ul></section></section>
<p class="fine after"><span class="ref-line">${ctx.t.approval.reference} ${reference(batch.reference)}</span> ${b.fine}</p>`;
  return renderFrame({ title: b.title, body }, ctx);
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
export function renderUploadReceipt(model: UploadReceiptModel, ctx: RenderContext): string {
  const t = ctx.t.upload;
  const lead = t.receivedLead(
    markup`<strong>${model.name}</strong>`,
    KIND_LABELS[model.kind],
    megabytes(model.size),
    pageTime(model.expiresAt),
  );
  const body = markup`<section class="sheet">
<div class="result-icon result-ok">${icon("check", 2)}</div>
<h1>${t.received}</h1>
<p class="message">${lead}</p>
${facts([{ label: ctx.t.approval.reference, value: reference(model.reference) }])}
</section>`;
  return renderFrame({ title: t.received, body }, ctx);
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
