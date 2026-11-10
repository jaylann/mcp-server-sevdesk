import { describe, expect, it } from "vitest";

import {
  DARK_SCHEME,
  DARK_TOKENS,
  LIGHT_SCHEME,
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
  ["text", "bg"],
  ["text", "bg-2"],
  ["text", "surface"],
  ["text-2", "bg"],
  ["text-2", "bg-2"],
  ["text-2", "surface"],
  // Not on bg-2: the tinted inbox rows set their secondary text in text-2.
  ["text-3", "bg"],
  ["text-3", "surface"],
  ["text-2", "line-2"],
  ["on-action", "action"],
  ["on-action", "action-hover"],
  ["on-approve", "approve"],
  ["on-approve", "approve-hover"],
  ["approve-text", "approve-tint"],
  ["approve-text", "bg"],
  ["approve-text", "surface"],
  ["ok-text", "ok-tint"],
  ["ok", "bg"],
  ["ok", "surface"],
  ["ok", "bg-2"],
  ["info", "info-tint"],
  ["danger", "danger-tint"],
  ["text", "danger-tint"],
];

/** Shapes that carry meaning without text: at least 3:1 (WCAG 1.4.11). */
const GRAPHIC_PAIRS: readonly (readonly [TokenName, TokenName])[] = [
  ["field", "surface"],
  ["field", "bg-2"],
  ["focus", "bg"],
  ["focus", "surface"],
  ["stamp-ink", "surface"],
  ["stamp-plain", "surface"],
  ["approve", "bg"],
  ["stamp-ink", "line"],
  ["text", "line-2"],
  ["danger", "surface"],
  ["ok", "ok-tint"],
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

  it("uses the website's stamp ink for approvals and ink for other actions", () => {
    expect(LIGHT_TOKENS.approve).toBe("#5a3fc0");
    expect(LIGHT_TOKENS.action).toBe("#1b2233");
    expect(LIGHT_TOKENS.bg).toBe("#f9f9f6");
  });
});

describe("page stylesheet", () => {
  it("names colours only through tokens", () => {
    const rules = PAGE_CSS.slice(PAGE_CSS.indexOf("*,*::before"));
    // The shadows are ink or white at an opacity; every other colour is a token.
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules.replaceAll(/rgb\((?:27 34 51|255 255 255|0 0 0)\/[.\d]+\)/g, "")).not.toMatch(
      /rgb\((?!from )/,
    );
  });

  it("applies the dark tokens when the system prefers dark", () => {
    expect(PAGE_CSS).toContain(`:root{color-scheme:light dark;${LIGHT_SCHEME};`);
    expect(PAGE_CSS).toContain(`@media (prefers-color-scheme:dark){:root{${DARK_SCHEME}}}`);
    expect(DARK_SCHEME).toContain("--stamp-blend:normal");
    expect(LIGHT_SCHEME).toContain("--stamp-blend:multiply");
  });

  it("loads fonts from /assets/ only, and nothing else from anywhere", () => {
    const urls = [...PAGE_CSS.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1]);
    expect(urls).toHaveLength(3);
    for (const url of urls) expect(url).toMatch(/^\/assets\/[a-z-]+\.[0-9a-f]{12}\.woff2$/);
    expect(PAGE_CSS).not.toMatch(/@import|https?:|\/\/[a-z]/i);
  });

  it("keeps values readable in full and respects reduced motion", () => {
    // Fact values keep their line breaks (the write flow relies on it).
    expect(PAGE_CSS).toContain(
      ".facts dd{min-width:0;overflow-wrap:anywhere;white-space: pre-wrap",
    );
    expect(PAGE_CSS).not.toMatch(
      /\.facts[^{]*\{[^}]*(?:max-height|overflow:(?:auto|scroll|hidden))/,
    );
    expect(PAGE_CSS).toContain(
      "@media (prefers-reduced-motion:reduce){.stamp,.struck,.meter i{animation:none}}",
    );
    // The expiry itself is not motion: it stays on.
    expect(PAGE_CSS).toContain(".live{animation:expire 1ms linear var(--ttl) forwards}");
    expect(PAGE_CSS).toContain(`@media (max-width:${NARROW}){`);
    expect(PAGE_CSS).toContain(":focus-visible{outline:2px solid var(--focus);outline-offset:3px}");
  });
});
