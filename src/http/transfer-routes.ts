/**
 * The browser side of remote file transfer (HTTP mode, `SEVDESK_HTTP_FILES=on`): the human
 * uploads a file a tool asked for, and downloads files tools created. See
 * docs/adr/0008-file-transfer-over-http.md.
 *
 * URLs are not capabilities: every page needs a browser session of the record's account
 * (`browser-session.ts`: set at OAuth consent, or by signing in with the account's sevDesk
 * token). Without one, a page shows only the sign-in form (no record data) with a `next` back to
 * the page. A record of another account answers exactly like an unknown id (404).
 *
 * Routes (`form` origin policy; together 60 requests a minute per client IP or IPv6 /64):
 * - `GET /uploads/<id>`: the upload form (trusted text only), the receipt once uploaded, 410 when
 *   expired;
 * - `POST /uploads/<id>`: `multipart/form-data` with exactly the fields `csrf` and `file`. Before
 *   the body is read (router `preflight`): 10 uploads a minute and 60 an hour per client, a
 *   same-origin POST, a session, a pending ticket of the session's account, a declared
 *   `Content-Length` (411) within the ticket's limit (413), and at most 2 upload bodies at once
 *   (503). Then the CSRF tag (`keyedTag(csrf, sid)`), the kind by content (`sniffKind`, 415), and
 *   the cleaned name (`safeFilename`, extension from the sniffed kind). 409 for a second upload;
 *   uploads are never served back;
 * - `GET /files/<id>`: the file as an attachment (`downloadResponse`), at most 5 times, 410 once
 *   expired or used up. HEAD is not allowed (405). No sevDesk request is ever made here: the bytes
 *   were fetched during the tool call.
 *
 * Logs name the account, the reference, the kind and the size (`upload_received`,
 * `upload_refused` with a reason, `download_served`, `download_refused`), never ids or file
 * names; the router logs the route template only.
 */
import { safeFilename } from "../domain/document-files.js";
import { type LocalFileKind, sniffKind } from "../safety/local-files.js";
import {
  type FileTransferStore,
  MAX_UPLOAD_BYTES,
  type UploadTicketState,
} from "../safety/transfer-store.js";
import { sameOriginPost } from "../safety/web.js";
import { pageResponse } from "./approval-pages.js";
import type { BrowserSession } from "./browser-session.js";
import { rateLimitKey } from "./client-ip.js";
import {
  downloadResponse,
  FILES_PREFIX,
  renderUploadPage,
  renderUploadReceipt,
  tooLargeText,
  TRANSFER_TEXT,
  transferMessage,
  UPLOADS_PREFIX,
} from "./transfer-pages.js";
import type { HttpRequestContext, HttpRoute, RateRule, SessionRecord } from "./types.js";

/** All upload and download requests together per client IP (IPv6 by /64). */
export const FILES_RATE: RateRule = { name: "files", perMinute: 60 };
/** Upload POSTs per client: 10 a minute … */
export const UPLOAD_RATE_MINUTE: RateRule = { name: "uploads", perMinute: 10 };
/** … and 60 an hour. */
export const UPLOAD_RATE_HOUR: RateRule = { name: "uploads-hour", perMinute: 1, burst: 60 };

/** Room for the multipart framing and the CSRF field around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** The route's body limit: the largest upload plus framing. */
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;
/** Time an upload body may take (below the router's 120 s request deadline). */
const UPLOAD_BODY_TIMEOUT_MS = 90_000;
/** Upload bodies received at once (memory: each is held about three times while parsed). */
const MAX_CONCURRENT_UPLOADS = 2;
/** Ticket and link ids: 256 bit, base64url. */
const RECORD_ID = /^[A-Za-z0-9_-]{43}$/;

export interface TransferRoutesOptions {
  readonly store: FileTransferStore;
  /** The browser sessions (shared with the approval inbox when it is on). */
  readonly session: BrowserSession;
  /** The public origin, e.g. `https://mcp.example.com`. */
  readonly origin: string;
}

/** Refusal reasons in `upload_refused` / `download_refused` log lines. */
type RefusalReason =
  | "rate_limited"
  | "foreign_origin"
  | "signed_out"
  | "unknown"
  | "expired"
  | "exhausted"
  | "already_received"
  | "unsupported_type"
  | "length_required"
  | "too_large"
  | "bad_form"
  | "csrf"
  | "empty"
  | "wrong_kind"
  | "storage_full"
  | "failed";

/** Creates `/uploads/` and `/files/`. */
export function createTransferRoutes(options: TransferRoutesOptions): readonly HttpRoute[] {
  const { store, session, origin } = options;

  function refused(
    ctx: HttpRequestContext,
    reason: RefusalReason,
    response: Response,
    record?: SessionRecord,
  ): Response {
    ctx.log.warn("upload_refused", {
      reason,
      ...(record === undefined ? {} : { account: record.accountId }),
    });
    return response;
  }

  function idOf(request: Request, prefix: string): string | undefined {
    const id = new URL(request.url).pathname.slice(prefix.length);
    return RECORD_ID.test(id) ? id : undefined;
  }

  /** The sign-in page, returning to this page afterwards when its path is well formed. */
  function signInPage(request: Request, prefix: string): Response {
    const id = idOf(request, prefix);
    return session.loginPage(200, { next: id === undefined ? undefined : `${prefix}${id}` });
  }

  function isMultipart(request: Request): boolean {
    const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    return type === "multipart/form-data";
  }

  /**
   * The checks every upload POST passes before its body is read, repeated by the handler (so the
   * route is safe without the router's preflight): the session and a pending ticket of its
   * account. Returns the refusal, or the session and ticket.
   */
  async function admit(
    request: Request,
    ctx: HttpRequestContext,
  ): Promise<Response | { record: SessionRecord; ticket: UploadTicketState; id: string }> {
    if (!sameOriginPost(request, origin)) {
      return refused(ctx, "foreign_origin", transferMessage(403, TRANSFER_TEXT.foreignPost));
    }
    const record = await session.sessionOf(request, ctx);
    if (record === undefined) {
      return refused(ctx, "signed_out", transferMessage(403, TRANSFER_TEXT.signedOut));
    }
    const id = idOf(request, UPLOADS_PREFIX);
    const ticket = id === undefined ? undefined : store.ticketFor(id, record.accountId);
    if (id === undefined || ticket === undefined) {
      return refused(ctx, "unknown", transferMessage(404, TRANSFER_TEXT.uploadNotFound), record);
    }
    if (ticket === "expired") {
      return refused(ctx, "expired", transferMessage(410, TRANSFER_TEXT.uploadExpired), record);
    }
    if (ticket.status !== "pending") {
      return refused(
        ctx,
        "already_received",
        transferMessage(409, TRANSFER_TEXT.alreadyUploaded),
        record,
      );
    }
    if (!isMultipart(request)) {
      return refused(ctx, "unsupported_type", transferMessage(415, TRANSFER_TEXT.badForm), record);
    }
    return { record, ticket, id };
  }

  /** Before the body: rate limits, {@link admit}, and the declared length. */
  async function preflight(head: Request, ctx: HttpRequestContext): Promise<Response | undefined> {
    if (head.method !== "POST") return undefined;
    const client = rateLimitKey(ctx.clientIp);
    if (!ctx.limit(UPLOAD_RATE_MINUTE, client) || !ctx.limit(UPLOAD_RATE_HOUR, client)) {
      return refused(
        ctx,
        "rate_limited",
        transferMessage(429, TRANSFER_TEXT.limited, { "Retry-After": "60" }),
      );
    }
    const admitted = await admit(head, ctx);
    if (admitted instanceof Response) return admitted;
    const declared = head.headers.get("content-length");
    if (declared === null || !/^\d{1,12}$/.test(declared.trim())) {
      return refused(
        ctx,
        "length_required",
        transferMessage(411, TRANSFER_TEXT.lengthRequired),
        admitted.record,
      );
    }
    if (Number(declared) > admitted.ticket.maxBytes + MULTIPART_OVERHEAD_BYTES) {
      return refused(
        ctx,
        "too_large",
        transferMessage(413, tooLargeText(admitted.ticket.maxBytes)),
        admitted.record,
      );
    }
    return undefined;
  }

  async function showUpload(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const record = await session.sessionOf(request, ctx);
    if (record === undefined) return signInPage(request, UPLOADS_PREFIX);
    const id = idOf(request, UPLOADS_PREFIX);
    const ticket = id === undefined ? undefined : store.ticketFor(id, record.accountId);
    if (id === undefined || ticket === undefined) {
      return transferMessage(404, TRANSFER_TEXT.uploadNotFound);
    }
    if (ticket === "expired") return transferMessage(410, TRANSFER_TEXT.uploadExpired);
    if (ticket.status === "receiving") return transferMessage(200, TRANSFER_TEXT.receiving);
    if (ticket.file !== undefined) return receiptPage(ticket);
    return pageResponse(200, (nonce) =>
      renderUploadPage(
        {
          accountId: record.accountId,
          purpose: ticket.purpose,
          kinds: ticket.kinds,
          maxBytes: ticket.maxBytes,
          reference: ticket.reference,
          expiresAt: ticket.expiresAt,
          formAction: `${UPLOADS_PREFIX}${id}`,
          csrf: session.csrfTag(record),
        },
        nonce,
      ),
    );
  }

  function receiptPage(ticket: UploadTicketState): Response {
    const file = ticket.file;
    if (file === undefined) return transferMessage(200, TRANSFER_TEXT.receiving);
    return pageResponse(200, (nonce) =>
      renderUploadReceipt(
        {
          name: file.name,
          kind: file.kind,
          size: file.size,
          reference: ticket.reference,
          expiresAt: ticket.expiresAt,
        },
        nonce,
      ),
    );
  }

  async function upload(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const admitted = await admit(request, ctx);
    if (admitted instanceof Response) return admitted;
    const { record, ticket, id } = admitted;
    const refuse = (reason: RefusalReason, response: Response): Response =>
      refused(ctx, reason, response, record);

    let form: FormData;
    try {
      // undici marks `formData()` as not recommended for servers: it buffers the whole body. Here
      // the router already holds the whole body, capped at 20 MiB + 64 KiB, with at most 2
      // uploads at once and only after the session and ticket checks; no extra dependency.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      form = await request.formData();
    } catch {
      return refuse("bad_form", transferMessage(400, TRANSFER_TEXT.badForm));
    }
    const names = [...form.keys()].sort();
    if (names.length !== 2 || names[0] !== "csrf" || names[1] !== "file") {
      return refuse("bad_form", transferMessage(400, TRANSFER_TEXT.badForm));
    }
    const csrf = form.get("csrf");
    if (typeof csrf !== "string" || !session.csrfValid(record, csrf)) {
      return refuse("csrf", transferMessage(403, TRANSFER_TEXT.csrf));
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return refuse("bad_form", transferMessage(400, TRANSFER_TEXT.badForm));
    }
    if (file.size === 0) return refuse("empty", transferMessage(400, TRANSFER_TEXT.empty));
    if (file.size > ticket.maxBytes) {
      return refuse("too_large", transferMessage(413, tooLargeText(ticket.maxBytes)));
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffKind(bytes);
    if (kind === undefined || !ticket.kinds.includes(kind)) {
      return refuse("wrong_kind", transferMessage(415, TRANSFER_TEXT.wrongKind));
    }
    let outcome;
    try {
      outcome = await store.receive(id, record.accountId, {
        name: uploadName(file.name, kind),
        kind,
        bytes,
      });
    } catch {
      return refuse("failed", transferMessage(500, TRANSFER_TEXT.failed));
    }
    switch (outcome.status) {
      case "received":
        ctx.log.info("upload_received", {
          account: record.accountId,
          reference: outcome.ticket.reference,
          kind,
          bytes: bytes.byteLength,
        });
        return receiptPage(outcome.ticket);
      case "unknown":
        return refuse("unknown", transferMessage(404, TRANSFER_TEXT.uploadNotFound));
      case "expired":
        return refuse("expired", transferMessage(410, TRANSFER_TEXT.uploadExpired));
      case "already_received":
        return refuse("already_received", transferMessage(409, TRANSFER_TEXT.alreadyUploaded));
      case "wrong_kind":
        return refuse("wrong_kind", transferMessage(415, TRANSFER_TEXT.wrongKind));
      case "too_large":
        return refuse("too_large", transferMessage(413, tooLargeText(ticket.maxBytes)));
      case "storage_full":
        return refuse("storage_full", transferMessage(507, TRANSFER_TEXT.storageFull));
    }
  }

  async function download(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const record = await session.sessionOf(request, ctx);
    const deny = (reason: RefusalReason, response: Response): Response => {
      ctx.log.warn("download_refused", {
        reason,
        ...(record === undefined ? {} : { account: record.accountId }),
      });
      return response;
    };
    if (record === undefined) return deny("signed_out", signInPage(request, FILES_PREFIX));
    const id = idOf(request, FILES_PREFIX);
    if (id === undefined) return deny("unknown", transferMessage(404, TRANSFER_TEXT.fileNotFound));
    const outcome = await store.takeDownload(id, record.accountId);
    switch (outcome.status) {
      case "served":
        ctx.log.info("download_served", {
          account: record.accountId,
          reference: outcome.file.reference,
          kind: outcome.file.kind,
          bytes: outcome.file.bytes.byteLength,
        });
        return downloadResponse(outcome.file);
      case "unknown":
        return deny("unknown", transferMessage(404, TRANSFER_TEXT.fileNotFound));
      case "expired":
        return deny("expired", transferMessage(410, TRANSFER_TEXT.fileExpired));
      case "exhausted":
        return deny("exhausted", transferMessage(410, TRANSFER_TEXT.fileExhausted));
    }
  }

  return [
    {
      path: UPLOADS_PREFIX,
      match: "prefix",
      methods: ["GET", "POST"],
      maxBodyBytes: MAX_UPLOAD_BODY_BYTES,
      origin: "form",
      rateLimit: FILES_RATE,
      preflight,
      bodyTimeoutMs: UPLOAD_BODY_TIMEOUT_MS,
      bodySlots: {
        max: MAX_CONCURRENT_UPLOADS,
        busy: () => transferMessage(503, TRANSFER_TEXT.busy, { "Retry-After": "10" }),
      },
      handle: (request, ctx) =>
        request.method === "POST" ? upload(request, ctx) : showUpload(request, ctx),
    },
    {
      path: FILES_PREFIX,
      match: "prefix",
      methods: ["GET"],
      maxBodyBytes: 0,
      origin: "form",
      rateLimit: FILES_RATE,
      handle: (request, ctx) => download(request, ctx),
    },
  ];
}

/**
 * The name an upload is kept under: the last segment of what the browser sent, cleaned to
 * `[A-Za-z0-9._-]` (umlauts transliterated, invisible and control characters, quotes, markup and
 * path separators removed), at most 100 characters, with the extension of the kind its content
 * shows (`upload.pdf` when nothing usable is left). Never used as a path.
 */
export function uploadName(raw: string, kind: LocalFileKind): string {
  const extension = kind === "jpeg" ? "jpg" : kind;
  const stem = raw.replace(/\.(?:pdf|png|jpe?g|xml)$/i, "");
  return safeFilename(stem, "upload", extension);
}
