import { afterEach, describe, expect, it } from "vitest";

import { createServerKeys } from "../../../../src/http/keys.js";
import { openGrantStore } from "../../../../src/http/oauth/grant-store.js";
import { createOAuthModule } from "../../../../src/http/oauth/index.js";
import { openConsent } from "../../../../src/http/oauth/tokens.js";
import { createRateLimiter } from "../../../../src/http/rate-limit.js";
import { SEALED_TOKEN_PATTERN } from "../../../../src/http/seal.js";
import {
  ACCOUNT,
  authorizeUrl,
  captureLog,
  CLAUDE_AI_CLIENT,
  CLAUDE_AI_REDIRECT,
  CLAUDE_CODE_CLIENT,
  claudeDocuments,
  completeConsent,
  CookieJar,
  createOAuthRig,
  createTestRouter,
  DEAD_TOKEN,
  DEFAULT_OAUTH,
  failingStore,
  fakeCimd,
  fakeClock,
  fakeIdentity,
  type OAuthRig,
  openAuthorize,
  ORIGIN,
  OTHER_ACCOUNT,
  OTHER_TOKEN,
  parseConsentForm,
  pkcePair,
  SEVDESK_TOKEN,
  submitConsent,
  testContext,
} from "../../../helpers/oauth-browser.js";

const rigs: OAuthRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
});

async function rig(overrides: Parameters<typeof createOAuthRig>[0] = {}): Promise<OAuthRig> {
  const created = await createOAuthRig(overrides);
  rigs.push(created);
  return created;
}

async function challenge(): Promise<string> {
  return (await pkcePair()).challenge;
}

function location(response: Response): URL {
  const value = response.headers.get("location");
  if (value === null) throw new Error(`no Location (status ${String(response.status)})`);
  return new URL(value);
}

describe("GET /authorize", () => {
  it("shows the consent page for claude.ai with CSRF cookie and page security headers", async () => {
    const r = await rig();
    const jar = new CookieJar();
    const page = await openAuthorize(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
      jar,
    );
    expect(page.response.status).toBe(200);
    expect(page.html).toContain("<strong>claude.ai</strong> wants to use your sevDesk account");
    expect(page.html).toContain("It calls itself “Claude” (self-declared, not verified).");
    expect(page.html).toContain("your browser returns to <strong>claude.ai</strong>");
    expect(page.html).not.toContain("runs on your own computer");
    expect(page.form?.tiers).toEqual([{ value: "write", checked: false }]);
    expect(page.form?.hidden.map(([name]) => name)).toEqual(["consent", "csrf", "tier"]);
    expect(page.form?.steps).toEqual(["check", "deny"]);
    expect(page.form?.hasTokenField).toBe(true);

    const headers = page.response.headers;
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self' https://claude.ai;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("cross-origin-opener-policy")).toBeNull();
    expect(headers.get("cache-control")).toBe("no-store");
    const [cookie] = headers.getSetCookie();
    expect(cookie).toMatch(
      /^__Host-sevdesk_csrf=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; HttpOnly; SameSite=Strict; Secure$/,
    );
  });

  it("offers every allowed tier when the client asks for no specific scope", async () => {
    const r = await rig();
    const page = await openAuthorize(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge(), scope: undefined }),
      new CookieJar(),
    );
    expect(page.form?.tiers.map((tier) => tier.value)).toEqual(["write", "commit"]);
    const scoped = await openAuthorize(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge(), scope: "sevdesk:external sevdesk:read" }),
      new CookieJar(),
    );
    expect(scoped.form?.tiers).toEqual([]);
  });

  it("warns when the redirect goes to a local app (Claude Code, any loopback port)", async () => {
    const r = await rig();
    const page = await openAuthorize(
      r.fetch,
      authorizeUrl({
        client_id: CLAUDE_CODE_CLIENT,
        redirect_uri: "http://127.0.0.1:53111/callback",
        code_challenge: await challenge(),
      }),
      new CookieJar(),
    );
    expect(page.response.status).toBe(200);
    expect(page.html).toContain("This app runs on your own computer");
    expect(page.html).toContain("<strong>127.0.0.1:53111</strong>");
    expect(page.response.headers.get("content-security-policy")).toContain(
      "form-action 'self' http://127.0.0.1:53111;",
    );
  });

  it("escapes a hostile client_name", async () => {
    const documents = claudeDocuments();
    documents.set(CLAUDE_AI_CLIENT, {
      ...documents.get(CLAUDE_AI_CLIENT),
      client_name: '<script>alert("x")</script><img src=x onerror=1>',
    });
    const r = await rig({ cimd: fakeCimd(documents) });
    const page = await openAuthorize(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
      new CookieJar(),
    );
    expect(page.html).not.toContain("<script>");
    expect(page.html).not.toContain("<img");
    expect(page.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=1&gt;",
    );
  });

  it.each([
    ["no client_id", { client_id: undefined }, /no single client/],
    [
      "a client off the allowlist",
      { client_id: "https://evil.example/oauth/client" },
      /SEVDESK_OAUTH_CLIENTS/,
    ],
    ["a non-CIMD client_id", { client_id: "my-client" }, /not the https address/],
    [
      "a client without a document",
      { client_id: "https://claude.ai/oauth/unknown" },
      /could not be loaded/,
    ],
    [
      "no redirect_uri",
      { redirect_uri: undefined },
      /redirect address is missing or not registered/,
    ],
    [
      "a foreign redirect_uri",
      { redirect_uri: "https://evil.example/cb" },
      /not registered by the app at claude\.ai/,
    ],
    ["a near-miss redirect_uri", { redirect_uri: `${CLAUDE_AI_REDIRECT}/` }, /not registered/],
    [
      "a redirect_uri with a fragment",
      { redirect_uri: `${CLAUDE_AI_REDIRECT}#x` },
      /not registered/,
    ],
  ] as const)("shows a 400 page and never redirects for %s", async (_label, params, message) => {
    const r = await rig();
    const response = await r.fetch(authorizeUrl({ code_challenge: await challenge(), ...params }));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toMatch(message);
    expect(parseConsentForm(html)).toBeUndefined();
  });

  it("never redirects for duplicated client_id or redirect_uri", async () => {
    const r = await rig();
    for (const name of ["client_id", "redirect_uri"]) {
      const url = authorizeUrl({ code_challenge: await challenge() });
      url.searchParams.append(name, url.searchParams.get(name) ?? "");
      const response = await r.fetch(url);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it.each([
    ["response_type=token", { response_type: "token" }, "unsupported_response_type"],
    ["no response_type", { response_type: undefined }, "unsupported_response_type"],
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["no PKCE method", { code_challenge_method: undefined }, "invalid_request"],
    ["no code_challenge", { code_challenge: undefined }, "invalid_request"],
    ["a malformed code_challenge", { code_challenge: "short" }, "invalid_request"],
    ["another resource", { resource: "https://other.example/mcp" }, "invalid_target"],
    ["a resource with a trailing slash", { resource: `${ORIGIN}/mcp/` }, "invalid_target"],
    ["the origin as resource", { resource: ORIGIN }, "invalid_target"],
  ] as const)("redirects %s back with error, state and iss", async (_label, params, error) => {
    const r = await rig();
    const response = await r.fetch(authorizeUrl({ code_challenge: await challenge(), ...params }));
    expect(response.status).toBe(303);
    const target = location(response);
    expect(`${target.origin}${target.pathname}`).toBe(CLAUDE_AI_REDIRECT);
    expect(target.searchParams.get("error")).toBe(error);
    expect(target.searchParams.get("state")).toBe("state-123");
    expect(target.searchParams.get("iss")).toBe(ORIGIN);
    expect(target.searchParams.get("code")).toBeNull();
  });

  it("refuses duplicated parameters and an oversized state", async () => {
    const r = await rig();
    for (const name of ["response_type", "scope", "resource", "state"]) {
      const url = authorizeUrl({ code_challenge: await challenge() });
      url.searchParams.append(name, url.searchParams.get(name) ?? "");
      const response = await r.fetch(url);
      expect(response.status, name).toBe(303);
      expect(location(response).searchParams.get("error"), name).toMatch(
        /invalid_request|invalid_target/,
      );
    }
    const long = await r.fetch(
      authorizeUrl({ code_challenge: await challenge(), state: "s".repeat(1025) }),
    );
    expect(location(long).searchParams.get("error")).toBe("invalid_request");
    expect(location(long).searchParams.get("state")).toBeNull();
  });

  it("accepts a request without resource (bound to this server) and without state", async () => {
    const r = await rig();
    const { challenge: cc } = await pkcePair();
    const { redirect } = await completeConsent(
      r.fetch,
      authorizeUrl({ code_challenge: cc, resource: undefined, state: undefined }),
    );
    expect(redirect.searchParams.get("state")).toBeNull();
    expect(redirect.searchParams.get("code")).toMatch(/^sdmcp_ac_/);
  });
});

describe("POST /authorize", () => {
  async function firstPage(r: OAuthRig) {
    const jar = new CookieJar();
    const page = await openAuthorize(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
      jar,
    );
    if (page.form === undefined) throw new Error("no form");
    return { jar, form: page.form };
  }

  it("checks the token, shows the account, and connects with code, state and iss", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const checked = await submitConsent(r.fetch, form, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
      tiers: ["write", "external"],
    });
    expect(checked.response.status).toBe(200);
    expect(checked.html).toContain("Connect to sevDesk account 4711?");
    expect(checked.html).toContain("(named “Muster &lt;b&gt;GmbH&lt;/b&gt;” in sevDesk)");
    expect(checked.html).toContain("<strong>Write</strong>");
    expect(checked.html).not.toContain("<strong>External</strong>");
    expect(checked.html).not.toContain(SEVDESK_TOKEN);
    expect(checked.form?.steps).toEqual(["connect", "deny"]);
    expect(checked.form?.hasTokenField).toBe(false);
    expect(r.identity.calls).toEqual([SEVDESK_TOKEN]);

    const connected = await submitConsent(r.fetch, checked.form!, jar, { step: "connect" });
    expect(connected.response.status).toBe(303);
    const target = location(connected.response);
    expect(`${target.origin}${target.pathname}`).toBe(CLAUDE_AI_REDIRECT);
    expect(target.searchParams.get("code")).toMatch(/^sdmcp_ac_[A-Za-z0-9_-]+$/);
    expect(target.searchParams.get("state")).toBe("state-123");
    expect(target.searchParams.get("iss")).toBe(ORIGIN);
    expect(connected.response.headers.get("cache-control")).toBe("no-store");
    expect(connected.response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookies = connected.response.headers.getSetCookie();
    expect(cookies[0]).toMatch(/^__Host-sevdesk_csrf=; Path=\/; Max-Age=0;/);
    expect(cookies[1]).toMatch(/^__Host-sevdesk_session=/);

    const [grant] = r.module.store.list();
    expect(grant).toMatchObject({
      accountId: ACCOUNT,
      clientId: CLAUDE_AI_CLIENT,
      clientHost: "claude.ai",
      tiers: ["read", "write"],
      status: "pending",
    });
    expect(r.sessionMints).toEqual([{ accountId: ACCOUNT, gid: grant?.gid }]);
    expect(r.log.lines).toContainEqual({
      level: "info",
      event: "consent_granted",
      fields: {
        grant: grant?.gid.slice(0, 8),
        account: ACCOUNT,
        client: "claude.ai",
        tiers: "read,write",
      },
    });
  });

  it("goes back with access_denied on cancel, in either step", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const denied = await submitConsent(r.fetch, form, jar, { step: "deny" });
    expect(denied.response.status).toBe(303);
    const target = location(denied.response);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("state-123");
    expect(target.searchParams.get("iss")).toBe(ORIGIN);
    expect(r.module.store.list()).toEqual([]);
  });

  it("re-shows the token step for a malformed token without echoing it", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const typed = "not-a-token-<b>-secret-value-1234";
    const again = await submitConsent(r.fetch, form, jar, {
      step: "check",
      token: typed,
      tiers: ["write"],
    });
    expect(again.response.status).toBe(400);
    expect(again.html).toContain("That is not a sevDesk API token");
    expect(again.html).not.toContain("secret-value");
    expect(again.form?.tiers).toEqual([{ value: "write", checked: true }]);
    expect(r.identity.calls).toEqual([]);
  });

  it("reports a token sevDesk refuses, and sevDesk being unreachable", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const refused = await submitConsent(r.fetch, form, jar, { step: "check", token: DEAD_TOKEN });
    expect(refused.response.status).toBe(400);
    expect(refused.html).toContain("sevDesk did not accept this token");
    expect(refused.html).not.toContain(DEAD_TOKEN);
    r.identity.unreachable(true);
    const down = await submitConsent(r.fetch, form, jar, { step: "check", token: SEVDESK_TOKEN });
    expect(down.response.status).toBe(502);
    expect(down.html).toContain("Try again in a moment");
  });

  it("refuses an account off the allowlist, naming its id and the variable", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const refused = await submitConsent(r.fetch, form, jar, { step: "check", token: OTHER_TOKEN });
    expect(refused.response.status).toBe(403);
    expect(refused.html).toContain(`does not accept sevDesk account ${OTHER_ACCOUNT}`);
    expect(refused.html).toContain(`adding ${OTHER_ACCOUNT} to SEVDESK_OAUTH_ACCOUNTS`);
    expect(refused.form).toBeUndefined();
    expect(r.log.lines).toContainEqual({
      level: "warn",
      event: "account_refused",
      fields: { account: OTHER_ACCOUNT },
    });
  });

  it("accepts any account with accounts=any", async () => {
    const r = await rig({ oauth: { ...DEFAULT_OAUTH, accounts: "any" } });
    const { jar, form } = await firstPage(r);
    const checked = await submitConsent(r.fetch, form, jar, { step: "check", token: OTHER_TOKEN });
    expect(checked.response.status).toBe(200);
    expect(checked.html).toContain(`account ${OTHER_ACCOUNT}?`);
  });

  it("rate-limits token checks per client IP", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const limited = createTestRouter(r.module.routes, {
      log: r.log,
      context: { limit: (rule) => rule.name !== "oauth-token-check" },
    });
    const response = await submitConsent(limited, form, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
    });
    expect(response.response.status).toBe(429);
    expect(r.identity.calls).toEqual([]);
  });

  it("refuses a missing cookie, a foreign or null Origin and a wrong CSRF tag (403)", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const cases: [string, Parameters<typeof submitConsent>[3], CookieJar][] = [
      ["no cookie", { step: "check", token: SEVDESK_TOKEN }, new CookieJar()],
      ["cross-site", { step: "check", token: SEVDESK_TOKEN, origin: "https://evil.example" }, jar],
      ["Origin: null", { step: "check", token: SEVDESK_TOKEN, origin: "null" }, jar],
      ["no Origin", { step: "check", token: SEVDESK_TOKEN, origin: null }, jar],
      [
        "wrong tag",
        { step: "check", token: SEVDESK_TOKEN, override: { csrf: "x".repeat(43) } },
        jar,
      ],
    ];
    for (const [label, options, cookies] of cases) {
      const response = await submitConsent(r.fetch, form, cookies, options);
      expect(response.response.status, label).toBe(403);
      expect(response.response.headers.get("location"), label).toBeNull();
    }
    expect(r.identity.calls).toEqual([]);
  });

  it("refuses consent state from another browser's page", async () => {
    const r = await rig();
    const victim = await firstPage(r);
    const attacker = await firstPage(r);
    // The attacker's page state with the victim's cookie and tag.
    const mixed = {
      ...victim.form,
      hidden: victim.form.hidden.map(([name, value]): [string, string] =>
        name === "consent" ? [name, attacker.form.hidden[0]?.[1] ?? ""] : [name, value],
      ),
    };
    const response = await submitConsent(r.fetch, mixed, victim.jar, {
      step: "check",
      token: SEVDESK_TOKEN,
    });
    expect(response.response.status).toBe(403);
  });

  it("accepts a same-origin POST without Origin when the browser says so", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const body = new URLSearchParams([
      ...form.hidden.map(([name, value]): [string, string] => [name, value]),
      ["step", "deny"],
    ]);
    const response = await r.fetch(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          Cookie: jar.header(),
        },
        body,
      }),
    );
    expect(response.status).toBe(303);
  });

  it("expires the consent state after 10 minutes", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    r.clock.advance(600_000);
    const response = await submitConsent(r.fetch, form, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
    });
    expect(response.response.status).toBe(400);
    expect(response.html).toContain("This page has expired");
  });

  it("refuses non-form bodies, oversized forms and unknown steps", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const json = await r.fetch(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: jar.header() },
        body: "{}",
      }),
    );
    expect(json.status).toBe(400);
    const big = await submitConsent(r.fetch, form, jar, {
      step: "check",
      override: { pad: "x".repeat(9000) },
    });
    expect(big.response.status).toBe(413);
    const odd = await submitConsent(r.fetch, form, jar, { step: "launch" });
    expect(odd.response.status).toBe(400);
    const early = await submitConsent(r.fetch, form, jar, { step: "connect" });
    expect(early.response.status).toBe(400);
    expect(early.html).toContain("Check the token first");
    expect(r.module.store.list()).toEqual([]);
  });

  it("ignores tiers that were not offered", async () => {
    const r = await rig();
    const { jar, form } = await firstPage(r);
    const tampered = {
      ...form,
      tiers: [
        ...form.tiers,
        { value: "external", checked: true },
        { value: "admin", checked: true },
      ],
    };
    const checked = await submitConsent(r.fetch, tampered, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
    });
    await submitConsent(r.fetch, checked.form!, jar, { step: "connect" });
    expect(r.module.store.list()[0]?.tiers).toEqual(["read"]);
  });

  it("refuses a new consent when the grant cap is reached", async () => {
    const clock = fakeClock();
    const store = await openGrantStore({ stateDir: undefined, now: clock.now, maxGrants: 0 });
    const r = await rig({ store, now: clock.now });
    const { jar, form } = await firstPage(r);
    const checked = await submitConsent(r.fetch, form, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
    });
    const connected = await submitConsent(r.fetch, checked.form!, jar, { step: "connect" });
    expect(connected.response.status).toBe(503);
    expect(connected.html).toContain("grants revoke");
    await store.close();
  });

  it("still connects when the inbox session cannot be minted, or without a minter", async () => {
    const failing = await rig({ mintSessionCookie: () => Promise.reject(new Error("boom")) });
    const { redirect } = await completeConsent(
      failing.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
    );
    expect(redirect.searchParams.get("code")).toBeTruthy();
    expect(failing.log.events()).toContain("session_mint_failed");

    const none = await rig({ mintSessionCookie: null });
    const jar = new CookieJar();
    const page = await openAuthorize(
      none.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
      jar,
    );
    const checked = await submitConsent(none.fetch, page.form!, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
    });
    const connected = await submitConsent(none.fetch, checked.form!, jar, { step: "connect" });
    expect(connected.response.headers.getSetCookie()).toHaveLength(1);
  });

  it("uses an unprefixed, non-Secure CSRF cookie on a loopback http origin", async () => {
    const origin = "http://127.0.0.1:8080";
    const log = captureLog();
    const cimd = fakeCimd();
    const module = await createOAuthModule({
      origin,
      keys: createServerKeys(new Uint8Array(32).map((_, i) => i * 7 + 1)),
      oauth: DEFAULT_OAUTH,
      allowedTiers: new Set(["read"]),
      stateDir: undefined,
      identity: fakeIdentity().lookup,
      log,
      resolve: cimd.resolve,
      httpsGet: cimd.httpsGet,
    });
    const route = module.routes.find((candidate) => candidate.path === "/authorize")!;
    const url = authorizeUrl({ code_challenge: await challenge(), resource: `${origin}/mcp` });
    const response = await route.handle(new Request(url), testContext(log, { origin }));
    expect(response?.status).toBe(200);
    expect(response?.headers.getSetCookie()[0]).toMatch(
      /^sevdesk_csrf=[^;]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Strict$/,
    );
    await module.close();
  });

  it("never puts the sevDesk token or a sealed token other than the code into pages, redirects or logs", async () => {
    const r = await rig();
    const { redirect, pages } = await completeConsent(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
    );
    const code = redirect.searchParams.get("code") ?? "";
    for (const entry of r.fetch.transcript) {
      const visible = `${entry.body}\n${entry.headers
        .filter(([name]) => name !== "set-cookie")
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n")}`;
      expect(visible).not.toContain(SEVDESK_TOKEN);
      // Only the consent state (a hidden field, by design) and the one code redirect carry sealed tokens.
      const sealed = [...visible.matchAll(SEALED_TOKEN_PATTERN)].map((match) => match[0]);
      for (const token of sealed)
        expect(token.startsWith("sdmcp_cs_") || token === code).toBe(true);
    }
    expect(pages.join("")).not.toContain(SEVDESK_TOKEN);
    const consent = pages[1]?.match(/name="consent" value="([^"]+)"/)?.[1] ?? "";
    // The consent state of step 2 does carry the token, sealed: readable only with the server key.
    expect(
      openConsent({ keys: r.keys, issuer: ORIGIN }, consent, Math.floor(r.clock.now() / 1000))?.tok,
    ).toBe(SEVDESK_TOKEN);
    expect(r.log.text()).not.toContain(SEVDESK_TOKEN);
    expect(r.log.text()).not.toMatch(new RegExp(SEALED_TOKEN_PATTERN.source));
  });
});

describe("POST /authorize: abuse limits", () => {
  it("connects once per checked consent state (no series of grants from one token check)", async () => {
    const r = await rig();
    const jar = new CookieJar();
    const page = await openAuthorize(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
      jar,
    );
    const checked = await submitConsent(r.fetch, page.form!, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
    });
    const cookie = jar.header();
    const first = await submitConsent(r.fetch, checked.form!, jar, { step: "connect" });
    expect(first.response.status).toBe(303);
    // Replaying the same form with the same (kept) CSRF cookie is refused.
    const replayJar = new CookieJar();
    replayJar.store(new Response(null, { headers: { "Set-Cookie": cookie } }));
    const again = await submitConsent(r.fetch, checked.form!, replayJar, { step: "connect" });
    expect(again.response.status).toBe(400);
    expect(again.html).toContain("This page was already used");
    expect(r.module.store.list()).toHaveLength(1);
    expect(r.identity.calls).toHaveLength(1);

    // Used states are forgotten once they expired (fresh consents keep working).
    r.clock.advance(601_000);
    const next = await completeConsent(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
    );
    expect(next.redirect.searchParams.get("code")).toBeTruthy();
  });

  it("limits token checks per IPv6 /64, not per address", async () => {
    const r = await rig();
    const jar = new CookieJar();
    const page = await openAuthorize(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
      jar,
    );
    const limiter = createRateLimiter({ now: r.clock.now });
    const statuses: number[] = [];
    for (let index = 1; index <= 7; index += 1) {
      const fromAddress = createTestRouter(r.module.routes, {
        log: r.log,
        context: {
          clientIp: `2001:db8:1:2::${index.toString(16)}`,
          limit: (rule, key) => limiter.take(rule, key).allowed,
        },
      });
      const result = await submitConsent(fromAddress, page.form!, jar, {
        step: "check",
        token: DEAD_TOKEN,
      });
      statuses.push(result.response.status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429, 429]);
    expect(r.identity.calls).toHaveLength(5);
  });

  it("answers 503 while the grant store cannot be trusted", async () => {
    const failed = { on: false };
    const store = await openGrantStore({ stateDir: undefined });
    const r = await rig({ store: failingStore(store, failed) });
    const jar = new CookieJar();
    const page = await openAuthorize(
      r.fetch,
      authorizeUrl({ code_challenge: await challenge() }),
      jar,
    );
    const checked = await submitConsent(r.fetch, page.form!, jar, {
      step: "check",
      token: SEVDESK_TOKEN,
    });
    failed.on = true;
    const connected = await submitConsent(r.fetch, checked.form!, jar, { step: "connect" });
    expect(connected.response.status).toBe(503);
    expect(connected.html).toContain("The server is restarting");
    await store.close();
  });
});
