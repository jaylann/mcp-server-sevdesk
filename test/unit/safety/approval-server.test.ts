import { afterEach, describe, expect, it, vi } from "vitest";

import { escapeHtml } from "../../../src/safety/approval-page.js";
import {
  type ApprovalBinding,
  type ApprovalDecision,
  ApprovalLimitError,
  type ApprovalService,
  createApprovalService,
} from "../../../src/safety/approval-server.js";
import {
  browserOrigin,
  decideInBrowser,
  effectiveReferrerPolicy,
  openApproval,
  send,
  submitDecision,
} from "../../helpers/approval-browser.js";

const services: ApprovalService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function service(options: Parameters<typeof createApprovalService>[0] = {}): ApprovalService {
  const created = createApprovalService({ log: () => undefined, ...options });
  services.push(created);
  return created;
}

function binding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    toolName: "sevdesk_invoice_finalize",
    toolTitle: "Finalize invoice",
    tier: "commit",
    tierText: "legally binding bookkeeping",
    argsHash: "a".repeat(64),
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

describe("approval service", () => {
  it("starts lazily on 127.0.0.1 with an ephemeral port and a 256-bit id", async () => {
    const approvals = service();
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))).toBeUndefined();

    const ticket = await approvals.create(binding());

    const url = new URL(ticket.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(url.pathname).toMatch(/^\/approve\/[A-Za-z0-9_-]{43}$/);
    expect(ticket.id).toHaveLength(43);
    expect(ticket.status).toBe("pending");
    expect(ticket.callId).toBe("call-1");
  });

  it("reuses one server for every approval and replaces an approval for the same call", async () => {
    const approvals = service();
    const first = await approvals.create(binding());
    const other = await approvals.create(binding({ argsHash: "b".repeat(64) }));
    const replaced = await approvals.create(binding({ previewHash: "q".repeat(64) }));

    expect(new URL(other.url).port).toBe(new URL(first.url).port);
    expect(replaced.id).not.toBe(first.id);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.id).toBe(replaced.id);
    expect((await send(first.url)).status).toBe(404);
  });

  it("shows the preview HTML-escaped under a strict CSP and sets a SameSite=Strict cookie", async () => {
    const approvals = service();
    const ticket = await approvals.create(
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

    const { page, csrf, cookie } = await openApproval(ticket.url);

    expect(page.status).toBe(200);
    expect(page.body).not.toContain("<script>");
    expect(page.body).not.toContain("<img");
    expect(page.body).not.toContain("<b>bold");
    expect(page.body).toContain(escapeHtml('Finalize <script>alert("x")</script> RE-1'));
    expect(page.body).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &#39;Co&#39;");
    expect(page.body).toContain("The record &lt;changed&gt;.");
    expect(page.body).toContain("This cannot be undone.");
    expect(page.body).toContain("sevdesk_invoice_finalize");
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toMatch(
      /^default-src 'none'; style-src 'nonce-[A-Za-z0-9_-]+'; form-action 'self'/,
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.body).toContain(`<style nonce="${/'nonce-([^']+)'/.exec(csp)?.[1] ?? ""}">`);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.body).toContain(`<meta name="referrer" content="same-origin">`);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).toMatch(/^sevdesk_approval=[A-Za-z0-9_-]{43}$/);
    const setCookie = String(page.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain(`Path=/approve/${ticket.id}`);
    expect(page.body).not.toContain("<script");
  });

  it("records an approval made with the page's token, cookie and origin", async () => {
    const approvals = service();
    const ticket = await approvals.create(binding());

    const decided = await decideInBrowser(ticket.url, "approve");

    expect(decided.status).toBe(200);
    expect(decided.body).toContain("You approved this action");
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("approved");
    // Reloading shows the decision, without a form.
    const reloaded = await openApproval(ticket.url);
    expect(reloaded.csrf).toBeUndefined();
    expect(reloaded.page.body).toContain("You approved this action");
  });

  it("records a rejection", async () => {
    const approvals = service();
    const ticket = await approvals.create(binding());

    const decided = await decideInBrowser(ticket.url, "reject");

    expect(decided.body).toContain("Nothing was changed in sevDesk");
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("rejected");
  });

  it("lets a decision be made only once", async () => {
    const approvals = service();
    const ticket = await approvals.create(binding());
    const opened = await openApproval(ticket.url);

    expect((await submitDecision(ticket.url, "reject", opened)).status).toBe(200);
    const second = await submitDecision(ticket.url, "approve", opened);

    expect(second.status).toBe(409);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("rejected");
  });

  it("hands a decided approval out once (take) and forgets it", async () => {
    const approvals = service();
    const ticket = await approvals.create(binding());
    await decideInBrowser(ticket.url, "approve");

    expect(approvals.take(ticket.id)?.status).toBe("approved");
    expect(approvals.take(ticket.id)).toBeUndefined();
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))).toBeUndefined();
    expect((await send(ticket.url)).status).toBe(404);
  });

  it.each([
    ["a wrong Host (DNS rebinding)", { Host: "evil.example:80" }],
    ["localhost instead of 127.0.0.1", { Host: "localhost" }],
  ])("refuses a page request with %s", async (_label, headers) => {
    const approvals = service();
    const ticket = await approvals.create(binding());

    const page = await send(ticket.url, { headers });

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
  ])("refuses a decision with %s and keeps the approval pending", async (_label, override) => {
    const approvals = service();
    const ticket = await approvals.create(binding());
    const opened = await openApproval(ticket.url);
    const { csrfOverride, ...headers } = override as Record<string, string | undefined>;

    const decided = await submitDecision(
      ticket.url,
      "approve",
      csrfOverride === undefined ? opened : { ...opened, csrf: csrfOverride },
      headers,
    );

    expect([403, 421]).toContain(decided.status);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("pending");
  });

  it("accepts a same-origin POST without Origin when the browser marks it Sec-Fetch-Site: same-origin", async () => {
    const approvals = service();
    const ticket = await approvals.create(binding());

    const decided = await submitDecision(ticket.url, "approve", await openApproval(ticket.url), {
      Origin: undefined,
    });

    expect(decided.status).toBe(200);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("approved");
  });

  it("derives the browser Origin from the page's referrer policy (no-referrer would fail)", async () => {
    const approvals = service();
    const ticket = await approvals.create(binding());
    const opened = await openApproval(ticket.url);

    expect(opened.referrerPolicy).toBe("same-origin");
    expect(browserOrigin("same-origin", "http://127.0.0.1:1")).toBe("http://127.0.0.1:1");
    expect(browserOrigin("no-referrer", "http://127.0.0.1:1")).toBe("null");
    // A page under no-referrer would make the browser send Origin: null, which is refused.
    const underNoReferrer = await submitDecision(ticket.url, "approve", {
      ...opened,
      referrerPolicy: "no-referrer",
    });
    expect(underNoReferrer.status).toBe(403);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("pending");
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
    const approvals = service();
    const ticket = await approvals.create(binding());

    const decided = await submitDecision(ticket.url, "maybe", await openApproval(ticket.url));

    expect(decided.status).toBe(400);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("pending");
  });

  it("refuses non-form bodies and oversized bodies", async () => {
    const approvals = service();
    const ticket = await approvals.create(binding());
    const opened = await openApproval(ticket.url);

    const json = await submitDecision(ticket.url, "approve", opened, {
      "Content-Type": "application/json",
    });
    expect(json.status).toBe(400);

    const huge = await send(ticket.url, {
      method: "POST",
      headers: {
        Origin: new URL(ticket.url).origin,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: opened.cookie ?? "",
      },
      body: `csrf=${opened.csrf ?? ""}&decision=approve&pad=${"z".repeat(10_000)}`,
    }).catch(() => ({ status: 400 }));
    expect(huge.status).toBe(400);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("pending");
  });

  it("answers 404 for other paths and unknown ids, 405 for other methods", async () => {
    const approvals = service();
    const ticket = await approvals.create(binding());
    const origin = new URL(ticket.url).origin;

    expect((await send(`${origin}/`)).status).toBe(404);
    expect((await send(`${origin}/approve/short`)).status).toBe(404);
    expect((await send(`${origin}/approve/${"A".repeat(43)}`)).status).toBe(404);
    const put = await send(ticket.url, { method: "PUT" });
    expect(put.status).toBe(405);
    expect(put.headers["allow"]).toBe("GET, POST");
  });

  it("expires approvals after their lifetime (10 minutes by default)", async () => {
    let now = 1_000_000;
    const approvals = service({ now: () => now });
    const ticket = await approvals.create(binding());
    expect(Date.parse(ticket.expiresAt)).toBe(1_000_000 + 600_000);

    now += 600_000;

    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))).toBeUndefined();
    expect((await send(ticket.url)).status).toBe(404);
    expect(approvals.take(ticket.id)).toBeUndefined();
  });

  it("refuses a decision that arrives after the approval expired", async () => {
    let now = 1_000_000;
    const approvals = service({ now: () => now });
    const ticket = await approvals.create(binding());
    const opened = await openApproval(ticket.url);

    now += 600_001;
    const decided = await submitDecision(ticket.url, "approve", opened);

    expect(decided.status).toBe(404);
  });

  it("keeps at most maxApprovals, dropping the oldest", async () => {
    const approvals = service({ maxApprovals: 2, maxPending: 10 });
    const first = await approvals.create(binding({ argsHash: "1".repeat(64) }));
    await approvals.create(binding({ argsHash: "2".repeat(64) }));
    await approvals.create(binding({ argsHash: "3".repeat(64) }));

    expect(approvals.current("sevdesk_invoice_finalize", "1".repeat(64))).toBeUndefined();
    expect(approvals.take(first.id)).toBeUndefined();
    expect(approvals.current("sevdesk_invoice_finalize", "3".repeat(64))).toBeDefined();
  });

  it("closes the server and forgets approvals; closing twice or unstarted is fine", async () => {
    const approvals = createApprovalService({ log: () => undefined });
    await approvals.close();
    const ticket = await approvals.create(binding());

    await approvals.close();
    await approvals.close();

    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))).toBeUndefined();
    await expect(send(ticket.url)).rejects.toThrow();
  });
});

describe("reference codes, log line and opener", () => {
  it("gives each approval a 6-character reference independent of its id", async () => {
    const approvals = service();
    const a = await approvals.create(binding());
    const b = await approvals.create(binding({ argsHash: "b".repeat(64) }));

    expect(a.reference).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(a.id).not.toContain(a.reference);
    expect(b.reference).not.toBe(a.reference);
    expect((await openApproval(a.url)).page.body).toContain(`<strong>${a.reference}</strong>`);
  });

  it("logs one trusted line per new approval with tool, reference and URL", async () => {
    const lines: string[] = [];
    const approvals = service({ log: (line) => lines.push(line) });

    const ticket = await approvals.create(binding());
    approvals.current("sevdesk_invoice_finalize", "a".repeat(64));

    expect(lines).toEqual([
      `sevdesk_invoice_finalize: approval ${ticket.reference} waiting at ${ticket.url} ` +
        `(until ${ticket.expiresAt})`,
    ]);
  });

  it("logs to stderr by default", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const approvals = createApprovalService();
    services.push(approvals);

    const ticket = await approvals.create(binding());

    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^mcp-server-sevdesk: .*${ticket.reference}.*${ticket.url}`),
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
    const approvals = service({
      openUrl: (url) => {
        urls.push(url);
        return openUrl();
      },
    });

    const ticket = await approvals.create(binding());

    expect(urls).toEqual([ticket.url]);
    expect(ticket.opened).toBe(opened);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.opened).toBe(opened);
  });

  it("does not open anything without an opener", async () => {
    const approvals = service();

    expect((await approvals.create(binding())).opened).toBe(false);
  });
});

describe("decisions and limits", () => {
  it("reports each decision with the binding and the reference", async () => {
    const decisions: ApprovalDecision[] = [];
    const approvals = service({ onDecision: (decision) => decisions.push(decision) });
    const a = await approvals.create(binding());
    const b = await approvals.create(binding({ argsHash: "b".repeat(64) }));

    await decideInBrowser(a.url, "approve");
    await decideInBrowser(b.url, "reject");

    expect(
      decisions.map(({ binding: bound, reference, decision }) => [
        bound.argsHash,
        reference,
        decision,
      ]),
    ).toEqual([
      ["a".repeat(64), a.reference, "approved"],
      ["b".repeat(64), b.reference, "rejected"],
    ]);
  });

  it("keeps the decision when reporting it throws", async () => {
    const approvals = service({
      onDecision: () => {
        throw new Error("audit down");
      },
    });
    const ticket = await approvals.create(binding());

    expect((await decideInBrowser(ticket.url, "approve")).status).toBe(200);
    expect(approvals.current("sevdesk_invoice_finalize", "a".repeat(64))?.status).toBe("approved");
  });

  it("refuses more than maxPending waiting approvals; replacements and decided ones do not count", async () => {
    const approvals = service({ maxPending: 2 });
    const first = await approvals.create(binding({ argsHash: "1".repeat(64) }));
    await approvals.create(binding({ argsHash: "2".repeat(64) }));

    await expect(approvals.create(binding({ argsHash: "3".repeat(64) }))).rejects.toBeInstanceOf(
      ApprovalLimitError,
    );
    await expect(
      approvals.create(binding({ argsHash: "2".repeat(64), previewHash: "q".repeat(64) })),
    ).resolves.toMatchObject({ status: "pending" });
    await decideInBrowser(first.url, "reject");
    await expect(approvals.create(binding({ argsHash: "3".repeat(64) }))).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("defaults to 5 waiting approvals", async () => {
    const approvals = service();
    for (const digit of ["1", "2", "3", "4", "5"]) {
      await approvals.create(binding({ argsHash: digit.repeat(64) }));
    }

    const refused: unknown = await approvals
      .create(binding({ argsHash: "6".repeat(64) }))
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApprovalLimitError);
    expect((refused as ApprovalLimitError).limit).toBe(5);
    expect((refused as ApprovalLimitError).message).toBe(
      "5 approval requests are already waiting for a decision.",
    );
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
