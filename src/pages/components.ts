/**
 * The building blocks the pages share. Each returns {@link Html}; text passed in is escaped by
 * the `markup` tag, so callers hand over plain strings (also untrusted ones) and markup they
 * built with `markup` themselves.
 */
import { type Html, type HtmlValue, markup, trusted } from "./html.js";
import { icon, type IconName } from "./icons.js";

type BadgeTone = "plain" | "approve" | "ok" | "info" | "danger";

/** A pill: a status or a permission tier. */
export function badge(content: HtmlValue, tone: BadgeTone = "plain"): Html {
  return markup`<span class="badge${tone === "plain" ? "" : ` badge-${tone}`}">${content}</span>`;
}

/**
 * A note the reader must not miss. Monochrome with an ink bar by default (as the website's
 * callouts); `danger` is for what cannot be undone or was refused, `note` for an aside. With
 * `alert`, assistive technology announces it when the page loads (a failed form).
 */
export function callout(
  content: HtmlValue,
  options: {
    readonly tone?: "danger" | "note";
    readonly icon?: IconName;
    readonly alert?: boolean;
  } = {},
): Html {
  const tone = options.tone === undefined ? "" : ` callout-${options.tone}`;
  const role = options.alert === true ? trusted(' role="alert"') : "";
  const sign = icon(options.icon ?? "info");
  return markup`<div class="callout${tone}"${role}>${sign}<div>${content}</div></div>`;
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
 * A rubber stamp, the pages' one loud element: it stands for the thing a model can never do by
 * itself, a human's decision. The same drawing as on the website (`components/system/stamp.tsx`):
 * a double frame around the word, printed through an SVG filter that speckles and slightly warps
 * the ink. The filter is referenced inside the same SVG, so nothing is fetched.
 *
 * Decoration: the heading next to it says the same, so the stamp is hidden from assistive
 * technology. `tone` is `approve` (stamp ink) for an approval, `plain` (ink) otherwise.
 */
export function stamp(word: string, tone: "approve" | "plain"): Html {
  const text = word.toUpperCase();
  const width = Math.max(180, Array.from(text).length * 21 + 56);
  const height = 74;
  return markup`<div class="stamp stamp-${tone}" aria-hidden="true"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<defs><filter id="stamp-ink" x="-5%" y="-5%" width="110%" height="110%">
<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" result="grain"/>
<feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -5.5 4.55" result="holes"/>
<feComposite in="SourceGraphic" in2="holes" operator="in" result="inked"/>
<feTurbulence type="turbulence" baseFrequency="0.035" numOctaves="2" seed="9" result="warp"/>
<feDisplacementMap in="inked" in2="warp" scale="2.6" xChannelSelector="R" yChannelSelector="G"/>
</filter></defs>
<g filter="url(#stamp-ink)" fill="currentColor" stroke="currentColor">
<rect x="3" y="3" width="${width - 6}" height="${height - 6}" rx="9" fill="none" stroke-width="4.5"/>
<rect x="10.5" y="10.5" width="${width - 21}" height="${height - 21}" rx="4" fill="none" stroke-width="1.5"/>
<text class="stamp-word" x="${width / 2}" y="49" text-anchor="middle" textLength="${width - 52}" lengthAdjust="spacingAndGlyphs" stroke="none" font-size="31">${text}</text>
</g></svg></div>`;
}

/** Values longer than this, or with a line break, get the full width of the sheet. */
const LONG_VALUE = 72;

/**
 * Label and value rows, like the lines of a ledger. Values keep their line breaks
 * (`white-space: pre-wrap` in the stylesheet) and are never cut or scrolled: what the reader
 * decides on is shown in full. Nothing but the value goes between `<dd>` and `</dd>`: any
 * whitespace there would show.
 */
export function facts(
  rows: readonly { readonly label: string; readonly value: HtmlValue; readonly long?: boolean }[],
  options: { readonly plain?: boolean } = {},
): Html {
  if (rows.length === 0) return trusted("");
  const cells = rows.map((row) => {
    const long =
      row.long ??
      (typeof row.value === "string" &&
        (row.value.includes("\n") || row.value.length > LONG_VALUE));
    const wide = long ? trusted(' class="long"') : "";
    return markup`<dt${wide}>${row.label}</dt><dd>${row.value}</dd>`;
  });
  return markup`<dl class="facts${options.plain === true ? " facts-plain" : ""}">${cells}</dl>`;
}
