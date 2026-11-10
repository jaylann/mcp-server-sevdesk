/**
 * The languages of the server's own pages, and which one a browser gets.
 *
 * The pages are English or German. A request without a usable `Accept-Language` header gets
 * English, so clients that are not browsers (and the tests) see the same wording as before the
 * pages were translated.
 */

/** Page languages, the default first. */
export const LOCALES = ["en", "de"] as const;

export type Locale = (typeof LOCALES)[number];

const DEFAULT_LOCALE: Locale = "en";

/** Longer headers are cut here: a browser sends a few dozen characters. */
const MAX_HEADER_LENGTH = 512;

/**
 * The page language for an `Accept-Language` header: the supported language with the highest
 * quality value (the first one on a tie), English when the header names none. Region subtags
 * count for their language (`de-AT` is German); `*` and entries with `q=0` or a malformed `q`
 * are ignored.
 */
export function pickLocale(acceptLanguage: string | null | undefined): Locale {
  let best = DEFAULT_LOCALE;
  let bestQuality = 0;
  for (const entry of (acceptLanguage ?? "").slice(0, MAX_HEADER_LENGTH).split(",")) {
    const [range = "", ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    const locale = LOCALES.find((known) => range === known || range.startsWith(`${known}-`));
    if (locale === undefined) continue;
    const quality = qualityOf(params);
    if (quality > bestQuality) {
      best = locale;
      bestQuality = quality;
    }
  }
  return best;
}

/** The `q` of a language range: 1 without one, 0 (ignored) when it is malformed. */
function qualityOf(params: readonly string[]): number {
  const param = params.find((candidate) => candidate.startsWith("q="));
  if (param === undefined) return 1;
  return /^q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(param) ? Number(param.slice(2)) : 0;
}
