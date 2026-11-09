import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { RequestPrincipal } from "../../../src/accounts/types.js";
import {
  type ApprovalInbox,
  createApprovalRoutes,
  INBOX_RATE,
  type InboxLogin,
  LOGIN_RATE_HOUR,
  LOGIN_RATE_MINUTE,
} from "../../../src/http/approval-routes.js";
import { createServerKeys, keyedTag, type ServerKeys } from "../../../src/http/keys.js";
import { createHttpLog } from "../../../src/http/log.js";
import { createRateLimiter } from "../../../src/http/rate-limit.js";
import { createRouter } from "../../../src/http/router.js";
import {
  createSessionCookie,
  readSession,
  SESSION_TTL_SECONDS,
} from "../../../src/http/session.js";
import type { HttpRequestContext, HttpRoute, RateRule } from "../../../src/http/types.js";
import { escapeHtml } from "../../../src/safety/approval-page.js";
import { createApprovalStore } from "../../../src/safety/approval-store.js";
import type { ApprovalDecision, ApprovalStore } from "../../../src/safety/approval-types.js";
import {
  type BrowserResponse,
  captureLog,
  contextFactory,
  createMemoryApprovalStore,
  createMemorySessionStore,
  csrfOf,
  dispatch,
  fakeClock,
  inboxLinks,
  ORIGIN,
  RemoteBrowser,
  testBinding,
} from "../../helpers/remote-approvals.js";

const TOKEN_A = "a1c3".repeat(8);
const TOKEN_B = "b2d4".repeat(8);
const WRONG_TOKEN = "e5f6".repeat(8);
const ACCOUNTS: Readonly<Record<string, string>> = { [TOKEN_A]: "1001", [TOKEN_B]: "2002" };
const A1: RequestPrincipal = { grantKey: "grant-a1", accountScope: "1001" };
const A2: RequestPrincipal = { grantKey: "grant-a2", accountScope: "1001" };
const B: RequestPrincipal = { grantKey: "grant-b", accountScope: "2002" };
const secret = new Uint8Array(randomBytes(32));
const LOGIN_FORM = 'action="/approvals/login"';

interface SetupOptions {
  readonly origin?: string;
  readonly keys?: ServerKeys;
  /** Pass a store object instead of the getter the HTTP wiring uses (`() => runtime.approvals`). */
  readonly explicitStore?: boolean;
  readonly login?: InboxLogin;
  readonly accountAllowed?: (accountId: string) => boolean;
}

type MemoryStore = ReturnType<typeof createMemoryApprovalStore>;

function setup(options: SetupOptions = {}) {
  const origin = options.origin ?? ORIGIN;
  const clock = fakeClock();
  const log = captureLog();
  const sessions = createMemorySessionStore(clock.now);
  const keys = options.keys ?? createServerKeys(secret);
  const login = vi.fn<InboxLogin>(
    options.login ??
      ((token) => {
        const accountId = ACCOUNTS[token];
        return Promise.resolve(
          accountId === undefined ? { error: "The token was not accepted." } : { accountId },
        );
      }),
  );
  // Created after the channel, like the safety runtime's store.
  const holder: { store?: MemoryStore } = {};
  const store = (): MemoryStore => {
    if (holder.store === undefined) throw new Error("no store yet");
    return holder.store;
  };
  const inbox = createApprovalRoutes({
    sessions,
    keys,
    origin,
    login,
    now: clock.now,
    accountAllowed: options.accountAllowed,
    approvals:
      options.explicitStore === true
        ? {
            list: (scope) => store().list(scope),
            get: (id) => store().get(id),
            decide: (id, decision) => store().decide(id, decision),
          }
        : () => holder.store,
  });
  const approvals = createMemoryApprovalStore(clock.now, { channel: inbox.channel });
  holder.store = approvals;
  const context = contextFactory({ now: clock.now, log, origin });
  const send = (request: Request, overrides: Partial<HttpRequestContext> = {}) =>
    dispatch(inbox.routes, request, context(overrides));
  const browser = () => new RemoteBrowser((request) => send(request), origin);
  return { clock, log, sessions, keys, login, inbox, approvals, send, browser, origin };
}

async function signedIn(env: ReturnType<typeof setup>, token = TOKEN_A): Promise<RemoteBrowser> {
  const browser = env.browser();
  const response = await browser.signIn(token);
  expect(response.status).toBe(303);
  return browser;
}

/** A sign-in POST as the inbox form sends it. */
function loginRequest(token: string): Request {
  return new Request(`${ORIGIN}/approvals/login`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

/** The page body without the per-response style nonce, to compare two pages. */
function withoutNonce(body: string): string {
  return body.replace(/nonce="[^"]+"/g, 'nonce=""');
}

describe("approval inbox routes", () => {
  it("declares the inbox routes under the form origin policy with 4 KiB bodies", () => {
    const { inbox } = setup();
    const summary = inbox.routes.map((route: HttpRoute) => ({
      path: route.path,
      match: route.match ?? "exact",
      methods: route.methods,
      origin: route.origin,
      maxBodyBytes: route.maxBodyBytes,
    }));
    expect(summary).toEqual([
      { path: "/approvals", match: "exact", methods: ["GET"], origin: "form", maxBodyBytes: 4096 },
      {
        path: "/approvals/login",
        match: "exact",
        methods: ["POST"],
        origin: "form",
        maxBodyBytes: 4096,
      },
      {
        path: "/approvals/logout",
        match: "exact",
        methods: ["POST"],
        origin: "form",
        maxBodyBytes: 4096,
      },
      {
        path: "/approvals/",
        match: "prefix",
        methods: ["GET", "POST"],
        origin: "form",
        maxBodyBytes: 4096,
      },
    ]);
    // One router-level rule for all inbox routes together, per client IP or IPv6 /64.
    expect(inbox.routes.map((route) => route.rateLimit)).toEqual(Array(4).fill(INBOX_RATE));
    expect(INBOX_RATE).toEqual({ name: "approvals", perMinute: 120 });
  });

  it("is a remote channel that names the inbox and opens nothing", async () => {
    const { inbox, approvals } = setup();
    expect(inbox.channel.kind).toBe("remote");
    expect(inbox.channel.inboxUrl).toBe("https://mcp.example.com/approvals");

    const ticket = await approvals.create(A1, testBinding());

    expect(ticket.opened).toBe(false);
    await expect(approvals.close()).resolves.toBeUndefined();
  });

  it("shows only the sign-in form without a session, with no approval data", async () => {
    const env = setup();
    const view = env.approvals.add(A1, {
      preview: {
        action: "Finalize invoice PREVIEW-SECRET-42.",
        facts: [],
        warnings: [],
        irreversible: false,
      },
    });
    const browser = env.browser();

    for (const path of ["/approvals", `/approvals/${view.id}`, "/approvals/not-an-id"]) {
      const page = await browser.get(path);
      expect(page.status).toBe(200);
      expect(page.body).toContain(LOGIN_FORM);
      expect(page.body).toContain('type="password"');
      expect(page.body).toContain("Only enter your token on <strong>mcp.example.com</strong>");
      expect(page.body).not.toContain("PREVIEW-SECRET-42");
      expect(page.body).not.toContain(view.reference);
      expect(page.body).not.toContain(view.id);
      expect(page.body).not.toContain("sevdesk_invoice_finalize");
      expect(page.body).not.toContain('name="csrf"');
      expect(page.body).not.toContain("<script");
      expect(page.headers.get("content-security-policy")).toMatch(
        /^default-src 'none'; style-src 'nonce-[A-Za-z0-9_-]+'; form-action 'self'; frame-ancestors 'none'/,
      );
      expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("cache-control")).toBe("no-store");
    }
    expect(env.login).not.toHaveBeenCalled();
  });

  it("unlocks with the account's token and lists the account's approvals only", async () => {
    const env = setup();
    const a1 = env.approvals.add(A1);
    const a2 = env.approvals.add(A2, {
      toolName: "sevdesk_voucher_book",
      toolTitle: "Book voucher",
    });
    const b = env.approvals.add(B);
    const browser = env.browser();

    const response = await browser.signIn(TOKEN_A);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://mcp.example.com/approvals");
    expect(response.headers.get("set-cookie")).toMatch(
      /^__Host-sevdesk_session=sdmcp_ss_[A-Za-z0-9_-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(env.login).toHaveBeenCalledWith(TOKEN_A, expect.any(AbortSignal));
    expect(env.log.lines).toContain('info approval_login {"account":"1001"}');

    const inbox = await browser.get("/approvals");
    expect(inbox.status).toBe(200);
    expect(inbox.body).toContain("sevDesk account <strong>1001</strong>");
    // Both grants of the account, newest first; never the other account's.
    expect(inboxLinks(inbox.body)).toEqual([`/approvals/${a2.id}`, `/approvals/${a1.id}`]);
    expect(inbox.body).toContain(a1.reference);
    expect(inbox.body).toContain("Book voucher (<code>sevdesk_voucher_book</code>)");
    expect(inbox.body).toContain("Finalize invoice RE-1042.");
    expect(inbox.body).toContain("Waiting for your decision; expires 2026-11-09 12:10 UTC");
    expect(inbox.body).not.toContain(b.id);
    expect(inbox.body).not.toContain(b.reference);
    expect(inbox.body).toContain('action="/approvals/logout"');
    expect(csrfOf(inbox.body)).toBeDefined();
  });

  it("shows an empty inbox when nothing waits", async () => {
    const env = setup();
    const browser = await signedIn(env);
    const inbox = await browser.get("/approvals");
    expect(inbox.body).toContain("No approval requests right now.");
    expect(inboxLinks(inbox.body)).toEqual([]);
  });

  it("unlocks with the cookie set at consent, until the grant is revoked", async () => {
    const env = setup();
    env.approvals.add(A1);
    const browser = env.browser();
    browser.accept(
      await createSessionCookie({
        keys: env.keys,
        store: env.sessions,
        accountId: "1001",
        gid: "grant-a1",
        via: "consent",
        origin: ORIGIN,
        ttlSeconds: SESSION_TTL_SECONDS,
      }),
    );

    expect(inboxLinks((await browser.get("/approvals")).body)).toHaveLength(1);

    env.sessions.revokeGrant("grant-a1");
    const page = await browser.get("/approvals");
    expect(page.body).toContain(LOGIN_FORM);
    expect(inboxLinks(page.body)).toEqual([]);
  });

  it("refuses a wrong token without echoing it or setting a cookie", async () => {
    const env = setup();
    const browser = env.browser();

    const page = await browser.signIn(WRONG_TOKEN);

    expect(page.status).toBe(401);
    expect(page.body).toContain("The token was not accepted.");
    expect(page.body).toContain(LOGIN_FORM);
    expect(page.body).not.toContain(WRONG_TOKEN);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(browser.jar.size).toBe(0);
    expect(env.log.lines).toEqual(["warn approval_login_refused {}"]);
  });

  it("redacts the token from a login error and falls back to a generic text", async () => {
    const echoing = setup({
      login: (token) => Promise.resolve({ error: `Token ${token} belongs to <another> account.` }),
    });
    const page = await echoing.browser().signIn(TOKEN_A);
    expect(page.status).toBe(401);
    expect(page.body).not.toContain(TOKEN_A);
    expect(page.body).toContain("Token [REDACTED] belongs to &lt;another&gt; account.");

    const silent = setup({ login: () => Promise.resolve({ error: "  " }) });
    expect((await silent.browser().signIn(TOKEN_A)).body).toContain("The token was not accepted.");
  });

  it("refuses empty, oversized or spaced tokens without checking them", async () => {
    const env = setup();
    const browser = env.browser();
    for (const token of ["", "   ", "a".repeat(257), "abc def"]) {
      const page = await browser.signIn(token);
      expect(page.status).toBe(400);
      expect(page.body).toContain("Paste the API token of your sevDesk account");
    }
    expect(env.login).not.toHaveBeenCalled();
    // Surrounding whitespace from copying is fine.
    expect((await browser.signIn(`  ${TOKEN_A}\n`)).status).toBe(303);
  });

  it("says to try again when the token cannot be checked, and aborts with the request", async () => {
    const env = setup({
      login: (_token, signal) =>
        signal.aborted ? Promise.reject(new Error("aborted")) : Promise.reject(new Error("down")),
    });
    const controller = new AbortController();
    controller.abort();
    const request = new Request(`${ORIGIN}/approvals/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN_A}`,
    });

    const response = await env.send(request, { signal: controller.signal });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("could not be checked right now");
    expect(env.login.mock.calls[0]?.[1].aborted).toBe(true);
    expect(env.log.lines).toEqual(["warn approval_login_unavailable {}"]);
  });

  it("limits sign-ins per client IP with the minute and the hour rule", async () => {
    const env = setup();
    const browser = env.browser();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await browser.signIn(WRONG_TOKEN)).status).toBe(401);
    }

    const limited = await browser.signIn(TOKEN_A);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.body).toContain("Too many sign-in attempts");
    expect(env.login).toHaveBeenCalledTimes(5);
    expect(env.log.lines.at(-1)).toBe("warn approval_login_limited {}");
    // Another client is not affected; a minute later this one may try again.
    const other = new Request(`${ORIGIN}/approvals/login`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN_A}`,
    });
    expect((await env.send(other, { clientIp: "198.51.100.1" })).status).toBe(303);
    env.clock.advance(60_000);
    expect((await browser.signIn(TOKEN_A)).status).toBe(303);
  });

  it("consults both rate rules keyed by the client IP, and refuses when either is empty", async () => {
    expect(LOGIN_RATE_MINUTE).toEqual({ name: "approvals-login", perMinute: 5 });
    expect(LOGIN_RATE_HOUR).toEqual({
      name: "approvals-login-hour",
      perMinute: 20 / 60,
      burst: 20,
    });
    for (const empty of [LOGIN_RATE_MINUTE.name, LOGIN_RATE_HOUR.name]) {
      const env = setup();
      const calls: string[] = [];
      const limit = (rule: RateRule, key: string): boolean => {
        calls.push(`${rule.name}|${key}`);
        return rule.name !== empty;
      };
      const request = new Request(`${ORIGIN}/approvals/login`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
        body: `token=${TOKEN_A}`,
      });
      const response = await env.send(request, { limit, clientIp: "192.0.2.5" });
      expect(response.status).toBe(429);
      expect(calls[0]).toBe("approvals-login|192.0.2.5");
      expect(env.login).not.toHaveBeenCalled();
    }
  });

  it("creates a new session on every sign-in and ends the one it replaces", async () => {
    const env = setup();
    const browser = await signedIn(env);
    const firstCookie = [...browser.jar][0]?.join("=") ?? "";
    const firstSid = readSession(new Request(ORIGIN, { headers: { Cookie: firstCookie } }), {
      keys: env.keys,
      store: env.sessions,
      origin: ORIGIN,
      now: env.clock.now,
    })?.sid;

    expect((await browser.signIn(TOKEN_A)).status).toBe(303);

    const secondCookie = [...browser.jar][0]?.join("=") ?? "";
    expect(secondCookie).not.toBe(firstCookie);
    expect(firstSid).toBeDefined();
    expect(env.sessions.records.has(firstSid ?? "")).toBe(false);
    expect(env.sessions.records.size).toBe(1);
    const stale = env.browser();
    stale.jar.set("__Host-sevdesk_session", firstCookie.split("=")[1] ?? "");
    expect((await stale.get("/approvals")).body).toContain(LOGIN_FORM);
    expect((await browser.get("/approvals")).body).toContain(
      "sevDesk account <strong>1001</strong>",
    );
  });

  it("shows the escaped preview and decides it once with the session's CSRF tag", async () => {
    const env = setup();
    const view = env.approvals.add(A1, {
      preview: {
        action: 'Finalize <script>alert("x")</script> RE-1',
        facts: [{ label: "Customer", value: "<img src=x onerror=alert(1)> & 'Co'" }],
        warnings: ["<b>bold</b>"],
        irreversible: true,
      },
      notice: "The record <changed>.",
    });
    const browser = await signedIn(env);
    const inbox = await browser.get("/approvals");
    expect(inbox.body).toContain(escapeHtml('Finalize <script>alert("x")</script> RE-1'));

    const page = await browser.get(`/approvals/${view.id}`);

    expect(page.status).toBe(200);
    expect(page.body).not.toContain("<script>");
    expect(page.body).not.toContain("<img");
    expect(page.body).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &#39;Co&#39;");
    expect(page.body).toContain("The record &lt;changed&gt;.");
    expect(page.body).toContain("This cannot be undone.");
    expect(page.body).toContain(`action="/approvals/${view.id}"`);
    expect(page.body).toContain('<a href="/approvals">Back to the inbox</a>');
    const session = [...env.sessions.records.values()][0];
    expect(csrfOf(page.body)).toBe(keyedTag(env.keys.current, "csrf", session?.sid ?? ""));

    const approved = await browser.post(`/approvals/${view.id}`, {
      csrf: csrfOf(page.body) ?? "",
      decision: "approve",
    });

    expect(approved.status).toBe(200);
    expect(approved.body).toContain("You approved this action.");
    expect(env.approvals.decisions).toHaveLength(1);
    expect(env.approvals.decisions[0]).toMatchObject({
      owner: A1,
      binding: { toolName: "sevdesk_invoice_finalize" },
      reference: view.reference,
      decision: "approved",
    });
    expect(env.log.lines).toContain(
      `info approval_decided {"decision":"approved","reference":"${view.reference}"}`,
    );

    const again = await browser.post(`/approvals/${view.id}`, {
      csrf: csrfOf(page.body) ?? "",
      decision: "reject",
    });
    expect(again.status).toBe(409);
    expect(again.body).toContain("You approved this action.");
    expect(env.approvals.decisions).toHaveLength(1);
    const shown = await browser.get(`/approvals/${view.id}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toContain("You approved this action.");
    expect((await browser.get("/approvals")).body).toContain("Approved; expires");
  });

  it("rejects, and refuses anything but approve or reject", async () => {
    const env = setup();
    const view = env.approvals.add(A1);
    const browser = await signedIn(env);
    const csrf = csrfOf((await browser.get(`/approvals/${view.id}`)).body) ?? "";

    const bad = await browser.post(`/approvals/${view.id}`, { csrf, decision: "maybe" });
    expect(bad.status).toBe(400);
    expect(env.approvals.get(view.id)?.status).toBe("pending");

    const rejected = await browser.post(`/approvals/${view.id}`, { csrf, decision: "reject" });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toContain("Nothing was changed in sevDesk.");
    expect(env.approvals.get(view.id)?.status).toBe("rejected");
    const again = await browser.post(`/approvals/${view.id}`, { csrf, decision: "approve" });
    expect(again.status).toBe(409);
    expect(again.body).toContain("You rejected this action.");
  });

  it("refuses decisions without the session's CSRF tag", async () => {
    const env = setup();
    const view = env.approvals.add(A1);
    const browser = await signedIn(env);
    const other = await signedIn(env);
    const otherTag = csrfOf((await other.get("/approvals")).body) ?? "";
    const path = `/approvals/${view.id}`;

    for (const fields of [
      { decision: "approve" },
      { csrf: "forged", decision: "approve" },
      { csrf: otherTag, decision: "approve" },
    ]) {
      const response = await browser.post(path, fields);
      expect(response.status).toBe(403);
      expect(response.body).toContain("could not be verified");
    }
    expect(env.approvals.get(view.id)?.status).toBe("pending");
  });

  it("refuses cross-site, opaque and origin-less cross-site POSTs on every form", async () => {
    const env = setup();
    const view = env.approvals.add(A1);
    const browser = await signedIn(env);
    const csrf = csrfOf((await browser.get(`/approvals/${view.id}`)).body) ?? "";
    const forged: Readonly<Record<string, string | undefined>>[] = [
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { Origin: "http://mcp.example.com" },
      { Origin: undefined, "Sec-Fetch-Site": "cross-site" },
      { Origin: undefined, "Sec-Fetch-Site": undefined },
    ];
    for (const headers of forged) {
      for (const [path, fields] of [
        [`/approvals/${view.id}`, { csrf, decision: "approve" }],
        ["/approvals/login", { token: TOKEN_A }],
        ["/approvals/logout", { csrf }],
      ] as const) {
        const response = await browser.post(path, fields, headers);
        expect(response.status).toBe(403);
        expect(response.body).toContain("did not come from this server");
      }
    }
    expect(env.approvals.get(view.id)?.status).toBe("pending");
    expect(env.login).toHaveBeenCalledTimes(1);
    expect(env.sessions.records.size).toBe(1);

    // A browser that sends no Origin but marks the request same-origin is accepted.
    const accepted = await browser.post(
      `/approvals/${view.id}`,
      { csrf, decision: "approve" },
      { Origin: undefined, "Sec-Fetch-Site": "same-origin" },
    );
    expect(accepted.status).toBe(200);
  });

  it("never shows or decides another account's approval, and answers as for an unknown id", async () => {
    const env = setup();
    const ofB = env.approvals.add(B, {
      preview: {
        action: "Send invoice B-SECRET by email.",
        facts: [],
        warnings: [],
        irreversible: false,
      },
    });
    const browser = await signedIn(env, TOKEN_A);
    const csrf = csrfOf((await browser.get("/approvals")).body) ?? "";
    const unknownId = randomBytes(32).toString("base64url");

    const foreign = await browser.get(`/approvals/${ofB.id}`);
    const unknown = await browser.get(`/approvals/${unknownId}`);
    expect(foreign.status).toBe(404);
    expect(withoutNonce(foreign.body)).toBe(withoutNonce(unknown.body));
    expect(foreign.body).not.toContain("B-SECRET");

    const decided = await browser.post(`/approvals/${ofB.id}`, { csrf, decision: "approve" });
    const decidedUnknown = await browser.post(`/approvals/${unknownId}`, {
      csrf,
      decision: "approve",
    });
    expect(decided.status).toBe(404);
    expect(withoutNonce(decided.body)).toBe(withoutNonce(decidedUnknown.body));
    expect(env.approvals.get(ofB.id)?.status).toBe("pending");
    expect(env.approvals.decisions).toEqual([]);

    // B sees and decides its own.
    const ownerB = await signedIn(env, TOKEN_B);
    expect(inboxLinks((await ownerB.get("/approvals")).body)).toEqual([`/approvals/${ofB.id}`]);
    expect((await ownerB.decide(`/approvals/${ofB.id}`, "approve")).status).toBe(200);
  });

  it("treats malformed ids as unknown", async () => {
    const env = setup();
    const browser = await signedIn(env);
    const csrf = csrfOf((await browser.get("/approvals")).body) ?? "";
    expect((await browser.get("/approvals/short")).status).toBe(404);
    expect((await browser.get("/approvals/a/b")).status).toBe(404);
    expect((await browser.post("/approvals/short", { csrf, decision: "approve" })).status).toBe(
      404,
    );
  });

  it("answers 404 after expiry and 410 when the approval expires while deciding", async () => {
    const env = setup({ explicitStore: true });
    const view = env.approvals.add(A1);
    const browser = await signedIn(env);
    const csrf = csrfOf((await browser.get(`/approvals/${view.id}`)).body) ?? "";

    const decide = vi.spyOn(env.approvals, "decide").mockReturnValueOnce("expired");
    const expired = await browser.post(`/approvals/${view.id}`, { csrf, decision: "approve" });
    expect(expired.status).toBe(410);
    expect(expired.body).toContain("no longer valid");
    decide.mockReturnValueOnce("unknown");
    expect(
      (await browser.post(`/approvals/${view.id}`, { csrf, decision: "approve" })).status,
    ).toBe(410);
    decide.mockRestore();

    env.clock.advance(10 * 60 * 1000);
    expect((await browser.get(`/approvals/${view.id}`)).status).toBe(404);
    expect(
      (await browser.post(`/approvals/${view.id}`, { csrf, decision: "approve" })).status,
    ).toBe(404);
    expect((await browser.get("/approvals")).body).toContain("No approval requests right now.");
  });

  it("answers 409 with a neutral text when an already decided approval is gone", async () => {
    const env = setup({ explicitStore: true });
    const view = env.approvals.add(A1);
    const browser = await signedIn(env);
    const csrf = csrfOf((await browser.get(`/approvals/${view.id}`)).body) ?? "";
    vi.spyOn(env.approvals, "decide").mockImplementationOnce((id) => {
      env.approvals.take(A1, id);
      return "already_decided";
    });

    const response = await browser.post(`/approvals/${view.id}`, { csrf, decision: "approve" });

    expect(response.status).toBe(409);
    expect(response.body).toContain("Approval not found");
  });

  it("asks to sign in again when deciding without a session", async () => {
    const env = setup();
    const view = env.approvals.add(A1);
    const browser = await signedIn(env);
    const csrf = csrfOf((await browser.get(`/approvals/${view.id}`)).body) ?? "";
    browser.jar.clear();

    const response = await browser.post(`/approvals/${view.id}`, { csrf, decision: "approve" });

    expect(response.status).toBe(403);
    expect(response.body).toContain("Your sign-in has ended.");
    expect(env.approvals.get(view.id)?.status).toBe("pending");
  });

  it("refuses tampered and expired session cookies", async () => {
    const env = setup();
    env.approvals.add(A1);
    const browser = await signedIn(env);
    const name = "__Host-sevdesk_session";
    const value = browser.jar.get(name) ?? "";

    browser.jar.set(
      name,
      `${value.slice(0, 20)}${value[20] === "A" ? "B" : "A"}${value.slice(21)}`,
    );
    expect((await browser.get("/approvals")).body).toContain(LOGIN_FORM);

    browser.jar.set(name, value);
    expect((await browser.get("/approvals")).body).not.toContain(LOGIN_FORM);
    env.clock.advance(SESSION_TTL_SECONDS * 1000);
    expect((await browser.get("/approvals")).body).toContain(LOGIN_FORM);
  });

  it("signs out: revokes the session and clears the cookie", async () => {
    const env = setup();
    const browser = await signedIn(env);
    const cookie = browser.jar.get("__Host-sevdesk_session") ?? "";
    const csrf = csrfOf((await browser.get("/approvals")).body) ?? "";

    const refused = await browser.post("/approvals/logout", { csrf: "wrong" });
    expect(refused.status).toBe(403);
    expect(env.sessions.records.size).toBe(1);

    const out = await browser.post("/approvals/logout", { csrf });

    expect(out.status).toBe(200);
    expect(out.body).toContain("You are signed out");
    expect(out.headers.get("set-cookie")).toBe(
      "__Host-sevdesk_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    );
    expect(browser.jar.size).toBe(0);
    expect(env.sessions.records.size).toBe(0);
    expect(env.log.lines).toContain("info approval_logout {}");
    const replay = env.browser();
    replay.jar.set("__Host-sevdesk_session", cookie);
    expect((await replay.get("/approvals")).body).toContain(LOGIN_FORM);
    // Signing out without a session just clears the cookie.
    expect((await env.browser().post("/approvals/logout", {})).status).toBe(200);
  });

  it("reads forms of at most 4 KiB, url-encoded only", async () => {
    const env = setup();
    const view = env.approvals.add(A1);
    const browser = await signedIn(env);
    const csrf = csrfOf((await browser.get("/approvals")).body) ?? "";
    const path = `/approvals/${view.id}`;

    const large = await browser.post(path, { csrf, decision: "approve", pad: "x".repeat(5000) });
    expect(large.status).toBe(413);
    const json = await browser.post(
      path,
      { csrf, decision: "approve" },
      { "Content-Type": "application/json" },
    );
    expect(json.status).toBe(400);
    expect((await browser.post("/approvals/login", { token: "x".repeat(5000) })).status).toBe(413);
    expect(
      (await browser.post("/approvals/logout", { csrf }, { "Content-Type": "text/plain" })).status,
    ).toBe(400);
    expect(env.approvals.get(view.id)?.status).toBe("pending");
  });

  it("keeps the sevDesk token, cookies and sealed tokens out of pages, redirects and logs", async () => {
    const env = setup();
    const view = env.approvals.add(A1);
    const browser = env.browser();
    await browser.signIn(WRONG_TOKEN);
    await browser.signIn(TOKEN_A);
    await browser.get("/approvals");
    await browser.decide(`/approvals/${view.id}`, "approve");
    await browser.post("/approvals/logout", {
      csrf: csrfOf((await browser.get("/approvals")).body) ?? "",
    });

    const visible = browser.responses.flatMap((response: BrowserResponse) => [
      response.body,
      response.headers.get("location") ?? "",
    ]);
    const everything = [...visible, ...env.log.lines].join("\n");
    for (const secretText of [TOKEN_A, WRONG_TOKEN, "sdmcp_"]) {
      expect(everything).not.toContain(secretText);
    }
    const cookies = browser.responses.map((response) => response.headers.get("set-cookie") ?? "");
    expect(cookies.filter((cookie) => cookie.includes("sdmcp_ss_"))).toHaveLength(1);
  });

  it("works on a plain-http loopback origin with the unprefixed, port-named cookie", async () => {
    const origin = "http://127.0.0.1:8080";
    const env = setup({ origin });
    const view = env.approvals.add(A1);
    const browser = env.browser();

    const login = await browser.get("/approvals");
    expect(login.body).toContain("Only enter your token on <strong>127.0.0.1:8080</strong>");
    const response = await browser.signIn(TOKEN_A);

    expect(response.headers.get("location")).toBe("http://127.0.0.1:8080/approvals");
    expect(response.headers.get("set-cookie")).toMatch(
      /^sevdesk_session_8080=sdmcp_ss_[A-Za-z0-9_-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/,
    );
    expect(env.inbox.channel.inboxUrl).toBe("http://127.0.0.1:8080/approvals");
    expect((await browser.decide(`/approvals/${view.id}`, "approve")).status).toBe(200);
  });

  it("accepts the previous key's cookie and CSRF tag during a secret rotation", async () => {
    const old = new Uint8Array(randomBytes(32));
    const env = setup({ keys: createServerKeys(old) });
    const view = env.approvals.add(A1);
    const browser = await signedIn(env);
    const csrf = csrfOf((await browser.get(`/approvals/${view.id}`)).body) ?? "";
    const rotated = createApprovalRoutes({
      approvals: env.approvals,
      sessions: env.sessions,
      keys: createServerKeys(secret, old),
      origin: ORIGIN,
      login: env.login,
      now: env.clock.now,
    });
    const context = contextFactory({ now: env.clock.now });
    const after = new RemoteBrowser((request) => dispatch(rotated.routes, request, context()));
    for (const [name, value] of browser.jar) after.jar.set(name, value);

    const response = await after.post(`/approvals/${view.id}`, { csrf, decision: "approve" });

    expect(response.status).toBe(200);
    expect(env.approvals.get(view.id)?.status).toBe("approved");
  });

  it("answers sign-in and sign-out on the prefix route as well", async () => {
    const env = setup();
    const prefix = env.inbox.routes.find((route) => route.match === "prefix");
    const context = contextFactory({ now: env.clock.now });
    const browser = new RemoteBrowser(async (request) => {
      const response = await prefix?.handle(request, context());
      return response ?? new Response("none", { status: 404 });
    });

    expect((await browser.signIn(TOKEN_A)).status).toBe(303);
    const get = await browser.get("/approvals/login");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await browser.post("/approvals/logout", { csrf: "x" })).status).toBe(403);
  });

  it("answers 503 while the store getter has no store yet, then serves it", async () => {
    const clock = fakeClock();
    const sessions = createMemorySessionStore(clock.now);
    const keys = createServerKeys(secret);
    const holder: { store?: ApprovalInbox } = {};
    const inbox = createApprovalRoutes({
      approvals: () => holder.store,
      sessions,
      keys,
      origin: ORIGIN,
      login: () => Promise.resolve({ accountId: "1001" }),
      now: clock.now,
    });
    const context = contextFactory({ now: clock.now });
    const browser = new RemoteBrowser((request) => dispatch(inbox.routes, request, context()));
    await browser.signIn(TOKEN_A);
    const id = randomBytes(32).toString("base64url");
    const tag = keyedTag(keys.current, "csrf", [...sessions.records.keys()][0] ?? "");

    expect((await browser.get("/approvals")).status).toBe(503);
    expect((await browser.get(`/approvals/${id}`)).status).toBe(503);
    expect(
      (await browser.post(`/approvals/${id}`, { csrf: tag, decision: "approve" })).status,
    ).toBe(503);

    const store = createMemoryApprovalStore(clock.now, { channel: inbox.channel });
    holder.store = store;
    const view = store.add(A1);
    expect(inboxLinks((await browser.get("/approvals")).body)).toEqual([`/approvals/${view.id}`]);
  });

  it("keeps nothing from attach and presents without opening a page", async () => {
    const env = setup({ explicitStore: true });
    const view = env.approvals.add(A1);
    env.inbox.channel.attach({ get: () => undefined, decide: () => "unknown" });
    const browser = await signedIn(env);
    expect(inboxLinks((await browser.get("/approvals")).body)).toEqual([`/approvals/${view.id}`]);
    await expect(env.inbox.channel.present(view)).resolves.toEqual({ opened: false });
    await expect(env.inbox.channel.close()).resolves.toBeUndefined();
  });
  it("serves the safety runtime's approval store, created after the channel", async () => {
    const clock = fakeClock();
    const sessions = createMemorySessionStore(clock.now);
    const keys = createServerKeys(secret);
    const holder: { store?: ApprovalStore } = {};
    const inbox = createApprovalRoutes({
      approvals: () => holder.store,
      sessions,
      keys,
      origin: ORIGIN,
      login: (token) =>
        Promise.resolve(token === TOKEN_A ? { accountId: "1001" } : { error: "No." }),
      now: clock.now,
    });
    const decisions: ApprovalDecision[] = [];
    const store = createApprovalStore({
      channel: inbox.channel,
      now: clock.now,
      onDecision: (decision) => decisions.push(decision),
    });
    holder.store = store;
    const ticket = await store.create(A1, testBinding());
    await store.create(B, testBinding());
    const context = contextFactory({ now: clock.now });
    const browser = new RemoteBrowser((request) => dispatch(inbox.routes, request, context()));
    await browser.signIn(TOKEN_A);

    expect(ticket.opened).toBe(false);
    expect(inboxLinks((await browser.get("/approvals")).body)).toEqual([`/approvals/${ticket.id}`]);
    expect((await browser.decide(`/approvals/${ticket.id}`, "approve")).status).toBe(200);

    expect(decisions.map((decision) => decision.decision)).toEqual(["approved"]);
    expect(store.take(A1, ticket.id)?.status).toBe("approved");
    await store.close();
  });

  it("keys the sign-in limits by the IPv6 /64 and the IPv4 address", async () => {
    const env = setup();
    const signIn = (clientIp: string) => env.send(loginRequest(WRONG_TOKEN), { clientIp });

    for (let host = 1; host <= 5; host += 1) {
      expect((await signIn(`2001:db8:1:2::${String(host)}`)).status).toBe(401);
    }
    expect((await signIn("2001:db8:1:2:ffff:ffff:ffff:ffff")).status).toBe(429);
    expect((await signIn("2001:db8:1:3::1")).status).toBe(401);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signIn("192.0.2.10")).status).toBe(401);
    }
    expect((await signIn("192.0.2.10")).status).toBe(429);
    expect((await signIn("192.0.2.11")).status).toBe(401);
    expect(env.login).toHaveBeenCalledTimes(12);
  });

  it("is rate-limited by the router per IPv6 /64, sign-ins and page loads alike", async () => {
    const env = setup();
    const router = createRouter({
      http: { allowedHosts: ["mcp.example.com"], allowedOrigins: [ORIGIN], trustProxy: 0 },
      origin: ORIGIN,
      routes: env.inbox.routes,
      log: createHttpLog({ write: () => undefined }),
      limiter: createRateLimiter({ now: env.clock.now }),
      now: env.clock.now,
    });
    let address = 0;
    // Every request from another address of the same /64.
    const browser = new RemoteBrowser((request) => {
      address += 1;
      const headers = new Headers(request.headers);
      headers.set("host", "mcp.example.com");
      return router.fetch(
        new Request(request, { headers }),
        `2001:db8:5:6::${address.toString(16)}`,
      );
    });

    const signIns: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      signIns.push((await browser.signIn(WRONG_TOKEN)).status);
    }
    expect(signIns).toEqual([401, 401, 401, 401, 401, 429]);
    expect(env.login).toHaveBeenCalledTimes(5);

    // 120 requests a minute to the inbox routes together: 6 went to the sign-ins.
    const pages: number[] = [];
    for (let load = 0; load < 115; load += 1) {
      pages.push((await browser.get("/approvals")).status);
    }
    expect(pages.slice(0, 114).every((status) => status === 200)).toBe(true);
    const limited = browser.responses.at(-1);
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBeTruthy();
  });

  it("treats a session of an account that is no longer allowed as signed out, and revokes it", async () => {
    const allowedAccounts = new Set(["1001", "2002"]);
    const env = setup({ accountAllowed: (id) => allowedAccounts.has(id) });
    const ofB = env.approvals.add(B);
    const a = await signedIn(env, TOKEN_A);
    const b = await signedIn(env, TOKEN_B);
    const consent = env.browser();
    consent.accept(
      await createSessionCookie({
        keys: env.keys,
        store: env.sessions,
        accountId: "2002",
        gid: "grant-b",
        via: "consent",
        origin: ORIGIN,
        ttlSeconds: SESSION_TTL_SECONDS,
      }),
    );
    const csrf = csrfOf((await b.get("/approvals")).body) ?? "";
    expect(inboxLinks((await consent.get("/approvals")).body)).toEqual([`/approvals/${ofB.id}`]);
    expect(env.sessions.records.size).toBe(3);

    // The operator removes account 2002 from the allowlist (and restarts).
    allowedAccounts.delete("2002");

    const decided = await b.post(`/approvals/${ofB.id}`, { csrf, decision: "approve" });
    expect(decided.status).toBe(403);
    expect(decided.body).toContain("Your sign-in has ended.");
    expect(env.approvals.get(ofB.id)?.status).toBe("pending");
    expect((await b.get("/approvals")).body).toContain(LOGIN_FORM);
    const consentPage = await consent.get(`/approvals/${ofB.id}`);
    expect(consentPage.body).toContain(LOGIN_FORM);
    expect(consentPage.body).not.toContain(ofB.reference);
    expect(env.sessions.records.size).toBe(1);
    expect(env.log.lines).toContain('warn approval_session_refused {"account":"2002"}');
    expect((await a.get("/approvals")).body).toContain("sevDesk account <strong>1001</strong>");

    // Signing in again is refused before a session exists.
    const again = await b.signIn(TOKEN_B);
    expect(again.status).toBe(401);
    expect(again.body).toContain(
      "This server is not set up for the sevDesk account of this token.",
    );
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(env.sessions.records.size).toBe(1);
    expect(env.log.lines).toContain('warn approval_login_refused {"account":"2002"}');
  });
});
