/**
 * HTML of the consent page (`/authorize`), in two steps: the user picks the tiers and pastes the
 * sevDesk token (step `check`), then confirms the account the token belongs to (step `connect`).
 *
 * Everything shown that comes from outside is untrusted and escaped: the client's self-declared
 * name (sanitized, labelled as self-declared), the account name from sevDesk. The client host and
 * the redirect host come from validated URLs. The page has no script, one nonce'd style block,
 * and posts only to `/authorize`; the sevDesk token is never echoed back into a page.
 */
import { escapeHtml } from "../../safety/approval-page.js";
import { type Tier, TIER_DESCRIPTIONS } from "../../safety/tiers.js";

/** The client as the consent page presents it. */
export interface ConsentClientView {
  /** Host of the `client_id` URL (validated DNS name). */
  readonly host: string;
  /** The client's self-declared name, sanitized; untrusted. */
  readonly name: string | undefined;
  /** Host (and port, for loopback) of the validated redirect URI. */
  readonly redirectHost: string;
  /** The redirect URI is loopback: the client is an app on the user's machine, not a website. */
  readonly loopbackOnly: boolean;
}

/** Step 1: tiers and token. */
export interface TokenStepModel {
  readonly client: ConsentClientView;
  /** Tiers the user may choose (always starts with `read`, which is fixed). */
  readonly offered: readonly Tier[];
  /** Tiers ticked when the page is shown again after an error. */
  readonly chosen: readonly Tier[];
  /** The sealed consent state. */
  readonly consent: string;
  readonly csrf: string;
  /** Trusted text shown above the token field after a failed check. */
  readonly error: string | undefined;
}

/** Step 2: confirm the account. */
export interface ConfirmStepModel {
  readonly client: ConsentClientView;
  readonly tiers: readonly Tier[];
  readonly accountId: string;
  /** The company name from sevDesk, sanitized; untrusted. */
  readonly accountName: string | undefined;
  readonly consent: string;
  readonly csrf: string;
}

const TIER_LABELS: Readonly<Record<Tier, string>> = {
  read: "Read",
  write: "Write",
  commit: "Commit",
  external: "External",
};

function clientSection(client: ConsentClientView): string {
  const name =
    client.name === undefined
      ? ""
      : `<p class="small">It calls itself “${escapeHtml(client.name)}” (self-declared, not verified).</p>\n`;
  const back = client.loopbackOnly
    ? `<p class="notice">This app runs on your own computer: after connecting, your browser returns to
<strong>${escapeHtml(client.redirectHost)}</strong>. Continue only if you just started connecting from an app on this device.</p>`
    : `<p>After connecting, your browser returns to <strong>${escapeHtml(client.redirectHost)}</strong>.</p>`;
  return `<section class="card">
<p>The app at <strong>${escapeHtml(client.host)}</strong> wants to use your sevDesk account through this server.</p>
${name}${back}
</section>`;
}

function hidden(consent: string, csrf: string): string {
  return `<input type="hidden" name="consent" value="${escapeHtml(consent)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function tierLine(tier: Tier): string {
  return `<strong>${escapeHtml(TIER_LABELS[tier])}</strong>: ${escapeHtml(TIER_DESCRIPTIONS[tier])}`;
}

/** The first step: tier checkboxes and the token field. */
export function renderTokenStep(model: TokenStepModel, nonce: string): string {
  const chosen = new Set(model.chosen);
  const tiers = model.offered
    .map((tier) =>
      tier === "read"
        ? `<label><input type="checkbox" checked disabled> ${tierLine(tier)}</label>
<input type="hidden" name="tier" value="read">`
        : `<label><input type="checkbox" name="tier" value="${escapeHtml(tier)}"${chosen.has(tier) ? " checked" : ""}> ${tierLine(tier)}</label>`,
    )
    .join("\n");
  const error =
    model.error === undefined
      ? ""
      : `<p class="error" role="alert">${escapeHtml(model.error)}</p>\n`;
  const body = `<h1>Connect an app to sevDesk</h1>
${clientSection(model.client)}
<form method="post" action="/authorize">
${hidden(model.consent, model.csrf)}
<fieldset>
<legend>What may it do?</legend>
${tiers}
<p class="small">Commit and external actions still ask you to approve each one.</p>
</fieldset>
<label for="sevdesk-token" class="field">Your sevDesk API token</label>
<input id="sevdesk-token" type="password" name="sevdesk_token" autocomplete="off" spellcheck="false" required minlength="32" maxlength="32">
<p class="small">In sevDesk: Settings → Users → API token. It is encrypted into this connection and
not stored on the server in readable form. Anyone with access to the app can use sevDesk within the
tiers you choose here, until you disconnect.</p>
${error}<div class="actions">
<button type="submit" name="step" value="check" class="primary">Check token</button>
<button type="submit" name="step" value="deny" formnovalidate>Cancel</button>
</div>
</form>`;
  return page("Connect to sevDesk", body, nonce);
}

/** The second step: the account the token belongs to, and the final confirmation. */
export function renderConfirmStep(model: ConfirmStepModel, nonce: string): string {
  const name =
    model.accountName === undefined ? "" : ` (named “${escapeHtml(model.accountName)}” in sevDesk)`;
  const tiers = model.tiers.map((tier) => `<li>${tierLine(tier)}</li>`).join("\n");
  const body = `<h1>Connect to sevDesk account ${escapeHtml(model.accountId)}?</h1>
${clientSection(model.client)}
<p>The token belongs to sevDesk account <strong>${escapeHtml(model.accountId)}</strong>${name}.
The app may:</p>
<ul>
${tiers}
</ul>
<form method="post" action="/authorize">
${hidden(model.consent, model.csrf)}
<div class="actions">
<button type="submit" name="step" value="connect" class="primary">Connect</button>
<button type="submit" name="step" value="deny">Cancel</button>
</div>
</form>
<p class="small">You can disconnect at any time in the app; the server's operator can revoke the
connection with <code>mcp-server-sevdesk grants revoke</code>.</p>`;
  return page("Connect to sevDesk", body, nonce);
}

/** A page with a title and one paragraph of trusted text (errors that end the flow). */
export function renderConsentError(title: string, message: string, nonce: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`, nonce);
}

function page(title: string, body: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(title)}</title>
<style nonce="${escapeHtml(nonce)}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --card: #fff; --line: #d8d8dc;
  --warn: #8a4b00; --accent: #0a5bd3; --no: #a1121b; }
@media (prefers-color-scheme: dark) { :root { --fg: #f2f2f4; --bg: #121214; --card: #1c1c1f;
  --line: #3a3a3f; --warn: #ffb15c; --accent: #6aa5ff; --no: #ff6b73; } }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; overflow-wrap: anywhere; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 0.75rem 1.25rem; margin: 1rem 0 1.5rem; overflow-wrap: anywhere; }
fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 0.75rem 1.25rem;
  margin: 0 0 1.25rem; }
fieldset label { display: block; margin: 0.35rem 0; }
.field { display: block; font-weight: 600; margin-bottom: 0.35rem; }
input[type=password] { font: inherit; width: 100%; box-sizing: border-box; padding: 0.5rem;
  border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); }
.actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem; }
button { font: inherit; padding: 0.6rem 1.4rem; border-radius: 8px; border: 1px solid var(--line);
  cursor: pointer; background: var(--card); color: var(--fg); }
button.primary { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.notice { border-left: 4px solid var(--warn); padding-left: 0.75rem; }
.error { color: var(--no); font-weight: 600; }
.small { font-size: 0.9rem; opacity: 0.8; }
`;
