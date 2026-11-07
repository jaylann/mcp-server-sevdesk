/**
 * HTML for the local approval page (`SEVDESK_CONFIRM=browser`). Every dynamic value is
 * HTML-escaped; the page has no script and only one inline style block, allowed by a per-response
 * CSP nonce.
 */
import type { ConfirmationPreview } from "../tools/types.js";
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
After approving, return to your assistant: it runs the action when it calls the tool again.</p>`;
  return page("Approve sevDesk action", body, styleNonce);
}

/** A page with a title and one paragraph of trusted text (results, errors). */
export function renderMessagePage(title: string, message: string, styleNonce: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`, styleNonce);
}

function page(title: string, body: string, styleNonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(title)}</title>
<style nonce="${escapeHtml(styleNonce)}">${STYLE}</style>
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
