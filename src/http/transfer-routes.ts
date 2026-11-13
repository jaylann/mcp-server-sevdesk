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
 * - `POST /uploads/<id>`: `multipart/form-data` with one `csrf`, one or more `file` parts, and a
 *   batch's `slots` binding. Successful batch submissions redirect to GET. Before
 *   the body is read (router `preflight`): 10 uploads a minute and 60 an hour per client, a
 *   same-origin POST, a session, a pending ticket of the session's account, a declared
 *   `Content-Length` (411) within the ticket's limit (413), and at most 2 upload bodies at once on
 *   the server and 1 per account (503). The body must arrive within 90 s, never pause for 10 s and
 *   average at least 16 KB/s after the first 10 s (408), so a trickled body cannot hold a slot.
 *   Then the CSRF tag (`keyedTag(csrf, sid)`), the kind by content (`sniffKind`, 415), and
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
import type { PageMessage, Texts } from "../pages/text/index.js";
import { type LocalFileKind, sniffKind } from "../safety/local-files.js";
import {
  type FileTransferStore,
  MAX_UPLOAD_BYTES,
  megabytes,
  type UploadTicketState,
} from "../safety/transfer-store.js";
import type { UploadBatchState } from "../safety/transfer-types.js";
import { sameOriginPost } from "../safety/web.js";
import { pageOf, pageResponse } from "./approval-pages.js";
import type { BrowserSession } from "./browser-session.js";
import { rateLimitKey } from "./client-ip.js";
import {
  downloadResponse,
  FILES_PREFIX,
  renderUploadBatch,
  renderUploadPage,
  renderUploadReceipt,
  transferMessage,
  UPLOADS_PREFIX,
} from "./transfer-pages.js";
import type {
  BodyPace,
  HttpRequestContext,
  HttpRoute,
  PreflightPass,
  RateRule,
  SessionRecord,
} from "./types.js";

/** All upload and download requests together per client IP (IPv6 by /64). */
export const FILES_RATE: RateRule = { name: "files", perMinute: 60 };
/** Upload POSTs per client: 10 a minute … */
export const UPLOAD_RATE_MINUTE: RateRule = { name: "uploads", perMinute: 10 };
/** … and 60 an hour. */
export const UPLOAD_RATE_HOUR: RateRule = { name: "uploads-hour", perMinute: 1, burst: 60 };

/** Room for the multipart framing and the CSRF field around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
/** Absolute route cap: ten largest files plus framing; preflight tightens it per request. */
export const MAX_UPLOAD_BODY_BYTES = 10 * MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;

/** Time an upload body may take (below the router's 120 s request deadline). */
const UPLOAD_BODY_TIMEOUT_MS = 90_000;
/**
 * How fast an upload body must keep coming: no pause of 10 s, and 16 KB/s on average once 10 s
 * have passed. A legitimate upload is far faster; a trickled one loses its slot within seconds.
 */
const UPLOAD_BODY_PACE: BodyPace = {
  idleMs: 10_000,
  graceMs: 10_000,
  minBytesPerSecond: 16 * 1024,
};
/** Upload bodies received at once (memory: each is held about three times while parsed). */
const MAX_CONCURRENT_UPLOADS = 2;
/** Upload bodies of one sevDesk account at once: no account can take every slot. */
const MAX_CONCURRENT_UPLOADS_PER_ACCOUNT = 1;
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
  | "stale_form"
  | "csrf"
  | "empty"
  | "wrong_kind"
  | "storage_full"
  | "failed";

/** Creates `/uploads/` and `/files/`. */
export function createTransferRoutes(options: TransferRoutesOptions): readonly HttpRoute[] {
  const { store, session, origin } = options;

  /** A message page in the language of `request`. */
  function say(
    request: Request,
    status: number,
    pick: (texts: Texts["transfer"]) => PageMessage,
    headers?: Readonly<Record<string, string>>,
  ): Response {
    const page = pageOf(request, origin);
    return transferMessage(page, status, pick(page.t.transfer), headers);
  }

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
    return session.loginPage(pageOf(request, origin), 200, {
      next: id === undefined ? undefined : `${prefix}${id}`,
    });
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
  ): Promise<
    | Response
    | { record: SessionRecord; ticket: UploadTicketState; id: string; batch?: UploadBatchState }
  > {
    if (!sameOriginPost(request, origin)) {
      return refused(
        ctx,
        "foreign_origin",
        say(request, 403, (t) => t.foreignPost),
      );
    }
    const record = await session.sessionOf(request, ctx);
    if (record === undefined) {
      return refused(
        ctx,
        "signed_out",
        say(request, 403, (t) => t.signedOut),
      );
    }
    const id = idOf(request, UPLOADS_PREFIX);
    const batch = id === undefined ? undefined : store.batchFor(id, record.accountId);
    const pending = batch?.slots.find((slot) => slot.status === "pending");
    if (batch !== undefined && pending === undefined) {
      return batchPage(request, record, batch, 409);
    }
    const ticket: UploadTicketState | "expired" | undefined =
      batch === undefined
        ? id === undefined
          ? undefined
          : store.ticketFor(id, record.accountId)
        : { ...batch, accountId: record.accountId, status: "pending" };
    if (id === undefined || ticket === undefined) {
      return refused(
        ctx,
        "unknown",
        say(request, 404, (t) => t.uploadNotFound),
        record,
      );
    }
    if (ticket === "expired") {
      return refused(
        ctx,
        "expired",
        say(request, 410, (t) => t.uploadExpired),
        record,
      );
    }
    if (ticket.status !== "pending") {
      return refused(
        ctx,
        "already_received",
        say(request, 409, (t) => t.alreadyUploaded),
        record,
      );
    }
    if (!isMultipart(request)) {
      return refused(
        ctx,
        "unsupported_type",
        say(request, 415, (t) => t.badForm),
        record,
      );
    }
    return { record, ticket, id, ...(batch === undefined ? {} : { batch }) };
  }

  /**
   * Before the body: rate limits, {@link admit}, and the declared length. A POST that passes
   * counts its body slot under its account.
   */
  async function preflight(
    head: Request,
    ctx: HttpRequestContext,
  ): Promise<Response | PreflightPass | undefined> {
    if (head.method !== "POST") return undefined;
    const client = rateLimitKey(ctx.clientIp);
    if (!ctx.limit(UPLOAD_RATE_MINUTE, client) || !ctx.limit(UPLOAD_RATE_HOUR, client)) {
      return refused(
        ctx,
        "rate_limited",
        say(head, 429, (t) => t.limited, { "Retry-After": "60" }),
      );
    }
    const admitted = await admit(head, ctx);
    if (admitted instanceof Response) return admitted;
    const declared = head.headers.get("content-length");
    if (declared === null || !/^\d{1,12}$/.test(declared.trim())) {
      return refused(
        ctx,
        "length_required",
        say(head, 411, (t) => t.lengthRequired),
        admitted.record,
      );
    }
    const limit = submissionLimit(admitted.ticket, admitted.batch);
    if (Number(declared) > limit) {
      return refused(
        ctx,
        "too_large",
        admitted.batch === undefined
          ? say(head, 413, (t) => t.tooLarge(megabytes(admitted.ticket.maxBytes)))
          : batchPage(
              head,
              admitted.record,
              admitted.batch,
              413,
              pageOf(head, origin).t.upload.batch.tooLarge(
                megabytes(limit - MULTIPART_OVERHEAD_BYTES),
              ),
            ),
        admitted.record,
      );
    }
    return { bodySlotKey: admitted.record.accountId, maxBodyBytes: limit };
  }

  async function showUpload(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const record = await session.sessionOf(request, ctx);
    if (record === undefined) return signInPage(request, UPLOADS_PREFIX);
    const id = idOf(request, UPLOADS_PREFIX);
    const batch = id === undefined ? undefined : store.batchFor(id, record.accountId);
    if (batch !== undefined) return batchPage(request, record, batch);
    const ticket = id === undefined ? undefined : store.ticketFor(id, record.accountId);
    if (id === undefined || ticket === undefined) {
      return say(request, 404, (t) => t.uploadNotFound);
    }
    if (ticket === "expired") return say(request, 410, (t) => t.uploadExpired);
    if (ticket.status === "receiving") return say(request, 200, (t) => t.receiving);
    if (ticket.file !== undefined) return receiptPage(request, ticket);
    return pageResponse(pageOf(request, origin), 200, (render) =>
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
        render,
      ),
    );
  }

  function submissionLimit(ticket: UploadTicketState, batch?: UploadBatchState): number {
    const count = batch?.slots.filter((slot) => slot.status === "pending").length ?? 1;
    const bytes =
      batch === undefined
        ? ticket.maxBytes
        : Math.min(ticket.maxBytes * count, store.uploadRoom(ticket.accountId));
    return bytes + MULTIPART_OVERHEAD_BYTES;
  }

  function batchPage(
    request: Request,
    record: SessionRecord,
    batch: UploadBatchState,
    status = 200,
    error?: PageMessage,
  ): Response {
    return pageResponse(pageOf(request, origin), status, (render) =>
      renderUploadBatch(
        {
          batch,
          accountId: record.accountId,
          csrf: session.csrfTag(record),
          maxTotalBytes: Math.min(
            batch.maxBytes * batch.slots.filter((slot) => slot.status === "pending").length,
            store.uploadRoom(record.accountId),
          ),
          ...(error === undefined ? {} : { error }),
        },
        render,
      ),
    );
  }

  function receiptPage(request: Request, ticket: UploadTicketState): Response {
    const file = ticket.file;
    if (file === undefined) return say(request, 200, (t) => t.receiving);
    return pageResponse(pageOf(request, origin), 200, (render) =>
      renderUploadReceipt(
        {
          name: file.name,
          kind: file.kind,
          size: file.size,
          reference: ticket.reference,
          expiresAt: ticket.expiresAt,
        },
        render,
      ),
    );
  }

  async function upload(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const admitted = await admit(request, ctx);
    if (admitted instanceof Response) return admitted;
    const { record, ticket, id, batch } = admitted;
    const slots = batch?.slots.filter((slot) => slot.status === "pending");
    // Preserve completed files on a later failure, and show exactly what still needs uploading.
    const failure = (status: number, pick: (texts: Texts["transfer"]) => PageMessage): Response => {
      const current = batch === undefined ? undefined : store.batchFor(id, record.accountId);
      return current === undefined
        ? say(request, status, pick)
        : batchPage(request, record, current, status, pick(pageOf(request, origin).t.transfer));
    };
    const badForm = (): Response => {
      const current = batch === undefined ? undefined : store.batchFor(id, record.accountId);
      return current === undefined
        ? say(request, 400, (t) => t.badForm)
        : batchPage(request, record, current, 400, pageOf(request, origin).t.upload.batch.badForm);
    };
    const refuse = (reason: RefusalReason, response: Response): Response =>
      refused(ctx, reason, response, record);

    let form: FormData;
    try {
      // undici marks `formData()` as not recommended for servers: it buffers the whole body. Here
      // the router already holds the whole body, capped by the remaining account allowance, with at most 2
      // uploads at once and only after the session and ticket checks; no extra dependency. It
      // also builds an object for every part before anything can be checked, and 20 MiB of empty
      // parts made several hundred MiB of them (security review 2026-11, finding 2): so the parts
      // are counted on the raw bytes first: only `csrf`, the batch's `slots` binding, and the
      // remaining number of files are allowed before parsing.
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > submissionLimit(ticket, batch)) {
        return refuse(
          "too_large",
          batch === undefined
            ? failure(413, (t) => t.tooLarge(megabytes(ticket.maxBytes)))
            : batchPage(
                request,
                record,
                batch,
                413,
                pageOf(request, origin).t.upload.batch.tooLarge(
                  megabytes(submissionLimit(ticket, batch) - MULTIPART_OVERHEAD_BYTES),
                ),
              ),
        );
      }
      const boundary = multipartBoundary(request.headers.get("content-type") ?? "");
      const maxDelimiters = slots === undefined ? 3 : slots.length + 3;
      if (boundary === undefined || !atMostDelimiters(body, boundary, maxDelimiters)) {
        throw new Error("not the upload form");
      }
      form = await new Response(body, {
        headers: { "content-type": multipartContentType(boundary) },
        // eslint-disable-next-line @typescript-eslint/no-deprecated
      }).formData();
    } catch {
      return refuse("bad_form", badForm());
    }
    const names = [...form.keys()];
    const files = form.getAll("file");
    if (
      form.getAll("csrf").length !== 1 ||
      (slots !== undefined && form.getAll("slots").length !== 1) ||
      files.length < 1 ||
      files.length > (slots?.length ?? 1) ||
      names.some(
        (name) => name !== "csrf" && name !== "file" && !(slots !== undefined && name === "slots"),
      )
    ) {
      return refuse("bad_form", badForm());
    }
    const csrf = form.get("csrf");
    if (typeof csrf !== "string" || !session.csrfValid(record, csrf)) {
      return refuse(
        "csrf",
        failure(403, (t) => t.csrf),
      );
    }
    // Bind this submission to the slots shown by its form. Replays must not move the same
    // files into the next free slots after a successful or partially successful submission.
    if (batch !== undefined && form.get("slots") !== slots?.map((slot) => slot.id).join(",")) {
      return refuse(
        "stale_form",
        batchPage(request, record, batch, 409, pageOf(request, origin).t.upload.batch.staleForm),
      );
    }
    for (const [index, file] of files.entries()) {
      if (!(file instanceof File)) {
        return refuse("bad_form", badForm());
      }
      if (file.size === 0)
        return refuse(
          "empty",
          failure(400, (t) => t.empty),
        );
      if (file.size > ticket.maxBytes) {
        return refuse(
          "too_large",
          failure(413, (t) => t.tooLarge(megabytes(ticket.maxBytes))),
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = sniffKind(bytes);
      if (kind === undefined || !ticket.kinds.includes(kind)) {
        return refuse(
          "wrong_kind",
          failure(415, (t) => t.wrongKind),
        );
      }
      let outcome;
      try {
        outcome = await store.receive(slots?.[index]?.id ?? id, record.accountId, {
          name: uploadName(file.name, kind),
          kind,
          bytes,
        });
      } catch {
        return refuse(
          "failed",
          failure(500, (t) => t.failed),
        );
      }
      switch (outcome.status) {
        case "received":
          ctx.log.info("upload_received", {
            account: record.accountId,
            reference: outcome.ticket.reference,
            kind,
            bytes: bytes.byteLength,
          });
          if (batch === undefined) return receiptPage(request, outcome.ticket);
          break;
        case "unknown":
          return refuse(
            "unknown",
            failure(404, (t) => t.uploadNotFound),
          );
        case "expired":
          return refuse(
            "expired",
            failure(410, (t) => t.uploadExpired),
          );
        case "already_received":
          return refuse(
            "already_received",
            failure(409, (t) => t.alreadyUploaded),
          );
        case "wrong_kind":
          return refuse(
            "wrong_kind",
            failure(415, (t) => t.wrongKind),
          );
        case "too_large":
          return refuse(
            "too_large",
            failure(413, (t) => t.tooLarge(megabytes(ticket.maxBytes))),
          );
        case "storage_full":
          return refuse(
            "storage_full",
            failure(507, (t) => t.storageFull),
          );
      }
    }
    // The progress page is a GET, so refreshing it never resubmits the uploaded files.
    return new Response(null, {
      status: 303,
      headers: { Location: `${UPLOADS_PREFIX}${id}`, "Cache-Control": "no-store, no-transform" },
    });
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
    if (id === undefined)
      return deny(
        "unknown",
        say(request, 404, (t) => t.fileNotFound),
      );
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
        return deny(
          "unknown",
          say(request, 404, (t) => t.fileNotFound),
        );
      case "expired":
        return deny(
          "expired",
          say(request, 410, (t) => t.fileExpired),
        );
      case "exhausted":
        return deny(
          "exhausted",
          say(request, 410, (t) => t.fileExhausted),
        );
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
      bodyPace: UPLOAD_BODY_PACE,
      bodySlots: {
        max: MAX_CONCURRENT_UPLOADS,
        perKey: MAX_CONCURRENT_UPLOADS_PER_ACCOUNT,
        busy: (scope, request) =>
          say(request, 503, (t) => (scope === "key" ? t.busyAccount : t.busy), {
            "Retry-After": "10",
          }),
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

/**
 * The boundary of an upload's content type, which must be exactly `multipart/form-data;
 * boundary=<b>` (`<b>` quoted or not): 1–70 of RFC 2046's boundary characters without space,
 * quote or backslash, as every browser sends. Anything else (more parameters, escapes, non-ASCII,
 * a `boundary=` inside another parameter) is `undefined` and refused: the part count and the
 * parser must agree on one boundary, and the parser is then given only this one (see
 * {@link multipartContentType}). Lenient parsing let escaped and nested boundaries count zero
 * parts while the parser found thousands (security review 2026-11, wave 2).
 */
export function multipartBoundary(contentType: string): string | undefined {
  const match =
    /^\s*multipart\/form-data\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,\-./:=?]{1,70})"|([0-9A-Za-z'()+_,\-./:=?]{1,70}))\s*$/i.exec(
      contentType,
    );
  return match?.[1] ?? match?.[2];
}

/** The content type the parser gets: built from the checked boundary, not the client's header. */
function multipartContentType(boundary: string): string {
  return `multipart/form-data; boundary="${boundary}"`;
}

/**
 * Whether `body` holds at most `max` delimiter lines `--<boundary>` (at the start or after CRLF,
 * the closing `--<boundary>--` included). Stops counting at the first one too many, so a body of
 * many tiny parts costs one scan and no allocation per part.
 */
export function atMostDelimiters(body: Uint8Array, boundary: string, max: number): boolean {
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  let count = 0;
  for (let at = bytes.indexOf(delimiter); at !== -1; at = bytes.indexOf(delimiter, at + 1)) {
    const atLineStart = at === 0 || (bytes[at - 2] === 0x0d && bytes[at - 1] === 0x0a);
    if (atLineStart && ++count > max) return false;
  }
  return true;
}
