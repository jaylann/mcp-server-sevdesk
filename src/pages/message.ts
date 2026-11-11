/**
 * The page that says one thing: a result, an error, an expired link. A title and one paragraph of
 * trusted text (`src/pages/text`), an icon for its tone and, where there is somewhere to go, one
 * link. Used by every part of the server that shows pages.
 */
import type { RenderContext } from "./context.js";
import { renderFrame } from "./frame.js";
import { markup } from "./html.js";
import { icon, type IconName } from "./icons.js";
import type { PageMessage } from "./text/index.js";

/**
 * How a message reads at a glance:
 * - `ok`: it worked;
 * - `info`: a neutral fact (signed out, nothing found);
 * - `wait`: time is the cause or the cure (expired, busy, too many attempts);
 * - `danger`: refused or failed.
 */
export type MessageTone = "ok" | "info" | "wait" | "danger";

/** A trusted link below a message (e.g. back to the inbox). */
export interface PageLink {
  readonly href: string;
  readonly label: string;
}

/** The tone that fits an HTTP status, for pages that do not choose one. */
export function toneForStatus(status: number): MessageTone {
  if (status === 408 || status === 410 || status === 429 || status === 503) return "wait";
  if (status === 404 || status === 409 || status < 400) return "info";
  return "danger";
}

const TONE_ICON: Readonly<Record<MessageTone, IconName>> = {
  ok: "check",
  info: "info",
  wait: "clock",
  danger: "alert",
};

const TONE_CLASS: Readonly<Record<MessageTone, string>> = {
  ok: " result-ok",
  info: "",
  wait: "",
  danger: " result-danger",
};

/** A page with a title and one paragraph of trusted text, optionally a link. */
export function renderMessagePage(
  text: PageMessage,
  ctx: RenderContext,
  options: { readonly tone?: MessageTone; readonly link?: PageLink } = {},
): string {
  const tone = options.tone ?? "info";
  const { link } = options;
  const after =
    link === undefined
      ? ""
      : markup`\n<p class="after"><a href="${link.href}">${link.label}</a></p>`;
  const body = markup`<section class="sheet">
<div class="result-icon${TONE_CLASS[tone]}">${icon(TONE_ICON[tone], 2)}</div>
<h1>${text.title}</h1>
<p class="message">${text.message}</p>${after}
</section>`;
  return renderFrame({ title: text.title, body }, ctx);
}
