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
import {
  type ConsentClientView,
  renderConfirmStep,
  renderConsentError,
  renderTokenStep,
} from "./consent-page.js";
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

class PageError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    message: string,
  ) {
    super(message);
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

  function errorPage(status: number, title: string, message: string): Response {
    const nonce = styleNonce();
    return htmlResponse(renderConsentError(title, message, nonce), {
      status,
      nonce,
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

  function consentPage(html: string, nonce: string, ruri: string, status: number, headers = {}) {
    return htmlResponse(html, {
      status,
      nonce,
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
      throw new PageError(
        400,
        "This sign-in link is incomplete",
        "The request names no single client (client_id). Start connecting again from your app.",
      );
    }
    try {
      return await options.cimd.load(clientId);
    } catch (error) {
      const reason = error instanceof CimdError ? error.reason : "fetch_failed";
      if (reason === "client_not_allowed") {
        throw new PageError(
          400,
          "This app is not allowed",
          `This server does not accept the app at ${new URL(clientId).hostname}. Its operator ` +
            "can allow it in SEVDESK_OAUTH_CLIENTS.",
        );
      }
      if (reason === "invalid_client_id") {
        throw new PageError(
          400,
          "Unknown app",
          "The client_id is not the https address of a client metadata document.",
        );
      }
      throw new PageError(
        400,
        "The app could not be verified",
        error instanceof CimdError
          ? error.message
          : "The app's metadata document could not be loaded.",
      );
    }
  }

  async function handleGet(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const client = await loadClient(single(params, "client_id"));
    const requestedRedirect = single(params, "redirect_uri");
    const ruri =
      typeof requestedRedirect === "string"
        ? matchRedirectUri(requestedRedirect, client.redirectUris)
        : undefined;
    if (ruri === undefined) {
      throw new PageError(
        400,
        "Unknown redirect address",
        `The redirect address is missing or not registered by the app at ${client.host}, so ` +
          "this server does not send you there. Start connecting again from your app.",
      );
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
      nonce,
    );
    return consentPage(html, nonce, ruri, 200, {
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
  ): Promise<Response> {
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
        nonce,
      );
      return consentPage(html, nonce, payload.ruri, status);
    };
    const token = (form.get("sevdesk_token") ?? "").trim();
    if (!SEVDESK_TOKEN_PATTERN.test(token)) {
      return again(
        400,
        "That is not a sevDesk API token: copy the 32 characters (digits and the letters a to f) " +
          "from sevDesk, Settings → Users → API token.",
      );
    }
    if (!ctx.limit(TOKEN_CHECK_RULE, rateLimitKey(ctx.clientIp))) {
      return again(429, "Too many attempts. Wait a minute, then try again.");
    }
    let identity: AccountIdentity;
    try {
      identity = await options.identity(
        token,
        AbortSignal.any([ctx.signal, AbortSignal.timeout(IDENTITY_TIMEOUT_MS)]),
      );
    } catch (error) {
      if (error instanceof IdentityError && error.kind === "unauthorized") {
        return again(
          400,
          "sevDesk did not accept this token. Copy it again from sevDesk (Settings → Users → " +
            "API token); a regenerated token replaces the old one.",
        );
      }
      return again(
        502,
        "The token could not be checked because sevDesk did not answer as expected. Try again " +
          "in a moment.",
      );
    }
    if (!ACCOUNT_ID_PATTERN.test(identity.accountId)) {
      return again(502, "sevDesk returned an unexpected account id. Try again in a moment.");
    }
    if (!isAccountAllowed(options.oauth, identity.accountId)) {
      options.log.warn("account_refused", { account: identity.accountId });
      return errorPage(
        403,
        "This sevDesk account is not allowed",
        `This server does not accept sevDesk account ${identity.accountId}. Its operator can ` +
          `allow it by adding ${identity.accountId} to SEVDESK_OAUTH_ACCOUNTS.`,
      );
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
      nonce,
    );
    return consentPage(html, nonce, payload.ruri, 200);
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

  async function connect(payload: ConsentPayload): Promise<Response> {
    const { acct, tok, tiers, jti } = payload;
    if (acct === undefined || tok === undefined || tiers === undefined || jti === undefined) {
      return errorPage(400, "Check the token first", "Start connecting again from your app.");
    }
    if (!firstUse(jti, payload.exp)) {
      return errorPage(
        400,
        "This page was already used",
        "Each consent page connects once. Start connecting again from your app.",
      );
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
        return errorPage(503, "Too many connections", error.message);
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

  async function handlePost(request: Request, ctx: HttpRequestContext): Promise<Response> {
    if (!sameOriginPost(request, options.origin)) {
      return errorPage(403, "Request refused", "This form can only be sent from its own page.");
    }
    let form: URLSearchParams;
    try {
      form = await readForm(request, MAX_FORM_BYTES);
    } catch (error) {
      if (error instanceof FormError) {
        return errorPage(
          error.reason === "too_large" ? 413 : 400,
          "Request refused",
          error.message,
        );
      }
      throw error;
    }
    const consent = form.get("consent") ?? "";
    const payload = openConsent(options, consent, toSeconds(options.now()));
    if (payload === undefined) {
      return errorPage(
        400,
        "This page has expired",
        "Consent pages are valid for 10 minutes. Start connecting again from your app.",
      );
    }
    const cookie = readCookie(request.headers.get("cookie"), cookieName);
    const tag = cookie === undefined ? "" : keyedTag(options.keys.current, "csrf", cookie);
    const sent = form.get("csrf") ?? "";
    if (cookie === undefined || !safeEqual(sent, tag) || !safeEqual(payload.csrf, tag)) {
      return errorPage(
        403,
        "Request refused",
        "This form was not sent from the page this browser opened. Start connecting again from " +
          "your app (cookies must be allowed for this site).",
      );
    }
    switch (form.get("step")) {
      case "check":
        return check(form, payload, consent, ctx);
      case "connect":
        return connect(payload);
      case "deny":
        return redirectError(payload.ruri, "access_denied", "The user cancelled.", payload.st);
      default:
        return errorPage(400, "Request refused", "Unknown step.");
    }
  }

  return {
    path: "/authorize",
    methods: ["GET", "POST"],
    maxBodyBytes: MAX_FORM_BYTES,
    origin: "form",
    rateLimit: { name: "oauth-authorize", perMinute: 30 },
    async handle(request, ctx) {
      try {
        return request.method === "POST"
          ? await handlePost(request, ctx)
          : await handleGet(request);
      } catch (error) {
        if (error instanceof PageError) return errorPage(error.status, error.title, error.message);
        if (error instanceof StateDirError) {
          return errorPage(
            503,
            "Temporarily unavailable",
            "The server is restarting. Try again in a minute.",
          );
        }
        throw error;
      }
    },
  };
}
