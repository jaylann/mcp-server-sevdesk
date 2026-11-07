/**
 * Handling of untrusted text: anything read from sevDesk (contact names, descriptions, bank
 * transfer purposes, e-invoice fields, upstream error messages) can be written by third parties
 * and may carry prompt injection. It is sanitized before it reaches the model and never
 * interpolated into trusted text such as error messages or instructions; where it has to appear
 * next to trusted text, it is fenced with {@link fenceInline} or {@link fenceBlock}.
 */

/**
 * Characters removed from untrusted text, selected by Unicode property so new and rarely seen
 * code points are covered too: they are invisible or reorder text, so a human reviewing the
 * output cannot see what the model reads (hidden instructions, "Trojan Source" bidi tricks, data
 * smuggled in variation selectors or tag characters).
 *
 * - `Cc` control characters, except tab and line feed (CR is normalized to LF before this runs);
 * - `Cf` format characters: zero-width (joiner) and bidi controls, soft hyphen, BOM, Arabic
 *   number signs, interlinear annotations, Egyptian hieroglyph and musical format controls, tags;
 * - `Default_Ignorable_Code_Point`: fillers that render blank (Hangul fillers), combining
 *   grapheme joiner, variation selectors (U+FE00–FE0F, U+E0100–E01EF), the reserved U+FFF0–FFF8
 *   and U+E0000–E0FFF blocks.
 *
 * Built from a string because property escapes need the `u` flag and the source should not carry
 * literal invisible characters.
 */
const INVISIBLE = new RegExp(
  "(?![\\t\\n])\\p{Cc}|[\\p{Cf}\\p{Default_Ignorable_Code_Point}]",
  "gu",
);

/** `\u{…}` regex escape for a code point (keeps invisible characters out of the source). */
function escapeCodePoint(codePoint: number): string {
  return `\\u{${codePoint.toString(16)}}`;
}

/**
 * CRLF, CR and the Unicode line and paragraph separators (U+2028, U+2029) all become a plain
 * line feed.
 */
const LINE_BREAKS = new RegExp(
  `\\r\\n?|${escapeCodePoint(0x2028)}|${escapeCodePoint(0x2029)}`,
  "gu",
);

const BACKTICK_RUNS = /`+/g;

/** Default cap for a single untrusted field. */
export const MAX_UNTRUSTED_LENGTH = 2_000;

/** Default cap for an untrusted value shown inline (an id, a key, a short name). */
export const MAX_INLINE_UNTRUSTED_LENGTH = 200;

/**
 * Normalizes untrusted text: line breaks unified to `\n`, invisible/bidi/tag/variation characters
 * removed (see `INVISIBLE`), NFC, and the length capped at `maxLength` code points with a
 * visible marker. Use on every string field of a DTO that originates from sevDesk data.
 *
 * Idempotent for values within the cap.
 */
export function sanitizeUntrusted(value: string, maxLength: number = MAX_UNTRUSTED_LENGTH): string {
  const cleaned = value.replace(LINE_BREAKS, "\n").replace(INVISIBLE, "").normalize("NFC");
  // UTF-16 length is an upper bound of the code point count: skip the split for short values.
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= maxLength) {
    return cleaned;
  }
  const omitted = codePoints.length - maxLength;
  return `${codePoints.slice(0, maxLength).join("")}… [truncated ${omitted} chars]`;
}

/**
 * Sanitizes `value` and wraps it in a Markdown code span that the value cannot close: the
 * delimiter is one backtick longer than the longest backtick run inside, line breaks become
 * spaces, and a space pads values that start or end with a backtick or a space (CommonMark strips
 * one such space on each side). An empty value becomes a code span holding one space.
 *
 * Use it to show a short untrusted value (an argument name, a document number) inside trusted
 * text.
 */
export function fenceInline(
  value: string,
  maxLength: number = MAX_INLINE_UNTRUSTED_LENGTH,
): string {
  const text = sanitizeUntrusted(value, maxLength).replace(/\n/g, " ");
  if (text === "") {
    return "` `";
  }
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const needsPadding =
    text.startsWith("`") ||
    text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "");
  const pad = needsPadding ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Sanitizes `value` and wraps it in a fenced Markdown code block that the value cannot break out
 * of: the fence is longer than any backtick run inside (at least three), so no line of the value
 * can close it. `label` becomes the info string after the opening fence; it is trusted text from
 * our code, reduced to `[A-Za-z0-9_ .:-]` so it cannot carry a backtick or a line break.
 *
 * Use it for multi-line untrusted text, such as sevDesk's own error message, shown together with
 * trusted guidance.
 */
export function fenceBlock(
  value: string,
  label = "text",
  maxLength: number = MAX_UNTRUSTED_LENGTH,
): string {
  const text = sanitizeUntrusted(value, maxLength);
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  const info = label.replace(/[^\w .:-]/g, "").trim();
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${fence}${info}\n${body}${fence}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(BACKTICK_RUNS)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}
