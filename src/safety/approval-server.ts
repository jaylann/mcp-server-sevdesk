/**
 * Local approval page for `SEVDESK_CONFIRM=browser`, for MCP clients that cannot show
 * elicitation prompts. A `commit`/`external` call creates a pending approval; the service writes
 * its URL to the server log and (with `SEVDESK_CONFIRM_OPEN`) opens it in the user's browser, so
 * the URL never reaches the model, which only gets a short, non-secret reference code that the
 * page shows as well. The human reads the preview and approves or rejects; the model then calls
 * the tool again with the same arguments, and the write flow takes the decision (once).
 *
 * Security properties:
 * - one HTTP server per service (per server factory, i.e. per process), started lazily, bound to
 *   127.0.0.1 on an ephemeral port only, `unref`ed and closed with {@link ApprovalService.close};
 * - each approval binds tool, argument hash and preview hash, has a random 256-bit id (the URL is
 *   a capability), expires after 10 minutes and is decided and taken at most once;
 * - every request must carry `Host: 127.0.0.1:<port>` (DNS rebinding); the decision is a POST
 *   from the page itself ({@link sameOriginPost}), with a per-approval CSRF token from the page
 *   and a per-approval `SameSite=Strict` cookie set by the GET (both compared in constant time);
 * - the page is static HTML with every value escaped, under a strict CSP (no scripts, no
 *   framing, forms only to itself).
 *
 * Limit (documented in SECURITY.md): anything that can read the server log or drive the user's
 * browser, including an agent with such tools, can still open the page and press Approve.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { ConfirmationPreview } from "../tools/types.js";
import { renderApprovalPage, renderMessagePage } from "./approval-page.js";
import type { OpenUrl } from "./open-url.js";
import type { WriteTier } from "./tiers.js";

type ApprovalStatus = "pending" | "approved" | "rejected";

/** What an approval is bound to and shows. */
export interface ApprovalBinding {
  readonly toolName: string;
  readonly toolTitle: string;
  readonly tier: WriteTier;
  /** Plain words for the tier, shown on the page. */
  readonly tierText: string;
  readonly argsHash: string;
  readonly previewHash: string;
  /** Already sanitized with `displayPreview`. */
  readonly preview: ConfirmationPreview;
  /** The call that asked; carried into the audit lines of the decision and the execution. */
  readonly callId: string;
  /** Trusted note shown above the preview (e.g. "the record changed"). */
  readonly notice?: string;
}

/** A decision made on the approval page. */
export interface ApprovalDecision {
  readonly binding: ApprovalBinding;
  readonly reference: string;
  readonly decision: "approved" | "rejected";
}

/** Thrown by {@link ApprovalService.create} when {@link ApprovalServiceOptions.maxPending} is reached. */
export class ApprovalLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`${String(limit)} approval requests are already waiting for a decision.`);
    this.name = "ApprovalLimitError";
    this.limit = limit;
  }
}

/** A pending or decided approval, as the write flow sees it. */
export interface ApprovalTicket {
  /** Secret (part of the URL); never shown to the model. */
  readonly id: string;
  /** Secret capability URL; only logged to stderr and handed to the opener. */
  readonly url: string;
  /** Short, non-secret code shown in the tool result and on the page, so the user can match them. */
  readonly reference: string;
  /** Whether the page was opened in the user's browser when the approval was created. */
  readonly opened: boolean;
  /** ISO 8601 (UTC). */
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  readonly previewHash: string;
  readonly callId: string;
}

export interface ApprovalService {
  /** The unexpired approval for this tool and argument hash, if any. */
  current(toolName: string, argsHash: string): ApprovalTicket | undefined;
  /**
   * Creates a pending approval (replacing any other one for the same tool and arguments) and
   * starts the server on first use. Rejects when the server cannot listen.
   */
  create(binding: ApprovalBinding): Promise<ApprovalTicket>;
  /** Removes the approval and returns its final state; `undefined` when unknown or expired. */
  take(id: string): ApprovalTicket | undefined;
  /** Stops the server (if started) and forgets every approval. */
  close(): Promise<void>;
}

export interface ApprovalServiceOptions {
  /** Epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
  /** Lifetime of an approval (default 10 minutes). */
  readonly ttlMs?: number;
  /** Most approvals kept at once; the oldest is dropped beyond it (default 100). */
  readonly maxApprovals?: number;
  /**
   * Most approvals waiting for a decision at once (default 5). Creating another one is refused
   * with {@link ApprovalLimitError}, so a looping model cannot flood the user with browser tabs.
   */
  readonly maxPending?: number;
  /** Called when the human approves or rejects on the page (for the audit log). */
  readonly onDecision?: (decision: ApprovalDecision) => void;
  /** Opens each new approval page; without it, pages are only logged (`SEVDESK_CONFIRM_OPEN=0`). */
  readonly openUrl?: OpenUrl;
  /** Receives one trusted line per new approval: tool, reference and URL (default: stderr). */
  readonly log?: (line: string) => void;
}

const HOST = "127.0.0.1";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_APPROVALS = 100;
const DEFAULT_MAX_PENDING = 5;
const SECRET_BYTES = 32;
const MAX_BODY_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 10_000;
const COOKIE_NAME = "sevdesk_approval";
/** Reference codes: no 0/O, 1/I, so they can be read out and compared easily. */
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERENCE_LENGTH = 6;
/** `/approve/<id>` with a 256-bit base64url id (43 characters). */
const APPROVAL_PATH = /^\/approve\/([A-Za-z0-9_-]{43})$/;

interface ApprovalRecord {
  readonly id: string;
  readonly key: string;
  readonly binding: ApprovalBinding;
  readonly csrf: string;
  readonly cookie: string;
  readonly expiresAtMs: number;
  readonly reference: string;
  status: ApprovalStatus;
  opened: boolean;
}

export function createApprovalService(options: ApprovalServiceOptions = {}): ApprovalService {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxApprovals = options.maxApprovals ?? DEFAULT_MAX_APPROVALS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const log =
    options.log ??
    ((line: string) => {
      console.error(`mcp-server-sevdesk: ${line}`);
    });
  /** By id, in creation order. */
  const records = new Map<string, ApprovalRecord>();
  let listening: Promise<{ server: Server; port: number }> | undefined;
  let port: number | undefined;

  function prune(): void {
    const at = now();
    for (const [id, record] of records) {
      if (record.expiresAtMs <= at) records.delete(id);
    }
  }

  function ticket(record: ApprovalRecord): ApprovalTicket {
    return {
      id: record.id,
      url: `http://${HOST}:${String(port)}/approve/${record.id}`,
      reference: record.reference,
      opened: record.opened,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      status: record.status,
      previewHash: record.binding.previewHash,
      callId: record.binding.callId,
    };
  }

  function start(): Promise<{ server: Server; port: number }> {
    listening ??= new Promise<{ server: Server; port: number }>((resolve, reject) => {
      const server = createServer((request, response) => {
        handle(request, response);
      });
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.headersTimeout = REQUEST_TIMEOUT_MS;
      server.once("error", reject);
      server.listen(0, HOST, () => {
        server.off("error", reject);
        server.unref();
        port = (server.address() as AddressInfo).port;
        resolve({ server, port });
      });
    }).catch((error: unknown) => {
      listening = undefined;
      throw error;
    });
    return listening;
  }

  function handle(request: IncomingMessage, response: ServerResponse): void {
    const origin = `http://${HOST}:${String(port)}`;
    if (request.headers.host !== `${HOST}:${String(port)}`) {
      reply(response, 421, "Wrong address", "Open the approval link exactly as it was given.");
      return;
    }
    const match = APPROVAL_PATH.exec((request.url ?? "").split("?")[0] ?? "");
    if (match === null) {
      reply(response, 404, "Not found", "There is no page at this address.");
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      reply(response, 405, "Method not allowed", "Use the buttons on the approval page.", {
        Allow: "GET, POST",
      });
      return;
    }
    prune();
    const record = records.get(match[1] ?? "");
    if (record === undefined) {
      reply(
        response,
        404,
        "Approval not found",
        "This approval request is unknown, has expired or was already used. Ask your assistant " +
          "to try again if you still want the action.",
      );
      return;
    }
    if (request.method === "GET") {
      showApproval(response, record);
      return;
    }
    if (!sameOriginPost(request, origin)) {
      reply(response, 403, "Request refused", "The decision did not come from the approval page.");
      return;
    }
    void readForm(request).then(
      (form) => {
        decide(request, response, record, form);
      },
      () => {
        reply(response, 400, "Bad request", "The form could not be read.");
      },
    );
  }

  function showApproval(response: ServerResponse, record: ApprovalRecord): void {
    if (record.status !== "pending") {
      replyDecided(response, 200, record);
      return;
    }
    const { binding } = record;
    const nonce = randomBytes(16).toString("base64url");
    const html = renderApprovalPage(
      {
        toolName: binding.toolName,
        toolTitle: binding.toolTitle,
        tierText: binding.tierText,
        preview: binding.preview,
        notice: binding.notice,
        reference: record.reference,
        expiresAt: new Date(record.expiresAtMs).toISOString(),
        formAction: `/approve/${record.id}`,
        csrf: record.csrf,
      },
      nonce,
    );
    send(response, 200, html, nonce, {
      "Set-Cookie":
        `${COOKIE_NAME}=${record.cookie}; Path=/approve/${record.id}; HttpOnly; ` +
        `SameSite=Strict; Max-Age=${String(Math.ceil(ttlMs / 1000))}`,
    });
  }

  function decide(
    request: IncomingMessage,
    response: ServerResponse,
    record: ApprovalRecord,
    form: URLSearchParams,
  ): void {
    const csrfOk = safeEqual(form.get("csrf") ?? "", record.csrf);
    const cookieOk = safeEqual(
      readCookie(request.headers.cookie, COOKIE_NAME) ?? "",
      record.cookie,
    );
    if (!csrfOk || !cookieOk) {
      reply(
        response,
        403,
        "Request refused",
        "The decision could not be verified. Reload the approval page and try again.",
      );
      return;
    }
    // The record may have expired or been taken while the body was read.
    if (records.get(record.id) !== record || record.expiresAtMs <= now()) {
      reply(response, 410, "Approval expired", "This approval request is no longer valid.");
      return;
    }
    if (record.status !== "pending") {
      replyDecided(response, 409, record);
      return;
    }
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "reject") {
      reply(response, 400, "Bad request", "Choose Approve or Reject.");
      return;
    }
    record.status = decision === "approve" ? "approved" : "rejected";
    try {
      options.onDecision?.({
        binding: record.binding,
        reference: record.reference,
        decision: record.status,
      });
    } catch {
      // Reporting must never undo or hide the decision.
    }
    replyDecided(response, 200, record);
  }

  function replyDecided(response: ServerResponse, status: number, record: ApprovalRecord): void {
    if (record.status === "approved") {
      reply(
        response,
        status,
        "Approved",
        "You approved this action. Go back to your assistant: it runs the action when it calls " +
          "the tool again with the same arguments, before the request expires.",
      );
    } else {
      reply(
        response,
        status,
        "Rejected",
        "You rejected this action. Nothing was changed in sevDesk.",
      );
    }
  }

  return {
    current(toolName, argsHash) {
      prune();
      const key = recordKey(toolName, argsHash);
      for (const record of records.values()) {
        if (record.key === key) return ticket(record);
      }
      return undefined;
    },
    async create(binding) {
      await start();
      prune();
      const key = recordKey(binding.toolName, binding.argsHash);
      // The approval this one replaces (same tool and arguments) does not count.
      const waiting = [...records.values()].filter(
        (record) => record.status === "pending" && record.key !== key,
      ).length;
      if (waiting >= maxPending) {
        throw new ApprovalLimitError(maxPending);
      }
      for (const [id, record] of records) {
        if (record.key === key) records.delete(id);
      }
      const record: ApprovalRecord = {
        id: secret(),
        key,
        binding,
        csrf: secret(),
        cookie: secret(),
        expiresAtMs: now() + ttlMs,
        reference: referenceCode(),
        status: "pending",
        opened: false,
      };
      records.set(record.id, record);
      while (records.size > maxApprovals) {
        const oldest = records.keys().next().value;
        if (oldest === undefined) break;
        records.delete(oldest);
      }
      const created = ticket(record);
      log(
        `${binding.toolName}: approval ${record.reference} waiting at ${created.url} ` +
          `(until ${created.expiresAt})`,
      );
      const { openUrl } = options;
      if (openUrl !== undefined) {
        record.opened = await Promise.resolve()
          .then(() => openUrl(created.url))
          .catch(() => false);
      }
      return ticket(record);
    },
    take(id) {
      prune();
      const record = records.get(id);
      if (record === undefined) return undefined;
      records.delete(id);
      return ticket(record);
    },
    async close() {
      records.clear();
      const started = listening;
      listening = undefined;
      if (started === undefined) return;
      const { server } = await started.catch(() => ({ server: undefined }));
      if (server === undefined) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * Whether a POST comes from the approval page itself: `Origin` equals the server's origin, or,
 * for clients that send no `Origin` at all, `Sec-Fetch-Site: same-origin` (set by the browser,
 * not by page scripts). `Origin: null` (an opaque or privacy-stripped origin) is always refused.
 * The page's referrer policy (`same-origin`) makes browsers send the real origin.
 */
function sameOriginPost(request: IncomingMessage, origin: string): boolean {
  const received = request.headers.origin;
  if (received !== undefined) return received === origin;
  return request.headers["sec-fetch-site"] === "same-origin";
}

function recordKey(toolName: string, argsHash: string): string {
  return `${toolName}:${argsHash}`;
}

function referenceCode(): string {
  return [...randomBytes(REFERENCE_LENGTH)]
    .map((byte) => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length] ?? "A")
    .join("");
}

function secret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

function safeEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const type = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") {
      request.resume();
      reject(new Error("unsupported content type"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}

function reply(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const nonce = randomBytes(16).toString("base64url");
  send(response, status, renderMessagePage(title, message, nonce), nonce, headers);
}

function send(
  response: ServerResponse,
  status: number,
  html: string,
  styleNonce: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      `default-src 'none'; style-src 'nonce-${styleNonce}'; form-action 'self'; ` +
      "frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    // Not `no-referrer`: under it, browsers send `Origin: null` with the form POST (Fetch standard),
    // which the origin check must refuse. `same-origin` keeps the page's URL from other sites.
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...headers,
  });
  response.end(html);
}
