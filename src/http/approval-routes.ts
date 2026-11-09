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
 * Routes (all under the `form` origin policy, bodies capped at 4 KiB):
 * - `GET /approvals`: the account's approvals, or the sign-in form without a session;
 * - `GET /approvals/<id>`: the preview with Approve / Reject; the sign-in form without a session;
 *   404 for an approval of another account, exactly as for an unknown id;
 * - `POST /approvals/login`: token → session cookie (5 per minute and 20 per hour per client IP);
 * - `POST /approvals/<id>`: the decision: session, CSRF tag (`keyedTag(csrf, sid)`), same-origin
 *   POST and the approval's account must all match; 409 when already decided, 410 when expired;
 * - `POST /approvals/logout`: ends the session.
 *
 * Without a session no page shows approval data. The sevDesk token is never echoed, logged or
 * stored. Handlers check the same-origin POST themselves too (the router's `form` policy is the
 * first line), so the routes are safe even when mounted without it.
 */
import type { RequestPrincipal } from "../accounts/types.js";
import {
  type InboxItem,
  renderApprovalPage,
  renderInboxPage,
  renderLoginPage,
} from "../safety/approval-page.js";
import type { ApprovalChannel, ApprovalStore, ApprovalView } from "../safety/approval-types.js";
import { redactSecrets } from "../safety/redact.js";
import { FormError, readForm, safeEqual, sameOriginPost } from "../safety/web.js";
import {
  DETAIL_PREFIX,
  INBOX_PATH,
  LOGIN_PATH,
  LOGIN_TEXT,
  LOGOUT_PATH,
  messageResponse,
  pageResponse,
  redirectResponse,
  TEXT,
} from "./approval-pages.js";
import { keyedTag, type ServerKeys } from "./keys.js";
import {
  clearSessionCookie,
  createSessionCookie,
  readSession,
  SESSION_TTL_SECONDS,
} from "./session.js";
import type {
  HttpRequestContext,
  HttpRoute,
  RateRule,
  SessionRecord,
  SessionStore,
} from "./types.js";

/** What the inbox needs of the approval store. */
export type ApprovalInbox = Pick<ApprovalStore, "list" | "get" | "decide">;

/**
 * Result of checking a sign-in token: the account it proves, or a refusal. `error` is trusted,
 * user-facing text shown (escaped) above the form; keep it generic and never include the token.
 */
type LoginResult = { readonly accountId: string } | { readonly error: string };

/**
 * Checks a pasted sevDesk token. Resolves the account the inbox then shows (it must equal the
 * `accountScope` the approvals are owned by), or `{error}`; rejects only when the check could not
 * run (the page then says to try again). Never logs or echoes the token.
 */
export type InboxLogin = (token: string, signal: AbortSignal) => Promise<LoginResult>;

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
  /** Epoch milliseconds (default `Date.now`). */
  readonly now?: () => number;
  /** Lifetime of a session created by signing in (default 12 hours). */
  readonly sessionTtlSeconds?: number;
}

export interface ApprovalRoutes {
  readonly routes: readonly HttpRoute[];
  /** The `remote` channel to hand to the safety runtime. */
  readonly channel: ApprovalChannel;
}

/** Sign-in attempts per client IP: 5 per minute … */
export const LOGIN_RATE_MINUTE: RateRule = { name: "approvals-login", perMinute: 5 };
/** … and 20 per hour. */
export const LOGIN_RATE_HOUR: RateRule = {
  name: "approvals-login-hour",
  perMinute: 20 / 60,
  burst: 20,
};

const MAX_BODY_BYTES = 4_096;
/** Longest token the form accepts (sevDesk tokens have 32 characters). */
const MAX_TOKEN_LENGTH = 256;
/** How long a token check may take before the page says to try again. */
const LOGIN_TIMEOUT_MS = 8_000;
/** Approval ids: base64url, 128 to 768 bit (the store uses 256). */
const APPROVAL_ID = /^[A-Za-z0-9_-]{22,128}$/;

/** Creates the inbox routes and the `remote` approval channel. */
export function createApprovalRoutes(options: ApprovalRoutesOptions): ApprovalRoutes {
  const { keys, origin, sessions } = options;
  const now = options.now ?? Date.now;
  const sessionTtlSeconds = options.sessionTtlSeconds ?? SESSION_TTL_SECONDS;
  const inboxUrl = `${origin}${INBOX_PATH}`;
  const host = new URL(origin).host;

  function store(): ApprovalInbox | undefined {
    const source = options.approvals;
    return typeof source === "function" ? source() : source;
  }

  function sessionOf(request: Request): SessionRecord | undefined {
    return readSession(request, { keys, store: sessions, origin, now });
  }

  function csrfTag(session: SessionRecord): string {
    return keyedTag(keys.current, "csrf", session.sid);
  }

  /** The form's tag against the current key and, during a rotation, the previous one. */
  function csrfValid(session: SessionRecord, received: string | null): boolean {
    const value = received ?? "";
    const current = safeEqual(value, csrfTag(session));
    const previous =
      keys.previous !== undefined && safeEqual(value, keyedTag(keys.previous, "csrf", session.sid));
    return current || previous;
  }

  /** The approval when it exists, is unexpired and belongs to the session's account. */
  function ownedView(
    approvals: ApprovalInbox,
    id: string,
    session: SessionRecord,
  ): ApprovalView | undefined {
    const view = approvals.get(id);
    if (view === undefined || !ownedBy(view.owner, session)) return undefined;
    return view;
  }

  function loginPage(
    status: number,
    message?: string,
    headers?: Readonly<Record<string, string>>,
  ): Response {
    return pageResponse(
      status,
      (nonce) =>
        renderLoginPage(
          {
            formAction: LOGIN_PATH,
            host,
            sessionHours: Math.round(sessionTtlSeconds / 3600),
            message,
          },
          nonce,
        ),
      headers,
    );
  }

  function decidedPage(status: number, decided: "approved" | "rejected"): Response {
    return messageResponse(status, decided === "approved" ? TEXT.approved : TEXT.rejected);
  }

  async function formOf(request: Request): Promise<URLSearchParams | Response> {
    try {
      return await readForm(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof FormError && error.reason === "too_large") {
        return messageResponse(413, TEXT.tooLarge);
      }
      return messageResponse(400, TEXT.badForm);
    }
  }

  function showInbox(request: Request): Response {
    const session = sessionOf(request);
    if (session === undefined) return loginPage(200);
    const approvals = store();
    if (approvals === undefined) return messageResponse(503, TEXT.notReady, { link: false });
    const items: InboxItem[] = approvals
      .list(session.accountId)
      .filter((view) => ownedBy(view.owner, session))
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
          accountId: session.accountId,
          items,
          inboxHref: INBOX_PATH,
          logoutAction: LOGOUT_PATH,
          csrf: csrfTag(session),
        },
        nonce,
      ),
    );
  }

  function showApproval(request: Request, id: string): Response {
    const session = sessionOf(request);
    if (session === undefined) return loginPage(200);
    const approvals = store();
    if (approvals === undefined) return messageResponse(503, TEXT.notReady, { link: false });
    const view = APPROVAL_ID.test(id) ? ownedView(approvals, id, session) : undefined;
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
          csrf: csrfTag(session),
          inboxHref: INBOX_PATH,
        },
        nonce,
      ),
    );
  }

  async function decide(request: Request, ctx: HttpRequestContext, id: string): Promise<Response> {
    if (!sameOriginPost(request, origin)) return messageResponse(403, TEXT.foreignPost);
    const session = sessionOf(request);
    if (session === undefined) return messageResponse(403, TEXT.signedOutPost);
    const form = await formOf(request);
    if (form instanceof Response) return form;
    if (!csrfValid(session, form.get("csrf"))) return messageResponse(403, TEXT.csrf);
    const choice = form.get("decision");
    if (choice !== "approve" && choice !== "reject") {
      return messageResponse(400, TEXT.noDecision);
    }
    const approvals = store();
    if (approvals === undefined) return messageResponse(503, TEXT.notReady, { link: false });
    const view = APPROVAL_ID.test(id) ? ownedView(approvals, id, session) : undefined;
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

  async function signIn(request: Request, ctx: HttpRequestContext): Promise<Response> {
    if (!sameOriginPost(request, origin)) return messageResponse(403, TEXT.foreignPost);
    if (!ctx.limit(LOGIN_RATE_MINUTE, ctx.clientIp) || !ctx.limit(LOGIN_RATE_HOUR, ctx.clientIp)) {
      ctx.log.warn("approval_login_limited");
      return loginPage(429, LOGIN_TEXT.limited, { "Retry-After": "60" });
    }
    const form = await formOf(request);
    if (form instanceof Response) return form;
    const token = (form.get("token") ?? "").trim();
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
      return loginPage(400, LOGIN_TEXT.empty);
    }
    let result: LoginResult;
    try {
      result = await options.login(
        token,
        AbortSignal.any([ctx.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)]),
      );
    } catch {
      ctx.log.warn("approval_login_unavailable");
      return loginPage(503, LOGIN_TEXT.unavailable);
    }
    if ("error" in result) {
      ctx.log.warn("approval_login_refused");
      const message = redactSecrets(result.error, [token]).trim();
      return loginPage(401, message.length === 0 ? LOGIN_TEXT.refused : message);
    }
    const previous = sessionOf(request);
    const cookie = await createSessionCookie({
      keys,
      store: sessions,
      accountId: result.accountId,
      via: "token",
      origin,
      ttlSeconds: sessionTtlSeconds,
    });
    // A new id on every sign-in; the session it replaces ends.
    if (previous !== undefined) await sessions.revokeSession(previous.sid);
    ctx.log.info("approval_login", { account: result.accountId });
    return redirectResponse(inboxUrl, cookie);
  }

  async function signOut(request: Request, ctx: HttpRequestContext): Promise<Response> {
    if (!sameOriginPost(request, origin)) return messageResponse(403, TEXT.foreignPost);
    const session = sessionOf(request);
    if (session !== undefined) {
      const form = await formOf(request);
      if (form instanceof Response) return form;
      if (!csrfValid(session, form.get("csrf"))) return messageResponse(403, TEXT.csrf);
      await sessions.revokeSession(session.sid);
      ctx.log.info("approval_logout");
    }
    return messageResponse(200, TEXT.signedOut, {
      headers: { "Set-Cookie": clearSessionCookie(origin) },
    });
  }

  /** `/approvals/<id>`; also answers `login`/`logout` should a router prefer the prefix route. */
  async function detail(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const rest = new URL(request.url).pathname.slice(DETAIL_PREFIX.length);
    if (rest === "login" || rest === "logout") {
      if (request.method !== "POST") {
        return messageResponse(405, TEXT.method, { headers: { Allow: "POST" } });
      }
      return rest === "login" ? signIn(request, ctx) : signOut(request, ctx);
    }
    if (request.method === "POST") return decide(request, ctx, rest);
    return showApproval(request, rest);
  }

  const routes: HttpRoute[] = [
    {
      path: INBOX_PATH,
      methods: ["GET"],
      maxBodyBytes: MAX_BODY_BYTES,
      origin: "form",
      handle: (request) => Promise.resolve(showInbox(request)),
    },
    {
      path: LOGIN_PATH,
      methods: ["POST"],
      maxBodyBytes: MAX_BODY_BYTES,
      origin: "form",
      handle: (request, ctx) => signIn(request, ctx),
    },
    {
      path: LOGOUT_PATH,
      methods: ["POST"],
      maxBodyBytes: MAX_BODY_BYTES,
      origin: "form",
      handle: (request, ctx) => signOut(request, ctx),
    },
    {
      path: DETAIL_PREFIX,
      match: "prefix",
      methods: ["GET", "POST"],
      maxBodyBytes: MAX_BODY_BYTES,
      origin: "form",
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

  return { routes, channel };
}

function ownedBy(owner: RequestPrincipal, session: SessionRecord): boolean {
  return owner.accountScope === session.accountId;
}
