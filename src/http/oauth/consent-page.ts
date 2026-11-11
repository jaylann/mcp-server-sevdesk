/**
 * HTML of the consent page (`/authorize`), in two steps: the user picks the tiers and pastes the
 * sevDesk token (step `check`), then confirms the account the token belongs to (step `connect`).
 *
 * Everything shown that comes from outside is untrusted and escaped (the `markup` tag escapes every
 * value it interpolates): the client's self-declared name (sanitized, labelled as self-declared),
 * the account name from sevDesk. The client host and the redirect host come from validated URLs.
 * The page has no script, one nonce'd style block, and posts only to `/authorize`; the sevDesk
 * token is never echoed back into a page.
 *
 * The consent form is the first form of the page, and its controls keep their names (`consent`,
 * `csrf`, `tier`, `sevdesk_token`, `step`): the browser posts them back to `/authorize`.
 */
import { badge, callout, facts } from "../../pages/components.js";
import type { RenderContext } from "../../pages/context.js";
import { renderFrame } from "../../pages/frame.js";
import { type Html, markup, trusted } from "../../pages/html.js";
import { icon } from "../../pages/icons.js";
import { requiresConfirmation, type Tier } from "../../safety/tiers.js";

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
  /** The server runs commit and external actions without asking (`SEVDESK_CONFIRM=off`). */
  readonly unconfirmed: boolean;
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
  /** See {@link TokenStepModel.unconfirmed}. */
  readonly unconfirmed: boolean;
}

/** The badge colour of each tier, as on the website. */
const TIER_TONE = { read: "ok", write: "info", commit: "approve", external: "danger" } as const;

/** Where the reader is in the two steps. */
function steps(current: 1 | 2, ctx: RenderContext): Html {
  const t = ctx.t.connect.steps;
  const step = (number: 1 | 2, label: string): Html => {
    const state = number === current ? "now" : number < current ? "done" : "next";
    const mark = state === "done" ? icon("check", 2.25) : String(number);
    const here = state === "now" ? trusted(' aria-current="step"') : "";
    return markup`<li class="step step-${state}"${here}><span class="step-mark">${mark}</span>${label}</li>`;
  };
  return markup`<ol class="steps">${step(1, t.token)}${step(2, t.confirm)}</ol>`;
}

/** Who asks: the app's host, what it calls itself, and where the browser goes afterwards. */
function clientSection(client: ConsentClientView, ctx: RenderContext): Html {
  const t = ctx.t.connect;
  const redirect = markup`<strong>${client.redirectHost}</strong>`;
  const name =
    client.name === undefined ? "" : markup`<p class="small">${t.selfDeclared(client.name)}</p>\n`;
  const back = client.loopbackOnly
    ? callout(t.loopback(redirect), { icon: "alert" })
    : markup`<p class="small">${t.returns(redirect)}</p>`;
  return markup`<section class="sheet app">
<p>${t.wants(markup`<strong>${client.host}</strong>`)}</p>
${name}${back}
</section>`;
}

function hidden(consent: string, csrf: string): Html {
  return markup`<input type="hidden" name="consent" value="${consent}">
<input type="hidden" name="csrf" value="${csrf}">`;
}

/**
 * A tier as a badge with its name, and what it allows in plain words. With `unconfirmed` the
 * confirmed tiers lose their lock and say they run without asking: the page must not promise an
 * approval the server will not ask for (security review 2026-11, wave 2).
 */
function tierLine(tier: Tier, ctx: RenderContext, unconfirmed: boolean): Html {
  const asks = requiresConfirmation(tier) && !unconfirmed;
  const words =
    unconfirmed && (tier === "commit" || tier === "external")
      ? ctx.t.tiersUnconfirmed[tier]
      : ctx.t.tiers[tier];
  const mark = asks ? icon("lock") : markup`<span class="tier-dot"></span>`;
  const name = badge(markup`${mark}<strong>${words.label}</strong>`, TIER_TONE[tier]);
  return markup`<span class="tier-words">${name}<span class="small">${words.text}</span></span>`;
}

/** The first step: tier checkboxes and the token field. */
export function renderTokenStep(model: TokenStepModel, ctx: RenderContext): string {
  const t = ctx.t.connect;
  const chosen = new Set(model.chosen);
  const tiers = model.offered.map((tier) => {
    if (tier === "read") {
      return markup`<label class="tier"><input type="checkbox" checked disabled> ${tierLine(tier, ctx, model.unconfirmed)}</label>
<input type="hidden" name="tier" value="read">\n`;
    }
    const ticked = chosen.has(tier) ? trusted(" checked") : "";
    return markup`<label class="tier"><input type="checkbox" name="tier" value="${tier}"${ticked}> ${tierLine(tier, ctx, model.unconfirmed)}</label>\n`;
  });
  const error =
    model.error === undefined
      ? ""
      : markup`${callout(model.error, { tone: "danger", icon: "alert", alert: true })}\n`;
  const body = markup`${steps(1, ctx)}
<h1>${t.heading}</h1>
${clientSection(model.client, ctx)}
<form method="post" action="/authorize" class="sheet">
${hidden(model.consent, model.csrf)}
<fieldset class="tiers">
<legend>${t.legend}</legend>
${tiers}<p class="hint">${model.unconfirmed ? t.tiersHintUnconfirmed : t.tiersHint}</p>
</fieldset>
<label for="sevdesk-token" class="field">${t.tokenLabel}</label>
<input id="sevdesk-token" type="password" name="sevdesk_token" autocomplete="off" spellcheck="false" required minlength="32" maxlength="32">
<p class="hint">${t.tokenHint}</p>
${error}<div class="actions form-actions">
<button type="submit" name="step" value="check" class="btn btn-ink">${t.check}</button>
<button type="submit" name="step" value="deny" class="btn btn-ghost" formnovalidate>${t.cancel}</button>
</div>
</form>`;
  return renderFrame({ title: t.title, body }, ctx);
}

/** The second step: the account the token belongs to, and the final confirmation. */
export function renderConfirmStep(model: ConfirmStepModel, ctx: RenderContext): string {
  const t = ctx.t.connect;
  const account = facts(
    [
      { label: t.account, value: markup`<strong>${model.accountId}</strong>` },
      ...(model.accountName === undefined
        ? []
        : [{ label: t.accountName, value: t.quoted(model.accountName), long: false }]),
    ],
    { plain: true },
  );
  const granted = model.tiers.map(
    (tier) => markup`<li>${tierLine(tier, ctx, model.unconfirmed)}</li>\n`,
  );
  const body = markup`${steps(2, ctx)}
<h1>${t.confirmHeading(model.accountId)}</h1>
${clientSection(model.client, ctx)}
<form method="post" action="/authorize" class="sheet">
${hidden(model.consent, model.csrf)}
${account}
<p class="field may">${t.mayLabel}</p>
<ul class="granted">
${granted}</ul>
<div class="actions form-actions">
<button type="submit" name="step" value="connect" class="btn btn-ink">${t.submit}</button>
<button type="submit" name="step" value="deny" class="btn btn-ghost">${t.cancel}</button>
</div>
</form>
<p class="fine after">${t.fine(markup`<code>mcp-server-sevdesk grants revoke</code>`)}</p>`;
  return renderFrame({ title: t.title, body }, ctx);
}
