/**
 * Confirmation previews as humans and models see them. A write tool's `prepare` builds the
 * preview; everything shown from it (elicitation message, approval page, dry-run and pending
 * results, audit log) goes through {@link displayPreview} first, so sevDesk text cannot hide
 * characters from the human, and fact values are shown in full: an email text keeps its line
 * breaks, and nothing is cut without saying so. The preview hash is computed over the raw
 * preview, so an approval always covers the complete text.
 */
import { z } from "zod";

import { sanitizeUntrusted } from "./fence.js";
import type { ConfirmationPreview } from "./write-types.js";

/**
 * Caps for the one-line parts after sanitizing (code points). They are trusted text written in
 * this repository, so the caps only bound what a bug could put there. They leave room for the
 * German wording, which runs about a third longer than the English: a consequence that is cut
 * off is one the reader never sees (`test/integration/write-previews-de.test.ts` checks that no
 * preview of a shipped tool reaches a cap in either language).
 */
const MAX_ACTION_LENGTH = 500;
const MAX_LABEL_LENGTH = 100;
const MAX_WARNING_LENGTH = 900;
/**
 * Longest fact value shown to a human (code points), e.g. an email text of up to 10,000
 * characters. Longer values end with {@link hiddenMarker}; the model-facing preview keeps them
 * whole.
 */
export const MAX_SHOWN_VALUE_LENGTH = 12_000;
/** No cap while sanitizing values: capping happens only where a value is shown to a human. */
const UNCAPPED = Number.MAX_SAFE_INTEGER;

/**
 * The shape of `ConfirmationPreview`, checked after `prepare`: a malformed preview is a bug and is
 * never shown to a human as if it were complete. Also the `preview` member of write-tool output.
 */
export const previewSchema = z.object({
  action: z.string().min(1).describe("Action in one sentence."),
  facts: z
    .array(z.object({ label: z.string().min(1), value: z.string() }))
    .describe("Record, customer, amounts, dates, recipients and texts."),
  warnings: z.array(z.string()).describe("Read these consequences first."),
  irreversible: z.boolean().describe("Cannot be undone."),
});

/**
 * Both previews of a write plan, checked after `prepare`: each a complete preview, and the
 * German one with as many facts and warnings as the English one and the same `irreversible`.
 * A German reader must never approve a text that leaves out a consequence the English one names.
 */
export const previewPairSchema = z
  .object({ preview: previewSchema, previewDe: previewSchema.optional() })
  .superRefine(({ preview, previewDe }, ctx) => {
    if (previewDe === undefined) return;
    const differs = (part: string): void => {
      ctx.addIssue({
        code: "custom",
        path: ["previewDe", part],
        message: `the German preview differs from the English one in ${part}`,
      });
    };
    if (previewDe.irreversible !== preview.irreversible) differs("irreversible");
    if (previewDe.facts.length !== preview.facts.length) differs("facts");
    if (previewDe.warnings.length !== preview.warnings.length) differs("warnings");
  });

/**
 * The preview sanitized for display: invisible, bidi and control characters removed everywhere
 * (`sanitizeUntrusted`; tabs become spaces), the action, labels and warnings folded onto one capped
 * line each (line breaks become " / "), and fact values kept whole with their line breaks
 * (trailing spaces and surrounding blank lines trimmed). Shown to the model and written to the
 * audit log as it is; {@link shownValue} caps values where a human reads them.
 */
export function displayPreview(preview: ConfirmationPreview): ConfirmationPreview {
  return {
    action: oneLine(preview.action, MAX_ACTION_LENGTH),
    facts: preview.facts.map((fact) => ({
      label: oneLine(fact.label, MAX_LABEL_LENGTH),
      value: multiLine(fact.value),
    })),
    warnings: preview.warnings.map((warning) => oneLine(warning, MAX_WARNING_LENGTH)),
    irreversible: preview.irreversible,
  };
}

/**
 * The line that states irreversibility in the plain-text preview. The approval page says the same
 * in the reader's language (`approval.irreversible` in `src/pages/text`).
 */
const IRREVERSIBLE_LINE = "This cannot be undone.";

/** The explicit marker that replaces the end of a value too long to show. */
export function hiddenMarker(hidden: number): string {
  return `[… ${hidden} more characters not shown; open the dry run to see everything]`;
}

/**
 * A (displayed) fact value as a human sees it: unchanged up to {@link MAX_SHOWN_VALUE_LENGTH}
 * code points, otherwise cut there and followed by {@link hiddenMarker} on its own line. Never a
 * silent cut.
 */
export function shownValue(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_SHOWN_VALUE_LENGTH) {
    return value;
  }
  const kept = codePoints.slice(0, MAX_SHOWN_VALUE_LENGTH).join("");
  return `${kept}\n${hiddenMarker(codePoints.length - MAX_SHOWN_VALUE_LENGTH)}`;
}

/**
 * Plain-text body of a confirmation for a human: the action, then the warnings and, for
 * irreversible actions, {@link IRREVERSIBLE_LINE}, then the facts. A single-line fact is a "Label: value" line; a
 * multi-line value follows its "Label:" line, every line indented by two spaces, so no line of a
 * value can pose as a label, a warning or the irreversible line. Expects a preview that went
 * through {@link displayPreview}; values are capped with {@link shownValue}.
 */
export function previewText(preview: ConfirmationPreview): string {
  const blocks = [preview.action];
  // Consequences first: they must not end up below a long text the human may not scroll past.
  const notes = preview.warnings.map((warning) => `Warning: ${warning}`);
  if (preview.irreversible) {
    notes.push(IRREVERSIBLE_LINE);
  }
  if (notes.length > 0) {
    blocks.push(notes.join("\n"));
  }
  if (preview.facts.length > 0) {
    blocks.push(
      preview.facts.map((fact) => factText(fact.label, shownValue(fact.value))).join("\n"),
    );
  }
  return blocks.join("\n\n");
}

function factText(label: string, value: string): string {
  if (!value.includes("\n")) {
    return `${label}: ${value}`;
  }
  const lines = value.split("\n").map((line) => (line === "" ? "" : `  ${line}`));
  return `${label}:\n${lines.join("\n")}`;
}

function oneLine(text: string, maxLength: number): string {
  return sanitizeUntrusted(text, maxLength)
    .replace(/\t/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" / ");
}

function multiLine(text: string): string {
  const lines = sanitizeUntrusted(text, UNCAPPED)
    .replace(/\t/g, " ")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}
