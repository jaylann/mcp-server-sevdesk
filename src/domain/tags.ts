/**
 * Tags (Tags, Schlagworte) of invoices, credit notes, orders and vouchers: lenient parsing of
 * sevDesk's `Tag` and `TagRelation` records, the tag list with usage counts, name lookups and the
 * `tag` filter of the document lists. The tag writes are in `tags-write.ts`.
 *
 * Recorded 2026-11-16 (spec/deviations.md D-088–D-090):
 * - `GET /Tag` rows carry `id`, `name` and no usage count; a tag is used through `TagRelation`
 *   rows (`tag: {id, objectName: "Tag"}`, `object: {id, objectName}`), and `GET /TagRelation`
 *   honours `tag[id]` + `tag[objectName]` and `object[id]` + `object[objectName]`, with `total`.
 *   Usage counts are therefore counted from the relations.
 * - sevDesk compares tag names ignoring case and accents when it tags a document by name. How
 *   `GET /Tag`'s own `name` filter matches is not measured, so names are looked up here, folded
 *   the same way ({@link foldName}), against all of the account's tags.
 * - The document lists filter by tag only with `tags[0][id]` + `tags[0][objectName]=Tag`; the
 *   spellings `tag[id]` and `tag` are ignored without an error (the whole list comes back). The
 *   rows carry no tags, so every row is checked again against the ids of the documents the
 *   tag's relations name (D-035).
 *
 * Tag names are untrusted text: they go into DTOs through `cleanText` and never into summaries
 * or error messages. Names are matched, and sent back to sevDesk, as sevDesk stores them
 * ({@link TagRecord.storedName}): the cleaned form drops invisible characters, truncates and
 * stands in a placeholder for a tag without a name, so sevDesk would not know it.
 */
import { z } from "zod";

import { SevdeskError } from "../sevdesk/errors.js";
import { parseUpstream, zId, zRef, zText } from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { cleanText } from "./common.js";
import { listChildRows, type PageState, type PageWindow, readPage } from "./paging.js";

/** Longest tag name accepted as an argument (sevDesk documents no limit). */
export const TAG_NAME_MAX = 255;

/**
 * Most tags or tag relations read for one lookup or count. Above it a count is a lower bound and
 * a list filter keeps rows on sevDesk's word (see {@link TagListFilter.complete}).
 */
export const TAG_READ_MAX = 10_000;
const TAG_PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------------------------
// Document kinds
// ---------------------------------------------------------------------------------------------

/** The document kinds sevDesk tags (spec `createTag`), as tool arguments name them. */
export const TAG_DOCUMENT_KINDS = ["invoice", "credit_note", "order", "voucher"] as const;
export type TagDocumentKind = (typeof TAG_DOCUMENT_KINDS)[number];

/** sevDesk's `objectName` per kind: the `object` of a TagRelation and of `Tag/Factory/create`. */
export const TAG_OBJECT_NAMES: Readonly<
  Record<TagDocumentKind, "Invoice" | "CreditNote" | "Order" | "Voucher">
> = {
  invoice: "Invoice",
  credit_note: "CreditNote",
  order: "Order",
  voucher: "Voucher",
};

function kindOfObjectName(objectName: string): TagDocumentKind | undefined {
  return TAG_DOCUMENT_KINDS.find((kind) => TAG_OBJECT_NAMES[kind] === objectName);
}

// ---------------------------------------------------------------------------------------------
// Upstream schemas (lenient)
// ---------------------------------------------------------------------------------------------

const tagRecordSchema = z.object({ id: zId, name: zText });

const tagRelationRecordSchema = z.object({
  id: zId,
  tag: zRef("Tag"),
  object: zRef(),
});

/** A tag as read from sevDesk. */
export interface TagRecord {
  readonly id: number;
  /** The name for output: cleaned untrusted text, or a placeholder when the tag has none. */
  readonly name: string;
  /**
   * The name exactly as sevDesk stores it ("" when it has none): what names are matched against
   * and what is sent back to sevDesk. Untrusted and uncleaned, so never shown.
   */
  readonly storedName: string;
}

/** One use of a tag: the tag on one document. */
export interface TagRelation {
  readonly id: number;
  readonly tagId: number;
  readonly objectId: number;
  readonly objectName: string;
}

function parseTag(raw: unknown): TagRecord {
  const record = parseUpstream(tagRecordSchema, raw, "a tag");
  return {
    id: record.id,
    name: cleanText(record.name, TAG_NAME_MAX) ?? `(unnamed tag ${record.id})`,
    storedName: record.name ?? "",
  };
}

/** Parses one `TagRelation` (a `GET /TagRelation` row or the answer of `Tag/Factory/create`). */
export function parseTagRelation(raw: unknown): TagRelation {
  const record = parseUpstream(tagRelationRecordSchema, raw, "a tag relation");
  return {
    id: record.id,
    tagId: record.tag.id,
    objectId: record.object.id,
    objectName: record.object.objectName,
  };
}

/** The relation filter of one tag (D-088: honoured). */
function tagRelationQuery(tagId: number): Record<string, QueryValue> {
  return { "tag[id]": tagId, "tag[objectName]": "Tag" };
}

// ---------------------------------------------------------------------------------------------
// The tag list
// ---------------------------------------------------------------------------------------------

/** Uses per document kind; kinds without a use are left out. */
const usedOnSchema = z.object({
  invoice: z.number().int().optional(),
  credit_note: z.number().int().optional(),
  order: z.number().int().optional(),
  voucher: z.number().int().optional(),
});

/** One row of `sevdesk_tags_list`. */
export const tagDtoSchema = z.object({
  id: z.number().int(),
  name: z.string().describe("Tag name as stored in sevDesk."),
  uses: z
    .number()
    .int()
    .describe("Documents carrying the tag (TagRelation rows); see usesComplete."),
  usedOn: usedOnSchema.describe("Uses per document kind; kinds without a use are left out."),
});

type TagDto = z.output<typeof tagDtoSchema>;

export interface TagListResult {
  readonly items: readonly TagDto[];
  readonly window: PageWindow;
  readonly state: PageState;
  /** False when the account has more relations than {@link TAG_READ_MAX}: counts are lower bounds. */
  readonly usesComplete: boolean;
}

/**
 * One page of tags (`GET /Tag`, explicit `limit`) with how often each is used: the account's tag
 * relations are read once (`GET /TagRelation`, up to {@link TAG_READ_MAX} rows in pages of 1,000)
 * and counted per tag and document kind.
 */
export async function listTags(
  client: SevdeskClient,
  page: { readonly limit: number; readonly offset: number },
  signal?: AbortSignal,
): Promise<TagListResult> {
  const withSignal = signal === undefined ? {} : { signal };
  const [tags, relations] = await Promise.all([
    readPage(client, "/Tag", {}, page, parseTag, signal),
    client.listAll("/TagRelation", undefined, {
      max: TAG_READ_MAX,
      pageSize: TAG_PAGE_SIZE,
      ...withSignal,
    }),
  ]);
  const counts = new Map<
    number,
    { uses: number; usedOn: Partial<Record<TagDocumentKind, number>> }
  >();
  for (const raw of relations.items) {
    const relation = parseTagRelation(raw);
    const count = counts.get(relation.tagId) ?? { uses: 0, usedOn: {} };
    count.uses += 1;
    const kind = kindOfObjectName(relation.objectName);
    if (kind !== undefined) count.usedOn[kind] = (count.usedOn[kind] ?? 0) + 1;
    counts.set(relation.tagId, count);
  }
  return {
    items: tags.items.map((tag) => {
      const count = counts.get(tag.id);
      return { id: tag.id, name: tag.name, uses: count?.uses ?? 0, usedOn: { ...count?.usedOn } };
    }),
    window: tags.window,
    state: tags.state,
    usesComplete: !relations.truncated,
  };
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** The account's tags as compared with one name; see {@link findTagsByName}. */
export interface TagMatches {
  /** The tags whose stored name equals the name, ignoring case and accents ({@link foldName}). */
  readonly matches: readonly TagRecord[];
  /**
   * Tags that do not match but whose name differs only in what {@link looseFoldName} also
   * ignores: sevDesk may treat them as the same name, which is not measured. A hint, never a pick.
   */
  readonly similar: readonly TagRecord[];
  /** Every tag read, by id: tells after a write whether sevDesk used a tag that existed. */
  readonly known: ReadonlyMap<number, TagRecord>;
  /** False when the account has more tags than {@link TAG_READ_MAX}: some were not compared. */
  readonly complete: boolean;
}

/**
 * A tag name as sevDesk's tag factory compares it, as far as measured (D-088): trimmed, letter
 * case and accents ignored ("Café" and "cafe" are one tag). Only case and the é/e pair were
 * measured; sevDesk's exact collation (ß, ligatures, …) is not known. NFKD splits accented
 * letters into base letter and combining mark, and the marks are dropped.
 */
function foldName(name: string): string {
  return name.trim().normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Letters NFKD keeps whole that collations commonly spell out (`utf8mb4_unicode_ci`: ß = ss). */
const SPELLED_OUT: Readonly<Record<string, string>> = { ß: "ss", æ: "ae", œ: "oe", ø: "o" };

/**
 * A looser comparison than {@link foldName}, only to warn that sevDesk may reuse a tag: it also
 * drops the invisible characters `cleanText` drops (zero-width spaces, bidi marks, soft hyphens),
 * collapses runs of white space and spells out ß, æ, œ and ø. Database collations commonly ignore
 * these differences, but whether sevDesk does is not measured (D-088).
 */
function looseFoldName(name: string): string {
  return foldName(name.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, ""))
    .replace(/\s+/gu, " ")
    .replace(/[ßæœø]/gu, (letter) => SPELLED_OUT[letter] ?? letter);
}

/**
 * Reads the account's tags (up to {@link TAG_READ_MAX}) and compares their stored names with
 * `name`. A tag without a name matches none.
 */
export async function findTagsByName(
  client: SevdeskClient,
  name: string,
  signal?: AbortSignal,
): Promise<TagMatches> {
  const all = await client.listAll("/Tag", undefined, {
    max: TAG_READ_MAX,
    pageSize: TAG_PAGE_SIZE,
    ...(signal === undefined ? {} : { signal }),
  });
  const tags = all.items.map(parseTag);
  const named = tags.filter((tag) => tag.storedName !== "");
  const folded = foldName(name);
  const loose = looseFoldName(name);
  const matches = named.filter((tag) => foldName(tag.storedName) === folded);
  const similar = named.filter(
    (tag) => foldName(tag.storedName) !== folded && looseFoldName(tag.storedName) === loose,
  );
  return {
    matches,
    similar,
    known: new Map(tags.map((tag) => [tag.id, tag])),
    complete: !all.truncated,
  };
}

/**
 * The one tag a name means: the only match, or among several matches (tags whose names differ
 * only in case or accents, or a rename that duplicated a name, D-089) the only one with exactly
 * that spelling. `undefined` when no tag has the name; a `validation` error when it stays
 * ambiguous.
 */
export function pickTag(found: TagMatches, name: string): TagRecord | undefined {
  if (found.matches.length <= 1) return found.matches[0];
  const exact = found.matches.filter((tag) => tag.storedName.trim() === name.trim());
  if (exact.length === 1) return exact[0];
  throw validation(
    "Several tags have this name (compared ignoring case and accents). Give one of them a " +
      "distinct name in sevDesk first; sevdesk_tags_list shows their ids.",
  );
}

/** How many documents carry a tag; see {@link countTagUses}. */
export interface TagUses {
  readonly count: number;
  /** False when more than {@link TAG_READ_MAX} relations had to be read: `count` is a lower bound. */
  readonly complete: boolean;
}

/**
 * Counts a tag's relations (`GET /TagRelation` filtered by the tag) with `listChildRows`: every
 * row of the first 1,000 is checked to belong to the tag, so a filter sevDesk ignored cannot pass
 * off the account's relation count as the tag's and hide that a removal takes its last use.
 */
export async function countTagUses(
  client: SevdeskClient,
  tagId: number,
  signal?: AbortSignal,
): Promise<TagUses> {
  const uses = await listChildRows(
    client,
    "/TagRelation",
    tagRelationQuery(tagId),
    { parse: parseTagRelation, belongs: (row) => row.tagId === tagId },
    signal,
  );
  return { count: uses.rows.length, complete: uses.complete };
}

/**
 * The relation that puts a tag on one document, if the document carries it
 * (`GET /TagRelation` with the tag and the object, each row checked again).
 */
export async function findTagRelation(
  client: SevdeskClient,
  tagId: number,
  object: { readonly id: number; readonly objectName: string },
  signal?: AbortSignal,
): Promise<TagRelation | undefined> {
  const found = await listChildRows(
    client,
    "/TagRelation",
    {
      ...tagRelationQuery(tagId),
      "object[id]": object.id,
      "object[objectName]": object.objectName,
    },
    {
      parse: parseTagRelation,
      belongs: (row) =>
        row.tagId === tagId && row.objectId === object.id && row.objectName === object.objectName,
    },
    signal,
  );
  return found.rows[0];
}

// ---------------------------------------------------------------------------------------------
// The tag filter of the document lists
// ---------------------------------------------------------------------------------------------

/** The `tag` argument of the document list tools. */
export const tagFilterInputShape = {
  tag: z
    .string()
    .trim()
    .min(1)
    .max(TAG_NAME_MAX)
    .optional()
    .describe(
      "Only documents with this tag (name, case and accents ignored; see sevdesk_tags_list).",
    ),
};

/** A resolved `tag` filter for one document list. */
export interface TagListFilter {
  readonly tagId: number;
  /** The ids of the documents of the listed kind that carry the tag, as far as read. */
  readonly objectIds: ReadonlySet<number>;
  /**
   * False when the tag has more uses than {@link TAG_READ_MAX}: rows outside `objectIds` are then
   * kept on the word of sevDesk's own filter instead of being checked here.
   */
  readonly complete: boolean;
}

/**
 * Resolves a tag name for a document list of `kind`: the tag (see {@link pickTag}) and the
 * documents its relations name. A name no tag has is refused with a `validation` error: sending
 * no filter would return the unfiltered list, and an ignored filter spelling would too (D-090).
 * `undefined` when no tag was asked for.
 */
export async function resolveTagFilter(
  client: SevdeskClient,
  name: string | undefined,
  kind: TagDocumentKind,
  signal?: AbortSignal,
): Promise<TagListFilter | undefined> {
  if (name === undefined) return undefined;
  const found = await findTagsByName(client, name, signal);
  const tag = pickTag(found, name);
  if (tag === undefined) {
    throw validation(
      found.complete
        ? "No tag has this name (compared ignoring case and accents), so no document carries it. " +
            "sevdesk_tags_list lists the tags."
        : `The account has more than ${TAG_READ_MAX.toLocaleString("en-US")} tags and none of ` +
            "the first ones has this name; this server cannot filter by it.",
    );
  }
  const objectName = TAG_OBJECT_NAMES[kind];
  const uses = await listChildRows(
    client,
    "/TagRelation",
    tagRelationQuery(tag.id),
    { parse: parseTagRelation, belongs: (row) => row.tagId === tag.id },
    signal,
  );
  const objectIds = new Set(
    uses.rows.filter((row) => row.objectName === objectName).map((row) => row.objectId),
  );
  return { tagId: tag.id, objectIds, complete: uses.complete };
}

/** The list query of a tag filter: `tags[0][id]` + `tags[0][objectName]` (D-090). */
export function tagFilterQuery(filter: TagListFilter | undefined): Record<string, QueryValue> {
  return filter === undefined ? {} : { "tags[0][id]": filter.tagId, "tags[0][objectName]": "Tag" };
}

/**
 * Whether a list row passes the tag filter's re-check: it is one of the documents the tag's
 * relations name, or (when not every relation could be read) sevDesk's filter let it through.
 */
export function carriesTag(filter: TagListFilter | undefined, documentId: number): boolean {
  return filter === undefined || !filter.complete || filter.objectIds.has(documentId);
}

/** The output field of a list tool with a tag filter; spread next to `pageOutputShape`. */
export const tagFilterOutputShape = {
  tagFilter: z
    .object({
      tagId: z.number().int(),
      rowsChecked: z
        .boolean()
        .describe(
          "True: every row was checked against the tag's uses. False: the tag has more than " +
            `${TAG_READ_MAX.toLocaleString("en-US")} uses, so rows beyond them rely on ` +
            "sevDesk's own filter.",
        ),
    })
    .optional()
    .describe("Only with tag: the tag the list was filtered by."),
};

/** The {@link tagFilterOutputShape} value of a list call. */
export function tagFilterOutput(filter: TagListFilter | undefined): {
  tagFilter?: { tagId: number; rowsChecked: boolean };
} {
  return filter === undefined
    ? {}
    : { tagFilter: { tagId: filter.tagId, rowsChecked: filter.complete } };
}

/** A trusted sentence for the summary when the tag filter could not check every row, or "". */
export function tagFilterNote(filter: TagListFilter | undefined): string {
  return filter === undefined || filter.complete
    ? ""
    : ` The tag has more than ${TAG_READ_MAX.toLocaleString("en-US")} uses: rows were checked ` +
        "against the first ones only, the others rely on sevDesk's tag filter.";
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
