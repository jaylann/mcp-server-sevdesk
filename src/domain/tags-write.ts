/**
 * Adding a tag to one document and taking it off again: the checks, preview and requests behind
 * `sevdesk_document_tag`.
 *
 * Recorded 2026-11-16 (spec/deviations.md D-088, D-089):
 * - `POST /Tag/Factory/create {name, object: {id, objectName}}` tags an invoice, voucher, order or
 *   credit note by name and answers the TagRelation. A name that exists, in any letter case,
 *   reuses that tag; a new name creates the tag. A tag cannot be given by id.
 * - Nothing in the spec takes a tag off a document. The undocumented
 *   `DELETE /TagRelation/{id}` removes one relation; removing a tag's last relation deletes the
 *   tag itself.
 *
 * One document per call: each tag or untag is one request that is never retried, so a call either
 * did everything its preview says or nothing, and the preview can say exactly whether the tag is
 * created or deleted.
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
      /** The name sent to sevDesk: the existing tag's own spelling, or the new name. */
      readonly name: string;
      /** The tag the name reuses; `undefined` when sevDesk creates it. */
      readonly existingTagId: number | undefined;
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
  /** Add: sevDesk created the tag. Remove: the tag went with its last use. */
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
      "Several tags have this name (compared ignoring case), and sevDesk would pick one of " +
        "them. Give one a distinct name in sevDesk first; sevdesk_tags_list shows their ids.",
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
  const facts: ConfirmationFact[] = [
    ...documentFacts(doc),
    { label: "Tag", value: shownName },
    {
      label: "Tag status",
      value:
        existing === undefined
          ? "new: sevDesk creates it"
          : `exists (id ${String(existing.id)}), added to this document`,
    },
  ];
  const warnings: string[] = [];
  if (existing === undefined) {
    warnings.push(
      "No tag has this name yet (compared ignoring case, as sevDesk does): sevDesk creates the " +
        "tag.",
    );
  } else if (existing.name !== name) {
    warnings.push(
      "sevDesk compares tag names ignoring case: the existing tag is used with its own spelling.",
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
      // The existing spelling makes sevDesk reuse exactly that tag.
      name: existing?.name ?? name,
      existingTagId: existing?.id,
    },
  };
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
      `${documentRef(doc, true)} does not carry this tag (compared ignoring case); nothing to ` +
        "remove. sevdesk_tags_list lists the tags.",
    );
  }
  const uses = await countTagUses(client, tag.id, signal);
  const lastUse = uses <= 1;
  return {
    preview: {
      action: `Remove the tag ${tag.name} from ${documentTitle(doc)}.`,
      facts: [
        ...documentFacts(doc),
        { label: "Tag", value: `${tag.name} (id ${String(tag.id)})` },
        { label: "Tag uses", value: `${String(uses)} document${uses === 1 ? "" : "s"}` },
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
  return {
    relationId: relation.id,
    tagId: relation.tagId,
    tagName: display(state.name),
    // Judged from the answer, not the preview: the tag sevDesk actually used.
    tagCreated: relation.tagId !== state.existingTagId,
  };
}

/** A name given as an argument, cleaned like sevDesk text for previews and output. */
function display(name: string): string {
  return cleanText(name, TAG_NAME_MAX) ?? name;
}

function validation(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}
