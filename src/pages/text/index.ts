/** The trusted texts of the server's own pages, per language. */
import type { Locale } from "../locale.js";
import { de } from "./de.js";
import { en, type Texts } from "./en.js";

export type { PageMessage, Texts } from "./en.js";

const TEXTS: Readonly<Record<Locale, Texts>> = { en, de };

/** The page texts in `locale`. */
export function pageTexts(locale: Locale): Texts {
  return TEXTS[locale];
}
