/**
 * HTML for the approval pages of `SEVDESK_CONFIRM=browser`: the approval page itself and the page
 * after a decision (shared by the local 127.0.0.1 page and the HTTP server's inbox), and the
 * inbox's list and sign-in pages.
 *
 * Every page is built with the `markup` tag of `src/pages/html.ts`, which escapes every value it
 * interpolates, and set into the shared frame (`src/pages/frame.ts`): no script, one inline style
 * block allowed by a per-response CSP nonce. The texts come from `src/pages/text` in the
 * request's language.
 *
 * What the preview says (the action, its warnings and facts) comes from the tool that asked and
 * may contain sevDesk text; it is sanitized before it gets here (`displayPreview`) and shown
 * inside the sheet, apart from the page's own words. The page never cuts or scrolls a value, and
 * shows the warnings before the facts: the reader passes everything before reaching the buttons.
 */
import { badge, callout, facts, pageTime, reference, stamp } from "../pages/components.js";
import type { RenderContext } from "../pages/context.js";
import { renderFrame } from "../pages/frame.js";
import { type Html, markup } from "../pages/html.js";
import { icon } from "../pages/icons.js";
import type { Locale } from "../pages/locale.js";
import type { ApprovalBinding, ApprovalStatus } from "./approval-types.js";
import { shownValue } from "./preview.js";
import type { WriteTier } from "./tiers.js";
import type { ConfirmationPreview } from "./write-types.js";

/** What the approval page shows. */
export interface ApprovalPageModel {
  readonly toolName: string;
  readonly toolTitle: string;
  readonly tier: WriteTier;
  /** Already sanitized with `displayPreview`. */
  readonly preview: ConfirmationPreview;
  /** The record changed after the human was first asked: the page says so above the preview. */
  readonly recordChanged: boolean;
  /** The non-secret reference code the assistant was given, so the user can match them. */
  readonly reference: string;
  /** ISO 8601 (UTC). */
  readonly createdAt: string;
  /** ISO 8601 (UTC). */
  readonly expiresAt: string;
  /** The time the page is rendered at (epoch milliseconds), for the time left. */
  readonly now: number;
  readonly formAction: string;
  readonly csrf: string;
  /** Inbox only: a link back to the list (the local page has none). */
  readonly inboxHref?: string;
}

/** What the page after a decision shows. */
export interface DecisionPageModel {
  readonly decision: Exclude<ApprovalStatus, "pending">;
  readonly reference: string;
  /** The preview's action sentence (already sanitized with `displayPreview`). */
  readonly action: string;
  /** Inbox only: a link back to the list. */
  readonly inboxHref?: string;
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
  /**
   * Where to go after signing in (a validated path such as `/uploads/<id>`), sent back in a
   * hidden field. Absent: the server's default (the inbox).
   */
  readonly next?: string | undefined;
  /** Wording of the page: approving actions (default) or uploading and downloading files. */
  readonly purpose?: "approvals" | "files" | undefined;
}

/** The badge colour of each tier, as on the website: commit is stamp ink, external is storno. */
const TIER_TONE = { write: "info", commit: "approve", external: "danger" } as const;

/**
 * The time left, as CSS for this response: the seconds until the request expires (`--ttl`,
 * `--secs`) and how much of its lifetime that is (`--part`). The stylesheet drains a bar over
 * that time and, when it is up, hides the buttons and shows that the request has expired, all
 * without script. Built from numbers only.
 */
function expiryCss(model: ApprovalPageModel): string {
  const expires = Date.parse(model.expiresAt);
  const lifetime = Math.max(1, expires - Date.parse(model.createdAt));
  const left = Math.min(lifetime, Math.max(0, expires - model.now));
  const seconds = Math.ceil(left / 1000);
  const part = (left / lifetime).toFixed(4);
  return `:root{--ttl:${String(seconds)}s;--secs:${String(seconds)};--part:${part}}`;
}

/**
 * The preview a reader of `locale` gets: the German one for German when the tool wrote it
 * (every tool a human confirms does), else the English one. The approval is bound to both.
 */
export function previewFor(
  binding: Pick<ApprovalBinding, "preview" | "previewDe">,
  locale: Locale,
): ConfirmationPreview {
  return locale === "de" ? (binding.previewDe ?? binding.preview) : binding.preview;
}

/** The page with the preview and the Approve / Reject form. */
export function renderApprovalPage(model: ApprovalPageModel, ctx: RenderContext): string {
  const t = ctx.t.approval;
  const { preview } = model;
  const warnings: Html[] = preview.warnings.map(
    (warning) => markup`<li>${callout(warning, { icon: "alert" })}</li>`,
  );
  if (preview.irreversible) {
    const line = markup`<strong>${t.irreversible}</strong>`;
    warnings.push(markup`<li>${callout(line, { tone: "danger", icon: "alert" })}</li>`);
  }
  const consequences = warnings.length === 0 ? "" : markup`<ul class="callouts">${warnings}</ul>\n`;
  const rows = preview.facts.map((fact) => ({ label: fact.label, value: shownValue(fact.value) }));
  const changed = model.recordChanged
    ? markup`<div class="notice">${callout(t.changed, { icon: "refresh" })}</div>\n`
    : "";
  const tier = badge(markup`${icon("lock")}${t.tier[model.tier]}`, TIER_TONE[model.tier]);
  const code = markup`<span class="fine">${t.reference}</span> ${reference(model.reference)}`;
  const back =
    model.inboxHref === undefined
      ? ""
      : markup`\n<p class="small after"><a href="${model.inboxHref}">${ctx.t.inbox.back}</a></p>`;
  const body = markup`<p class="eyebrow">${icon("stamp")}${t.eyebrow}</p>
<h1>${t.heading}</h1>
<p class="lead">${t.lead}</p>
${changed}<section class="sheet">
<div class="sheet-head">${tier}<span class="ref-line">${code}</span></div>
<h2>${preview.action}</h2>
<p class="meta">${t.tool(markup`<code>${model.toolName}</code>`, model.toolTitle)}</p>
${consequences}${facts(rows)}
<form method="post" action="${model.formAction}" class="strip">
<input type="hidden" name="csrf" value="${model.csrf}">
<p class="live">${t.unless}</p>
<p class="late">${t.expired}</p>
<div class="actions live">
<button type="submit" name="decision" value="reject" class="btn btn-outline">${t.reject}</button>
<button type="submit" name="decision" value="approve" class="btn btn-approve">${icon("stamp")}${t.approve}</button>
</div>
</form>
</section>
<div class="expiry">
<div class="meter"><i></i></div>
<p class="fine"><span class="clock-line">${t.expiresIn} <span class="clock"></span>. </span>${t.validUntil(pageTime(model.expiresAt))} ${t.once} ${t.sameCode}</p>
</div>
<p class="small next">${t.next}</p>${back}`;
  return renderFrame({ title: t.title, body, css: expiryCss(model) }, ctx);
}

/**
 * The page after a decision: the stamp, what was decided (the reference code and the action) and
 * what to do next.
 */
export function renderDecisionPage(model: DecisionPageModel, ctx: RenderContext): string {
  const approved = model.decision === "approved";
  const text = approved ? ctx.t.inbox.approved : ctx.t.inbox.rejected;
  const back =
    model.inboxHref === undefined
      ? ""
      : markup`\n<p class="after"><a href="${model.inboxHref}">${ctx.t.inbox.back}</a></p>`;
  const decided = facts([
    { label: ctx.t.approval.reference, value: reference(model.reference) },
    { label: ctx.t.approval.decided.action, value: model.action, long: false },
  ]);
  const body = markup`<section class="sheet struck">
${stamp(text.title, approved ? "approve" : "plain")}
<h1>${text.title}</h1>
<p class="message">${text.message}</p>
${decided}${back}
</section>`;
  return renderFrame({ title: text.title, body }, ctx);
}

const STATUS_TONE = { pending: "approve", approved: "ok", rejected: "plain" } as const;

function renderInboxItem(item: InboxItem, ctx: RenderContext): Html {
  const t = ctx.t.inboxPage;
  const time = pageTime(item.expiresAt);
  const when =
    item.status === "pending"
      ? t.expires(time)
      : item.status === "approved"
        ? t.runnableUntil(time)
        : undefined;
  const until = when === undefined ? "" : markup` <span class="fine">${when}</span>`;
  const review =
    item.status === "pending"
      ? markup`\n<span class="btn btn-outline btn-sm" aria-hidden="true">${t.review}</span>`
      : "";
  return markup`<li class="row row-${item.status}">
<div class="row-main">
<p class="row-title"><a href="${item.href}">${item.action}</a></p>
<p class="row-meta">${t.tool(markup`<code>${item.toolName}</code>`, item.toolTitle)} ${reference(item.reference)}</p>
<p class="row-status">${badge(t.status[item.status], STATUS_TONE[item.status])}${until}</p>
</div>${review}
</li>`;
}

/** The inbox: the account's approvals (newest first) with links to their pages, and sign-out. */
export function renderInboxPage(model: InboxPageModel, ctx: RenderContext): string {
  const t = ctx.t.inboxPage;
  const waiting = model.items.filter((item) => item.status === "pending").length;
  const refresh = markup`<a class="btn btn-outline btn-sm" href="${model.inboxHref}">${icon("refresh")}${t.refresh}</a>`;
  const count = badge(t.waiting(waiting), waiting === 0 ? "plain" : "approve");
  const list =
    model.items.length === 0
      ? markup`<div class="empty">${icon("envelope", 1.25)}
<h2>${t.emptyTitle}</h2>
<p>${t.empty}</p>
${refresh}
</div>`
      : markup`<div class="sheet-head">${count}${refresh}</div>
<ul class="rows">
${model.items.map((item) => markup`${renderInboxItem(item, ctx)}\n`)}</ul>`;
  const body = markup`<div class="title-row">
<h1>${t.heading}</h1>
<form method="post" action="${model.logoutAction}">
<input type="hidden" name="csrf" value="${model.csrf}">
<button type="submit" class="btn btn-ghost btn-sm">${t.signOut}</button>
</form>
</div>
<p class="lead">${t.lead(markup`<strong>${model.accountId}</strong>`)}</p>
<section class="sheet">
${list}
</section>
<p class="fine after">${t.fine}</p>`;
  return renderFrame({ title: t.title, body, wide: true }, ctx);
}

/**
 * The inbox sign-in form: the sevDesk API token proves the account. Shows no approval data, and
 * warns to enter the token only on this server's host (lookalike pages could phish it).
 */
export function renderLoginPage(model: LoginPageModel, ctx: RenderContext): string {
  const t = ctx.t.signIn;
  const words = model.purpose === "files" ? t.files : t.approvals;
  const note =
    model.message === undefined
      ? ""
      : markup`${callout(model.message, { tone: "danger", icon: "alert", alert: true })}\n`;
  const next =
    model.next === undefined
      ? ""
      : markup`<input type="hidden" name="next" value="${model.next}">\n`;
  const body = markup`<h1>${words.heading}</h1>
<p class="lead">${words.lead}</p>
<section class="sheet">
${note}<div class="address">${icon("lock")}<span>${model.host}</span></div>
<p class="small">${t.onlyOn(markup`<strong>${model.host}</strong>`)}</p>
<form method="post" action="${model.formAction}" class="login">
<label for="token">${t.tokenLabel}</label>
<input type="password" id="token" name="token" autocomplete="off" spellcheck="false" maxlength="256" required>
<p class="hint">${t.where}</p>
${next}<button type="submit" class="btn btn-ink">${t.submit}</button>
</form>
</section>
<p class="fine after">${t.fine(model.sessionHours)}</p>`;
  return renderFrame({ title: words.title, body }, ctx);
}

/** An ISO 8601 time as the pages show it: `2026-11-09 12:15 UTC`. */
export function formatPageTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
