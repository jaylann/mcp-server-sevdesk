/**
 * The frame every page of the server shares: the document head (one nonce'd style block, the
 * icon, the font preload), the wordmark, `<main>` and the footer.
 *
 * The head keeps `<meta name="referrer" content="same-origin">`: under `no-referrer` browsers
 * send `Origin: null` with the pages' form POSTs, which the servers refuse (see `web.ts`).
 */
import { assetPath } from "./assets.js";
import type { RenderContext } from "./context.js";
import { type Html, markup, trusted } from "./html.js";
import { SEAL } from "./icons.js";
import type { Locale } from "./locale.js";
import { DARK_TOKENS, LIGHT_TOKENS, PAGE_CSS } from "./theme.js";

export interface FrameOptions {
  /** The document title (plain text). */
  readonly title: string;
  /** The content of `<main>`. */
  readonly body: Html;
  /** The language of `body`; the request's language unless the page is not translated yet. */
  readonly lang?: Locale;
  /** A wider column, for lists. */
  readonly wide?: boolean;
  /**
   * CSS for this response only, appended to the stylesheet (e.g. the seconds until a request
   * expires). Trusted: build it from numbers and constants, never from text.
   */
  readonly css?: string;
}

/** The complete HTML document of a page. */
export function renderFrame(options: FrameOptions, ctx: RenderContext): string {
  const lang = options.lang ?? ctx.locale;
  return markup`<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="theme-color" content="${LIGHT_TOKENS.bg}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${DARK_TOKENS.bg}" media="(prefers-color-scheme: dark)">
<title>${options.title}</title>
<link rel="icon" href="${assetPath("icon")}" type="image/svg+xml">
<link rel="preload" href="${assetPath("archivoLatin")}" as="font" type="font/woff2" crossorigin>
<style nonce="${ctx.nonce}">${trusted(PAGE_CSS)}${trusted(options.css ?? "")}</style>
</head>
<body${options.wide === true ? trusted(' class="wide"') : ""}>
<div class="page">
<header class="top"><span class="wordmark">${SEAL}<span>sevDesk&nbsp;MCP</span></span></header>
<main>
${options.body}
</main>
<footer class="foot"><p>${ctx.t.frame.disclaimer}</p></footer>
</div>
</body>
</html>
`.toString();
}
