/**
 * Head and foot texts from text templates (Textvorlagen) for the invoice and order draft tools:
 * `headTextTemplate` and `footTextTemplate` name a template, which is resolved against the
 * account's templates of the draft's type (invoices `RE`, every order type `AN`,
 * `src/domain/text-templates.ts`) and copied into
 * `headText` / `footText`, the fields the tools already write. So the tier stays `write`, and the
 * finalize approval shows the text as stored, like any other head or foot text.
 *
 * A name that matches no template or several, and a template and a text for the same place, are
 * refused before anything is sent. The preview shows the chosen text fenced, as untrusted text.
 */
import { z } from "zod";

import { fenceInline } from "../../safety/fence.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { chooseTextTemplate, type ChosenText, listTextTemplates } from "../text-templates.js";
import type { PreviewFact } from "./preview.js";

/** Characters of a chosen text the draft preview shows (fenced). */
const PREVIEW_TEXT_LENGTH = 500;

function templateInput(place: string, field: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      `${place} from a text template (Textvorlage) of this document type, by its name ` +
        `(sevdesk_reference_lookup kind=text_templates); instead of ${field}.`,
    );
}

export const headTextTemplateInput = templateInput("Head text (Kopftext)", "headText");
export const footTextTemplateInput = templateInput("Foot text (Fußtext)", "footText");

/** The text arguments of a draft tool. */
export interface TextArgs {
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
  readonly headTextTemplate?: string | undefined;
  readonly footTextTemplate?: string | undefined;
}

/** The texts a draft gets, and the preview facts of the ones taken from templates. */
export interface ResolvedTexts {
  readonly headText: string | undefined;
  readonly footText: string | undefined;
  readonly facts: readonly PreviewFact[];
}

/**
 * The head and foot text of a draft of text template type `objectType` (`RE` invoices, `AN` orders):
 * the given texts, or the texts of the named templates (one read of the templates, only when a
 * template is named). Throws a `validation` error for a text and a template of the same place,
 * and for a name that does not resolve.
 */
export async function resolveTemplateTexts(
  client: SevdeskClient,
  args: TextArgs,
  objectType: string,
  signal?: AbortSignal,
): Promise<ResolvedTexts> {
  for (const [text, template, field] of [
    [args.headText, args.headTextTemplate, "headText"],
    [args.footText, args.footTextTemplate, "footText"],
  ] as const) {
    if (text !== undefined && template !== undefined) {
      throw new SevdeskError({
        kind: "validation",
        message: `Give ${field} or ${field}Template, not both.`,
      });
    }
  }
  if (args.headTextTemplate === undefined && args.footTextTemplate === undefined) {
    return { headText: args.headText, footText: args.footText, facts: [] };
  }
  const templates = (await listTextTemplates(client, signal)).items;
  const head =
    args.headTextTemplate === undefined
      ? undefined
      : chooseTextTemplate(templates, "head", objectType, args.headTextTemplate);
  const foot =
    args.footTextTemplate === undefined
      ? undefined
      : chooseTextTemplate(templates, "foot", objectType, args.footTextTemplate);
  return {
    headText: head?.text ?? args.headText,
    footText: foot?.text ?? args.footText,
    facts: [head, foot].flatMap((chosen) => (chosen === undefined ? [] : [templateFact(chosen)])),
  };
}

/** "Head text from a template": the template's name and its text, both fenced. */
function templateFact(chosen: ChosenText): PreviewFact {
  return {
    label: chosen.place === "head" ? "Head text from a template" : "Foot text from a template",
    value:
      `template ${fenceInline(chosen.name)} (id ${String(chosen.templateId)}): ` +
      fenceInline(chosen.text, PREVIEW_TEXT_LENGTH),
  };
}
