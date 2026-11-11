import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createBrowserSession,
  type InboxLogin,
  SIGN_IN_TARGET,
} from "../../../src/http/browser-session.js";
import { createServerKeys } from "../../../src/http/keys.js";
import { pageContext } from "../../../src/pages/context.js";
import { renderLoginPage } from "../../../src/safety/approval-page.js";
import {
  captureLog,
  contextFactory,
  createMemorySessionStore,
  dispatch,
  fakeClock,
  ORIGIN,
  RemoteBrowser,
} from "../../helpers/remote-approvals.js";

const TOKEN = "a1c3".repeat(8);
const PAGE = pageContext(undefined, ORIGIN);
const UPLOAD_PATH = `/uploads/${"u".repeat(43)}`;
const FILE_PATH = `/files/${"f".repeat(43)}`;
const APPROVAL_PATH = `/approvals/${"a".repeat(43)}`;

function setup(homePath?: string) {
  const clock = fakeClock();
  const log = captureLog();
  const sessions = createMemorySessionStore(clock.now);
  const login: InboxLogin = (token) =>
    Promise.resolve(token === TOKEN ? { accountId: "1001" } : { error: "refused" });
  const session = createBrowserSession({
    sessions,
    keys: createServerKeys(new Uint8Array(randomBytes(32))),
    origin: ORIGIN,
    login,
    now: clock.now,
    homePath,
  });
  const context = contextFactory({ now: clock.now, log });
  const browser = new RemoteBrowser((request) => dispatch(session.routes, request, context()));
  return { session, sessions, log, browser };
}

describe("browser session: sign-in target", () => {
  it.each([UPLOAD_PATH, FILE_PATH, APPROVAL_PATH])(
    "returns to %s after signing in",
    async (next) => {
      const { browser } = setup("/approvals");
      const response = await browser.post("/approvals/login", { token: TOKEN, next });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${ORIGIN}${next}`);
      expect(response.headers.get("set-cookie")).toMatch(/^__Host-sevdesk_session=/);
    },
  );

  it.each([
    "https://evil.example/uploads/x",
    "//evil.example/uploads/aaaaaaaaaaaaaaaaaaaaaaaaaa",
    "/\\evil.example",
    `/uploads/../approvals/${"a".repeat(43)}`,
    "/uploads/short",
    "/approvals/login",
    `/mcp/${"a".repeat(43)}`,
    `${UPLOAD_PATH}?x=1`,
    `${UPLOAD_PATH}\n`,
  ])("ignores the unsafe target %j and goes to the inbox", async (next) => {
    const { browser } = setup("/approvals");
    const response = await browser.post("/approvals/login", { token: TOKEN, next });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/approvals`);
    expect(SIGN_IN_TARGET.test(next)).toBe(false);
  });

  it("shows a Signed in page without the inbox, linking nowhere", async () => {
    const { browser } = setup();
    const response = await browser.post("/approvals/login", { token: TOKEN });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-sevdesk_session=/);
    expect(response.body).toContain("<h1>Signed in</h1>");
    expect(response.body).not.toContain("<a href");
    const out = await browser.post("/approvals/logout", { csrf: "x" });
    expect(out.status).toBe(403);
    expect(out.body).not.toContain("/approvals");
  });

  it("keeps the target on a failed sign-in and never echoes the token", async () => {
    const { browser, log } = setup();
    const wrong = "e5f6".repeat(8);
    const response = await browser.post("/approvals/login", { token: wrong, next: UPLOAD_PATH });
    expect(response.status).toBe(401);
    expect(response.body).toContain(`name="next" value="${UPLOAD_PATH}"`);
    expect(response.body).toContain("Sign in to transfer files");
    expect(response.body).not.toContain(wrong);
    const empty = await browser.post("/approvals/login", { token: " ", next: "//evil" });
    expect(empty.status).toBe(400);
    expect(empty.body).not.toContain('name="next"');
    expect(log.lines.join("\n")).not.toContain(wrong);
  });

  it("signs out without the inbox and clears the cookie", async () => {
    const { browser, session, sessions } = setup();
    await browser.post("/approvals/login", { token: TOKEN });
    const [record] = [...sessions.records.values()];
    if (record === undefined) throw new Error("no session");
    const out = await browser.post("/approvals/logout", { csrf: session.csrfTag(record) });
    expect(out.status).toBe(200);
    expect(out.body).toContain("You are signed out of this server in this browser.");
    expect(out.body).not.toContain("<a href");
    expect(browser.jar.size).toBe(0);
    expect(sessions.records.size).toBe(0);
  });
});

describe("browser session: sign-in page", () => {
  it("carries a valid target and the files wording; drops anything else", async () => {
    const { session } = setup("/approvals");
    const files = await session.loginPage(PAGE, 200, { next: FILE_PATH }).text();
    expect(files).toContain(`<input type="hidden" name="next" value="${FILE_PATH}">`);
    expect(files).toContain("<title>Sign in: sevDesk files</title>");
    expect(files).toContain("To upload or download files for your AI assistant");
    const approval = await session.loginPage(PAGE, 200, { next: APPROVAL_PATH }).text();
    expect(approval).toContain("Sign in to approve sevDesk actions");
    const evil = await session.loginPage(PAGE, 200, { next: "https://evil.example" }).text();
    expect(evil).not.toContain('name="next"');
    expect(evil).toContain("Sign in to approve sevDesk actions");
  });

  it("is the approvals sign-in when neither target nor purpose is given", () => {
    const html = renderLoginPage(
      { formAction: "/approvals/login", host: "mcp.example.com", sessionHours: 12, message: "x" },
      { ...PAGE, nonce: "nonce" },
    );
    expect(html).toContain(
      '<form method="post" action="/approvals/login" class="login">\n<label for="token">',
    );
    expect(html).toContain(
      '<p class="lead">To see and decide approval requests from your AI assistant, sign in with the API token',
    );
    expect(html).toContain("<title>Sign in: sevDesk approvals</title>");
    expect(html).not.toContain('name="next"');
    // The note above the form is announced, and the form asks for the token only.
    expect(html).toContain('role="alert"');
    expect(html.match(/<input\b/g)).toHaveLength(1);
  });

  it("is German for a German browser, with the host to check", () => {
    const german = { ...pageContext("de", ORIGIN), nonce: "nonce" };
    const html = renderLoginPage(
      {
        formAction: "/approvals/login",
        host: "mcp.example.com",
        sessionHours: 12,
        message: undefined,
        purpose: "files",
      },
      german,
    );
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("<title>Anmelden: sevDesk-Dateien</title>");
    expect(html).toContain("Geben Sie Ihr Token nur auf <strong>mcp.example.com</strong> ein.");
    expect(html).toContain("Die Anmeldung gilt 12 Stunden in diesem Browser");
    expect(html).not.toContain('role="alert"');
  });
});
