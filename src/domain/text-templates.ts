/**
 * Text templates (Textvorlagen): the head and foot texts an account keeps for its documents,
 * `GET /TextTemplate` (not in the spec, spec/deviations.md D-024, D-115). A row carries `name`,
 * `text`, `objectType` (the document type: `RE` invoice, `AN` offer, `MA` reminder, `ALL`, …),
 * `textType` (`HEAD`, `FOOT`, `TEXT`), `category` (`DOCUMENT`, `MAIL`) and `main` (the default of
 * its type).
 *
 * The endpoint ignores `limit` and `offset` and answers every row with `total` (recorded
 * 2026-11-10: all 9 rows for `limit=2`), so the list is read with one request (`limit` 1000, sent
 * explicitly like every list) and never paged: a second page would repeat the first.
 *
 * The draft tools take a head or foot text by a template's name: resolved against the templates
 * of the draft's type (invoices `RE`; orders `AN`, the only order type the account's templates
 * carry: no `AB` or `LI` rows exist, recorded 2026-11-17). Credit notes are not offered: no text
 * template of theirs exists, and `POST /TextTemplate` stores any `objectType` it is sent (`GU`,
 * `CN` and an invented `ZZ` alike), so the API cannot tell their code (D-115).
 */
import { z } from "zod";

import { findHiddenCharacters } from "../safety/fence.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { parseUpstream, zBool01, zId, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { cleanText } from "./common.js";

/** Rows asked for in the one request (sevDesk answers all of them anyway). */
const TEXT_TEMPLATE_LIMIT = 1000;

/** The longest head or foot text the draft tools write (`headTextInput`, `footTextInput`). */
const MAX_DOCUMENT_TEXT = 10_000;

const rowSchema = z.object({
  id: zId,
  name: zText,
  text: zText,
  objectType: zText,
  textType: zText,
  category: zText,
  main: zBool01.optional(),
});

/** One text template. Texts are untrusted (written by the account). */
export interface TextTemplate {
  readonly id: number;
  /** Cleaned for display. */
  readonly name: string | undefined;
  /** As stored: what a draft gets when the template is chosen. */
  readonly text: string | undefined;
  readonly objectType: string | undefined;
  readonly textType: string | undefined;
  readonly category: string | undefined;
  /** sevDesk's `main`: the default text of its type. */
  readonly isDefault: boolean;
}

export interface TextTemplateList {
  readonly items: readonly TextTemplate[];
  /** sevDesk's `total`; the number of rows when it sent none. */
  readonly total: number;
  /** sevDesk reported more rows than it sent. */
  readonly truncated: boolean;
}

/** Reads every text template of the account (one request, see the module doc). */
export async function listTextTemplates(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<TextTemplateList> {
  const page = await client.list("/TextTemplate", undefined, {
    limit: TEXT_TEMPLATE_LIMIT,
    ...(signal === undefined ? {} : { signal }),
  });
  const items = page.items.map((raw) => {
    const row = parseUpstream(rowSchema, raw, "a text template");
    return {
      id: row.id,
      name: cleanText(row.name, 200),
      text: row.text,
      objectType: cleanText(row.objectType, 50)?.toUpperCase(),
      textType: cleanText(row.textType, 50)?.toUpperCase(),
      category: cleanText(row.category, 50)?.toUpperCase(),
      isDefault: row.main === true,
    };
  });
  const total = page.total ?? items.length;
  return { items, total, truncated: total > items.length };
}

/** Where a template goes: the head text (Kopftext) or the foot text (Fußtext). */
export type TextPlace = "head" | "foot";

const TEXT_TYPE: Readonly<Record<TextPlace, string>> = { head: "HEAD", foot: "FOOT" };

const PLACE_NAMES: Readonly<Record<TextPlace, string>> = {
  head: "head text (Kopftext)",
  foot: "foot text (Fußtext)",
};

/** A template chosen for a draft: its name (cleaned) and its text as stored (CRLF made LF). */
export interface ChosenText {
  readonly place: TextPlace;
  readonly templateId: number;
  readonly name: string;
  readonly text: string;
}

/**
 * The template named `name` among the `place` templates of document type `objectType` (`RE`,
 * `AN`, `AB`, `LI`), compared case-insensitively without surrounding space. Refuses, before any
 * write and with a trusted sentence, a name that matches none or several, a template without
 * text, a text longer than the draft tools write, and a text with characters a human would not
 * see (the rule the write flow applies to arguments).
 */
export function chooseTextTemplate(
  templates: readonly TextTemplate[],
  place: TextPlace,
  objectType: string,
  name: string,
): ChosenText {
  const wanted = name.trim().toLocaleLowerCase("de-DE");
  const matches = templates.filter(
    (template) =>
      template.textType === TEXT_TYPE[place] &&
      template.objectType === objectType &&
      template.name?.toLocaleLowerCase("de-DE") === wanted,
  );
  const what = PLACE_NAMES[place];
  const [only] = matches;
  if (only === undefined || matches.length > 1) {
    throw refusal(
      matches.length > 1
        ? `${String(matches.length)} text templates for the ${what} of this document type ` +
            `(${objectType}) have this name. Rename one in sevDesk, or pass the text itself.`
        : `No text template for the ${what} of this document type (${objectType}) has this name; ` +
            "sevdesk_reference_lookup kind=text_templates lists them. Nothing was sent.",
    );
  }
  // Windows line ends become plain ones, the form arguments take; anything else is kept as is.
  const text = only.text?.replace(/\r\n/g, "\n");
  if (text === undefined || text.trim() === "") {
    throw refusal(`Text template ${String(only.id)} has no text. Nothing was sent.`);
  }
  if (text.length > MAX_DOCUMENT_TEXT) {
    throw refusal(
      `Text template ${String(only.id)} is longer than ${String(MAX_DOCUMENT_TEXT)} characters, ` +
        `more than this server writes into a ${what}. Nothing was sent.`,
    );
  }
  if (findHiddenCharacters(text, { allowNewlines: true }).length > 0) {
    throw refusal(
      `Text template ${String(only.id)} contains characters a human would not see (control or ` +
        "invisible characters), so it is not copied into the document. Clean it up in sevDesk " +
        "first. Nothing was sent.",
    );
  }
  return { place, templateId: only.id, name: only.name ?? "", text };
}

function refusal(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
