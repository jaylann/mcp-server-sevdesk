/**
 * The layout of an invoice, order or credit note: its language (Sprache), template (Vorlage) and
 * letterhead (Briefpapier). sevDesk keeps them in the rendered document, not in the record
 * (spec/deviations.md D-113): no field of `GET /Invoice/{id}` or of the `getPdf` answer holds
 * them. They are set with `PUT /{Invoice|Order|CreditNote}/{id}/changeParameter` (`{key, value}`,
 * one key per request) and read from the `parameters` a layout answer lists: the current `value`
 * and the choices (`values`) of each print option.
 *
 * - Reading without a change: `POST /{Invoice|Order|CreditNote}/{id}/render` with
 *   `{forceReload: false}`, a reading POST (`src/sevdesk/read-posts.ts`; recorded on drafts of
 *   all three kinds, D-113).
 * - Orders and credit notes accept `changeParameter` only after a PDF preview (`getPdf` with
 *   `preventSendBy=true`, which leaves a draft a draft); before it sevDesk answered 500 "Syntax
 *   error" (D-113). A render before it was enough on one order draft, but the preview is what was
 *   recorded on both kinds, so the layout tool fetches it.
 * - The lists to choose from (`GET /DocServer/getLetterpapersWithThumb`, `getTemplatesWithThumb`)
 *   sit under `objects` and carry base64 thumbnails, PDFs and HTML (D-114); they are read with a
 *   size cap and reduced to id, name and flags before anything else sees them.
 *
 * Languages are the eight sevDesk lists on all three kinds (by `translationCode`
 * `SEVDOC_LANG_<XX>_<YY>`), sent in the locale form (`en_US`), which all three kinds take
 * (D-140). The stored values differ per kind: invoices store `en` and `de` for `en_US` and
 * `de_DE` (the other six as sent), orders and credit notes the locale form. So a stored value is
 * read back through the choice that lists it, by its translation code. Orders and credit notes
 * store German for a value they do not know, without an error: a read-back that differs from
 * the language sent is a failure.
 */
import { z } from "zod";

import { readEnvelope } from "../sevdesk/envelope.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath } from "../sevdesk/paths.js";
import { RENDER_WITHOUT_RELOAD } from "../sevdesk/read-posts.js";
import { parseUpstream, zBool01, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { cleanText } from "./common.js";
import { fetchDocumentFile } from "./document-files.js";
import { KINDS, type SalesKind } from "./lifecycle/documents.js";
import { type Phrase, phrase, type PreviewLanguage } from "./preview-text.js";

// ---------------------------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------------------------

/** The languages offered, as locale codes: the form all three kinds take (D-140). */
export const LANGUAGES = [
  "de_DE",
  "de_AT",
  "de_CH",
  "en_US",
  "es_ES",
  "fr_FR",
  "it_IT",
  "el_GR",
] as const;

export type LanguageCode = (typeof LANGUAGES)[number];

/** Trusted names of the offered languages. */
const LANGUAGE_NAMES: Readonly<Record<LanguageCode, Phrase>> = {
  de_DE: phrase("German (Germany)", "Deutsch (Deutschland)"),
  de_AT: phrase("German (Austria)", "Deutsch (Österreich)"),
  de_CH: phrase("German (Switzerland)", "Deutsch (Schweiz)"),
  en_US: phrase("English (USA)", "Englisch (USA)"),
  es_ES: phrase("Spanish (Spain)", "Spanisch (Spanien)"),
  fr_FR: phrase("French (France)", "Französisch (Frankreich)"),
  it_IT: phrase("Italian (Italy)", "Italienisch (Italien)"),
  el_GR: phrase("Greek (Greece)", "Griechisch (Griechenland)"),
};

/** "English (USA), en_US" in the preview's language. */
export function languageText(code: LanguageCode, lang: PreviewLanguage): string {
  return `${LANGUAGE_NAMES[code][lang]}, ${code}`;
}

/** `SEVDOC_LANG_EN_US` → `en_US` when it is one of {@link LANGUAGES}, else `undefined`. */
export function languageOfTranslationCode(code: string | undefined): LanguageCode | undefined {
  const match = /^SEVDOC_LANG_([A-Z]{2})_([A-Z]{2})$/.exec(code ?? "");
  if (match === null) return undefined;
  const locale = `${(match[1] ?? "").toLowerCase()}_${match[2] ?? ""}`;
  return (LANGUAGES as readonly string[]).includes(locale) ? (locale as LanguageCode) : undefined;
}

/** The translation code sevDesk lists for `code`, e.g. `SEVDOC_LANG_EN_US`. */
function translationCodeOf(code: LanguageCode): string {
  return `SEVDOC_LANG_${code.toUpperCase()}`;
}

// ---------------------------------------------------------------------------------------------
// Layout lists (DocServer)
// ---------------------------------------------------------------------------------------------

/**
 * Largest DocServer answer read (16 MiB), cut off while streaming. The template list of one type
 * holds 21 rows with thumbnails (up to 184 KB) and HTML (up to 74 KB) each; the whole list of all
 * types was 3.2 MB even with its thumbnails scrubbed (D-114). Only the list of one type is read.
 * `sevdesk_api_get` keeps its own 1 MiB cap and keeps refusing `DocServer`.
 */
export const LAYOUT_LIST_MAX_BYTES = 16 * 1024 * 1024;

/** The `type` of `getTemplatesWithThumb` per kind (the spec's enum). */
const TEMPLATE_TYPES: Readonly<Record<SalesKind, "Invoice" | "Order" | "Creditnote">> = {
  invoice: "Invoice",
  order: "Order",
  creditNote: "Creditnote",
};

/** A letterhead or template to choose from, without its thumbnail, PDF or HTML. */
export interface LayoutOption {
  /** sevDesk's id (a string), the `value` `changeParameter` takes. */
  readonly id: string;
  /** Untrusted (stock names are sevDesk's, own ones the account's), cleaned. */
  readonly name: string | undefined;
  /** The account's default. */
  readonly isDefault: boolean;
  /** sevDesk's `isCustom` (an own upload); `undefined` when sevDesk sent none. */
  readonly custom: boolean | undefined;
  /** A stock entry of sevDesk (`sevClient` "0"). */
  readonly stock: boolean;
  /** Templates: the type sevDesk lists it under (`Invoice`, `Order`, `Creditnote`). */
  readonly type: string | undefined;
  /** Templates: sevDesk's `premium` flag. */
  readonly premium: boolean | undefined;
}

/** Ids are sevDesk's own strings (24 hex digits in the spec's example); kept as sent, capped. */
const optionSchema = z.object({
  id: z.union([z.string().min(1).max(200), z.number().int()]).transform(String),
  name: zText,
  default: zBool01.optional(),
  isCustom: zBool01.optional(),
  sevClient: z.unknown().optional(),
  type: zText,
  premium: zBool01.optional(),
});

function toOption(row: z.output<typeof optionSchema>): LayoutOption {
  return {
    id: row.id,
    name: cleanText(row.name, 200),
    isDefault: row.default === true,
    custom: row.isCustom,
    stock: row.sevClient === "0" || row.sevClient === 0,
    type: cleanText(row.type, 50),
    premium: row.premium,
  };
}

/** The letterheads (Briefpapiere) of the account: `GET /DocServer/getLetterpapersWithThumb`. */
export async function listLetterpapers(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<LayoutOption[]> {
  return readLayoutList(client, "/DocServer/getLetterpapersWithThumb", undefined, "letterpapers", {
    what: "the letterheads",
    signal,
  });
}

/**
 * The templates (Vorlagen) of one document kind: `GET /DocServer/getTemplatesWithThumb?type=…`.
 * Rows of another type are left out.
 */
export async function listTemplates(
  client: SevdeskClient,
  kind: SalesKind,
  signal?: AbortSignal,
): Promise<LayoutOption[]> {
  const type = TEMPLATE_TYPES[kind];
  const rows = await readLayoutList(
    client,
    "/DocServer/getTemplatesWithThumb",
    { type },
    "templates",
    { what: `the ${KINDS[kind].noun} templates`, signal },
  );
  return rows.filter((row) => row.type === undefined || row.type === type);
}

/**
 * One DocServer list: a capped download (no `limit`: the recorded call sent none and got all 147
 * rows of the untyped list, past sevDesk's usual cut at 100), JSON in the envelope, the rows under
 * `objects.<key>` as recorded, each reduced to {@link LayoutOption}.
 */
async function readLayoutList(
  client: SevdeskClient,
  path: string,
  query: Readonly<Record<string, string>> | undefined,
  key: "letterpapers" | "templates",
  options: { readonly what: string; readonly signal?: AbortSignal | undefined },
): Promise<LayoutOption[]> {
  let answer: { body: Uint8Array; contentType: string | undefined };
  try {
    answer = await client.download({
      method: "GET",
      path,
      ...(query === undefined ? {} : { query }),
      maxBytes: LAYOUT_LIST_MAX_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (isOversized(error)) {
      throw unexpected(
        `sevDesk's list of ${options.what} is larger than ` +
          `${String(LAYOUT_LIST_MAX_BYTES / (1024 * 1024))} MiB, so it was not read.`,
        path,
        true,
      );
    }
    throw error;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(answer.body)) as unknown;
  } catch {
    throw unexpected(`sevDesk answered the list of ${options.what} with something not JSON.`, path);
  }
  const objects = readEnvelope(body)?.objects;
  const rows =
    typeof objects === "object" && objects !== null && !Array.isArray(objects)
      ? (objects as Record<string, unknown>)[key]
      : undefined;
  if (!Array.isArray(rows)) {
    throw unexpected(`sevDesk returned the list of ${options.what} in an unexpected format.`, path);
  }
  return rows.map((row) => toOption(parseUpstream(optionSchema, row, `one of ${options.what}`)));
}

/** The client's cap error: `unexpected_response` with a 2xx status. */
function isOversized(error: unknown): boolean {
  return (
    error instanceof SevdeskError &&
    error.kind === "unexpected_response" &&
    error.status !== undefined &&
    error.status >= 200 &&
    error.status < 300
  );
}

function unexpected(message: string, path: string, expectedLimit = false): SevdeskError {
  return new SevdeskError({
    kind: "unexpected_response",
    message,
    method: "GET",
    path,
    ...(expectedLimit ? { expectedLimit } : {}),
  });
}

/**
 * The option `input` names among `options`: its id exactly, else its name (case-insensitive,
 * surrounding space ignored). Throws a trusted `validation` error for an unknown or ambiguous
 * name; `what` and `lookup` are trusted ("template", "kind=templates").
 */
export function resolveLayoutOption(
  options: readonly LayoutOption[],
  input: string,
  what: { readonly noun: string; readonly lookup: string },
): LayoutOption {
  const byId = options.find((option) => option.id === input);
  if (byId !== undefined) return byId;
  const wanted = input.trim().toLocaleLowerCase("de-DE");
  const byName = options.filter(
    (option) => option.name?.toLocaleLowerCase("de-DE") === wanted && wanted !== "",
  );
  const [only] = byName;
  if (only !== undefined && byName.length === 1) return only;
  throw new SevdeskError({
    kind: "validation",
    message:
      byName.length > 1
        ? `${String(byName.length)} ${what.noun}s have this name; pass the id of the one you ` +
          `mean (sevdesk_reference_lookup ${what.lookup} lists them).`
        : `sevDesk offers no ${what.noun} with this id or name for this document; ` +
          `sevdesk_reference_lookup ${what.lookup} lists the ones it offers. Nothing was changed.`,
  });
}

// ---------------------------------------------------------------------------------------------
// The layout of one document (parameters)
// ---------------------------------------------------------------------------------------------

/** The keys this server reads and sets (the other twelve print options are left alone). */
export const LAYOUT_KEYS = ["language", "template", "letterpaper"] as const;

export type LayoutKey = (typeof LAYOUT_KEYS)[number];

/** One choice of a print option as sevDesk lists it. */
export interface LayoutChoice {
  readonly value: string;
  /** Untrusted, cleaned. */
  readonly name: string | undefined;
  /** Languages: `SEVDOC_LANG_EN_US`, … */
  readonly translationCode: string | undefined;
}

/** One print option: its current value (as sent, untrusted) and its choices. */
export interface LayoutParameter {
  readonly value: string | undefined;
  readonly choices: readonly LayoutChoice[];
}

/** The language, template and letterhead of a document, as a layout answer lists them. */
export type DocumentLayout = Readonly<Partial<Record<LayoutKey, LayoutParameter>>>;

/** A scalar layout value as text: strings as sent, numbers as digits, anything else unset. */
const zLayoutValue = z
  .unknown()
  .optional()
  .transform((value) =>
    typeof value === "string" && value !== ""
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined,
  );

const choiceSchema = z.object({
  name: zLayoutValue,
  value: zLayoutValue,
  translationCode: zLayoutValue,
});

const parameterSchema = z.object({
  key: z.string(),
  value: zLayoutValue,
  values: z
    .array(z.unknown())
    .nullish()
    .transform((value) => value ?? []),
});

/** `parameters` under `metaData` (changeParameter) or at the top (render), else `undefined`. */
function parametersOf(objects: unknown): unknown {
  if (typeof objects !== "object" || objects === null || Array.isArray(objects)) return undefined;
  const record = objects as Record<string, unknown>;
  const meta = record["metaData"];
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    return (meta as Record<string, unknown>)["parameters"];
  }
  return record["parameters"];
}

/**
 * Reads the language, template and letterhead from a layout answer (`objects` of `render` or of
 * `changeParameter`); the PDF and the other print options are ignored. An answer without a
 * `parameters` list, or a listed option of ours that does not fit, is `unexpected_response`
 * (`what` is trusted, e.g. "the layout of invoice 1001").
 */
export function parseLayoutAnswer(objects: unknown, what: string): DocumentLayout {
  const parameters = parametersOf(objects);
  if (!Array.isArray(parameters)) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message: `sevDesk returned ${what} without its print options (parameters).`,
    });
  }
  const layout: Partial<Record<LayoutKey, LayoutParameter>> = {};
  for (const raw of parameters) {
    const key =
      typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["key"] : undefined;
    if (typeof key !== "string" || !(LAYOUT_KEYS as readonly string[]).includes(key)) continue;
    const parameter = parseUpstream(parameterSchema, raw, what);
    const choices = parameter.values.flatMap((entry) => {
      const choice = parseUpstream(choiceSchema, entry, what);
      return choice.value === undefined
        ? []
        : [
            {
              value: choice.value,
              name: cleanText(choice.name, 200),
              translationCode: choice.translationCode,
            },
          ];
    });
    layout[key as LayoutKey] = { value: parameter.value, choices };
  }
  return layout;
}

/** The language a parameter's current value stands for, by the matching choice's code. */
export function currentLanguage(parameter: LayoutParameter | undefined): LanguageCode | undefined {
  if (parameter?.value === undefined) return undefined;
  const choice = parameter.choices.find((item) => item.value === parameter.value);
  return languageOfTranslationCode(choice?.translationCode);
}

/** The choice of a language parameter for `code`, by its translation code. */
export function languageChoice(
  parameter: LayoutParameter | undefined,
  code: LanguageCode,
): LayoutChoice | undefined {
  const wanted = translationCodeOf(code);
  return parameter?.choices.find((choice) => choice.translationCode === wanted);
}

/** The offered languages of a language parameter that this server knows, in its order. */
export function offeredLanguages(parameter: LayoutParameter | undefined): LanguageCode[] {
  const codes = new Set(
    (parameter?.choices ?? []).map((choice) => languageOfTranslationCode(choice.translationCode)),
  );
  return LANGUAGES.filter((code) => codes.has(code));
}

/** The name sevDesk lists for a parameter's current value (template, letterhead), cleaned. */
export function currentChoiceName(parameter: LayoutParameter | undefined): string | undefined {
  if (parameter?.value === undefined) return undefined;
  return parameter.choices.find((choice) => choice.value === parameter.value)?.name;
}

/** The current raw values, for an approval binding. */
export function layoutValues(layout: DocumentLayout): Record<LayoutKey, string | null> {
  return {
    language: layout.language?.value ?? null,
    template: layout.template?.value ?? null,
    letterpaper: layout.letterpaper?.value ?? null,
  };
}

/**
 * Reads the layout of an invoice, order or credit note without changing it:
 * `POST /{Invoice|Order|CreditNote}/{id}/render` with `{forceReload: false}` (a reading POST,
 * D-113, see `read-posts.ts`). The answer's base64 PDF is dropped here.
 */
export async function readDocumentLayout(
  client: SevdeskClient,
  kind: SalesKind,
  id: number,
  signal?: AbortSignal,
): Promise<DocumentLayout> {
  const objects = await client.request({
    method: "POST",
    path: sevdeskPath(KINDS[kind].objectName, id, "render"),
    body: RENDER_WITHOUT_RELOAD,
    ...(signal === undefined ? {} : { signal }),
  });
  return parseLayoutAnswer(objects, `the layout of ${KINDS[kind].noun} ${String(id)}`);
}

/**
 * The PDF preview sevDesk needs before it accepts a layout change on an order or credit note
 * (D-113): `getPdf` through `fetchDocumentFile`, which always sends `preventSendBy=true`, so the
 * draft stays a draft (D-023). The PDF itself is not kept.
 */
export async function previewBeforeLayoutChange(
  client: SevdeskClient,
  kind: Exclude<SalesKind, "invoice">,
  id: number,
  signal?: AbortSignal,
): Promise<void> {
  await fetchDocumentFile(client, kind === "order" ? "order_pdf" : "credit_note_pdf", id, signal);
}

/**
 * Sets one print option: `PUT /{Invoice|Order|CreditNote}/{id}/changeParameter` with `{key,
 * value}` (`commit` in the client's tier table; never retried) and returns the layout its answer
 * lists. The request is sent before the answer is parsed: a parse failure means the change was
 * made (the caller reports it as completed).
 */
export async function changeLayoutParameter(
  client: SevdeskClient,
  kind: SalesKind,
  id: number,
  change: { readonly key: LayoutKey; readonly value: string },
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "PUT",
    path: sevdeskPath(KINDS[kind].objectName, id, "changeParameter"),
    body: { key: change.key, value: change.value },
    ...(signal === undefined ? {} : { signal }),
  });
}
