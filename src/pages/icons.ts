/**
 * The pictograms of the server's own pages, as inline SVG (the pages' CSP loads no images besides
 * the favicon). Drawn in ink like the website's: strokes with round caps and joins on a 24-unit
 * grid, no fills except small dots. A stroke marked as accent is stamp ink, used only where a
 * human approves. Colours come from the stylesheet (`.ink`, `.ink-accent`, `.dot` in `theme.ts`),
 * because the CSP allows no `style` attributes.
 *
 * Every icon here is decoration next to text that says the same, so each is `aria-hidden`.
 */
import { type Html, trusted } from "./html.js";

type Shape =
  | { readonly d: string; readonly accent?: true }
  | { readonly dot: readonly [cx: number, cy: number, r: number] };

const CIRCLE = "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z";

const ICONS = {
  /** A rubber stamp from the side, and the impression it leaves. */
  stamp: [
    { d: "M10 5.5V3.75a2 2 0 0 1 4 0V5.5" },
    { d: "M10.5 5.5h3v3h-3z" },
    { d: "M5.5 8.5h13v4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-4z" },
    { d: "M7 17.5h10", accent: true },
    { d: "M9 20.5h6", accent: true },
  ],
  lock: [
    { d: "M7 11h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" },
    { d: "M8.5 11V8a3.5 3.5 0 0 1 7 0v3" },
    { dot: [12, 15.5, 1] },
  ],
  /** An envelope with a seal: the approval inbox. */
  envelope: [
    { d: "M3 6h18v12H3z" },
    { d: "M3 6l9 7 9-7" },
    { d: "M20.25 15a2.75 2.75 0 1 1-5.5 0 2.75 2.75 0 0 1 5.5 0z", accent: true },
    { d: "M16.25 15.1l.9.9 1.7-1.9", accent: true },
  ],
  key: [
    { d: "M12 15a4 4 0 1 1-8 0 4 4 0 0 1 8 0z" },
    { d: "M11 12.25l9-9" },
    { d: "M17 6.25l2 2" },
    { d: "M14.75 8.5l2 2" },
    { dot: [8, 15, 0.9] },
  ],
  check: [{ d: "M5 12.5l4.5 4.5L19 7.5" }],
  cross: [{ d: "M6.5 6.5l11 11" }, { d: "M17.5 6.5l-11 11" }],
  clock: [{ d: CIRCLE }, { d: "M12 7v5l3.25 2" }],
  alert: [{ d: "M12 4.25L21 19.5H3L12 4.25z" }, { d: "M12 10.25v4" }, { dot: [12, 16.9, 0.9] }],
  info: [{ d: CIRCLE }, { d: "M12 11v5.5" }, { dot: [12, 7.75, 0.9] }],
  refresh: [
    { d: "M19.5 12a7.5 7.5 0 0 1-12.9 5.2" },
    { d: "M4.5 12a7.5 7.5 0 0 1 12.9-5.2" },
    { d: "M17.5 3.5V7H14" },
    { d: "M6.5 20.5V17H10" },
  ],
  upload: [{ d: "M12 15.5v-11" }, { d: "M7.5 9L12 4.5 16.5 9" }, { d: "M5 19.5h14" }],
  file: [{ d: "M7 3h7.5L19 7.5V21H7z" }, { d: "M14.5 3v4.5H19" }],
} as const satisfies Readonly<Record<string, readonly Shape[]>>;

export type IconName = keyof typeof ICONS;

function shape(part: Shape): string {
  if ("dot" in part) {
    const [cx, cy, r] = part.dot;
    return `<circle class="dot" cx="${String(cx)}" cy="${String(cy)}" r="${String(r)}"/>`;
  }
  return `<path${part.accent === true ? ' class="ink-accent"' : ""} d="${part.d}"/>`;
}

/**
 * The icon `name`. Its size comes from the stylesheet (the element it sits in); `stroke` is the
 * line width on the 24-unit grid: 1.75 for icons of text size, less for large ones.
 */
export function icon(name: IconName, stroke = 1.75): Html {
  return trusted(
    `<svg class="ink" viewBox="0 0 24 24" stroke-width="${String(stroke)}" aria-hidden="true">` +
      `${ICONS[name].map(shape).join("")}</svg>`,
  );
}

/**
 * The mark of sevDesk MCP: a round office stamp (Rundstempel) with a tick in stamp ink, as on the
 * website (`components/system/wordmark.tsx`).
 */
export const SEAL: Html = trusted(
  '<svg class="ink" viewBox="0 0 32 32" aria-hidden="true">' +
    '<circle cx="16" cy="16" r="14.25" stroke-width="2.5"/>' +
    '<circle cx="16" cy="16" r="10.25" stroke-width="1" stroke-dasharray="1.6 1.9" stroke-linecap="butt"/>' +
    '<path class="ink-accent" d="M10.6 16.4l3.6 3.5 7.4-8" stroke-width="3"/></svg>',
);
