/**
 * `sevdesk_document_set_layout`: the language (Sprache), template (Vorlage) and letterhead
 * (Briefpapier) of a draft invoice, order or credit note, through
 * `PUT /{Invoice|Order|CreditNote}/{id}/changeParameter` (`{key, value}`, one key per request;
 * spec/deviations.md D-113, D-140). One tool with a `kind`, like `sevdesk_document_save`.
 *
 * Why `commit` although it only touches drafts (ADR 0003, "The layout of a document"): the HTTP
 * client lists `changeParameter` as `commit`, because on a finalized document it changes what was
 * already sent, and the client cannot tell from a request whether the target is a draft. A `write`
 * tool sending it would need an exception the client cannot check. So the rule stays, and this
 * tool, which refuses everything but drafts, asks a human; the finalize approval shows a draft's
 * layout again (`src/domain/lifecycle/content.ts`).
 *
 * What it does, in order:
 * - `prepare`: reads the document (drafts only, no recurring templates), its current layout
 *   (`render` without reload, a reading POST), and the template list of its type and the
 *   letterheads (only those asked for, `src/domain/layouts.ts`). Unknown or ambiguous templates
 *   and letterheads, and a language the document does not offer, are refused before anything is
 *   sent; so is a call that would change nothing. The preview shows the current and the new
 *   choice.
 * - `execute`: for an order or credit note first the PDF preview sevDesk needs (`getPdf` with
 *   `preventSendBy=true`, D-113), then one `changeParameter` per changed key in the order
 *   language, template, letterhead, never repeated. A failure after the first names what was
 *   set. The layout the last answer lists (or, if it lists none, a `render` read) must hold every
 *   choice sent: orders and credit notes store German for a language they do not take, without
 *   an error (D-140), so a difference is a failure, reported with the document as changed.
 */
import { z } from "zod";

import { cleanText, compact } from "../../domain/common.js";
import {
  changeLayoutParameter,
  currentChoiceName,
  currentLanguage,
  type DocumentLayout,
  languageChoice,
  type LanguageCode,
  LANGUAGES,
  languageText,
  LAYOUT_KEYS,
  type LayoutKey,
  layoutValues,
  listLetterpapers,
  listTemplates,
  offeredLanguages,
  parseLayoutAnswer,
  previewBeforeLayoutChange,
  readDocumentLayout,
  resolveLayoutOption,
} from "../../domain/layouts.js";
import {
  documentRef,
  KINDS,
  type LifecycleDocument,
  readLifecycleDocument,
  type SalesKind,
  STATUS,
} from "../../domain/lifecycle/documents.js";
import { documentFacts, documentTitle } from "../../domain/lifecycle/preview.js";
import { refuse } from "../../domain/lifecycle/transitions.js";
import {
  bothPreviews,
  inLanguage,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../../domain/preview-text.js";
import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
import { SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import { defineWriteTool } from "../define-tool.js";
import { capitalize, documentObject, KIND_TOOLS } from "../lifecycle/shared.js";
import type { ToolContext } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

/** The values of the `kind` argument. */
const KIND_ARGS = ["invoice", "credit_note", "order"] as const;

type LayoutKindArg = (typeof KIND_ARGS)[number];

/** The lifecycle kind each `kind` argument names. */
const LAYOUT_KINDS: Readonly<Record<LayoutKindArg, SalesKind>> = {
  invoice: "invoice",
  credit_note: "creditNote",
  order: "order",
};

const SALES_KINDS: readonly SalesKind[] = KIND_ARGS.map((arg) => LAYOUT_KINDS[arg]);

const choiceOutput = z.object({
  id: z.string().describe("sevDesk's id of the choice."),
  name: z.string().optional().describe("Its name as sevDesk lists it."),
});

const output = z.object({
  kind: z.enum(KIND_ARGS),
  id: z.number().int().describe("The draft's id."),
  applied: z
    .array(z.enum(LAYOUT_KEYS))
    .describe("The print options sevDesk accepted, in the order they were sent."),
  layout: z
    .object({
      language: z
        .object({
          code: z.enum(LANGUAGES).optional().describe("The language, when it is one offered here."),
          value: z.string().describe("The value sevDesk stores, e.g. en for en_US on invoices."),
        })
        .optional(),
      template: choiceOutput.optional(),
      letterpaper: choiceOutput
        .optional()
        .describe("Left out when none is chosen (sevDesk's standard)."),
    })
    .describe("Language, template and letterhead as sevDesk lists them after the change."),
});

/** Trusted names of the three print options. */
const KEY_NAMES: Readonly<Record<LayoutKey, Phrase>> = {
  language: phrase("language", "Sprache"),
  template: phrase("template", "Vorlage"),
  letterpaper: phrase("letterhead", "Briefpapier"),
};

const LABELS: Readonly<Record<LayoutKey, Phrase>> = {
  language: phrase("Language (Sprache)", "Sprache"),
  template: phrase("Template (Vorlage)", "Vorlage"),
  letterpaper: phrase("Letterhead (Briefpapier)", "Briefpapier"),
};

const NONE_CHOSEN: Phrase = phrase(
  "none chosen (sevDesk's standard)",
  "nicht gewählt (Standard von sevDesk)",
);

const ONE_REQUEST_EACH: Phrase = phrase(
  "Each choice goes to sevDesk as a request of its own (changeParameter), in the order " +
    "language, template, letterhead, and none is repeated. If one fails, those before it stay " +
    "set and the result says which.",
  "Jede Auswahl geht als eigene Anfrage an sevDesk (changeParameter), in der Reihenfolge " +
    "Sprache, Vorlage, Briefpapier, und keine wird wiederholt. Schlägt eine fehl, bleiben die " +
    "vorherigen gesetzt, und das Ergebnis nennt sie.",
);

const ONLY_LAYOUT: Phrase = phrase(
  "Only the layout changes: status, number, texts and positions of the draft stay as they are.",
  "Nur das Layout ändert sich: Status, Nummer, Texte und Positionen des Entwurfs bleiben, wie " +
    "sie sind.",
);

const PREVIEW_FIRST: Phrase = phrase(
  "sevDesk takes a layout change on this draft only after a PDF preview, so the server fetches " +
    "one first (getPdf with preventSendBy=true, which leaves the draft a draft).",
  "sevDesk nimmt eine Layout-Änderung an diesem Entwurf erst nach einer PDF-Vorschau an; der " +
    "Server ruft daher zuerst eine ab (getPdf mit preventSendBy=true, der Entwurf bleibt ein " +
    "Entwurf).",
);

/** One planned request and how the preview and the read-back name its choice. */
interface PlannedChange {
  readonly key: LayoutKey;
  /** What `changeParameter` gets: the language's locale form, the template's or letterhead's id. */
  readonly value: string;
  /** Trusted (languages) or untrusted (templates, letterheads) display text per language. */
  readonly text: Phrase;
}

interface LayoutState {
  readonly changes: readonly PlannedChange[];
}

/** `sevdesk_document_set_layout`: language, template and letterhead of a draft. */
export const documentSetLayoutTool = defineWriteTool({
  name: "sevdesk_document_set_layout",
  title: "Set the language, template or letterhead of a draft",
  description:
    "Set the language (Sprache), template (Vorlage) or letterhead (Briefpapier) of a draft " +
    "invoice (Rechnung), order (Angebot, Auftragsbestätigung, Lieferschein) or credit note " +
    "(Gutschrift), e.g. an English invoice on a second letterhead. Drafts only. language: " +
    `${LANGUAGES.join(", ")}; template and letterpaper: an id or name from ` +
    "sevdesk_reference_lookup kind=templates (with documentType) or kind=letterpapers. Commit " +
    "tier: sevDesk's endpoint (changeParameter) can also re-render finalized documents, so a " +
    "human confirms the preview of the current and new choice; dryRun only previews. Other " +
    "print options stay. Before: the draft tool, e.g. sevdesk_invoice_create_draft. After: " +
    "sevdesk_invoice_pdf to look at it, sevdesk_invoice_finalize.",
  toolset: "meta",
  tier: "commit",
  available: (config) => SALES_KINDS.some((kind) => config.toolsets.has(KIND_TOOLS[kind].toolset)),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    kind: z.enum(KIND_ARGS).describe("Which document: invoice, credit_note or order."),
    id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe(
        "Draft id (not its number), e.g. from sevdesk_invoices_list, sevdesk_orders_list or " +
          "sevdesk_credit_notes_list.",
      ),
    language: z
      .enum(LANGUAGES)
      .optional()
      .describe("Language of the printed document, e.g. en_US for English."),
    template: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Template (Vorlage): its id or exact name."),
    letterpaper: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Letterhead (Briefpapier): its id or exact name."),
    ...dryRunInputShape,
  }),
  output,
  // Serialized with other calls on the same record (see WriteToolDefinition.locks).
  locks: (args) => [documentObject(LAYOUT_KINDS[args.kind], args.id)],
  prepare: async (args, ctx) => {
    const kind = LAYOUT_KINDS[args.kind];
    const { toolset } = KIND_TOOLS[kind];
    // First, so a refusal costs no sevDesk request.
    if (!ctx.config.toolsets.has(toolset)) {
      refuse(
        `Setting the layout of ${KINDS[kind].noun} drafts needs the ${toolset} toolset, which ` +
          "is not enabled (SEVDESK_TOOLSETS).",
      );
    }
    if (
      args.language === undefined &&
      args.template === undefined &&
      args.letterpaper === undefined
    ) {
      refuse("Nothing to change: give language, template or letterpaper (or several).");
    }
    const doc = await readDraft(ctx, kind, args.id);
    const current = await readDocumentLayout(ctx.client, kind, doc.id, ctx.signal);
    const changes: PlannedChange[] = [];
    if (args.language !== undefined) {
      changes.push(languageChange(doc, current, args.language));
    }
    if (args.template !== undefined) {
      const option = resolveLayoutOption(
        await listTemplates(ctx.client, kind, ctx.signal),
        args.template,
        { noun: "template", lookup: "kind=templates" },
      );
      changes.push(optionChange("template", option.id, option.name));
    }
    if (args.letterpaper !== undefined) {
      const option = resolveLayoutOption(
        await listLetterpapers(ctx.client, ctx.signal),
        args.letterpaper,
        { noun: "letterhead", lookup: "kind=letterpapers" },
      );
      changes.push(optionChange("letterpaper", option.id, option.name));
    }
    const pending = changes.filter((change) => !holds(current, change));
    if (pending.length === 0) {
      refuse(
        `${documentRef(doc, true)} already has the ${keyList(changes, "en")} asked for; ` +
          "nothing to change.",
      );
    }
    const warnings: Phrase[] = [
      ONLY_LAYOUT,
      ONE_REQUEST_EACH,
      ...(kind === "invoice" ? [] : [PREVIEW_FIRST]),
    ];
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `${capitalize(keyList(pending, lang))} von ${documentTitle(doc, lang)} (Entwurf) ` +
              "ändern."
            : `Set the ${keyList(pending, lang)} of ${documentTitle(doc)} (draft).`,
        facts: [
          ...documentFacts(doc, lang),
          ...changes.map((change) => ({
            label: LABELS[change.key][lang],
            value: changeText(change, current, lang),
          })),
        ],
        warnings: inLanguage(warnings, lang),
        irreversible: false,
      })),
      // The record and the current layout: a draft finalized or a layout changed in between asks
      // again.
      binding: sha256Hex(canonicalJson({ kind, record: doc.raw, layout: layoutValues(current) })),
      state: { changes: pending } satisfies LayoutState,
    };
  },
  execute: async (args, plan, ctx) => {
    const kind = LAYOUT_KINDS[args.kind];
    const changed = documentObject(kind, args.id);
    if (kind !== "invoice") {
      await previewBeforeLayoutChange(ctx.client, kind, args.id, ctx.signal);
    }
    const applied: LayoutKey[] = [];
    let answer: unknown;
    for (const change of plan.state.changes) {
      try {
        answer = await changeLayoutParameter(ctx.client, kind, args.id, change, ctx.signal);
      } catch (error) {
        if (error instanceof SevdeskError && applied.length > 0) {
          throw partialFailure(error, kind, args.id, applied, plan.state.changes);
        }
        throw error;
      }
      applied.push(change.key);
    }
    const layout = await readBack(ctx, kind, args.id, answer);
    checkStored(layout, kind, args.id, plan.state.changes);
    return {
      data: {
        kind: args.kind,
        id: args.id,
        applied,
        layout: layoutOutput(layout),
      },
      summary:
        `Set the ${keyList(plan.state.changes, "en")} of ${KINDS[kind].noun} ` +
        `${String(args.id)} (draft); sevDesk lists what was sent.`,
      affected: [changed],
    };
  },
});

/** Reads the document and refuses anything but a draft (and recurring invoice templates). */
async function readDraft(
  ctx: ToolContext,
  kind: SalesKind,
  id: number,
): Promise<LifecycleDocument<SalesKind>> {
  let doc: LifecycleDocument<SalesKind>;
  try {
    doc = await readLifecycleDocument(ctx.client, kind, id, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      refuse(`${capitalize(KINDS[kind].noun)} ${String(id)} does not exist in sevDesk.`);
    }
    throw error;
  }
  if (kind === "invoice" && doc.typeCode === "WKR") {
    refuse(
      `${documentRef(doc, true)} is a recurring invoice template (WKR, Abo-Rechnung); its ` +
        "layout is not set here.",
    );
  }
  if (doc.status !== STATUS.draft) {
    refuse(
      `${documentRef(doc, true)} is not a draft (status ${String(doc.status)}, ` +
        `${doc.statusLabel}); this tool sets the layout of drafts only, before they are ` +
        "finalized.",
    );
  }
  return doc;
}

/**
 * The language change, sent in the locale form all three kinds take (D-140). Refused when the
 * document's language choices do not list the code: on orders and credit notes sevDesk would
 * store German instead without saying so.
 */
function languageChange(
  doc: LifecycleDocument,
  current: DocumentLayout,
  code: LanguageCode,
): PlannedChange {
  if (languageChoice(current.language, code) === undefined) {
    const offered = offeredLanguages(current.language);
    refuse(
      `sevDesk does not offer the language ${code} for ${documentRef(doc)}. ` +
        (offered.length === 0
          ? "It lists none of the languages this server knows."
          : `It offers: ${offered.join(", ")}.`) +
        " Nothing was changed.",
    );
  }
  return {
    key: "language",
    value: code,
    text: phrase(languageText(code, "en"), languageText(code, "de")),
  };
}

function optionChange(
  key: "template" | "letterpaper",
  id: string,
  name: string | undefined,
): PlannedChange {
  const shown = (lang: PreviewLanguage) =>
    `${name ?? (lang === "de" ? "(ohne Namen)" : "(no name)")} (${lang === "de" ? "ID" : "id"} ${id})`;
  return { key, value: id, text: phrase(shown("en"), shown("de")) };
}

/**
 * Whether `layout` holds `change`: a language by its translation code (invoices store `en` for
 * `en_US`), a template or letterhead by its id.
 */
function holds(layout: DocumentLayout, change: PlannedChange): boolean {
  if (change.key === "language") return currentLanguage(layout.language) === change.value;
  return layout[change.key]?.value === change.value;
}

/** "current → new", or "new (unchanged)" for a key the document already has. */
function changeText(change: PlannedChange, current: DocumentLayout, lang: PreviewLanguage): string {
  const next = change.text[lang];
  if (holds(current, change)) return `${next} (${lang === "de" ? "unverändert" : "unchanged"})`;
  return `${currentText(change.key, current, lang)} → ${next}`;
}

/** The current choice of `key`, as the preview shows it. */
function currentText(key: LayoutKey, current: DocumentLayout, lang: PreviewLanguage): string {
  if (key === "language") {
    const code = currentLanguage(current.language);
    if (code !== undefined) return languageText(code, lang);
    return cleanText(current.language?.value, 100) ?? NONE_CHOSEN[lang];
  }
  const id = cleanText(current[key]?.value, 200);
  if (id === undefined) return NONE_CHOSEN[lang];
  const name = currentChoiceName(current[key]);
  const idText = `${lang === "de" ? "ID" : "id"} ${id}`;
  return name === undefined ? idText : `${name} (${idText})`;
}

/** "language, template and letterhead" / "Sprache, Vorlage und Briefpapier". */
function keyList(changes: readonly PlannedChange[], lang: PreviewLanguage): string {
  const names = changes.map((change) => KEY_NAMES[change.key][lang]);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} ${lang === "de" ? "und" : "and"} ${names.at(-1) ?? ""}`;
}

/** "language, template" in English, for trusted error text. */
function keyNames(keys: readonly LayoutKey[]): string {
  return keys.map((key) => KEY_NAMES[key].en).join(", ");
}

/**
 * A request failed after others were applied: the same failure with the document as a completed
 * write and a trusted sentence naming what was set and what was not.
 */
function partialFailure(
  error: SevdeskError,
  kind: SalesKind,
  id: number,
  applied: readonly LayoutKey[],
  changes: readonly PlannedChange[],
): SevdeskError {
  const missing = changes.map((change) => change.key).filter((key) => !applied.includes(key));
  return new SevdeskError({
    kind: error.kind,
    message:
      `${error.message} Already set on ${KINDS[kind].noun} ${String(id)}: ${keyNames(applied)}. ` +
      `Not set: ${keyNames(missing)}. Do not repeat the whole call; check the document ` +
      `(${KINDS[kind].toolPrefix}_pdf) and set only what is missing.`,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.upstreamMessage === undefined ? {} : { upstreamMessage: error.upstreamMessage }),
    ...(error.method === undefined ? {} : { method: error.method }),
    ...(error.path === undefined ? {} : { path: error.path }),
    cause: error,
    completedWrites: [documentObject(kind, id)],
  });
}

/**
 * The layout after the changes: from the last answer's `metaData.parameters`, or, when that lists
 * none, from a `render` read (a reading POST). A failure of that read carries the document as a
 * completed write.
 */
async function readBack(
  ctx: ToolContext,
  kind: SalesKind,
  id: number,
  answer: unknown,
): Promise<DocumentLayout> {
  try {
    return parseLayoutAnswer(answer, `the layout of ${KINDS[kind].noun} ${String(id)}`);
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
  }
  try {
    return await readDocumentLayout(ctx.client, kind, id, ctx.signal);
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, [documentObject(kind, id)]);
    throw error;
  }
}

/**
 * Fails, with the document as a completed write, when the layout does not hold every change sent
 * (D-140: orders and credit notes store German for a language they do not take). The message
 * names keys and language codes only.
 */
function checkStored(
  layout: DocumentLayout,
  kind: SalesKind,
  id: number,
  changes: readonly PlannedChange[],
): void {
  const differ = changes.filter((change) => !holds(layout, change));
  if (differ.length === 0) return;
  const stored = currentLanguage(layout.language);
  const language = differ.some((change) => change.key === "language")
    ? ` The language stored is ${stored ?? "one this server does not know"}.`
    : "";
  throw new SevdeskError({
    kind: "unexpected_response",
    message:
      `sevDesk accepted the layout changes of ${KINDS[kind].noun} ${String(id)}, but it lists ` +
      `another ${keyNames(differ.map((change) => change.key))} than the one sent.${language} ` +
      `Check the document with ${KINDS[kind].toolPrefix}_pdf and set it again if needed.`,
    completedWrites: [documentObject(kind, id)],
  });
}

/** The output's `layout`: what sevDesk lists, ids and values as it sent them (cleaned). */
function layoutOutput(layout: DocumentLayout): z.input<typeof output>["layout"] {
  const option = (key: "template" | "letterpaper") => {
    const id = cleanText(layout[key]?.value, 200);
    return id === undefined ? undefined : compact({ id, name: currentChoiceName(layout[key]) });
  };
  const value = cleanText(layout.language?.value, 100);
  return compact({
    language:
      value === undefined ? undefined : compact({ code: currentLanguage(layout.language), value }),
    template: option("template"),
    letterpaper: option("letterpaper"),
  });
}
