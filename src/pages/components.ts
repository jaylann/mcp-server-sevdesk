/**
 * The building blocks the pages share, after the Lanfermann system's components (`Badge`,
 * `Alert`, the dot of its marks). Each returns {@link Html}; text passed in is escaped by the
 * `markup` tag, so callers hand over plain strings (also untrusted ones) and markup they built
 * with `markup` themselves.
 */
import { type Html, type HtmlValue, markup, trusted } from "./html.js";
import { icon, type IconName } from "./icons.js";

/** The tones of a badge or an alert: neutral, or one of the system's status colours. */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** One or two words in a small label: a status or a permission tier. */
export function badge(content: HtmlValue, tone: Tone = "neutral"): Html {
  return markup`<span class="badge${tone === "neutral" ? "" : ` badge-${tone}`}">${content}</span>`;
}

/**
 * The system's mark, from ring to disc, in the states the pages need: a ring is open (rejected,
 * not yet), a faint ring is still ahead, a disc in the text colour is done by the machine, an
 * accent ring waits for a person and an accent disc is a person's decision. Decoration: the
 * words next to it say the same.
 */
export function dot(state: "open" | "faint" | "done" | "waits" | "chosen"): Html {
  return trusted(
    `<span class="dot${state === "open" ? "" : ` dot-${state}`}" aria-hidden="true"></span>`,
  );
}

const TONE_ICON: Readonly<Record<Tone, IconName>> = {
  neutral: "info",
  info: "info",
  success: "done",
  warning: "alert",
  danger: "danger",
};

/**
 * A message the reader must not miss: words with an icon on a soft wash of the tone (the system's
 * `Alert`). `danger` is for what cannot be undone or was refused, `warning` for a consequence to
 * weigh. With `alert`, assistive technology announces it when the page loads (a failed form).
 */
export function callout(
  content: HtmlValue,
  options: {
    readonly tone?: Tone;
    readonly icon?: IconName;
    readonly alert?: boolean;
  } = {},
): Html {
  const tone = options.tone ?? "neutral";
  const kind = tone === "neutral" ? "" : ` alert-${tone}`;
  const role = options.alert === true ? trusted(' role="alert"') : "";
  const sign = icon(options.icon ?? TONE_ICON[tone]);
  return markup`<div class="alert${kind}"${role}>${sign}<div>${content}</div></div>`;
}

/**
 * The short code a request is known by in the assistant's messages and on the page, so the
 * reader can match the two. Not a secret.
 */
export function reference(code: string): Html {
  return markup`<span class="ref"><strong>${code}</strong></span>`;
}

/**
 * A UTC time as the pages show it (`2026-11-09 12:15 UTC`), kept on one line. The pages have no
 * script, so they cannot show the reader's local time.
 */
export function pageTime(iso: string): Html {
  const shown = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  return markup`<time class="nb" datetime="${iso}">${shown}</time>`;
}

/**
 * The checkpoint at the top of the page after a decision, as on the website: a hairline with the
 * mark in its middle, an accent disc when the person approved, an open ring when they rejected.
 * Decoration: the heading below says the same.
 */
export function checkpoint(approved: boolean): Html {
  return markup`<div class="checkpoint" aria-hidden="true">${dot(approved ? "chosen" : "open")}</div>`;
}

/** Values longer than this, or with a line break, are set as a block under their label. */
const LONG_VALUE = 72;
/** Values longer than this get a row of their own instead of half of one. */
const WIDE_VALUE = 32;

/**
 * Label and value pairs. On a wide screen two short pairs share a row; a longer value gets the
 * row to itself (`fact-wide`), and a value with a line break or longer still is set as a block
 * under its label (`fact-long`). `long: false` keeps a long value beside its label. Values keep
 * their line breaks (`white-space: pre-wrap` in the stylesheet) and are never cut or scrolled:
 * what the reader decides on is shown in full, in the order given. Nothing but the value goes
 * between `<dd>` and `</dd>`: any whitespace there would show.
 */
export function facts(
  rows: readonly { readonly label: string; readonly value: HtmlValue; readonly long?: boolean }[],
  options: { readonly plain?: boolean } = {},
): Html {
  if (rows.length === 0) return trusted("");
  const cells = rows.map((row) => {
    const text = typeof row.value === "string" ? row.value : undefined;
    const long =
      row.long ?? (text !== undefined && (text.includes("\n") || text.length > LONG_VALUE));
    const wide = !long && (row.long === false || (text?.length ?? 0) > WIDE_VALUE);
    const kind = long ? " fact-long" : wide ? " fact-wide" : "";
    return markup`<div class="fact${kind}"><dt>${row.label}</dt><dd>${row.value}</dd></div>`;
  });
  return markup`<dl class="facts${options.plain === true ? " facts-plain" : ""}">${cells}</dl>`;
}
