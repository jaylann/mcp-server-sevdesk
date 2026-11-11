/**
 * Browser sessions of the server's own pages (the approval inbox, the upload and download pages
 * of remote file transfer): who the browser is, CSRF tags for its forms, and signing in and out.
 *
 * A session proves that the browser holds the sevDesk account:
 * - it is set at OAuth consent (`createSessionCookie` in `session.ts`, called by the consent
 *   step), or
 * - by signing in on `POST /approvals/login` with the account's sevDesk API token (`login`, wired
 *   by the caller: OAuth mode checks the token with the identity lookup and the account
 *   allowlist, bearer mode compares it in constant time with the configured token, never with the
 *   bearer secret). 5 attempts a minute and 20 an hour per client IP (IPv6 by /64).
 *
 * The sign-in form may carry a hidden `next`, the page to return to; only paths of the server's
 * own record pages pass ({@link SIGN_IN_TARGET}), so the sign-in is no open redirect. Without a
 * valid `next` the browser lands on `homePath` (the inbox), or on a "Signed in" page when the
 * inbox is off. `POST /approvals/logout` ends the session (CSRF tag required).
 *
 * With `accountAllowed`, every session read also checks that its account may still use the
 * server: a session of an account the operator removed is revoked and treated as signed out. The
 * sevDesk token is never echoed, logged or stored. Handlers check the same-origin POST themselves
 * too (the router's `form` policy is the first line), so the routes are safe even when mounted
 * without it.
 */
import type { PageContext } from "../pages/context.js";
import type { PageMessage, Texts } from "../pages/text/index.js";
import { renderLoginPage } from "../safety/approval-page.js";
import { FormError, readForm, safeEqual, sameOriginPost } from "../safety/web.js";
import {
  LOGIN_PATH,
  LOGOUT_PATH,
  messageResponse,
  pageOf,
  pageResponse,
  redirectResponse,
} from "./approval-pages.js";
import { rateLimitKey } from "./client-ip.js";
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

/**
 * Why a sign-in token was refused; the page says it in the browser's language:
 * - `refused`: not accepted, without saying more;
 * - `wrong_token`: not the token this server is configured with (bearer mode);
 * - `rejected`: sevDesk did not accept the token;
 * - `not_allowed`: the token's account may not use this server.
 */
type LoginRefusal = "refused" | "wrong_token" | "rejected" | "not_allowed";

/** Result of checking a sign-in token: the account it proves, or a refusal. */
type LoginResult = { readonly accountId: string } | { readonly error: LoginRefusal };

function refusalText(t: Texts, refusal: LoginRefusal): string {
  switch (refusal) {
    case "refused":
      return t.login.refused;
    case "wrong_token":
      return t.login.wrongToken;
    case "rejected":
      return t.login.rejected;
    case "not_allowed":
      return t.login.notAllowed;
  }
}

/**
 * Checks a pasted sevDesk token. Resolves the account the session then belongs to (it must equal
 * the `accountScope` records are owned by), or `{error}`; rejects only when the check could not
 * run (the page then says to try again). Never logs or echoes the token.
 */
export type InboxLogin = (token: string, signal: AbortSignal) => Promise<LoginResult>;

/**
 * Requests to all inbox routes together per client IP (IPv6 by /64), applied by the router before
 * a handler runs: generous for a person, a ceiling for scripted page loads. The sign-in and
 * sign-out routes share it.
 */
export const INBOX_RATE: RateRule = { name: "approvals", perMinute: 120 };
/** Sign-in attempts per client IP (IPv6 by /64): 5 per minute … */
export const LOGIN_RATE_MINUTE: RateRule = { name: "approvals-login", perMinute: 5 };
/** … and 20 per hour. */
export const LOGIN_RATE_HOUR: RateRule = {
  name: "approvals-login-hour",
  perMinute: 20 / 60,
  burst: 20,
};

/**
 * The pages a sign-in may return to (`next`): an approval, an upload page or a download link of
 * this server, by id. Anything else (other paths, other hosts, `//host`) is ignored.
 */
export const SIGN_IN_TARGET = /^\/(?:approvals|uploads|files)\/[A-Za-z0-9_-]{22,128}$/;

/** Largest form the session routes (and the inbox's decisions) accept. */
export const SMALL_FORM_BYTES = 4_096;
/** Longest token the form accepts (sevDesk tokens have 32 characters). */
const MAX_TOKEN_LENGTH = 256;
/** How long a token check may take before the page says to try again. */
const LOGIN_TIMEOUT_MS = 8_000;

export interface BrowserSessionOptions {
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
  /**
   * Where a sign-in without a valid `next` goes, a path such as `/approvals` (the inbox); message
   * pages link back to it. Undefined (inbox off): a "Signed in" page, and no links.
   */
  readonly homePath?: string | undefined;
}

/** @public Options of {@link BrowserSession.loginPage}. */
export interface LoginPageOptions {
  /** Trusted note above the form. */
  readonly message?: string | undefined;
  /** A path matching {@link SIGN_IN_TARGET}; also picks the files wording for uploads and files. */
  readonly next?: string | undefined;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface BrowserSession {
  /**
   * The request's session, if any. A session whose account is no longer allowed is revoked here
   * and counts as none.
   */
  sessionOf(request: Request, ctx: HttpRequestContext): Promise<SessionRecord | undefined>;
  /** The CSRF tag forms of `session` carry (`keyedTag(csrf, sid)`). */
  csrfTag(session: SessionRecord): string;
  /** The form's tag against the current key and, during a rotation, the previous one. */
  csrfValid(session: SessionRecord, received: string | null): boolean;
  /** The sign-in page (no record data), posting to `/approvals/login`. */
  loginPage(page: PageContext, status: number, options?: LoginPageOptions): Response;
  /** A trusted message page, linking to the home path when there is one. */
  message(
    page: PageContext,
    status: number,
    text: PageMessage,
    headers?: Readonly<Record<string, string>>,
  ): Response;
  /** Reads a small url-encoded form; a 400 or 413 page when it cannot. */
  formOf(request: Request, page: PageContext): Promise<URLSearchParams | Response>;
  signIn(request: Request, ctx: HttpRequestContext): Promise<Response>;
  signOut(request: Request, ctx: HttpRequestContext): Promise<Response>;
  /** `POST /approvals/login` and `POST /approvals/logout`. */
  readonly routes: readonly HttpRoute[];
}

/** Creates the session helpers and the sign-in and sign-out routes. */
export function createBrowserSession(options: BrowserSessionOptions): BrowserSession {
  const { keys, origin, sessions, homePath } = options;
  const now = options.now ?? Date.now;
  const sessionTtlSeconds = options.sessionTtlSeconds ?? SESSION_TTL_SECONDS;
  const host = new URL(origin).host;
  const link = homePath !== undefined;

  function allowed(accountId: string): boolean {
    return options.accountAllowed?.(accountId) ?? true;
  }

  async function sessionOf(
    request: Request,
    ctx: HttpRequestContext,
  ): Promise<SessionRecord | undefined> {
    // `readSession` answers from memory: first pick up a `grants revoke` another process
    // appended, so a revoked session cannot decide an approval on the next request (security
    // review 2026-11, finding 4).
    await sessions.sync();
    const session = readSession(request, { keys, store: sessions, origin, now });
    if (session === undefined || allowed(session.accountId)) return session;
    await sessions.revokeSession(session.sid);
    ctx.log.warn("approval_session_refused", { account: session.accountId });
    return undefined;
  }

  function csrfTag(session: SessionRecord): string {
    return keyedTag(keys.current, "csrf", session.sid);
  }

  function csrfValid(session: SessionRecord, received: string | null): boolean {
    const value = received ?? "";
    const current = safeEqual(value, csrfTag(session));
    const previous =
      keys.previous !== undefined && safeEqual(value, keyedTag(keys.previous, "csrf", session.sid));
    return current || previous;
  }

  function loginPage(page: PageContext, status: number, form: LoginPageOptions = {}): Response {
    const next = form.next !== undefined && SIGN_IN_TARGET.test(form.next) ? form.next : undefined;
    const files = next !== undefined && !next.startsWith("/approvals/");
    return pageResponse(
      page,
      status,
      (ctx) =>
        renderLoginPage(
          {
            formAction: LOGIN_PATH,
            host,
            sessionHours: Math.round(sessionTtlSeconds / 3600),
            message: form.message,
            ...(next === undefined ? {} : { next }),
            ...(files ? { purpose: "files" as const } : {}),
          },
          ctx,
        ),
      form.headers,
    );
  }

  function message(
    page: PageContext,
    status: number,
    text: PageMessage,
    headers?: Readonly<Record<string, string>>,
  ): Response {
    return messageResponse(page, status, text, {
      link,
      ...(headers === undefined ? {} : { headers }),
    });
  }

  async function formOf(request: Request, page: PageContext): Promise<URLSearchParams | Response> {
    try {
      return await readForm(request, SMALL_FORM_BYTES);
    } catch (error) {
      if (error instanceof FormError && error.reason === "too_large") {
        return message(page, 413, page.t.inbox.tooLarge);
      }
      return message(page, 400, page.t.inbox.badForm);
    }
  }

  async function signIn(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const page = pageOf(request, origin);
    const { t } = page;
    if (!sameOriginPost(request, origin)) return message(page, 403, t.inbox.foreignPost);
    const client = rateLimitKey(ctx.clientIp);
    if (!ctx.limit(LOGIN_RATE_MINUTE, client) || !ctx.limit(LOGIN_RATE_HOUR, client)) {
      ctx.log.warn("approval_login_limited");
      return loginPage(page, 429, {
        message: t.login.limited,
        headers: { "Retry-After": "60" },
      });
    }
    const form = await formOf(request, page);
    if (form instanceof Response) return form;
    const requested = form.get("next") ?? "";
    const next = SIGN_IN_TARGET.test(requested) ? requested : undefined;
    const token = (form.get("token") ?? "").trim();
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
      return loginPage(page, 400, { message: t.login.empty, next });
    }
    let result: LoginResult;
    try {
      result = await options.login(
        token,
        AbortSignal.any([ctx.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)]),
      );
    } catch {
      ctx.log.warn("approval_login_unavailable");
      return loginPage(page, 503, { message: t.login.unavailable, next });
    }
    if ("error" in result) {
      ctx.log.warn("approval_login_refused");
      return loginPage(page, 401, { message: refusalText(t, result.error), next });
    }
    if (!allowed(result.accountId)) {
      ctx.log.warn("approval_login_refused", { account: result.accountId });
      return loginPage(page, 401, { message: t.login.notAllowed, next });
    }
    const previous = await sessionOf(request, ctx);
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
    const target = next ?? homePath;
    if (target === undefined) {
      return message(page, 200, t.session.signedIn, { "Set-Cookie": cookie });
    }
    return redirectResponse(`${origin}${target}`, cookie);
  }

  async function signOut(request: Request, ctx: HttpRequestContext): Promise<Response> {
    const page = pageOf(request, origin);
    const { t } = page;
    if (!sameOriginPost(request, origin)) return message(page, 403, t.inbox.foreignPost);
    const session = await sessionOf(request, ctx);
    if (session !== undefined) {
      const form = await formOf(request, page);
      if (form instanceof Response) return form;
      if (!csrfValid(session, form.get("csrf"))) return message(page, 403, t.inbox.csrf);
      await sessions.revokeSession(session.sid);
      ctx.log.info("approval_logout");
    }
    return message(page, 200, link ? t.inbox.signedOut : t.session.signedOut, {
      "Set-Cookie": clearSessionCookie(origin),
    });
  }

  const routes: HttpRoute[] = [
    {
      path: LOGIN_PATH,
      methods: ["POST"],
      maxBodyBytes: SMALL_FORM_BYTES,
      origin: "form",
      rateLimit: INBOX_RATE,
      handle: (request, ctx) => signIn(request, ctx),
    },
    {
      path: LOGOUT_PATH,
      methods: ["POST"],
      maxBodyBytes: SMALL_FORM_BYTES,
      origin: "form",
      rateLimit: INBOX_RATE,
      handle: (request, ctx) => signOut(request, ctx),
    },
  ];

  return { sessionOf, csrfTag, csrfValid, loginPage, message, formOf, signIn, signOut, routes };
}
