/**
 * The approval inbox of the HTTP mode (`SEVDESK_CONFIRM=browser` with `--http`): where a human
 * approves or rejects the binding actions (finalize, book, cancel, send) that a remote client asks
 * for, including clients without MCP elicitation such as claude.ai.
 *
 * The model learns only the inbox URL (`<origin>/approvals`) and a reference code; approving needs
 * a browser session of the approval's account:
 * - set at OAuth consent (`createSessionCookie` in `session.ts`, called by the consent step), or
 * - by signing in here with the account's sevDesk API token (`login`, wired by the caller: OAuth
 *   mode checks the token with the identity lookup and the account allowlist, bearer mode compares
 *   it in constant time with the configured token, never with the bearer secret).
 *
 * Routes (all under the `form` origin policy, bodies capped at 4 KiB, 120 requests a minute per
 * client IP or IPv6 /64 together):
 * - `GET /approvals`: the account's approvals, or the sign-in form without a session;
 * - `GET /approvals/<id>`: the preview with Approve / Reject; the sign-in form without a session;
 *   404 for an approval of another account, exactly as for an unknown id;
 * - `POST /approvals/login`: token → session cookie (5 per minute and 20 per hour per client IP or
 *   IPv6 /64);
 * - `POST /approvals/<id>`: the decision: session, CSRF tag (`keyedTag(csrf, sid)`), same-origin
 *   POST and the approval's account must all match; 409 when already decided, 410 when expired;
 * - `POST /approvals/logout`: ends the session.
 *
 * Without a session no page shows approval data. Sessions, sign-in and sign-out live in
 * `browser-session.ts` (shared with the upload and download pages); this module adds the inbox,
 * the detail pages and the decision. Handlers check the same-origin POST themselves too (the
 * router's `form` policy is the first line), so the routes are safe even when mounted without it.
 */
import type { RequestPrincipal } from "../accounts/types.js";
import { type InboxItem, renderApprovalPage, renderInboxPage } from "../safety/approval-page.js";
import type { ApprovalChannel, ApprovalStore, ApprovalView } from "../safety/approval-types.js";
import { sameOriginPost } from "../safety/web.js";
import {
  DETAIL_PREFIX,
  INBOX_PATH,
  LOGOUT_PATH,
  messageResponse,
  pageResponse,
  TEXT,
} from "./approval-pages.js";
import {
  type BrowserSession,
  createBrowserSession,
  INBOX_RATE,
  type InboxLogin,
  SMALL_FORM_BYTES,
} from "./browser-session.js";
import type { ServerKeys } from "./keys.js";
import type { HttpRequestContext, HttpRoute, SessionRecord, SessionStore } from "./types.js";

export {
  INBOX_RATE,
  type InboxLogin,
  LOGIN_RATE_HOUR,
  LOGIN_RATE_MINUTE,
} from "./browser-session.js";

/** What the inbox needs of the approval store. */
export type ApprovalInbox = Pick<ApprovalStore, "list" | "get" | "decide">;

export interface ApprovalRoutesOptions {
  /**
   * The approvals to serve: the store, or a function returning it. The store is usually created
   * after this module's channel (the safety runtime creates it with the channel), so the HTTP
   * wiring passes `() => runtime.approvals`; until it returns a store, the pages answer 503.
   */
  readonly approvals: ApprovalInbox | (() => ApprovalInbox | undefined);
  readonly sessions: SessionStore;
  readonly keys: ServerKeys;
  /** The public origin, e.g. `https://mcp.example.com` (no trailing slash). */
  readonly origin: string;
  readonly login: InboxLogin;
  /**
   * Whether an account may (still) use the server, e.g. the OAuth account allowlist. Checked at
   * every sign-in and on every session read; a session of an account no longer allowed is revoked
   * and treated as signed out. Default: every account.
   */
  readonly accountAllowed?: ((accountId: string) => boolean) | undefined;
  /** Epoch milliseconds (default `Date.now`). */
  readonly now?: () => number;
  /** Lifetime of a session created by signing in (default 12 hours). */
  readonly sessionTtlSeconds?: number;
}

export interface ApprovalRoutes {
  /** The inbox, sign-in, sign-out and detail routes. */
  readonly routes: readonly HttpRoute[];
  /** The `remote` channel to hand to the safety runtime. */
  readonly channel: ApprovalChannel;
  /** The browser sessions behind the routes (home: the inbox), for other pages to share. */
  readonly session: BrowserSession;
}

/** Approval ids: base64url, 128 to 768 bit (the store uses 256). */
const APPROVAL_ID = /^[A-Za-z0-9_-]{22,128}$/;

/** Creates the inbox routes and the `remote` approval channel. */
export function createApprovalRoutes(options: ApprovalRoutesOptions): ApprovalRoutes {
  const { origin } = options;
  const inboxUrl = `${origin}${INBOX_PATH}`;
  const session = createBrowserSession({
    sessions: options.sessions,
    keys: options.keys,
    origin,
    login: options.login,
    accountAllowed: options.accountAllowed,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sessionTtlSeconds === undefined
      ? {}
      : { sessionTtlSeconds: options.sessionTtlSeconds }),
    homePath: INBOX_PATH,
  });

  function store(): ApprovalInbox | undefined {
    const source = options.approvals;
    return typeof source === "function" ? source() : source;
  }

  /** The approval when it exists, is unexpired and belongs to the session's account. */
  function ownedView(
    approvals: ApprovalInbox,
    id: string,
    record: SessionRecord,
  ): ApprovalView | undefined {
    const view = approvals.get(id);
    if (view === undefined || !ownedBy(view.owner, record)) return undefined;
    return view;
  }

  function decidedPage(status: number, decided: "approved" | "rejected"): Response {
    return messageResponse(status, decided === "approved" ? TEXT.approved : TEXT.rejected);
  }

  async function showInbox(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const record = await session.sessionOf(request, ctx);
    if (record === undefined) return session.loginPage(200);
    const approvals = store();
    if (approvals === undefined) return messageResponse(503, TEXT.notReady, { link: false });
    const items: InboxItem[] = approvals
      .list(record.accountId)
      .filter((view) => ownedBy(view.owner, record))
      .map((view) => ({
        href: `${DETAIL_PREFIX}${view.id}`,
        reference: view.reference,
        toolName: view.binding.toolName,
        toolTitle: view.binding.toolTitle,
        action: view.binding.preview.action,
        status: view.status,
        expiresAt: view.expiresAt,
      }));
    return pageResponse(200, (nonce) =>
      renderInboxPage(
        {
          accountId: record.accountId,
          items,
          inboxHref: INBOX_PATH,
          logoutAction: LOGOUT_PATH,
          csrf: session.csrfTag(record),
        },
        nonce,
      ),
    );
  }

  async function showApproval(
    request: Request,
    ctx: HttpRequestContext,
    id: string,
  ): Promise<Response> {
    const record = await session.sessionOf(request, ctx);
    if (record === undefined) return session.loginPage(200);
    const approvals = store();
    if (approvals === undefined) return messageResponse(503, TEXT.notReady, { link: false });
    const view = APPROVAL_ID.test(id) ? ownedView(approvals, id, record) : undefined;
    if (view === undefined) return messageResponse(404, TEXT.notFound);
    if (view.status !== "pending") return decidedPage(200, view.status);
    const { binding } = view;
    return pageResponse(200, (nonce) =>
      renderApprovalPage(
        {
          toolName: binding.toolName,
          toolTitle: binding.toolTitle,
          tierText: binding.tierText,
          preview: binding.preview,
          notice: binding.notice,
          reference: view.reference,
          expiresAt: view.expiresAt,
          formAction: `${DETAIL_PREFIX}${view.id}`,
          csrf: session.csrfTag(record),
          inboxHref: INBOX_PATH,
        },
        nonce,
      ),
    );
  }

  async function decide(request: Request, ctx: HttpRequestContext, id: string): Promise<Response> {
    if (!sameOriginPost(request, origin)) return messageResponse(403, TEXT.foreignPost);
    const record = await session.sessionOf(request, ctx);
    if (record === undefined) return messageResponse(403, TEXT.signedOutPost);
    const form = await session.formOf(request);
    if (form instanceof Response) return form;
    if (!session.csrfValid(record, form.get("csrf"))) return messageResponse(403, TEXT.csrf);
    const choice = form.get("decision");
    if (choice !== "approve" && choice !== "reject") {
      return messageResponse(400, TEXT.noDecision);
    }
    const approvals = store();
    if (approvals === undefined) return messageResponse(503, TEXT.notReady, { link: false });
    const view = APPROVAL_ID.test(id) ? ownedView(approvals, id, record) : undefined;
    if (view === undefined) return messageResponse(404, TEXT.notFound);
    const decision = choice === "approve" ? "approved" : "rejected";
    const outcome = approvals.decide(view.id, decision);
    switch (outcome) {
      case "decided":
        ctx.log.info("approval_decided", { decision, reference: view.reference });
        return decidedPage(200, decision);
      case "already_decided": {
        const status = approvals.get(view.id)?.status;
        return status === "approved" || status === "rejected"
          ? decidedPage(409, status)
          : messageResponse(409, TEXT.notFound);
      }
      case "expired":
      case "unknown":
        return messageResponse(410, TEXT.expired);
    }
  }

  /** `/approvals/<id>`; also answers `login`/`logout` should a router prefer the prefix route. */
  async function detail(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const rest = new URL(request.url).pathname.slice(DETAIL_PREFIX.length);
    if (rest === "login" || rest === "logout") {
      if (request.method !== "POST") {
        return messageResponse(405, TEXT.method, { headers: { Allow: "POST" } });
      }
      return rest === "login" ? session.signIn(request, ctx) : session.signOut(request, ctx);
    }
    if (request.method === "POST") return decide(request, ctx, rest);
    return showApproval(request, ctx, rest);
  }

  const routes: HttpRoute[] = [
    {
      path: INBOX_PATH,
      methods: ["GET"],
      maxBodyBytes: SMALL_FORM_BYTES,
      origin: "form",
      rateLimit: INBOX_RATE,
      handle: (request, ctx) => showInbox(request, ctx),
    },
    ...session.routes,
    {
      path: DETAIL_PREFIX,
      match: "prefix",
      methods: ["GET", "POST"],
      maxBodyBytes: SMALL_FORM_BYTES,
      origin: "form",
      rateLimit: INBOX_RATE,
      handle: (request, ctx) => detail(request, ctx),
    },
  ];

  const channel: ApprovalChannel = {
    kind: "remote",
    inboxUrl,
    attach() {
      // Nothing to keep: the routes read the store given as `approvals` (they also list).
    },
    present() {
      // The inbox lists every pending approval; nothing is opened in a browser from the server.
      return Promise.resolve({ opened: false });
    },
    close() {
      return Promise.resolve();
    },
  };

  return { routes, channel, session };
}

function ownedBy(owner: RequestPrincipal, session: SessionRecord): boolean {
  return owner.accountScope === session.accountId;
}
