/**
 * The `local` {@link ApprovalChannel}: an approval page on 127.0.0.1 for `SEVDESK_CONFIRM=browser`
 * over stdio, for MCP clients that cannot show elicitation prompts. Each new approval gets a
 * launch link that the channel writes to the server log and (with `SEVDESK_CONFIRM_OPEN`) opens in
 * the user's browser, so the link never reaches the model, which only gets the short, non-secret
 * reference code that the page shows as well. The human reads the preview and approves or
 * rejects; the model then calls the tool again with the same arguments, and the write flow takes
 * the decision from the store (once).
 *
 * Security properties:
 * - one HTTP server per channel (per safety runtime, i.e. per process), started lazily, bound to
 *   127.0.0.1 on an ephemeral port only, `unref`ed and closed with the store;
 * - every request must carry `Host: 127.0.0.1:<port>` (DNS rebinding);
 * - the launch link is `/open/<ticket>` with a random 256-bit ticket that works once: its first
 *   GET sets the approval's cookie (`HttpOnly`, `SameSite=Strict`, scoped to the page's path) and
 *   redirects to the page, `/approve/<id>`. The page and the decision need that cookie; the
 *   page's address alone shows nothing and hands out no cookie. The link is what the OS opener
 *   gets as an argument, where other local users can read it (`ps`): whoever presents the ticket
 *   second gets nothing, and the second presentation cancels the request (see {@link Launch});
 * - the decision is a POST from the page itself (same origin), with a CSRF token from the page
 *   and the cookie, both bound to the approval (HMAC with a per-channel random key) and compared
 *   in constant time;
 * - the page is static HTML with every value escaped, under a strict CSP (no scripts, no
 *   framing, forms only to itself) with the headers of `htmlResponse`.
 *
 * Limits (documented in SECURITY.md): anything that can read the server log or drive the user's
 * browser, including an agent with such tools, can still open the page and press Approve. And
 * another local user who reads the link from the process list and opens it before the user's own
 * browser does holds the page until that browser arrives: a decision made in that time stands,
 * because the store cannot take back a decision (the user's browser then says so).
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { assetHeaders, ASSETS_PREFIX, pageAsset } from "../pages/assets.js";
import { type PageContext, pageContext } from "../pages/context.js";
import { renderMessagePage, toneForStatus } from "../pages/message.js";
import type { PageMessage } from "../pages/text/index.js";
import { previewFor, renderApprovalPage, renderDecisionPage } from "./approval-page.js";
import type {
  ApprovalChannel,
  ApprovalStatus,
  ApprovalStore,
  ApprovalView,
} from "./approval-types.js";
import type { OpenUrl } from "./open-url.js";
import { htmlResponse, randomId, readCookie, safeEqual, styleNonce } from "./web.js";

export interface LocalApprovalChannelOptions {
  /** Opens each new approval page; without it, pages are only logged (`SEVDESK_CONFIRM_OPEN=0`). */
  readonly openUrl?: OpenUrl;
  /** Receives one trusted line per new approval: tool, reference and URL (default: stderr). */
  readonly log?: (line: string) => void;
  /** Epoch milliseconds, for the time a page says is left (default `Date.now`). */
  readonly now?: () => number;
}

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 10_000;
const COOKIE_NAME = "sevdesk_approval";
const LAUNCH_COOKIE_NAME = "sevdesk_approval_link";
/** `/approve/<id>` with a 256-bit base64url id (43 characters). */
const APPROVAL_PATH = /^\/approve\/([A-Za-z0-9_-]{43})$/;
/** `/open/<ticket>`: the launch link, with a 256-bit base64url ticket. */
const LAUNCH_PATH = /^\/open\/([A-Za-z0-9_-]{43})$/;

type DecisionStore = Pick<ApprovalStore, "get" | "decide" | "withdraw">;

/**
 * The launch link of one approval (review 2026-11, round 3). The page's address used to be the
 * capability and went to the OS opener as an argument, which other local users can read; anyone
 * who presented it got the cookie and the form token and could approve.
 *
 * Now the opener (and the log) get a ticket that is good for one GET. A second GET of the same
 * ticket means two parties hold the link, and the server cannot tell which one is the user's
 * browser, so it fails closed: the request is withdrawn, also when the first presenter approved
 * it already (`ApprovalStore.withdraw`), every later page request for it says that the link was
 * used twice, and the model has to ask again. Only an approval the tool has taken and run before
 * the second GET cannot be undone (`cancelled` is false then).
 */
interface Launch {
  readonly approvalId: string;
  /** The first GET was answered (cookie and redirect). */
  used: boolean;
  /** Set by a second GET: whether the request could still be withdrawn. */
  voided?: { readonly cancelled: boolean };
}

export function createLocalApprovalChannel(
  options: LocalApprovalChannelOptions = {},
): ApprovalChannel {
  const log =
    options.log ??
    ((line: string) => {
      console.error(`mcp-server-sevdesk: ${line}`);
    });
  const now = options.now ?? Date.now;
  const key = randomBytes(32);
  let store: DecisionStore | undefined;
  let listening: Promise<{ server: Server; port: number }> | undefined;
  let port: number | undefined;
  /** Launch links by ticket, and the same records by approval id for the page's own routes. */
  const launches = new Map<string, Launch>();
  const launchOf = new Map<string, Launch>();

  /**
   * The tag for `purpose` and an approval id (or, for `launch`, a ticket): an HMAC under the
   * key of this process, 43 base64url characters. It is what the cookies and the form carry; it
   * is derived on every request and never stored.
   */
  function tagFor(purpose: "csrf" | "cookie" | "launch", id: string): string {
    return createHmac("sha256", key).update(`${purpose}\0${id}`, "utf8").digest("base64url");
  }

  /** Whether the request carries the cookie the launch link set for this approval's page. */
  function hasPageCookie(request: IncomingMessage, approvalId: string): boolean {
    return safeEqual(
      readCookie(request.headers.cookie, COOKIE_NAME) ?? "",
      tagFor("cookie", approvalId),
    );
  }

  /** `Set-Cookie` values of a first (or repeated, same browser) GET of a launch link. */
  function launchCookies(ticket: string, approval: ApprovalView): string[] {
    const lifetimeSeconds = Math.ceil(
      (Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)) / 1000,
    );
    const attributes = `HttpOnly; SameSite=Strict; Max-Age=${String(lifetimeSeconds)}`;
    return [
      `${COOKIE_NAME}=${tagFor("cookie", approval.id)}; Path=/approve/${approval.id}; ${attributes}`,
      // Marks the browser that used the ticket, so opening the link again there is no "second
      // party" (the opener firing twice, the same link clicked in the log).
      `${LAUNCH_COOKIE_NAME}=${tagFor("launch", ticket)}; Path=/open/${ticket}; ${attributes}`,
    ];
  }

  /** Forgets the launch links of approvals the store no longer holds. */
  function pruneLaunches(): void {
    for (const [ticket, launch] of launches) {
      if (store?.get(launch.approvalId) !== undefined) continue;
      launches.delete(ticket);
      launchOf.delete(launch.approvalId);
    }
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
    const page = pageContext(request.headers["accept-language"], origin);
    const t = page.t.local;
    if (request.headers.host !== `${HOST}:${String(port)}`) {
      reply(response, page, 421, t.wrongAddress);
      return;
    }
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (path.startsWith(ASSETS_PREFIX)) {
      serveAsset(request, response, page, path);
      return;
    }
    const ticket = LAUNCH_PATH.exec(path)?.[1];
    if (ticket !== undefined) {
      openLaunch(request, response, page, ticket);
      return;
    }
    const match = APPROVAL_PATH.exec(path);
    if (match === null) {
      reply(response, page, 404, t.noPage);
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      reply(response, page, 405, t.method, { Allow: "GET, POST" });
      return;
    }
    const attached = store;
    const approval = attached?.get(match[1] ?? "");
    if (attached === undefined || approval === undefined) {
      reply(response, page, 404, t.notFound);
      return;
    }
    const voided = launchOf.get(approval.id)?.voided;
    if (voided !== undefined) {
      replyVoided(response, page, voided);
      return;
    }
    // The address is not enough: only the browser that used the launch link has the cookie. No
    // cookie is handed out here, and nothing about the request is shown.
    if (!hasPageCookie(request, approval.id)) {
      reply(response, page, 403, t.needLink);
      return;
    }
    if (request.method === "GET") {
      showApproval(response, page, approval);
      return;
    }
    if (!sameOriginPost(request, origin)) {
      reply(response, page, 403, t.foreignPost);
      return;
    }
    void readForm(request).then(
      (form) => {
        decide(request, response, page, attached, approval, form);
      },
      () => {
        reply(response, page, 400, t.badForm);
      },
    );
  }

  /**
   * `GET /open/<ticket>`: the launch link. Its first use sets the cookies and redirects to the
   * approval page; a second use by another party cancels the request (see {@link Launch}).
   */
  function openLaunch(
    request: IncomingMessage,
    response: ServerResponse,
    page: PageContext,
    ticket: string,
  ): void {
    const t = page.t.local;
    const launch = launches.get(ticket);
    const attached = store;
    const approval = launch === undefined ? undefined : attached?.get(launch.approvalId);
    if (launch === undefined || attached === undefined) {
      reply(response, page, 404, t.notFound);
      return;
    }
    if (approval === undefined) {
      // Expired, or the tool took the decision and ran. When someone else used the link before
      // this request, say that: a decision made there can no longer be withdrawn.
      const firstUser = safeEqual(
        readCookie(request.headers.cookie, LAUNCH_COOKIE_NAME) ?? "",
        tagFor("launch", ticket),
      );
      if (launch.used && !firstUser) replyVoided(response, page, { cancelled: false });
      else reply(response, page, 404, t.notFound);
      return;
    }
    if (request.method !== "GET") {
      reply(response, page, 405, t.method, { Allow: "GET" });
      return;
    }
    if (isSpeculativeLoad(request)) {
      // A browser preparing a page it may never show (address-bar prerender, prefetch) must not
      // use up the ticket: the real navigation follows.
      response.writeHead(503, { "Cache-Control": "no-store", "Retry-After": "1" });
      response.end();
      return;
    }
    const sameBrowser = safeEqual(
      readCookie(request.headers.cookie, LAUNCH_COOKIE_NAME) ?? "",
      tagFor("launch", ticket),
    );
    if (launch.used && !sameBrowser) {
      launch.voided ??= {
        cancelled: attached.withdraw(approval.id),
      };
    }
    if (launch.voided !== undefined) {
      replyVoided(response, page, launch.voided);
      return;
    }
    launch.used = true;
    response.writeHead(303, {
      Location: `/approve/${approval.id}`,
      "Set-Cookie": launchCookies(ticket, approval),
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "Content-Length": "0",
    });
    response.end();
  }

  function showApproval(response: ServerResponse, page: PageContext, approval: ApprovalView): void {
    if (approval.status !== "pending") {
      replyDecided(response, page, 200, approval, approval.status);
      return;
    }
    const { binding } = approval;
    const nonce = styleNonce();
    const html = renderApprovalPage(
      {
        toolName: binding.toolName,
        toolTitle: binding.toolTitle,
        tier: binding.tier,
        preview: previewFor(binding, page.locale),
        recordChanged: binding.recordChanged === true,
        reference: approval.reference,
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
        now: now(),
        formAction: `/approve/${approval.id}`,
        csrf: tagFor("csrf", approval.id),
      },
      { ...page, nonce },
    );
    send(response, page, 200, html, nonce);
  }

  function decide(
    request: IncomingMessage,
    response: ServerResponse,
    page: PageContext,
    attached: DecisionStore,
    approval: ApprovalView,
    form: URLSearchParams,
  ): void {
    const csrfOk = safeEqual(form.get("csrf") ?? "", tagFor("csrf", approval.id));
    if (!csrfOk || !hasPageCookie(request, approval.id)) {
      reply(response, page, 403, page.t.local.csrf);
      return;
    }
    // The approval may have expired or been taken while the body was read.
    const current = attached.get(approval.id);
    if (current === undefined) {
      replyExpired(response, page);
      return;
    }
    // Or its link was opened by a second party meanwhile.
    const voided = launchOf.get(approval.id)?.voided;
    if (voided !== undefined) {
      replyVoided(response, page, voided);
      return;
    }
    if (current.status !== "pending") {
      replyDecided(response, page, 409, current, current.status);
      return;
    }
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "reject") {
      reply(response, page, 400, page.t.local.noDecision);
      return;
    }
    const status = decision === "approve" ? "approved" : "rejected";
    switch (attached.decide(approval.id, status)) {
      case "decided":
        replyDecided(response, page, 200, approval, status);
        return;
      case "already_decided": {
        // Not reachable today (nothing awaits between the check above and here); kept honest.
        const decided = attached.get(approval.id)?.status;
        replyDecided(
          response,
          page,
          409,
          approval,
          decided === "pending" || decided === undefined ? status : decided,
        );
        return;
      }
      default:
        replyExpired(response, page);
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
      pruneLaunches();
      // The link names a ticket, not the approval: what the opener gets as an argument (and the
      // log holds) is good for one GET.
      const ticket = randomId();
      const launch: Launch = { approvalId: view.id, used: false };
      launches.set(ticket, launch);
      launchOf.set(view.id, launch);
      const url = `http://${HOST}:${String(started.port)}/open/${ticket}`;
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
      launches.clear();
      launchOf.clear();
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

/** `GET /assets/<name>`: a font or the icon of the page; 404 for other names. */
function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  page: PageContext,
  path: string,
): void {
  if (request.method !== "GET") {
    reply(response, page, 405, page.t.local.method, { Allow: "GET" });
    return;
  }
  const asset = pageAsset(path);
  if (asset === undefined) {
    reply(response, page, 404, page.t.local.noPage);
    return;
  }
  response.writeHead(200, assetHeaders(asset));
  response.end(asset.bytes);
}

function replyExpired(response: ServerResponse, page: PageContext): void {
  reply(response, page, 410, page.t.local.expired);
}

/** The page for a launch link that a second party opened: cancelled, or decided before that. */
function replyVoided(
  response: ServerResponse,
  page: PageContext,
  voided: NonNullable<Launch["voided"]>,
): void {
  const t = page.t.local;
  reply(response, page, 410, voided.cancelled ? t.linkUsed : t.linkUsedDecided);
}

/**
 * Whether a browser asks for the page ahead of time (`Sec-Purpose: prefetch;prerender`, the older
 * `Purpose` and `X-Moz` headers), without a human having navigated there yet.
 */
function isSpeculativeLoad(request: IncomingMessage): boolean {
  // A header may arrive once (a string) or repeated (a list).
  const purpose = ["sec-purpose", "purpose", "x-purpose", "x-moz"]
    .flatMap((name) => request.headers[name] ?? [])
    .join(" ");
  return /prefetch|prerender|preview/i.test(purpose);
}

/** The page after a decision: what was decided, with its reference code. */
function replyDecided(
  response: ServerResponse,
  page: PageContext,
  status: number,
  approval: ApprovalView,
  decision: Exclude<ApprovalStatus, "pending">,
): void {
  const nonce = styleNonce();
  const html = renderDecisionPage(
    {
      decision,
      reference: approval.reference,
      action: previewFor(approval.binding, page.locale).action,
    },
    { ...page, nonce },
  );
  send(response, page, status, html, nonce);
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

/** A message page in the request's language. */
function reply(
  response: ServerResponse,
  page: PageContext,
  status: number,
  text: PageMessage,
  headers: Readonly<Record<string, string>> = {},
): void {
  const nonce = styleNonce();
  const html = renderMessagePage(text, { ...page, nonce }, { tone: toneForStatus(status) });
  send(response, page, status, html, nonce, headers);
}

/** Writes `html` with the page security headers of `htmlResponse` (plus `headers`). */
function send(
  response: ServerResponse,
  page: PageContext,
  status: number,
  html: string,
  nonce: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent) return;
  const built = htmlResponse(html, { status, nonce, page, headers });
  response.writeHead(status, Object.fromEntries(built.headers));
  response.end(html);
}
