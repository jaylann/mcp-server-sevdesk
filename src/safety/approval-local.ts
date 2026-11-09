/**
 * The `local` {@link ApprovalChannel}: an approval page on 127.0.0.1 for `SEVDESK_CONFIRM=browser`
 * over stdio, for MCP clients that cannot show elicitation prompts. Each new approval gets a page
 * whose URL the channel writes to the server log and (with `SEVDESK_CONFIRM_OPEN`) opens in the
 * user's browser, so the URL never reaches the model, which only gets the short, non-secret
 * reference code that the page shows as well. The human reads the preview and approves or
 * rejects; the model then calls the tool again with the same arguments, and the write flow takes
 * the decision from the store (once).
 *
 * Security properties:
 * - one HTTP server per channel (per safety runtime, i.e. per process), started lazily, bound to
 *   127.0.0.1 on an ephemeral port only, `unref`ed and closed with the store;
 * - the page URL carries the approval's random 256-bit id (a capability); every request must carry
 *   `Host: 127.0.0.1:<port>` (DNS rebinding); the decision is a POST from the page itself (same
 *   origin), with a CSRF token from the page and a `SameSite=Strict` cookie set by the GET, both
 *   bound to the approval (HMAC with a per-channel random key) and compared in constant time;
 * - the page is static HTML with every value escaped, under a strict CSP (no scripts, no
 *   framing, forms only to itself) with the headers of `htmlResponse`.
 *
 * Limit (documented in SECURITY.md): anything that can read the server log or drive the user's
 * browser, including an agent with such tools, can still open the page and press Approve.
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { renderApprovalPage, renderMessagePage } from "./approval-page.js";
import type {
  ApprovalChannel,
  ApprovalStatus,
  ApprovalStore,
  ApprovalView,
} from "./approval-types.js";
import type { OpenUrl } from "./open-url.js";
import { htmlResponse, readCookie, safeEqual, styleNonce } from "./web.js";

export interface LocalApprovalChannelOptions {
  /** Opens each new approval page; without it, pages are only logged (`SEVDESK_CONFIRM_OPEN=0`). */
  readonly openUrl?: OpenUrl;
  /** Receives one trusted line per new approval: tool, reference and URL (default: stderr). */
  readonly log?: (line: string) => void;
}

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 10_000;
const COOKIE_NAME = "sevdesk_approval";
/** `/approve/<id>` with a 256-bit base64url id (43 characters). */
const APPROVAL_PATH = /^\/approve\/([A-Za-z0-9_-]{43})$/;

type DecisionStore = Pick<ApprovalStore, "get" | "decide">;

export function createLocalApprovalChannel(
  options: LocalApprovalChannelOptions = {},
): ApprovalChannel {
  const log =
    options.log ??
    ((line: string) => {
      console.error(`mcp-server-sevdesk: ${line}`);
    });
  const key = randomBytes(32);
  let store: DecisionStore | undefined;
  let listening: Promise<{ server: Server; port: number }> | undefined;
  let port: number | undefined;

  /** The per-approval secret for `purpose`: 43 base64url characters, like a random id. */
  function secretFor(purpose: "csrf" | "cookie", id: string): string {
    return createHmac("sha256", key).update(`${purpose}\0${id}`, "utf8").digest("base64url");
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
    const attached = store;
    const approval = attached?.get(match[1] ?? "");
    if (attached === undefined || approval === undefined) {
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
      showApproval(response, approval);
      return;
    }
    if (!sameOriginPost(request, origin)) {
      reply(response, 403, "Request refused", "The decision did not come from the approval page.");
      return;
    }
    void readForm(request).then(
      (form) => {
        decide(request, response, attached, approval, form);
      },
      () => {
        reply(response, 400, "Bad request", "The form could not be read.");
      },
    );
  }

  function showApproval(response: ServerResponse, approval: ApprovalView): void {
    if (approval.status !== "pending") {
      replyDecided(response, 200, approval.status);
      return;
    }
    const { binding } = approval;
    const nonce = styleNonce();
    const html = renderApprovalPage(
      {
        toolName: binding.toolName,
        toolTitle: binding.toolTitle,
        tierText: binding.tierText,
        preview: binding.preview,
        notice: binding.notice,
        reference: approval.reference,
        expiresAt: approval.expiresAt,
        formAction: `/approve/${approval.id}`,
        csrf: secretFor("csrf", approval.id),
      },
      nonce,
    );
    const lifetimeSeconds = Math.ceil(
      (Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)) / 1000,
    );
    send(response, 200, html, nonce, {
      "Set-Cookie":
        `${COOKIE_NAME}=${secretFor("cookie", approval.id)}; Path=/approve/${approval.id}; ` +
        `HttpOnly; SameSite=Strict; Max-Age=${String(lifetimeSeconds)}`,
    });
  }

  function decide(
    request: IncomingMessage,
    response: ServerResponse,
    attached: DecisionStore,
    approval: ApprovalView,
    form: URLSearchParams,
  ): void {
    const csrfOk = safeEqual(form.get("csrf") ?? "", secretFor("csrf", approval.id));
    const cookieOk = safeEqual(
      readCookie(request.headers.cookie, COOKIE_NAME) ?? "",
      secretFor("cookie", approval.id),
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
    // The approval may have expired or been taken while the body was read.
    const current = attached.get(approval.id);
    if (current === undefined) {
      replyExpired(response);
      return;
    }
    if (current.status !== "pending") {
      replyDecided(response, 409, current.status);
      return;
    }
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "reject") {
      reply(response, 400, "Bad request", "Choose Approve or Reject.");
      return;
    }
    const status = decision === "approve" ? "approved" : "rejected";
    switch (attached.decide(approval.id, status)) {
      case "decided":
        replyDecided(response, 200, status);
        return;
      case "already_decided": {
        // Not reachable today (nothing awaits between the check above and here); kept honest.
        const decided = attached.get(approval.id)?.status;
        replyDecided(
          response,
          409,
          decided === "pending" || decided === undefined ? status : decided,
        );
        return;
      }
      default:
        replyExpired(response);
    }
  }

  return {
    kind: "local",
    inboxUrl: undefined,
    attach(attached) {
      store = attached;
    },
    async present(view) {
      const started = await start();
      const url = `http://${HOST}:${String(started.port)}/approve/${view.id}`;
      log(
        `${view.binding.toolName}: approval ${view.reference} waiting at ${url} ` +
          `(until ${view.expiresAt})`,
      );
      const { openUrl } = options;
      if (openUrl === undefined) return { opened: false };
      const opened = await Promise.resolve()
        .then(() => openUrl(url))
        .catch(() => false);
      return { opened };
    },
    async close() {
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

function replyExpired(response: ServerResponse): void {
  reply(response, 410, "Approval expired", "This approval request is no longer valid.");
}

function replyDecided(
  response: ServerResponse,
  status: number,
  decided: Exclude<ApprovalStatus, "pending">,
): void {
  if (decided === "approved") {
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

/**
 * Whether a POST comes from the approval page itself: `Origin` equals the server's origin, or,
 * for clients that send no `Origin` at all, `Sec-Fetch-Site: same-origin` (set by the browser,
 * not by page scripts). `Origin: null` (an opaque or privacy-stripped origin) is always refused.
 * The page's referrer policy (`same-origin`) makes browsers send the real origin. The `node:http`
 * twin of `sameOriginPost` in `web.ts`.
 */
function sameOriginPost(request: IncomingMessage, origin: string): boolean {
  const received = request.headers.origin;
  if (received !== undefined) return received === origin;
  return request.headers["sec-fetch-site"] === "same-origin";
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
  const nonce = styleNonce();
  send(response, status, renderMessagePage(title, message, nonce), nonce, headers);
}

/** Writes `html` with the page security headers of `htmlResponse` (plus `headers`). */
function send(
  response: ServerResponse,
  status: number,
  html: string,
  nonce: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent) return;
  const page = htmlResponse(html, { status, nonce, headers });
  response.writeHead(status, Object.fromEntries(page.headers));
  response.end(html);
}
