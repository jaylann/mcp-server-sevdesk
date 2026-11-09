/**
 * The local approval page (`approval-local.ts`) on a real 127.0.0.1 socket, through the approval
 * store, as the stdio write flow uses it. The page's behaviour and output are those of the M3
 * approval server (moved here unchanged in M5).
 */
import { Server } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestPrincipal } from "../../../src/accounts/types.js";
import {
  createLocalApprovalChannel,
  type LocalApprovalChannelOptions,
} from "../../../src/safety/approval-local.js";
import { escapeHtml } from "../../../src/safety/approval-page.js";
import { createApprovalStore } from "../../../src/safety/approval-store.js";
import type {
  ApprovalBinding,
  ApprovalDecision,
  ApprovalStore,
  ApprovalTicket,
} from "../../../src/safety/approval-types.js";
import {
  browserOrigin,
  decideInBrowser,
  effectiveReferrerPolicy,
  openApproval,
  send,
  submitDecision,
} from "../../helpers/approval-browser.js";

const STDIO: RequestPrincipal = { grantKey: "stdio", accountScope: "local" };
const TOOL = "sevdesk_invoice_finalize";
const ARGS = "a".repeat(64);
const PAGE_URL = /http:\/\/127\.0\.0\.1:\d+\/approve\/[A-Za-z0-9_-]{43}/;

const stores: ApprovalStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

interface Harness {
  readonly approvals: ApprovalStore;
  /** Lines the channel logged. */
  readonly lines: string[];
  /** The page URL of `ticket`, as the log names it. */
  readonly url: (ticket: ApprovalTicket) => string;
  readonly current: (argsHash?: string) => ApprovalTicket | undefined;
}

function harness(
  options: {
    readonly channel?: LocalApprovalChannelOptions;
    readonly now?: () => number;
    readonly maxApprovals?: number;
    readonly maxPending?: number;
    readonly onDecision?: (decision: ApprovalDecision) => void;
  } = {},
): Harness {
  const lines: string[] = [];
  const channel = createLocalApprovalChannel({
    log: (line) => lines.push(line),
    ...options.channel,
  });
  const { channel: _channel, ...storeOptions } = options;
  const approvals = createApprovalStore({ channel, ...storeOptions });
  stores.push(approvals);
  return {
    approvals,
    lines,
    url: (ticket) => {
      const line = lines.find((candidate) => candidate.includes(`/approve/${ticket.id} `));
      const url = PAGE_URL.exec(line ?? "")?.[0];
      if (url === undefined) throw new Error("no page was logged for this approval");
      return url;
    },
    current: (argsHash = ARGS) => approvals.current(STDIO, TOOL, argsHash),
  };
}

function binding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    toolName: TOOL,
    toolTitle: "Finalize invoice",
    tier: "commit",
    tierText: "legally binding bookkeeping",
    argsHash: ARGS,
    previewHash: "p".repeat(64),
    preview: {
      action: "Finalize invoice RE-1042.",
      facts: [{ label: "Customer", value: "Muster GmbH" }],
      warnings: ["The invoice becomes legally binding."],
      irreversible: false,
    },
    callId: "call-1",
    ...overrides,
  };
}

describe("local approval page", () => {
  it("is a local channel without an inbox", () => {
    const channel = createLocalApprovalChannel();

    expect(channel.kind).toBe("local");
    expect(channel.inboxUrl).toBeUndefined();
  });

  it("starts lazily on 127.0.0.1 with an ephemeral port and a 256-bit id in the URL", async () => {
    const { approvals, url, current } = harness();
    expect(current()).toBeUndefined();

    const ticket = await approvals.create(STDIO, binding());

    const page = new URL(url(ticket));
    expect(page.hostname).toBe("127.0.0.1");
    expect(Number(page.port)).toBeGreaterThan(0);
    expect(page.pathname).toBe(`/approve/${ticket.id}`);
    expect(ticket.id).toHaveLength(43);
    expect(ticket.status).toBe("pending");
    expect(ticket.callId).toBe("call-1");
  });

  it("reuses one server for every approval; a replaced approval's page is gone", async () => {
    const { approvals, url, current } = harness();
    const first = await approvals.create(STDIO, binding());
    const other = await approvals.create(STDIO, binding({ argsHash: "b".repeat(64) }));
    const replaced = await approvals.create(STDIO, binding({ previewHash: "q".repeat(64) }));

    expect(new URL(url(other)).port).toBe(new URL(url(first)).port);
    expect(replaced.id).not.toBe(first.id);
    expect(current()?.id).toBe(replaced.id);
    expect((await send(url(first))).status).toBe(404);
  });

  it("shows the preview HTML-escaped under a strict CSP and sets a SameSite=Strict cookie", async () => {
    const { approvals, url } = harness();
    const ticket = await approvals.create(
      STDIO,
      binding({
        preview: {
          action: 'Finalize <script>alert("x")</script> RE-1',
          facts: [{ label: "Customer", value: "<img src=x onerror=alert(1)> & 'Co'" }],
          warnings: ["<b>bold</b>"],
          irreversible: true,
        },
        notice: "The record <changed>.",
      }),
    );

    const { page, csrf, cookie } = await openApproval(url(ticket));

    expect(page.status).toBe(200);
    expect(page.body).not.toContain("<script>");
    expect(page.body).not.toContain("<img");
    expect(page.body).not.toContain("<b>bold");
    expect(page.body).toContain(escapeHtml('Finalize <script>alert("x")</script> RE-1'));
    expect(page.body).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &#39;Co&#39;");
    expect(page.body).toContain("The record &lt;changed&gt;.");
    expect(page.body).toContain("This cannot be undone.");
    expect(page.body).toContain(TOOL);
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toMatch(
      /^default-src 'none'; style-src 'nonce-[A-Za-z0-9_-]+'; form-action 'self'/,
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.body).toContain(`<style nonce="${/'nonce-([^']+)'/.exec(csp)?.[1] ?? ""}">`);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-store, no-transform");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(page.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(page.body).toContain(`<meta name="referrer" content="same-origin">`);
    expect(page.body).not.toContain("inbox");
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatch(/^sevdesk_approval=[A-Za-z0-9_-]{43}$/);
    expect(cookie?.split("=")[1]).not.toBe(csrf);
    const setCookie = String(page.headers["set-cookie"]);
    expect(setCookie).toBe(
      `${cookie ?? ""}; Path=/approve/${ticket.id}; HttpOnly; SameSite=Strict; Max-Age=600`,
    );
    expect(page.body).not.toContain("<script");
  });

  it("records an approval made with the page's token, cookie and origin", async () => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());

    const decided = await decideInBrowser(url(ticket), "approve");

    expect(decided.status).toBe(200);
    expect(decided.body).toContain("You approved this action");
    expect(current()?.status).toBe("approved");
    // Reloading shows the decision, without a form.
    const reloaded = await openApproval(url(ticket));
    expect(reloaded.csrf).toBeUndefined();
    expect(reloaded.page.body).toContain("You approved this action");
  });

  it("records a rejection", async () => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());

    const decided = await decideInBrowser(url(ticket), "reject");

    expect(decided.body).toContain("Nothing was changed in sevDesk");
    expect(current()?.status).toBe("rejected");
    expect((await openApproval(url(ticket))).page.body).toContain("You rejected this action");
  });

  it("lets a decision be made only once", async () => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());
    const opened = await openApproval(url(ticket));

    expect((await submitDecision(url(ticket), "reject", opened)).status).toBe(200);
    const second = await submitDecision(url(ticket), "approve", opened);

    expect(second.status).toBe(409);
    expect(second.body).toContain("You rejected this action");
    expect(current()?.status).toBe("rejected");
  });

  it("hands a decided approval out once (take) and forgets it", async () => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());
    await decideInBrowser(url(ticket), "approve");

    expect(approvals.take(STDIO, ticket.id)?.status).toBe("approved");
    expect(approvals.take(STDIO, ticket.id)).toBeUndefined();
    expect(current()).toBeUndefined();
    expect((await send(url(ticket))).status).toBe(404);
  });

  /** A store on a channel whose view of the store a test can replace (`attach`). */
  async function rewired() {
    const lines: string[] = [];
    const channel = createLocalApprovalChannel({ log: (line) => lines.push(line) });
    const approvals = createApprovalStore({ channel });
    stores.push(approvals);
    const ticket = await approvals.create(STDIO, binding());
    const page = PAGE_URL.exec(lines[0] ?? "")?.[0] ?? "";
    return { channel, approvals, ticket, page };
  }

  it("answers 410 when the approval was taken or expired while the form was read", async () => {
    const { channel, approvals, page } = await rewired();
    const opened = await openApproval(page);
    // The record vanishes between the request's first lookup and the decision.
    let lookups = 0;
    channel.attach({
      get: (id) => (lookups++ === 0 ? approvals.get(id) : undefined),
      decide: (id, decision) => approvals.decide(id, decision),
    });

    const decided = await submitDecision(page, "approve", opened);

    expect(decided.status).toBe(410);
    expect(decided.body).toContain("no longer valid");
  });

  it.each([
    ["expired", 410],
    ["unknown", 410],
    ["already_decided", 409],
  ] as const)("answers a %s outcome of the store with %i", async (outcome, status) => {
    const { channel, approvals, page } = await rewired();
    const opened = await openApproval(page);
    let decided = false;
    channel.attach({
      get: (id) => {
        const view = approvals.get(id);
        return view === undefined || !decided ? view : { ...view, status: "rejected" };
      },
      decide: () => {
        decided = true;
        return outcome;
      },
    });

    const response = await submitDecision(page, "approve", opened);

    expect(response.status).toBe(status);
    expect(response.body).toContain(
      status === 409 ? "You rejected this action" : "no longer valid",
    );
  });

  it.each([
    ["a wrong Host (DNS rebinding)", { Host: "evil.example:80" }],
    ["localhost instead of 127.0.0.1", { Host: "localhost" }],
  ])("refuses a page request with %s", async (_label, headers) => {
    const { approvals, url } = harness();
    const ticket = await approvals.create(STDIO, binding());

    const page = await send(url(ticket), { headers });

    expect(page.status).toBe(421);
    expect(page.body).not.toContain("csrf");
  });

  it.each([
    ["a foreign Origin", { Origin: "http://evil.example" }],
    ["an empty Origin", { Origin: "" }],
    ["Origin: null, even from the same site", { Origin: "null" }],
    ["no Origin and no Sec-Fetch-Site", { Origin: undefined, "Sec-Fetch-Site": undefined }],
    ["no Origin and a cross-site fetch", { Origin: undefined, "Sec-Fetch-Site": "cross-site" }],
    ["a wrong Host", { Host: "evil.example" }],
    ["a wrong CSRF token", { csrfOverride: "x".repeat(43) }],
    ["no cookie", { Cookie: "" }],
    ["a wrong cookie", { Cookie: `sevdesk_approval=${"y".repeat(43)}` }],
    ["the CSRF token as cookie", { cookieFromCsrf: "1" }],
  ])("refuses a decision with %s and keeps the approval pending", async (_label, override) => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());
    const opened = await openApproval(url(ticket));
    const { csrfOverride, cookieFromCsrf, ...headers } = override as Record<
      string,
      string | undefined
    >;

    const decided = await submitDecision(
      url(ticket),
      "approve",
      csrfOverride === undefined ? opened : { ...opened, csrf: csrfOverride },
      cookieFromCsrf === undefined
        ? headers
        : { ...headers, Cookie: `sevdesk_approval=${opened.csrf ?? ""}` },
    );

    expect([403, 421]).toContain(decided.status);
    expect(current()?.status).toBe("pending");
  });

  it("does not accept one approval's token and cookie for another", async () => {
    const { approvals, url, current } = harness();
    const first = await approvals.create(STDIO, binding());
    const second = await approvals.create(STDIO, binding({ argsHash: "b".repeat(64) }));
    const openedFirst = await openApproval(url(first));

    const decided = await submitDecision(url(second), "approve", openedFirst);

    expect(decided.status).toBe(403);
    expect(current("b".repeat(64))?.status).toBe("pending");
  });

  it("accepts a same-origin POST without Origin when the browser marks it Sec-Fetch-Site: same-origin", async () => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());

    const decided = await submitDecision(url(ticket), "approve", await openApproval(url(ticket)), {
      Origin: undefined,
    });

    expect(decided.status).toBe(200);
    expect(current()?.status).toBe("approved");
  });

  it("derives the browser Origin from the page's referrer policy (no-referrer would fail)", async () => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());
    const opened = await openApproval(url(ticket));

    expect(opened.referrerPolicy).toBe("same-origin");
    expect(browserOrigin("same-origin", "http://127.0.0.1:1")).toBe("http://127.0.0.1:1");
    expect(browserOrigin("no-referrer", "http://127.0.0.1:1")).toBe("null");
    // A page under no-referrer would make the browser send Origin: null, which is refused.
    const underNoReferrer = await submitDecision(url(ticket), "approve", {
      ...opened,
      referrerPolicy: "no-referrer",
    });
    expect(underNoReferrer.status).toBe(403);
    expect(current()?.status).toBe("pending");
  });

  it("reads the referrer policy like a browser: the meta tag wins over the header", () => {
    const page = (body: string, header?: string) => ({
      status: 200,
      headers: header === undefined ? {} : { "referrer-policy": header },
      body,
    });

    expect(
      effectiveReferrerPolicy(page(`<meta name="referrer" content="no-referrer">`, "same-origin")),
    ).toBe("no-referrer");
    expect(effectiveReferrerPolicy(page("", "same-origin"))).toBe("same-origin");
    expect(effectiveReferrerPolicy(page(""))).toBe("strict-origin-when-cross-origin");
  });

  it("refuses a decision that is neither approve nor reject", async () => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());

    const decided = await submitDecision(url(ticket), "maybe", await openApproval(url(ticket)));

    expect(decided.status).toBe(400);
    expect(current()?.status).toBe("pending");
  });

  it("refuses non-form bodies and oversized bodies", async () => {
    const { approvals, url, current } = harness();
    const ticket = await approvals.create(STDIO, binding());
    const opened = await openApproval(url(ticket));

    const json = await submitDecision(url(ticket), "approve", opened, {
      "Content-Type": "application/json",
    });
    expect(json.status).toBe(400);

    const huge = await send(url(ticket), {
      method: "POST",
      headers: {
        Origin: new URL(url(ticket)).origin,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: opened.cookie ?? "",
      },
      body: `csrf=${opened.csrf ?? ""}&decision=approve&pad=${"z".repeat(10_000)}`,
    }).catch(() => ({ status: 400 }));
    expect(huge.status).toBe(400);
    expect(current()?.status).toBe("pending");
  });

  it("answers 404 for other paths and unknown ids, 405 for other methods", async () => {
    const { approvals, url } = harness();
    const ticket = await approvals.create(STDIO, binding());
    const origin = new URL(url(ticket)).origin;

    expect((await send(`${origin}/`)).status).toBe(404);
    expect((await send(`${origin}/approve/short`)).status).toBe(404);
    expect((await send(`${origin}/approve/${"A".repeat(43)}`)).status).toBe(404);
    const put = await send(url(ticket), { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers["allow"]).toBe("GET, POST");
  });

  it("expires approvals after their lifetime (10 minutes by default)", async () => {
    let now = 1_000_000;
    const { approvals, url, current } = harness({ now: () => now });
    const ticket = await approvals.create(STDIO, binding());
    expect(Date.parse(ticket.expiresAt)).toBe(1_000_000 + 600_000);

    now += 600_000;

    expect(current()).toBeUndefined();
    expect((await send(url(ticket))).status).toBe(404);
    expect(approvals.take(STDIO, ticket.id)).toBeUndefined();
  });

  it("refuses a decision that arrives after the approval expired", async () => {
    let now = 1_000_000;
    const { approvals, url } = harness({ now: () => now });
    const ticket = await approvals.create(STDIO, binding());
    const opened = await openApproval(url(ticket));

    now += 600_001;
    const decided = await submitDecision(url(ticket), "approve", opened);

    expect(decided.status).toBe(404);
  });

  it("closes the server with the store; closing twice or unstarted is fine", async () => {
    const lines: string[] = [];
    const approvals = createApprovalStore({
      channel: createLocalApprovalChannel({ log: (line) => lines.push(line) }),
    });
    await approvals.close();
    await approvals.create(STDIO, binding());
    const page = PAGE_URL.exec(lines[0] ?? "")?.[0] ?? "";

    await approvals.close();
    await approvals.close();

    expect(approvals.current(STDIO, TOOL, ARGS)).toBeUndefined();
    await expect(send(page)).rejects.toThrow();
  });

  it("starts again after a failed start", async () => {
    const approvals = createApprovalStore({
      channel: createLocalApprovalChannel({ log: () => undefined }),
    });
    stores.push(approvals);
    const listen = vi.spyOn(Server.prototype, "listen");
    listen.mockImplementationOnce(function (this: Server) {
      queueMicrotask(() => {
        this.emit("error", Object.assign(new Error("listen EPERM"), { code: "EPERM" }));
      });
      return this;
    });

    await expect(approvals.create(STDIO, binding())).rejects.toThrow("listen EPERM");
    expect(approvals.current(STDIO, TOOL, ARGS)).toBeUndefined();
    await expect(approvals.create(STDIO, binding())).resolves.toMatchObject({ status: "pending" });
  });
});

describe("reference codes, log line and opener", () => {
  it("shows the reference code on the page", async () => {
    const { approvals, url } = harness();
    const a = await approvals.create(STDIO, binding());
    const b = await approvals.create(STDIO, binding({ argsHash: "b".repeat(64) }));

    expect(b.reference).not.toBe(a.reference);
    expect((await openApproval(url(a))).page.body).toContain(`<strong>${a.reference}</strong>`);
  });

  it("logs one trusted line per new approval with tool, reference and URL", async () => {
    const { approvals, lines, url, current } = harness();

    const ticket = await approvals.create(STDIO, binding());
    current();

    expect(lines).toEqual([
      `${TOOL}: approval ${ticket.reference} waiting at ${url(ticket)} (until ${ticket.expiresAt})`,
    ]);
  });

  it("logs to stderr by default", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const approvals = createApprovalStore({ channel: createLocalApprovalChannel() });
    stores.push(approvals);

    const ticket = await approvals.create(STDIO, binding());

    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^mcp-server-sevdesk: .*${ticket.reference}.*/approve/${ticket.id} `),
      ),
    );
  });

  it.each([
    ["opens", () => Promise.resolve(true), true],
    ["fails", () => Promise.resolve(false), false],
    ["rejects", () => Promise.reject(new Error("boom")), false],
    [
      "throws",
      () => {
        throw new Error("boom");
      },
      false,
    ],
  ] as const)("records whether the opener %s", async (_label, openUrl, opened) => {
    const urls: string[] = [];
    const { approvals, url, current } = harness({
      channel: {
        openUrl: (page) => {
          urls.push(page);
          return openUrl();
        },
      },
    });

    const ticket = await approvals.create(STDIO, binding());

    expect(urls).toEqual([url(ticket)]);
    expect(ticket.opened).toBe(opened);
    expect(current()?.opened).toBe(opened);
  });

  it("does not open anything without an opener", async () => {
    const { approvals } = harness();

    expect((await approvals.create(STDIO, binding())).opened).toBe(false);
  });
});

describe("decisions", () => {
  it("reports each decision with the owner, the binding and the reference", async () => {
    const decisions: ApprovalDecision[] = [];
    const { approvals, url } = harness({ onDecision: (decision) => decisions.push(decision) });
    const a = await approvals.create(STDIO, binding());
    const b = await approvals.create(STDIO, binding({ argsHash: "b".repeat(64) }));

    await decideInBrowser(url(a), "approve");
    await decideInBrowser(url(b), "reject");

    expect(
      decisions.map(({ owner, binding: bound, reference, decision }) => [
        owner,
        bound.argsHash,
        reference,
        decision,
      ]),
    ).toEqual([
      [STDIO, ARGS, a.reference, "approved"],
      [STDIO, "b".repeat(64), b.reference, "rejected"],
    ]);
  });

  it("keeps the decision when reporting it throws", async () => {
    const { approvals, url, current } = harness({
      onDecision: () => {
        throw new Error("audit down");
      },
    });
    const ticket = await approvals.create(STDIO, binding());

    expect((await decideInBrowser(url(ticket), "approve")).status).toBe(200);
    expect(current()?.status).toBe("approved");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
