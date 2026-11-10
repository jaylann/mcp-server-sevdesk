/**
 * What a page of the server knows about the request it answers. Built once per request and passed
 * to the response helpers and renderers, so every page of one response speaks one language.
 */
import { type Locale, pickLocale } from "./locale.js";
import { pageTexts, type Texts } from "./text/index.js";

export interface PageContext {
  /** The page language, from the browser's `Accept-Language`. */
  readonly locale: Locale;
  /** The trusted texts in `locale`. */
  readonly t: Texts;
  /**
   * The origin the browser reaches the server on, e.g. `https://mcp.example.com` or
   * `http://127.0.0.1:53111` (no trailing slash).
   */
  readonly origin: string;
}

/** A page being rendered: the request's context plus the nonce of the page's one style block. */
export interface RenderContext extends PageContext {
  readonly nonce: string;
}

/** The context of a request with this `Accept-Language` header to the server at `origin`. */
export function pageContext(
  acceptLanguage: string | null | undefined,
  origin: string,
): PageContext {
  const locale = pickLocale(acceptLanguage);
  return { locale, t: pageTexts(locale), origin };
}
