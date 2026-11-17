/**
 * Adding a tag to one document and taking it off again: the checks, preview and requests behind
 * `sevdesk_document_tag`.
 *
 * Recorded 2026-11-16 (spec/deviations.md D-088, D-089):
 * - `POST /Tag/Factory/create {name, object: {id, objectName}}` tags an invoice, voucher, order or
 *   credit note by name, drafts and finalized documents alike, and answers the TagRelation. A
 *   name that exists, also with other letter case or accents, reuses that tag; a new name creates
 *   the tag. A tag cannot be given by id.
 * - Nothing in the spec takes a tag off a document. The undocumented
 *   `DELETE /TagRelation/{id}` removes one relation; removing a tag's last relation deletes the
 *   tag itself.
 *
 * One document per call: each tag or untag is one request that is never retried, so a call either
 * did everything its preview says or nothing, and the preview can say exactly whether the tag is
 * created or deleted. Where sevDesk's name comparison is not measured (ß/ss and the like), the
 * preview says that sevDesk may reuse a similar tag, and the result reports the tag sevDesk
 * actually used.
 */
import type { ConfirmationFact, ConfirmationPreview } from "../safety/write-types.js";
import { expectSingle } from "../sevdesk/envelope.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { cleanText } from "./common.js";
import type { CountryReadOptions } from "./country-codes.js";
import {
  documentRef,
  type LifecycleDocument,
  type LifecycleKind,
  readLifecycleDocument,
} from "./lifecycle/documents.js";
import { documentFacts, documentTitle } from "./lifecycle/preview.js";
import {
  countTagUses,
  findTagRelation,
  findTagsByName,
  parseTagRelation,
  pickTag,
  TAG_NAME_MAX,
  TAG_OBJECT_NAMES,
  TAG_READ_MAX,
  type TagDocumentKind,
  type TagMatches,
  type TagRecord,
} from "./tags.js";

/** The lifecycle kind (document reads, preview texts, toolsets) of each taggable kind. */
export const TAG_LIFECYCLE_KINDS: Readonly<Record<TagDocumentKind, LifecycleKind>> = {
  invoice: "invoice",
  credit_note: "creditNote",
  order: "order",
  voucher: "voucher",
};

export interface TagChangeInput {
  readonly action: "add" | "remove";
  readonly document: TagDocumentKind;
  readonly id: number;
  /** The tag's name, trimmed. */
  readonly tag: string;
}

/** What `execute` needs from the preparation. */
export type TagChangeState =
  | {
      readonly action: "add";
      readonly object: TagObject;
      /** The name sent to sevDesk: the existing tag's stored spelling, or the new name. */
      readonly name: string;
      /** The account's tags as read for the preview: whether sevDesk's answer names one of them. */
      readonly tags: TagMatches;
    }
  | {
      readonly action: "remove";
      readonly object: TagObject;
      readonly tag: TagRecord;
      readonly relationId: number;
      /** The relation is the tag's only use: removing it deletes the tag (D-089). */
      readonly lastUse: boolean;
    };

/** The document a tag change is about. */
interface TagObject {
  readonly kind: TagDocumentKind;
  readonly id: number;
  readonly objectName: "Invoice" | "CreditNote" | "Order" | "Voucher";
}

/** What a completed tag change did. */
export interface TagChangeResult {
  readonly relationId: number;
  readonly tagId: number;
  /** The tag's name (cleaned). */
  readonly tagName: string;
  /**
   * Add: sevDesk created the tag; left out when the account has more tags than were read and
   * sevDesk used one this server did not see. Remove: the tag went with its last use.
   */
  readonly tagCreated?: boolean;
  readonly tagDeleted?: boolean;
}

/**
 * Reads the document and the account's tags, decides whether the change is possible and builds
 * the preview. Reads only; throws a `validation` SevdeskError (trusted text, no tag names) when
 * the change cannot be made or would change nothing.
 */
export async function planTagChange(
  client: SevdeskClient,
  input: TagChangeInput,
  options: CountryReadOptions,
): Promise<{ preview: ConfirmationPreview; state: TagChangeState }> {
  const { signal } = options;
  const kind = TAG_LIFECYCLE_KINDS[input.document];
  const object: TagObject = {
    kind: input.document,
    id: toSevdeskId(input.id),
    objectName: TAG_OBJECT_NAMES[input.document],
  };
  const [doc, found] = await Promise.all([
    readLifecycleDocument(client, kind, object.id, options),
    findTagsByName(client, input.tag, signal),
  ]);
  return input.action === "add"
    ? planAdd(client, doc, object, input.tag, found, signal)
    : planRemove(client, doc, object, found, input.tag, signal);
}

async function planAdd(
  client: SevdeskClient,
  doc: LifecycleDocument,
  object: TagObject,
  name: string,
  found: TagMatches,
  signal: AbortSignal | undefined,
): Promise<{ preview: ConfirmationPreview; state: TagChangeState }> {
  if (found.matches.length > 1) {
    // sevDesk picks one of them by name; which one is not measured, so the preview could not say.
    throw validation(
      "Several tags have this name (compared ignoring case and accents), and sevDesk would pick " +
        "one of them. Give one a distinct name in sevDesk first; sevdesk_tags_list shows their " +
        "ids.",
    );
  }
  const existing = found.matches[0];
  if (existing === undefined && !found.complete) {
    throw validation(
      `The account has more than ${TAG_READ_MAX.toLocaleString("en-US")} tags; this server ` +
        "cannot tell whether the name is new, so it does not tag by it.",
    );
  }
  if (
    existing !== undefined &&
    (await findTagRelation(client, existing.id, object, signal)) !== undefined
  ) {
    throw validation(`${documentRef(doc, true)} already carries this tag; nothing to change.`);
  }

  const shownName = existing?.name ?? display(name);
  // Only consulted when no tag matches: then sevDesk may still take one of these as the same name.
  const similar = existing === undefined ? found.similar : [];
  const facts: ConfirmationFact[] = [
    ...documentFacts(doc),
    { label: "Tag", value: shownName },
    { label: "Tag status", value: addStatus(existing, similar) },
  ];
  if (similar.length > 0) {
    facts.push({
      label: similar.length === 1 ? "Similar tag" : "Similar tags",
      value: similarTags(similar),
    });
  }
  const warnings: string[] = [];
  if (existing !== undefined) {
    if (existing.storedName.trim() !== name) {
      warnings.push(
        "A tag whose name differs only in case or accents exists: sevDesk reuses it, with its " +
          "own spelling.",
      );
    }
  } else if (similar.length === 0) {
    warnings.push(
      "No tag has this name yet (compared ignoring case and accents, as sevDesk does): sevDesk " +
        "creates the tag.",
    );
  } else {
    warnings.push(
      "No tag has exactly this name (compared ignoring case and accents), but one is spelled " +
        "similarly (e.g. ß for ss, or with invisible characters). sevDesk may reuse that tag " +
        "instead of creating one: how it compares such spellings is not measured. The result " +
        "says which tag was used.",
    );
  }
  return {
    preview: {
      action: `Tag ${documentTitle(doc)} with the tag ${shownName}.`,
      facts,
      warnings,
      irreversible: false,
    },
    state: {
      action: "add",
      object,
      // The stored spelling, not the cleaned one, makes sevDesk reuse exactly that tag.
      name: existing?.storedName ?? name,
      tags: found,
    },
  };
}

/** The "Tag status" fact of an add. */
function addStatus(existing: TagRecord | undefined, similar: readonly TagRecord[]): string {
  if (existing !== undefined) return `exists (id ${String(existing.id)}), added to this document`;
  return similar.length === 0
    ? "new: sevDesk creates it"
    : "new, unless sevDesk takes a similar tag for it";
}

/** How many similar tags a preview names; the rest are counted. */
const SIMILAR_SHOWN = 3;

function similarTags(tags: readonly TagRecord[]): string {
  const shown = tags.slice(0, SIMILAR_SHOWN).map((tag) => `${tag.name} (id ${String(tag.id)})`);
  const more = tags.length - shown.length;
  return more > 0 ? `${shown.join("; ")}; and ${String(more)} more` : shown.join("; ");
}

async function planRemove(
  client: SevdeskClient,
  doc: LifecycleDocument,
  object: TagObject,
  found: TagMatches,
  name: string,
  signal: AbortSignal | undefined,
): Promise<{ preview: ConfirmationPreview; state: TagChangeState }> {
  const tag = pickTag(found, name);
  if (tag === undefined && !found.complete) {
    throw validation(
      `The account has more than ${TAG_READ_MAX.toLocaleString("en-US")} tags and none of the ` +
        "first ones has this name; this server cannot find the tag to remove.",
    );
  }
  const relation =
    tag === undefined ? undefined : await findTagRelation(client, tag.id, object, signal);
  if (tag === undefined || relation === undefined) {
    throw validation(
      `${documentRef(doc, true)} does not carry this tag (compared ignoring case and accents); ` +
        "nothing to remove. sevdesk_tags_list lists the tags.",
    );
  }
  const uses = await countTagUses(client, tag.id, signal);
  if (!uses.complete && uses.count <= 1) {
    // Only when sevDesk ignored the tag filter on an account with more relations than were read.
    throw validation(
      `The tag's uses could not all be counted (more than ${TAG_READ_MAX.toLocaleString("en-US")} ` +
        "tag uses were read), so this server cannot tell whether this is its last use, which " +
        "would delete the tag; it does not remove it.",
    );
  }
  const lastUse = uses.count <= 1;
  const counted = `${String(uses.count)} document${uses.count === 1 ? "" : "s"}`;
  return {
    preview: {
      action: `Remove the tag ${tag.name} from ${documentTitle(doc)}.`,
      facts: [
        ...documentFacts(doc),
        { label: "Tag", value: `${tag.name} (id ${String(tag.id)})` },
        { label: "Tag uses", value: uses.complete ? counted : `at least ${counted}` },
      ],
      warnings: lastUse
        ? [
            "This document is the tag's only use: sevDesk deletes the tag itself when its last " +
              "use is removed. Tagging a document with this name again creates a new tag.",
          ]
        : [],
      irreversible: false,
    },
    state: { action: "remove", object, tag, relationId: relation.id, lastUse },
  };
}

/**
 * Makes the change the preview describes: `POST /Tag/Factory/create` or
 * `DELETE /TagRelation/{id}`, each one request, never retried.
 */
export async function executeTagChange(
  client: SevdeskClient,
  state: TagChangeState,
  signal?: AbortSignal,
): Promise<TagChangeResult> {
  const withSignal = signal === undefined ? {} : { signal };
  if (state.action === "remove") {
    await client.request({
      method: "DELETE",
      path: sevdeskPath("TagRelation", state.relationId),
      ...withSignal,
    });
    return {
      relationId: state.relationId,
      tagId: state.tag.id,
      tagName: state.tag.name,
      tagDeleted: state.lastUse,
    };
  }
  const answer = await client.request({
    method: "POST",
    path: "/Tag/Factory/create",
    body: {
      name: state.name,
      object: { id: state.object.id, objectName: state.object.objectName },
    },
    ...withSignal,
  });
  const relation = parseTagRelation(expectSingle(answer, "tag relation"));
  const base = { relationId: relation.id, tagId: relation.tagId };
  // Judged from the answer, not the preview: sevDesk may have reused a tag whose name this
  // server did not match (its comparison is measured for case and accents only, D-088).
  const used = state.tags.known.get(relation.tagId);
  if (used !== undefined) return { ...base, tagName: used.name, tagCreated: false };
  const tagName = display(state.name);
  // A tag that was not among those read is new, unless the read stopped at the cap.
  return state.tags.complete ? { ...base, tagName, tagCreated: true } : { ...base, tagName };
}

/** A name given as an argument, cleaned like sevDesk text for previews and output. */
function display(name: string): string {
  return cleanText(name, TAG_NAME_MAX) ?? name;
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
