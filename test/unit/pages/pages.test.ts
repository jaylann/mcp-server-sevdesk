import { describe, expect, it } from "vitest";

import { renderConfirmStep, renderTokenStep } from "../../../src/http/oauth/consent-page.js";
import { renderUploadPage } from "../../../src/http/transfer-pages.js";
import {
  badge,
  callout,
  facts,
  pageTime,
  reference,
  stamp,
} from "../../../src/pages/components.js";
import { pageContext, type RenderContext } from "../../../src/pages/context.js";
import { icon, SEAL } from "../../../src/pages/icons.js";
import { renderMessagePage, toneForStatus } from "../../../src/pages/message.js";
import {
  type ApprovalPageModel,
  renderApprovalPage,
  renderDecisionPage,
  renderInboxPage,
} from "../../../src/safety/approval-page.js";

const ORIGIN = "https://mcp.example.com";

function ctx(language?: string): RenderContext {
  return { ...pageContext(language, ORIGIN), nonce: "n" };
}

const CREATED = "2026-11-09T12:05:00.000Z";
const EXPIRES = "2026-11-09T12:15:00.000Z";

function approval(overrides: Partial<ApprovalPageModel> = {}): ApprovalPageModel {
  return {
    toolName: "sevdesk_invoice_finalize",
    toolTitle: "Finalize a sevDesk invoice",
    tier: "commit",
    preview: {
      action: "Finalize invoice RE-1042.",
      facts: [
        { label: "Customer", value: "Muster GmbH" },
        { label: "Text", value: "line one\n  line two" },
      ],
      warnings: ["The invoice becomes legally binding."],
      irreversible: true,
    },
    recordChanged: false,
    reference: "K7Q2M4",
    createdAt: CREATED,
    expiresAt: EXPIRES,
    now: Date.parse(EXPIRES) - 537_000,
    formAction: "/approve/x",
    csrf: "tag",
    ...overrides,
  };
}

describe("components", () => {
  it("lays facts out as label and value, long values across the sheet", () => {
    const list = facts([
      { label: "Customer", value: "Muster <b> GmbH" },
      { label: "Text", value: "one\ntwo" },
      { label: "Note", value: "x".repeat(73) },
      { label: "Short", value: "x".repeat(72) },
      { label: "Forced", value: "x".repeat(200), long: false },
      { label: "Code", value: reference("K7Q2M4") },
    ]).toString();
    expect(list).toContain("<dt>Customer</dt><dd>Muster &lt;b&gt; GmbH</dd>");
    // Nothing but the value between the tags: the stylesheet shows whitespace as written.
    expect(list).toContain('<dt class="long">Text</dt><dd>one\ntwo</dd>');
    expect(list).toContain(`<dt class="long">Note</dt><dd>${"x".repeat(73)}</dd>`);
    expect(list).toContain(`<dt>Short</dt><dd>${"x".repeat(72)}</dd>`);
    expect(list).toContain("<dt>Forced</dt>");
    expect(list).toContain(
      '<dt>Code</dt><dd><span class="ref"><strong>K7Q2M4</strong></span></dd>',
    );
    expect(facts([]).toString()).toBe("");
    expect(facts([{ label: "a", value: "b" }], { plain: true }).toString()).toBe(
      '<dl class="facts facts-plain"><dt>a</dt><dd>b</dd></dl>',
    );
  });

  it("builds badges, callouts and times from escaped text", () => {
    expect(badge("a<b").toString()).toBe('<span class="badge">a&lt;b</span>');
    expect(badge("x", "approve").toString()).toBe('<span class="badge badge-approve">x</span>');
    const note = callout("careful <now>", { tone: "danger", icon: "alert", alert: true });
    expect(note.toString()).toMatch(
      /^<div class="callout callout-danger" role="alert"><svg class="ink"[^>]*aria-hidden="true">.*<\/svg><div>careful &lt;now&gt;<\/div><\/div>$/,
    );
    expect(callout("plain").toString()).not.toContain("role=");
    expect(pageTime(EXPIRES).toString()).toBe(
      '<time class="nb" datetime="2026-11-09T12:15:00.000Z">2026-11-09 12:15 UTC</time>',
    );
  });

  it("draws the stamp wide enough for its word, in capitals, hidden from screen readers", () => {
    const short = stamp("Approved", "approve").toString();
    expect(short).toContain('<div class="stamp stamp-approve" aria-hidden="true">');
    expect(short).toContain(">APPROVED</text>");
    expect(short).toContain('viewBox="0 0 224 74"');
    expect(short).toContain('filter="url(#stamp-ink)"');
    expect(short).toContain('<filter id="stamp-ink"');
    const long = stamp("Freigegeben", "plain").toString();
    expect(long).toContain('class="stamp stamp-plain"');
    expect(long).toContain('viewBox="0 0 287 74"');
    expect(long).toContain('textLength="235"');
    expect(stamp("ok", "plain").toString()).toContain('viewBox="0 0 180 74"');
    expect(stamp("<x>", "plain").toString()).toContain(">&lt;X&gt;</text>");
  });

  it("draws icons in ink, with stamp ink only where marked", () => {
    expect(icon("check").toString()).toBe(
      '<svg class="ink" viewBox="0 0 24 24" stroke-width="1.75" aria-hidden="true">' +
        '<path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    );
    expect(icon("stamp", 2).toString()).toContain('stroke-width="2"');
    expect(
      icon("stamp")
        .toString()
        .match(/class="ink-accent"/g),
    ).toHaveLength(2);
    expect(icon("lock").toString()).toContain('<circle class="dot" cx="12" cy="15.5" r="1"/>');
    expect(SEAL.toString()).toContain('class="ink-accent"');
    for (const name of [
      "envelope",
      "key",
      "cross",
      "clock",
      "alert",
      "info",
      "refresh",
      "upload",
      "file",
    ] as const) {
      expect(icon(name).toString()).toMatch(/^<svg class="ink"[^>]*aria-hidden="true">.+<\/svg>$/);
    }
  });
});

describe("message page", () => {
  it("takes its tone from the status unless told otherwise", () => {
    expect([200, 303, 404, 409].map(toneForStatus)).toEqual(["info", "info", "info", "info"]);
    expect([408, 410, 429, 503].map(toneForStatus)).toEqual(["wait", "wait", "wait", "wait"]);
    expect([400, 401, 403, 405, 411, 413, 415, 421, 500, 502, 507].map(toneForStatus)).toEqual(
      Array.from({ length: 11 }, () => "danger"),
    );
  });

  it("shows the tone as an icon, the text escaped, and a link only when given one", () => {
    const text = { title: "Not <ok>", message: 'It\'s "refused".' };
    const refused = renderMessagePage(text, ctx(), { tone: "danger" });
    expect(refused).toContain('<div class="result-icon result-danger">');
    expect(refused).toContain("<h1>Not &lt;ok&gt;</h1>");
    expect(refused).toContain('<p class="message">It&#39;s &quot;refused&quot;.</p>');
    expect(refused).toContain("<title>Not &lt;ok&gt;</title>");
    expect(refused).not.toContain("<a ");
    expect(renderMessagePage(text, ctx(), { tone: "ok" })).toContain("result-icon result-ok");
    expect(renderMessagePage(text, ctx())).toContain('<div class="result-icon">');
    const linked = renderMessagePage(text, ctx(), { link: { href: "/approvals", label: "Back" } });
    expect(linked).toContain('<p class="after"><a href="/approvals">Back</a></p>');
  });
});

describe("approval page", () => {
  it("puts the consequences before the facts and the buttons last", () => {
    const html = renderApprovalPage(approval(), ctx());
    const order = [
      "<h1>Approve this action?</h1>",
      '<section class="sheet">',
      "<h2>Finalize invoice RE-1042.</h2>",
      "The invoice becomes legally binding.",
      "<strong>This cannot be undone.</strong>",
      '<dl class="facts">',
      'value="reject"',
      'value="approve"',
      "</form>",
    ].map((part) => html.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('<dt class="long">Text</dt><dd>line one\n  line two</dd>');
    expect(html).toContain("Finalize a sevDesk invoice <code>sevdesk_invoice_finalize</code>");
    expect(html).toContain('<span class="ref"><strong>K7Q2M4</strong></span>');
    expect(html).toContain('class="btn btn-approve"');
    expect(html).not.toContain('class="notice"');
  });

  it("names the tier in plain words, coloured as on the website", () => {
    expect(renderApprovalPage(approval(), ctx())).toMatch(
      /<span class="badge badge-approve"><svg[^>]*>.*?<\/svg>Legally binding bookkeeping<\/span>/,
    );
    expect(renderApprovalPage(approval({ tier: "external" }), ctx())).toContain(
      "</svg>Reaches people outside sevDesk</span>",
    );
    expect(renderApprovalPage(approval({ tier: "external" }), ctx())).toContain("badge-danger");
    expect(renderApprovalPage(approval({ tier: "write" }), ctx())).toContain(
      "</svg>Changes reversible records</span>",
    );
  });

  it("says when the record changed, and nothing about consequences when there are none", () => {
    const changed = renderApprovalPage(approval({ recordChanged: true }), ctx());
    expect(changed).toContain('<div class="notice"><div class="callout">');
    expect(changed).toContain("The record changed after you were asked");
    const plain = renderApprovalPage(
      approval({
        preview: { action: "Do it.", facts: [], warnings: [], irreversible: false },
      }),
      ctx(),
    );
    expect(plain).not.toContain('class="callouts"');
    expect(plain).not.toContain("<dl");
    expect(plain).not.toContain("This cannot be undone.");
  });

  it("gives the stylesheet the time left, from numbers only", () => {
    const css = (model: ApprovalPageModel): string | undefined =>
      /:root\{--ttl:[^}]*\}/.exec(renderApprovalPage(model, ctx()))?.[0];
    expect(css(approval())).toBe(":root{--ttl:537s;--secs:537;--part:0.8950}");
    // Half a second counts as a second left; a request past its time has none.
    expect(css(approval({ now: Date.parse(EXPIRES) - 500 }))).toBe(
      ":root{--ttl:1s;--secs:1;--part:0.0008}",
    );
    expect(css(approval({ now: Date.parse(EXPIRES) + 5_000 }))).toBe(
      ":root{--ttl:0s;--secs:0;--part:0.0000}",
    );
    // A clock behind the store's: never more than the request's lifetime.
    expect(css(approval({ now: Date.parse(CREATED) - 60_000 }))).toBe(
      ":root{--ttl:600s;--secs:600;--part:1.0000}",
    );
    expect(css(approval({ createdAt: EXPIRES, now: Date.parse(EXPIRES) - 1_000 }))).toBe(
      ":root{--ttl:1s;--secs:1;--part:1.0000}",
    );
    const html = renderApprovalPage(approval(), ctx());
    expect(html).toContain('<p class="live">Nothing happens unless you approve.</p>');
    expect(html).toContain('<p class="late">This request has expired.');
    expect(html).toContain('<div class="actions live">');
    expect(html).toContain("Valid until <time");
  });

  it("is German for a German browser, except what the tool wrote", () => {
    const html = renderApprovalPage(approval({ inboxHref: "/approvals" }), ctx("de-DE"));
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("<title>sevDesk-Aktion freigeben</title>");
    expect(html).toContain("sevDesk MCP bittet um Ihre Freigabe");
    expect(html).toContain("<h1>Diese Aktion freigeben?</h1>");
    expect(html).toContain("</svg>Rechtlich bindende Buchhaltung</span>");
    expect(html).toContain("<strong>Das lässt sich nicht rückgängig machen.</strong>");
    expect(html).toContain(">Ablehnen</button>");
    expect(html).toContain("</svg>Freigeben</button>");
    expect(html).toContain("Ohne Ihre Freigabe passiert nichts.");
    expect(html).toContain('<a href="/approvals">Zurück zum Freigabe-Postfach</a>');
    expect(html).toContain("<h2>Finalize invoice RE-1042.</h2>");
    // Tool titles exist in English only: the German page names the tool, not its title.
    expect(html).toContain('<p class="meta">Tool <code>sevdesk_invoice_finalize</code></p>');
    expect(html).not.toContain("Finalize a sevDesk invoice");
  });
});

describe("decision page", () => {
  it("stamps the decision and says what it was about", () => {
    const html = renderDecisionPage(
      { decision: "approved", reference: "K7Q2M4", action: "Finalize <invoice> RE-1042." },
      ctx(),
    );
    expect(html).toContain('<section class="sheet struck">');
    expect(html).toContain('<div class="stamp stamp-approve" aria-hidden="true">');
    expect(html).toContain(">APPROVED</text>");
    expect(html).toContain("<h1>Approved</h1>");
    expect(html).toContain("You approved this action.");
    expect(html).toContain('<dd><span class="ref"><strong>K7Q2M4</strong></span></dd>');
    expect(html).toContain("<dt>Action</dt><dd>Finalize &lt;invoice&gt; RE-1042.</dd>");
    expect(html).not.toContain("<a ");
  });

  it("stamps a rejection in plain ink, in German capitals for a German browser", () => {
    const html = renderDecisionPage(
      { decision: "rejected", reference: "9FTW3C", action: "x", inboxHref: "/approvals" },
      ctx("de"),
    );
    expect(html).toContain('<div class="stamp stamp-plain" aria-hidden="true">');
    expect(html).toContain(">ABGELEHNT</text>");
    expect(html).toContain("<h1>Abgelehnt</h1>");
    expect(html).toContain("<dt>Aktion</dt><dd>x</dd>");
    expect(html).toContain(
      '<p class="after"><a href="/approvals">Zurück zum Freigabe-Postfach</a></p>',
    );
  });
});

describe("inbox page", () => {
  const item = (status: "pending" | "approved" | "rejected", reference: string) => ({
    href: `/approvals/${reference}`,
    reference,
    toolName: "sevdesk_voucher_book",
    toolTitle: "Book voucher",
    action: `Book <${reference}>.`,
    status,
    expiresAt: EXPIRES,
  });
  const model = {
    accountId: "1001",
    items: [item("pending", "AAAAAA"), item("approved", "BBBBBB"), item("rejected", "CCCCCC")],
    inboxHref: "/approvals",
    logoutAction: "/approvals/logout",
    csrf: "tag",
  };

  it("lists each request as one link, with its status and what happens to it", () => {
    const html = renderInboxPage(model, ctx());
    const rows = [...html.matchAll(/<li class="row row-(\w+)">[\s\S]*?<\/li>/g)];
    expect(rows.map((row) => row[1])).toEqual(["pending", "approved", "rejected"]);
    for (const [row] of rows) expect(row.match(/<a /g)).toHaveLength(1);
    expect(rows[0]?.[0]).toContain('<a href="/approvals/AAAAAA">Book &lt;AAAAAA&gt;.</a>');
    expect(rows[0]?.[0]).toContain("Waiting for your decision</span>");
    expect(rows[0]?.[0]).toContain("expires <time");
    expect(rows[0]?.[0]).toContain('aria-hidden="true">Review</span>');
    expect(rows[1]?.[0]).toContain("your assistant can run it until <time");
    expect(rows[1]?.[0]).not.toContain("Review");
    expect(rows[2]?.[0]).not.toContain("<time");
    expect(html).toContain('<span class="badge badge-approve">1 waiting</span>');
    expect(html).toContain("sevDesk account <strong>1001</strong>");
    expect(html).toContain('<body class="wide">');
    expect(html).toContain('<form method="post" action="/approvals/logout">');
  });

  it("says so when nothing waits, in the reader's language", () => {
    const none = renderInboxPage({ ...model, items: [] }, ctx("de"));
    expect(none).toContain('<div class="empty">');
    expect(none).toContain("<h2>Nichts wartet auf Sie</h2>");
    expect(none).not.toContain('<ul class="rows">');
    expect(none).toContain("</svg>Aktualisieren</a>");
    const decided = renderInboxPage({ ...model, items: [item("approved", "BBBBBB")] }, ctx("de"));
    expect(decided).toContain('<span class="badge">Nichts wartet</span>');
    const two = [item("pending", "AAAAAA"), item("pending", "DDDDDD")];
    expect(renderInboxPage({ ...model, items: two }, ctx("de"))).toContain("2 warten</span>");
    expect(renderInboxPage(model, ctx("de"))).toContain("1 wartet</span>");
  });
});

describe("consent pages", () => {
  const client = {
    host: "claude.ai",
    name: "Claude",
    redirectHost: "claude.ai",
    loopbackOnly: false,
  };

  it("offers the tiers as checkboxes, read fixed, with the step the reader is on", () => {
    const html = renderTokenStep(
      {
        client,
        offered: ["read", "write", "commit", "external"],
        chosen: ["read", "commit"],
        consent: "sealed",
        csrf: "tag",
        error: undefined,
      },
      ctx(),
    );
    expect(html).toContain(
      '<li class="step step-now" aria-current="step"><span class="step-mark">1</span>Permissions and token</li>',
    );
    expect(html).toContain(
      '<li class="step step-next"><span class="step-mark">2</span>Confirm account</li>',
    );
    expect(html).toContain('<label class="tier"><input type="checkbox" checked disabled> ');
    expect(html).toContain('<input type="hidden" name="tier" value="read">');
    expect(html).toContain('<input type="checkbox" name="tier" value="write"> ');
    expect(html).toContain('<input type="checkbox" name="tier" value="commit" checked> ');
    expect(html).toContain(
      '<span class="badge badge-ok"><span class="tier-dot"></span><strong>Read</strong></span>',
    );
    expect(html).toMatch(
      /<span class="badge badge-approve"><svg[^>]*>.*?<\/svg><strong>Commit<\/strong><\/span>/,
    );
    expect(html).not.toContain('role="alert"');
    expect(html.indexOf("<form")).toBe(html.lastIndexOf("<form"));
  });

  it("warns about an app on this computer and announces a failed check", () => {
    const html = renderTokenStep(
      {
        client: { ...client, name: undefined, redirectHost: "127.0.0.1:53111", loopbackOnly: true },
        offered: ["read"],
        chosen: ["read"],
        consent: "sealed",
        csrf: "tag",
        error: "No <token>.",
      },
      ctx(),
    );
    expect(html).toContain("This app runs on your own computer");
    expect(html).toContain("<strong>127.0.0.1:53111</strong>");
    expect(html).not.toContain("It calls itself");
    expect(html).toContain('<div class="callout callout-danger" role="alert">');
    expect(html).toContain("<div>No &lt;token&gt;.</div>");
  });

  it("confirms the account in German, with the name sevDesk gave in German quotes", () => {
    const html = renderConfirmStep(
      {
        client,
        tiers: ["read", "write"],
        accountId: "4711",
        accountName: "Muster & Co",
        consent: "s",
        csrf: "t",
      },
      ctx("de"),
    );
    expect(html).toContain("<h1>Mit dem sevDesk‑Konto 4711 verbinden?</h1>");
    expect(html).toContain('<li class="step step-done"><span class="step-mark"><svg');
    expect(html).toContain("<dt>Name laut sevDesk</dt><dd>„Muster &amp; Co“</dd>");
    expect(html).toContain("<strong>Entwerfen</strong>");
    expect(html).toContain("Sie nennt sich „Claude“ (eigene Angabe, nicht überprüft).");
    expect(html).toContain(">Verbinden</button>");
    expect(html).toContain("<code>mcp-server-sevdesk grants revoke</code>");
    const unnamed = renderConfirmStep(
      {
        client,
        tiers: ["read"],
        accountId: "4711",
        accountName: undefined,
        consent: "s",
        csrf: "t",
      },
      ctx("de"),
    );
    expect(unnamed).not.toContain("Name laut sevDesk");
  });
});

describe("upload page", () => {
  it("accepts the ticket's kinds and says so in the reader's language", () => {
    const model = {
      accountId: "1001",
      purpose: "einvoice" as const,
      kinds: ["pdf", "xml"] as const,
      maxBytes: 20 * 1024 * 1024,
      reference: "U4MKP7",
      expiresAt: EXPIRES,
      formAction: "/uploads/x",
      csrf: "tag",
    };
    const english = renderUploadPage(model, ctx());
    expect(english).toContain("<h1>Upload an e-invoice</h1>");
    expect(english).toContain("<dd>PDF or XML (checked by content)</dd>");
    expect(english).toContain(
      'accept=".pdf,application/pdf,.xml,application/xml,text/xml" required>',
    );
    expect(english).toContain('enctype="multipart/form-data" class="upload">');
    const german = renderUploadPage(model, ctx("de"));
    expect(german).toContain("<h1>E-Rechnung hochladen</h1>");
    expect(german).toContain("<dt>Akzeptiert</dt><dd>PDF oder XML (am Inhalt geprüft)</dd>");
    expect(german).toContain("<dt>Größte Datei</dt><dd>20 MB</dd>");
    expect(german).toContain("</svg>Hochladen</button>");
    expect(german).toContain("für das sevDesk-Konto <strong>1001</strong> gebeten");
  });
});
