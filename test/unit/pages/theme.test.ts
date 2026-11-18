import { describe, expect, it } from "vitest";

import {
  DARK_TOKENS,
  LIGHT_TOKENS,
  NARROW,
  PAGE_CSS,
  type TokenName,
} from "../../../src/pages/theme.js";

/** Relative luminance of `#rrggbb` (WCAG 2). */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio of two colours (WCAG 2), from 1 to 21. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Text on a background, as the pages combine them: at least 4.5:1 (WCAG AA). */
const TEXT_PAIRS: readonly (readonly [TokenName, TokenName])[] = [
  ["text", "ground"],
  ["text", "surface"],
  ["text", "surface-quiet"],
  ["text", "well"],
  ["text", "tint"],
  ["text-body", "ground"],
  ["text-body", "surface"],
  ["text-body", "surface-quiet"],
  ["text-body", "well"],
  ["text-body", "tint"],
  // Hints, labels of facts, the card's footer and the muted lines of the inbox.
  ["text-muted", "ground"],
  ["text-muted", "surface"],
  ["text-muted", "well"],
  // Links.
  ["accent", "ground"],
  ["accent", "surface"],
  ["on-key", "key"],
  ["on-key", "key-hover"],
  ["on-key", "key-pressed"],
  ["on-accent", "accent"],
  ["on-accent", "accent-hover"],
  ["on-accent", "accent-pressed"],
  // Badges, and the words and icons of alerts.
  ["info", "info-soft"],
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  ["text-body", "info-soft"],
  ["text-body", "success-soft"],
  ["text-body", "warning-soft"],
  ["text-body", "danger-soft"],
];

/** Shapes that carry meaning without text: at least 3:1 (WCAG 1.4.11). */
const GRAPHIC_PAIRS: readonly (readonly [TokenName, TokenName])[] = [
  // The outline of a field and a checkbox, the open dot, the drop zone (all on the surface).
  ["line", "surface"],
  ["line", "ground"],
  // A checked box, the dot of a person's decision, the focus ring.
  ["accent", "surface"],
  ["accent", "ground"],
  ["accent", "tint"],
  // The fill of the countdown in its trough.
  ["text", "trough"],
  ["key", "ground"],
  ["key", "surface"],
];

describe("page colours", () => {
  const schemes = { light: LIGHT_TOKENS, dark: DARK_TOKENS } as const;

  it.each(Object.entries(schemes))("keeps text readable in the %s scheme", (_name, tokens) => {
    for (const [text, background] of TEXT_PAIRS) {
      const ratio = contrast(tokens[text], tokens[background]);
      expect(ratio, `${text} on ${background}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(Object.entries(schemes))("keeps outlines and icons visible (%s)", (_name, tokens) => {
    for (const [shape, background] of GRAPHIC_PAIRS) {
      const ratio = contrast(tokens[shape], tokens[background]);
      expect(ratio, `${shape} on ${background}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("defines every token in both schemes, as six-digit hex colours", () => {
    expect(Object.keys(DARK_TOKENS).sort()).toEqual(Object.keys(LIGHT_TOKENS).sort());
    for (const tokens of [LIGHT_TOKENS, DARK_TOKENS]) {
      for (const [name, value] of Object.entries(tokens)) {
        expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("uses the Lanfermann system's Paper and Ink: Indigo for the ask, the key for other actions", () => {
    expect(LIGHT_TOKENS.accent).toBe("#5f50d0");
    expect(LIGHT_TOKENS.key).toBe("#24232f");
    expect(LIGHT_TOKENS.ground).toBe("#fbfbfd");
    expect(DARK_TOKENS.ground).toBe("#13121c");
    expect(DARK_TOKENS.accent).toBe("#a6a1fd");
  });
});

describe("page stylesheet", () => {
  it("is the system's, with Ink for a browser that prefers dark", () => {
    expect(PAGE_CSS).toMatch(/:root,\[data-theme=paper\][^{]*\{[^}]*--lf-ground:#fbfbfd/);
    expect(PAGE_CSS).toMatch(/\.dark,\[data-theme=ink\]\{[^}]*--lf-ground:#13121c/);
    expect(PAGE_CSS).toMatch(
      /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme\]\)\{color-scheme:dark;--lf-ground:#13121c/,
    );
    // Only what the pages use: not the system's components.
    expect(PAGE_CSS).not.toMatch(/\.prose\b|\.not-prose\b|\[data-theme=indigo\]/);
  });

  it("loads fonts from /assets/ only, and nothing else from anywhere", () => {
    const urls = [...PAGE_CSS.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1]);
    expect(urls).toHaveLength(3);
    for (const url of urls) expect(url).toMatch(/^\/assets\/[a-z-]+\.[0-9a-f]{12}\.woff2$/);
    expect(PAGE_CSS).not.toMatch(/@import|https?:|\/\/[a-z]/i);
  });

  it("keeps values readable in full and respects reduced motion", () => {
    // Fact values keep their line breaks (the write flow relies on it).
    expect(PAGE_CSS).toMatch(/\.facts dd\{[^}]*white-space:pre-wrap/);
    expect(PAGE_CSS).not.toMatch(
      /\.facts?[^{]*\{[^}]*(?:max-height|overflow:(?:auto|scroll|hidden))/,
    );
    expect(PAGE_CSS).toMatch(
      /\.meter i\{[^}]*\}@media \(prefers-reduced-motion:reduce\)\{\.meter i\{animation:none\}\}/,
    );
    // The expiry itself is not motion: it stays on.
    expect(PAGE_CSS).toContain(".live{animation:expire 1ms linear var(--ttl) forwards}");
    expect(PAGE_CSS).toContain(`@media (max-width:${NARROW}){`);
    expect(PAGE_CSS).toContain(
      ":focus-visible{outline:2px solid var(--lf-accent);outline-offset:2px}",
    );
  });
});
