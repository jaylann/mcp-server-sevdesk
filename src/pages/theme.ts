/**
 * The look of the server's own pages: the Lanfermann system (`@lanfermann/ui`, the website's
 * design system), compiled with Tailwind at development time from `pages.css` into
 * `styles.generated.ts` (`pnpm pages:css`, scripts/page-css.ts). The rules of the look and what
 * the pages add to the system are described there; this module adds the fonts, whose URLs carry
 * the hashes of the embedded files, and names the two grounds the pages use.
 *
 * The stylesheet goes into the page's single style block, which the response's CSP allows by
 * nonce; nothing here may depend on a `style=""` attribute (the CSP blocks them).
 */
import { assetPath } from "./assets.js";
import { INK, PAGE_STYLES, PAPER } from "./styles.generated.js";

/** The colour tokens of the light scheme: the system's Paper ground. */
export const LIGHT_TOKENS = PAPER;

export type TokenName = keyof typeof PAPER;

/** The colour tokens of the dark scheme: the system's Ink ground. */
export const DARK_TOKENS: Readonly<Record<TokenName, string>> = INK;

/**
 * Below this viewport width the pages use their narrow layout (stacked buttons); the stylesheet
 * writes it as `@media (max-width:30rem)`.
 */
export const NARROW = "30rem";

/**
 * The fonts the system sets its type in: Sofia Sans, variable, in the two files Fontsource
 * publishes for Latin (with the German umlauts) and Latin Extended (other European names; the
 * browser fetches it only when a page needs it), and JetBrains Mono for what a machine reads
 * (codes, hosts). The family names are the ones the system's font stacks ask for; the
 * `unicode-range`s are Fontsource's.
 */
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329," +
  "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329," +
  "U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F," +
  "U+A720-A7FF";

const FONTS =
  `@font-face{font-family:"Sofia Sans";font-style:normal;font-weight:1 1000;font-display:swap;src:url(${assetPath("sofiaSansLatin")}) format("woff2");unicode-range:${LATIN}}` +
  `@font-face{font-family:"Sofia Sans";font-style:normal;font-weight:1 1000;font-display:swap;src:url(${assetPath("sofiaSansLatinExt")}) format("woff2");unicode-range:${LATIN_EXT}}` +
  `@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:100 800;font-display:swap;src:url(${assetPath("jetbrainsMonoLatin")}) format("woff2");unicode-range:${LATIN}}`;

/** The stylesheet of every page of the server (fonts, the system, the pages' parts). */
export const PAGE_CSS = `${FONTS}${PAGE_STYLES}`;
