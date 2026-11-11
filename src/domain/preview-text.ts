/**
 * Confirmation previews are written in two languages. English is what the model, dry runs, the
 * audit log and an MCP client's own confirmation prompt show. German is what the approval pages
 * show a reader whose browser asks for German: the person who approves a legally binding action
 * reads it in their own language.
 *
 * Both texts come from the same data in the same place: a helper takes the language
 * ({@link PreviewLanguage}), and a sentence that a check produces is a {@link Phrase} with both
 * wordings side by side. So the two previews always have the same facts and warnings in the same
 * order, and a change to one wording is made next to the other.
 *
 * German text follows the approval pages (`src/pages/text/de.ts`): formal, sevDesk's own terms
 * (Rechnung, Beleg, festschreiben), amounts and dates in German notation.
 */

/** The languages of a confirmation preview. */
export type PreviewLanguage = "en" | "de";

/** One sentence of a preview in both languages. */
export interface Phrase {
  readonly en: string;
  readonly de: string;
}

/** A sentence in both languages: `phrase("Cannot be undone.", "Nicht umkehrbar.")`. */
export function phrase(en: string, de: string): Phrase {
  return { en, de };
}

/**
 * Builds a preview (or a part of one) in both languages from one function of the language, so
 * the two cannot differ in shape: `{ ...bothPreviews((lang) => ({ action: …, … })), state }`.
 */
export function bothPreviews<T>(build: (lang: PreviewLanguage) => T): {
  readonly preview: T;
  readonly previewDe: T;
} {
  return { preview: build("en"), previewDe: build("de") };
}

/** The sentences in one language, in order. */
export function inLanguage(phrases: readonly Phrase[], lang: PreviewLanguage): string[] {
  return phrases.map((sentence) => sentence[lang]);
}

const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * A decimal string in German notation: `"1190.00"` → `"1.190,00"`, `"-0.5"` → `"-0,5"`. Only
 * the separators change (string operations, no arithmetic), so every digit sevDesk sent is kept.
 * Anything that is not a plain decimal is returned as it is.
 */
export function germanNumber(value: string): string {
  const match = PLAIN_DECIMAL.exec(value);
  if (match === null) return value;
  const [, sign = "", whole = "", fraction] = match;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${grouped}${fraction === undefined ? "" : `,${fraction}`}`;
}

/** A decimal string as `lang` writes it (see {@link germanNumber}). */
export function numberText(value: string, lang: PreviewLanguage): string {
  return lang === "de" ? germanNumber(value) : value;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An ISO date as `lang` writes it: `"2026-11-03"` stays in English and becomes `"03.11.2026"` in
 * German. Anything that is not an ISO date is returned as it is.
 */
export function dateText(isoDate: string, lang: PreviewLanguage): string {
  if (lang === "en") return isoDate;
  const match = ISO_DATE.exec(isoDate);
  if (match === null) return isoDate;
  const [, year = "", month = "", day = ""] = match;
  return `${day}.${month}.${year}`;
}
