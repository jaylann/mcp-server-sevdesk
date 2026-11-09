/**
 * HTML for the approval pages of `SEVDESK_CONFIRM=browser`: the approval page itself (shared by
 * the local 127.0.0.1 page and the HTTP server's inbox), and the inbox's list and sign-in pages.
 * Every dynamic value is HTML-escaped; the pages have no script and only one inline style block,
 * allowed by a per-response CSP nonce.
 *
 * The local page's output must stay byte-identical: the remote additions are optional fields and
 * separate renderers.
 */
import type { ConfirmationPreview } from "../tools/types.js";
import type { ApprovalStatus } from "./approval-types.js";
import { IRREVERSIBLE_LINE, shownValue } from "./preview.js";

/** What the approval page shows. */
export interface ApprovalPageModel {
  readonly toolName: string;
  readonly toolTitle: string;
  readonly tierText: string;
  /** Already sanitized with `displayPreview`. */
  readonly preview: ConfirmationPreview;
  /** Trusted note above the preview, e.g. that the record changed. */
  readonly notice: string | undefined;
  /** The non-secret reference code the assistant was given, so the user can match them. */
  readonly reference: string;
  readonly expiresAt: string;
  readonly formAction: string;
  readonly csrf: string;
  /** Inbox only: a link back to the list (the local page has none). */
  readonly inboxHref?: string;
}

/** A trusted link below a message (e.g. back to the inbox). */
export interface PageLink {
  readonly href: string;
  readonly label: string;
}

/** One approval in the inbox list. */
export interface InboxItem {
  /** The detail page. */
  readonly href: string;
  readonly reference: string;
  readonly toolName: string;
  readonly toolTitle: string;
  /** The preview's action sentence (already sanitized with `displayPreview`). */
  readonly action: string;
  readonly status: ApprovalStatus;
  /** ISO 8601 (UTC). */
  readonly expiresAt: string;
}

/** What the inbox list shows. */
export interface InboxPageModel {
  /** The sevDesk account the session belongs to. */
  readonly accountId: string;
  /** Newest first. */
  readonly items: readonly InboxItem[];
  readonly inboxHref: string;
  readonly logoutAction: string;
  readonly csrf: string;
}

/** What the inbox sign-in page shows. */
export interface LoginPageModel {
  readonly formAction: string;
  /** Host of the server's public origin: the only place the user should enter the token. */
  readonly host: string;
  /** Session lifetime in hours, as the page states it. */
  readonly sessionHours: number;
  /** Trusted note above the form (a failed sign-in, a signed-out session). */
  readonly message: string | undefined;
}

/** Escapes `&`, `<`, `>`, `"` and `'` for HTML text and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The page with the preview and the Approve / Reject form. */
export function renderApprovalPage(model: ApprovalPageModel, styleNonce: string): string {
  const { preview } = model;
  const facts =
    preview.facts.length === 0
      ? ""
      : `<dl>${preview.facts
          .map(
            (fact) =>
              `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(shownValue(fact.value))}</dd>`,
          )
          .join("")}</dl>`;
  const warnings = preview.warnings.map((warning) => escapeHtml(warning));
  if (preview.irreversible) {
    warnings.push(`<strong>${escapeHtml(IRREVERSIBLE_LINE)}</strong>`);
  }
  const warningList =
    warnings.length === 0
      ? ""
      : `<ul class="warnings">${warnings.map((warning) => `<li>${warning}</li>`).join("")}</ul>`;
  const notice =
    model.notice === undefined ? "" : `<p class="notice">${escapeHtml(model.notice)}</p>`;
  const body = `<h1>Approve a sevDesk action?</h1>
${notice}<p class="lead">Your AI assistant wants to run <code>${escapeHtml(model.toolName)}</code>
(${escapeHtml(model.toolTitle)}; ${escapeHtml(model.tierText)}). Nothing happens unless you approve.</p>
<section class="preview">
<h2>${escapeHtml(preview.action)}</h2>
${warningList}${facts}</section>
<form method="post" action="${escapeHtml(model.formAction)}">
<input type="hidden" name="csrf" value="${escapeHtml(model.csrf)}">
<button type="submit" name="decision" value="approve" class="approve">Approve</button>
<button type="submit" name="decision" value="reject" class="reject">Reject</button>
</form>
<p class="reference">Reference: <strong>${escapeHtml(model.reference)}</strong> (your assistant names the same code)</p>
<p class="small">This request expires at ${escapeHtml(formatTime(model.expiresAt))} and can be decided once.
After approving, return to your assistant: it runs the action when it calls the tool again.</p>${
    model.inboxHref === undefined
      ? ""
      : `\n${renderLink({ href: model.inboxHref, label: "Back to the inbox" })}`
  }`;
  return page("Approve sevDesk action", body, styleNonce);
}

/** A page with a title and one paragraph of trusted text (results, errors), optionally a link. */
export function renderMessagePage(
  title: string,
  message: string,
  styleNonce: string,
  link?: PageLink,
): string {
  const after = link === undefined ? "" : `\n${renderLink(link)}`;
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>${after}`,
    styleNonce,
  );
}

/** The inbox: the account's approvals (newest first) with links to their pages, and sign-out. */
export function renderInboxPage(model: InboxPageModel, styleNonce: string): string {
  const list =
    model.items.length === 0
      ? `<p class="empty">No approval requests right now. When your assistant asks for one, reload this page.</p>`
      : `<ul class="inbox">\n${model.items.map(renderInboxItem).join("\n")}\n</ul>`;
  const body = `<h1>sevDesk approvals</h1>
<p class="lead">Signed in for sevDesk account <strong>${escapeHtml(model.accountId)}</strong>.
Open a request to see exactly what it does, then approve or reject it.</p>
${list}
<p><a href="${escapeHtml(model.inboxHref)}">Reload</a></p>
<form method="post" action="${escapeHtml(model.logoutAction)}">
<input type="hidden" name="csrf" value="${escapeHtml(model.csrf)}">
<button type="submit">Sign out</button>
</form>
<p class="small">Requests expire after a few minutes and can be decided once. After approving, return
to your assistant: it runs the action when it calls the tool again.</p>`;
  return page("sevDesk approvals", body, styleNonce, INBOX_STYLE);
}

/**
 * The inbox sign-in form: the sevDesk API token proves the account. Shows no approval data, and
 * warns to enter the token only on this server's host (lookalike pages could phish it).
 */
export function renderLoginPage(model: LoginPageModel, styleNonce: string): string {
  const message =
    model.message === undefined ? "" : `<p class="notice">${escapeHtml(model.message)}</p>\n`;
  const body = `<h1>Sign in to approve sevDesk actions</h1>
${message}<p class="lead">To see and decide approval requests from your AI assistant, sign in with
the API token of the sevDesk account (in sevDesk: Settings → Users → API token).</p>
<p class="warning">Only enter your token on <strong>${escapeHtml(model.host)}</strong>. Check the
address bar first: anywhere else, a page asking for it is phishing.</p>
<form method="post" action="${escapeHtml(model.formAction)}" class="login">
<label for="token">sevDesk API token</label>
<input type="password" id="token" name="token" autocomplete="off" spellcheck="false" maxlength="256" required>
<button type="submit" class="approve">Sign in</button>
</form>
<p class="small">The token is checked once and not stored. The sign-in lasts
${escapeHtml(String(model.sessionHours))} hours in this browser, or until you sign out.</p>`;
  return page("Sign in: sevDesk approvals", body, styleNonce, INBOX_STYLE);
}

const STATUS_TEXT: Readonly<Record<ApprovalStatus, string>> = {
  pending: "Waiting for your decision",
  approved: "Approved",
  rejected: "Rejected",
};

function renderInboxItem(item: InboxItem): string {
  return `<li><a href="${escapeHtml(item.href)}"><strong class="ref">${escapeHtml(item.reference)}</strong>
${escapeHtml(item.toolTitle)} (<code>${escapeHtml(item.toolName)}</code>)</a>
<span class="action">${escapeHtml(item.action)}</span>
<span class="small status-${item.status}">${STATUS_TEXT[item.status]}; expires ${escapeHtml(formatTime(item.expiresAt))}</span></li>`;
}

function renderLink(link: PageLink): string {
  return `<p class="small"><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`;
}

function page(title: string, body: string, styleNonce: string, extraStyle = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(title)}</title>
<style nonce="${escapeHtml(styleNonce)}">${STYLE}${extraStyle}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --card: #fff; --line: #d8d8dc;
  --warn: #8a4b00; --ok: #0a6b2d; --no: #a1121b; }
@media (prefers-color-scheme: dark) { :root { --fg: #f2f2f4; --bg: #121214; --card: #1c1c1f;
  --line: #3a3a3f; --warn: #ffb15c; --ok: #4fd17f; --no: #ff6b73; } }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
h2 { font-size: 1.1rem; margin: 0 0 0.75rem; }
.preview { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 1rem 1.25rem; margin: 1rem 0 1.5rem; }
dl { display: grid; grid-template-columns: minmax(8rem, max-content) 1fr; gap: 0.25rem 1rem;
  margin: 0; }
dt { font-weight: 600; } dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.warnings { color: var(--warn); margin: 0 0 1rem; padding-left: 1.25rem; }
.notice { border-left: 4px solid var(--warn); padding-left: 0.75rem; }
form { display: flex; gap: 0.75rem; flex-wrap: wrap; }
button { font: inherit; padding: 0.6rem 1.4rem; border-radius: 8px; border: 1px solid var(--line);
  cursor: pointer; background: var(--card); color: var(--fg); }
button.approve { border-color: var(--ok); color: var(--ok); font-weight: 600; }
button.reject { border-color: var(--no); color: var(--no); }
code { font-size: 0.95em; }
.small { font-size: 0.9rem; opacity: 0.8; }
.reference strong { font-family: ui-monospace, monospace; letter-spacing: 0.1em; }
`;

/** Added to {@link STYLE} on the inbox pages only (the local page stays unchanged). */
const INBOX_STYLE = `.inbox { list-style: none; padding: 0; margin: 1rem 0 1.5rem; }
.inbox li { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 0.75rem 1rem; margin: 0 0 0.75rem; }
.inbox li > span { display: block; }
.inbox a { color: inherit; }
.ref { font-family: ui-monospace, monospace; letter-spacing: 0.1em; margin-right: 0.5rem; }
.status-pending { color: var(--warn); opacity: 1; } .status-approved { color: var(--ok); opacity: 1; }
.status-rejected { color: var(--no); opacity: 1; }
.warning { border-left: 4px solid var(--warn); padding-left: 0.75rem; }
form.login { display: block; margin: 0 0 1.5rem; }
label { display: block; font-weight: 600; margin: 0 0 0.35rem; }
input[type="password"] { font: inherit; width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem;
  border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg);
  margin: 0 0 0.75rem; }
`;
