/**
 * The authorization endpoint (`GET`/`POST /authorize`): validates the request, shows the consent
 * page and, on `connect`, creates a pending grant and redirects back with the code.
 *
 * - Errors in the client, its metadata document or the `redirect_uri` show a 400 page and never
 *   redirect: the redirect target is not trustworthy yet.
 * - Other request errors go back to the validated redirect URI with `error`, `state` and `iss`:
 *   `unsupported_response_type`, `invalid_request` (PKCE S256 is required), `invalid_target`
 *   (`resource` must equal `<origin>/mcp` exactly; the SDK's prefix-based check is not used).
 * - The page's POSTs must come from the page itself (same origin, never `Origin: null`) and carry
 *   a CSRF tag that matches the `__Host-` cookie set with the page and the tag sealed into the
 *   consent state.
 * - The token check (`check`) enforces the token format, asks sevDesk who the token belongs to
 *   (8 s timeout, rate-limited per IPv4 address or IPv6 /64) and checks the account allowlist. The token is never shown
 *   again; it travels on sealed inside the consent state.
 * - `connect` creates the pending grant, mints the 60 s code and the approval inbox session, and
 *   answers `303` to the redirect URI with `code`, `state` and `iss`. A checked consent state
 *   connects once (its `jti` is remembered until it expires), so one token check cannot mint a
 *   series of grants.
 */
import { type AccountIdentity, IdentityError, type IdentityLookup } from "../../accounts/types.js";
import { type PageContext, pageContext } from "../../pages/context.js";
import { renderMessagePage, toneForStatus } from "../../pages/message.js";
import type { PageMessage, Texts } from "../../pages/text/index.js";
import { sanitizeUntrusted } from "../../safety/fence.js";
import { type Tier, TIERS } from "../../safety/tiers.js";
import {
  clearCookie,
  FormError,
  htmlResponse,
  randomId,
  readCookie,
  readForm,
  safeEqual,
  sameOriginPost,
  serializeCookie,
  styleNonce,
} from "../../safety/web.js";
import { rateLimitKey } from "../client-ip.js";
import { keyedTag, type ServerKeys } from "../keys.js";
import type {
  GrantStore,
  HttpLog,
  HttpRequestContext,
  HttpRoute,
  OAuthSettings,
  RateRule,
  SessionStore,
} from "../types.js";
import { CimdError, type CimdFetcher, type ClientMetadata } from "./cimd.js";
import { type ConsentClientView, renderConfirmStep, renderTokenStep } from "./consent-page.js";
import { GrantLimitError, StateDirError } from "./grant-store.js";
import { isAccountAllowed } from "./policy.js";
import { isLoopbackRedirect, matchRedirectUri } from "./redirect-uri.js";
import {
  ACCOUNT_ID_PATTERN,
  CODE_CHALLENGE_PATTERN,
  CODE_TTL_SECONDS,
  CONSENT_TTL_SECONDS,
  type ConsentPayload,
  openConsent,
  sealCode,
  sealConsent,
  SEVDESK_TOKEN_PATTERN,
  tiersOfScope,
  type TokenScope,
  toSeconds,
} from "./tokens.js";

/** Lifetime of the approval inbox session minted at consent. */
const CONSENT_SESSION_TTL_SECONDS = 12 * 3600;
const MAX_FORM_BYTES = 8 * 1024;
const MAX_STATE_LENGTH = 1024;
const IDENTITY_TIMEOUT_MS = 8_000;
const TOKEN_CHECK_RULE: RateRule = { name: "oauth-token-check", perMinute: 5, burst: 5 };

/**
 * Mints the approval inbox session cookie at consent and returns the `Set-Cookie` value. The
 * signature matches `createSessionCookie` in `src/http/session.ts`.
 */
export type SessionCookieMinter = (input: {
  readonly keys: ServerKeys;
  readonly store: SessionStore;
  readonly accountId: string;
  readonly gid: string;
  readonly via: "consent";
  readonly origin: string;
  readonly ttlSeconds: number;
}) => Promise<string>;

export interface AuthorizeOptions extends TokenScope {
  /** The public origin (also the issuer). */
  readonly origin: string;
  /** `<origin>/mcp`. */
  readonly resource: string;
  readonly oauth: OAuthSettings;
  readonly allowedTiers: ReadonlySet<Tier>;
  readonly cimd: CimdFetcher;
  readonly store: GrantStore;
  readonly identity: IdentityLookup;
  readonly mintSessionCookie: SessionCookieMinter | undefined;
  readonly now: () => number;
  readonly log: HttpLog;
}

/** Name of the consent CSRF cookie: `__Host-` and `Secure` on https, plain on loopback http. */
function csrfCookieName(origin: string): string {
  return origin.startsWith("https://") ? "__Host-sevdesk_csrf" : "sevdesk_csrf";
}

/** An error that ends the flow with a page; `text` picks its wording in the page's language. */
class PageError extends Error {
  constructor(
    readonly status: number,
    readonly text: (errors: Texts["consent"]["errors"]) => PageMessage,
  ) {
    super("The consent flow ended with an error page.");
  }
}

const DUPLICATE = Symbol("duplicate");

function single(params: URLSearchParams, name: string): string | undefined | typeof DUPLICATE {
  const values = params.getAll(name);
  return values.length > 1 ? DUPLICATE : values[0];
}

/** `uri` with `params` appended to its query (the existing query is kept byte for byte). */
function withQuery(uri: string, params: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.append(name, value);
  }
  return `${uri}${uri.includes("?") ? "&" : "?"}${query.toString()}`;
}

function redirectHost(uri: string): string {
  return new URL(uri).host;
}

/** The `/authorize` route. */
export function authorizeRoute(options: AuthorizeOptions): HttpRoute {
  const secure = options.origin.startsWith("https://");
  /**
   * Checked consent states already used for `connect` (jti → expiry, epoch seconds): one token
   * check gives one grant. Kept in memory for the state's 10 minutes.
   */
  const usedConsents = new Map<string, number>();
  const cookieName = csrfCookieName(options.origin);

  function errorPage(page: PageContext, status: number, text: PageMessage): Response {
    const nonce = styleNonce();
    const tone = toneForStatus(status);
    return htmlResponse(renderMessagePage(text, { ...page, nonce }, { tone }), {
      status,
      nonce,
      page,
      isolateOpener: false,
    });
  }

  function redirectError(
    ruri: string,
    error: string,
    description: string,
    state: string | undefined,
  ): Response {
    return new Response(null, {
      status: 303,
      headers: {
        Location: withQuery(ruri, {
          error,
          error_description: description,
          state,
          iss: options.issuer,
        }),
        "Cache-Control": "no-store, no-transform",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  function clientView(cid: string, ruri: string, name: string | undefined): ConsentClientView {
    return {
      host: new URL(cid).hostname,
      name,
      redirectHost: redirectHost(ruri),
      loopbackOnly: isLoopbackRedirect(ruri),
    };
  }

  function consentPage(
    html: string,
    nonce: string,
    page: PageContext,
    ruri: string,
    status: number,
    headers = {},
  ) {
    return htmlResponse(html, {
      status,
      nonce,
      page,
      // Browsers apply form-action to the redirect that follows the POST.
      formActions: [new URL(ruri).origin],
      isolateOpener: false,
      headers,
    });
  }

  async function loadClient(
    clientId: string | undefined | typeof DUPLICATE,
  ): Promise<ClientMetadata> {
    if (clientId === undefined || clientId === DUPLICATE) {
      throw new PageError(400, (errors) => errors.incompleteLink);
    }
    try {
      return await options.cimd.load(clientId);
    } catch (error) {
      const reason = error instanceof CimdError ? error.reason : "fetch_failed";
      if (reason === "client_not_allowed") {
        const host = new URL(clientId).hostname;
        throw new PageError(400, (errors) => errors.appNotAllowed(host));
      }
      if (reason === "invalid_client_id") {
        throw new PageError(400, (errors) => errors.unknownApp);
      }
      const detail =
        error instanceof CimdError
          ? error.message
          : "The app's metadata document could not be loaded.";
      throw new PageError(400, (errors) => errors.unverified(detail));
    }
  }

  async function handleGet(request: Request, page: PageContext): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const client = await loadClient(single(params, "client_id"));
    const requestedRedirect = single(params, "redirect_uri");
    const ruri =
      typeof requestedRedirect === "string"
        ? matchRedirectUri(requestedRedirect, client.redirectUris)
        : undefined;
    if (ruri === undefined) {
      throw new PageError(400, (errors) => errors.unknownRedirect(client.host));
    }
    // From here on, errors go back to the app.
    const state = single(params, "state");
    if (state === DUPLICATE || (state !== undefined && state.length > MAX_STATE_LENGTH)) {
      return redirectError(ruri, "invalid_request", "The state parameter is invalid.", undefined);
    }
    const responseType = single(params, "response_type");
    if (responseType === DUPLICATE) {
      return redirectError(ruri, "invalid_request", "Duplicate response_type.", state);
    }
    if (responseType !== "code") {
      return redirectError(
        ruri,
        "unsupported_response_type",
        "Only response_type=code is supported.",
        state,
      );
    }
    const challenge = single(params, "code_challenge");
    const method = single(params, "code_challenge_method");
    if (
      method !== "S256" ||
      typeof challenge !== "string" ||
      !CODE_CHALLENGE_PATTERN.test(challenge)
    ) {
      return redirectError(ruri, "invalid_request", "PKCE with S256 is required.", state);
    }
    const resources = params.getAll("resource");
    if (resources.length > 1 || (resources.length === 1 && resources[0] !== options.resource)) {
      return redirectError(
        ruri,
        "invalid_target",
        `The resource must be ${options.resource}.`,
        state,
      );
    }
    const scope = single(params, "scope");
    if (scope === DUPLICATE) {
      return redirectError(ruri, "invalid_request", "Duplicate scope.", state);
    }
    const requested = tiersOfScope(scope);
    const offer = TIERS.filter(
      (tier) =>
        tier === "read" ||
        (options.allowedTiers.has(tier) && (requested === undefined || requested.has(tier))),
    );
    const csrfValue = randomId(32);
    const csrf = keyedTag(options.keys.current, "csrf", csrfValue);
    const now = toSeconds(options.now());
    const consent = sealConsent(options, {
      cid: client.clientId,
      ruri,
      ...(state === undefined ? {} : { st: state }),
      ...(client.name === undefined ? {} : { cn: client.name }),
      cc: challenge,
      res: options.resource,
      offer,
      csrf,
      iat: now,
      exp: now + CONSENT_TTL_SECONDS,
    });
    const nonce = styleNonce();
    const html = renderTokenStep(
      {
        client: clientView(client.clientId, ruri, client.name),
        offered: offer,
        chosen: ["read"],
        consent,
        csrf,
        error: undefined,
      },
      { ...page, nonce },
    );
    return consentPage(html, nonce, page, ruri, 200, {
      "Set-Cookie": serializeCookie(cookieName, csrfValue, {
        maxAgeSeconds: CONSENT_TTL_SECONDS,
        secure,
        sameSite: "Strict",
      }),
    });
  }

  function chosenTiers(values: readonly string[], offered: readonly Tier[]): Tier[] {
    return offered.filter((tier) => tier === "read" || values.includes(tier));
  }

  async function check(
    form: URLSearchParams,
    payload: ConsentPayload,
    consent: string,
    ctx: HttpRequestContext,
    page: PageContext,
  ): Promise<Response> {
    const t = page.t.consent;
    const tiers = chosenTiers(form.getAll("tier"), payload.offer);
    const view = clientView(payload.cid, payload.ruri, payload.cn);
    const again = (status: number, message: string): Response => {
      const nonce = styleNonce();
      const html = renderTokenStep(
        {
          client: view,
          offered: payload.offer,
          chosen: tiers,
          consent,
          csrf: payload.csrf,
          error: message,
        },
        { ...page, nonce },
      );
      return consentPage(html, nonce, page, payload.ruri, status);
    };
    const token = (form.get("sevdesk_token") ?? "").trim();
    if (!SEVDESK_TOKEN_PATTERN.test(token)) {
      return again(400, t.check.badToken);
    }
    if (!ctx.limit(TOKEN_CHECK_RULE, rateLimitKey(ctx.clientIp))) {
      return again(429, t.check.limited);
    }
    let identity: AccountIdentity;
    try {
      identity = await options.identity(
        token,
        AbortSignal.any([ctx.signal, AbortSignal.timeout(IDENTITY_TIMEOUT_MS)]),
      );
    } catch (error) {
      if (error instanceof IdentityError && error.kind === "unauthorized") {
        return again(400, t.check.unauthorized);
      }
      return again(502, t.check.noAnswer);
    }
    if (!ACCOUNT_ID_PATTERN.test(identity.accountId)) {
      return again(502, t.check.badAccount);
    }
    if (!isAccountAllowed(options.oauth, identity.accountId)) {
      options.log.warn("account_refused", { account: identity.accountId });
      return errorPage(page, 403, t.errors.accountNotAllowed(identity.accountId));
    }
    const name =
      identity.name === undefined
        ? undefined
        : sanitizeUntrusted(identity.name, 120).replace(/\s+/g, " ").trim() || undefined;
    const next = sealConsent(options, {
      ...payload,
      jti: randomId(16),
      tiers,
      acct: identity.accountId,
      ...(name === undefined ? {} : { name }),
      tok: token,
    });
    const nonce = styleNonce();
    const html = renderConfirmStep(
      {
        client: view,
        tiers,
        accountId: identity.accountId,
        accountName: name,
        consent: next,
        csrf: payload.csrf,
      },
      { ...page, nonce },
    );
    return consentPage(html, nonce, page, payload.ruri, 200);
  }

  /** Marks a checked consent state used; false when it was used before. */
  function firstUse(jti: string, exp: number): boolean {
    const now = toSeconds(options.now());
    for (const [used, expires] of usedConsents) {
      if (expires <= now) usedConsents.delete(used);
    }
    if (usedConsents.has(jti)) return false;
    usedConsents.set(jti, exp);
    return true;
  }

  async function connect(payload: ConsentPayload, page: PageContext): Promise<Response> {
    const { errors } = page.t.consent;
    const { acct, tok, tiers, jti } = payload;
    if (acct === undefined || tok === undefined || tiers === undefined || jti === undefined) {
      return errorPage(page, 400, errors.checkFirst);
    }
    if (!firstUse(jti, payload.exp)) {
      return errorPage(page, 400, errors.alreadyUsed);
    }
    let grantId: string;
    try {
      const grant = await options.store.createPending({
        accountId: acct,
        clientId: payload.cid,
        clientHost: new URL(payload.cid).hostname,
        tiers,
        ttlSeconds: options.oauth.grantTtlSeconds,
      });
      grantId = grant.gid;
    } catch (error) {
      if (error instanceof GrantLimitError) {
        return errorPage(page, 503, errors.tooManyConnections(error.limit));
      }
      throw error;
    }
    const now = toSeconds(options.now());
    const code = sealCode(options, {
      jti: randomId(16),
      gid: grantId,
      cid: payload.cid,
      ruri: payload.ruri,
      cc: payload.cc,
      res: payload.res,
      acct,
      tiers,
      tok,
      iat: now,
      exp: now + CODE_TTL_SECONDS,
    });
    const headers = new Headers({
      Location: withQuery(payload.ruri, { code, state: payload.st, iss: options.issuer }),
      "Cache-Control": "no-store, no-transform",
      "Referrer-Policy": "no-referrer",
    });
    headers.append("Set-Cookie", clearCookie(cookieName, { secure, sameSite: "Strict" }));
    if (options.mintSessionCookie !== undefined) {
      try {
        headers.append(
          "Set-Cookie",
          await options.mintSessionCookie({
            keys: options.keys,
            store: options.store,
            accountId: acct,
            gid: grantId,
            via: "consent",
            origin: options.origin,
            ttlSeconds: CONSENT_SESSION_TTL_SECONDS,
          }),
        );
      } catch {
        options.log.warn("session_mint_failed", { grant: grantId.slice(0, 8) });
      }
    }
    options.log.info("consent_granted", {
      grant: grantId.slice(0, 8),
      account: acct,
      client: new URL(payload.cid).hostname,
      tiers: tiers.join(","),
    });
    return new Response(null, { status: 303, headers });
  }

  async function handlePost(
    request: Request,
    ctx: HttpRequestContext,
    page: PageContext,
  ): Promise<Response> {
    const { errors } = page.t.consent;
    if (!sameOriginPost(request, options.origin)) {
      return errorPage(page, 403, errors.foreignPost);
    }
    let form: URLSearchParams;
    try {
      form = await readForm(request, MAX_FORM_BYTES);
    } catch (error) {
      if (error instanceof FormError) {
        return errorPage(
          page,
          error.reason === "too_large" ? 413 : 400,
          errors.formUnreadable(error.reason),
        );
      }
      throw error;
    }
    const consent = form.get("consent") ?? "";
    const payload = openConsent(options, consent, toSeconds(options.now()));
    if (payload === undefined) {
      return errorPage(page, 400, errors.expired);
    }
    const cookie = readCookie(request.headers.get("cookie"), cookieName);
    const tag = cookie === undefined ? "" : keyedTag(options.keys.current, "csrf", cookie);
    const sent = form.get("csrf") ?? "";
    if (cookie === undefined || !safeEqual(sent, tag) || !safeEqual(payload.csrf, tag)) {
      return errorPage(page, 403, errors.csrf);
    }
    switch (form.get("step")) {
      case "check":
        return check(form, payload, consent, ctx, page);
      case "connect":
        return connect(payload, page);
      case "deny":
        return redirectError(payload.ruri, "access_denied", "The user cancelled.", payload.st);
      default:
        return errorPage(page, 400, errors.unknownStep);
    }
  }

  return {
    path: "/authorize",
    methods: ["GET", "POST"],
    maxBodyBytes: MAX_FORM_BYTES,
    origin: "form",
    rateLimit: { name: "oauth-authorize", perMinute: 30 },
    async handle(request, ctx) {
      const page = pageContext(request.headers.get("accept-language"), options.origin);
      const { errors } = page.t.consent;
      try {
        return request.method === "POST"
          ? await handlePost(request, ctx, page)
          : await handleGet(request, page);
      } catch (error) {
        if (error instanceof PageError) return errorPage(page, error.status, error.text(errors));
        if (error instanceof StateDirError) {
          return errorPage(page, 503, errors.unavailable);
        }
        throw error;
      }
    },
  };
}
