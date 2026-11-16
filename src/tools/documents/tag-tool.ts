/**
 * `sevdesk_document_tag`: adds a tag to, or removes it from, one invoice, credit note, order or
 * voucher (`src/domain/tags-write.ts`).
 *
 * Tier `write`: a tag only groups documents and can be put back. Adding and removing share the
 * tool because both are the same kind of change; removing a tag's last use deletes the tag
 * (D-089), so the tool is marked destructive and the preview says when that happens.
 *
 * One document per call ("tag these three invoices" is three calls): sevDesk has no batch
 * request, each change is one request that is never retried, so a call never ends half done, and
 * the account-wide tag lock ({@link ACCOUNT_TAGS}) lets each call's preview see what the previous
 * one changed (whether the tag exists now, how many uses are left).
 *
 * Registration: toolset `meta` and the tag tools' rule (`tag-kinds.ts`); each call is refused,
 * before any request, when the toolset of its document kind is disabled.
 */
import { z } from "zod";

import { documentRef } from "../../domain/lifecycle/documents.js";
import { TAG_DOCUMENT_KINDS, TAG_NAME_MAX } from "../../domain/tags.js";
import { executeTagChange, planTagChange, TAG_LIFECYCLE_KINDS } from "../../domain/tags-write.js";
import { refused } from "../../safety/output-files.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_TAGS, type SevdeskObjectRef } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { anyTaggableToolset, tagToolsetOf } from "./tag-kinds.js";

const output = z.object({
  action: z.enum(["added", "removed"]),
  document: z.object({ kind: z.enum(TAG_DOCUMENT_KINDS), id: z.number().int() }),
  tag: z.object({
    id: z.number().int(),
    name: z.string().describe("The tag's name as stored in sevDesk."),
  }),
  relationId: z.number().int().describe("The TagRelation that put the tag on the document."),
  tagCreated: z.boolean().optional().describe("Added: sevDesk created the tag for this call."),
  tagDeleted: z
    .boolean()
    .optional()
    .describe("Removed: it was the tag's last use, so sevDesk deleted the tag."),
});

/** `sevdesk_document_tag`: add a tag to or remove it from one document. */
export const documentTagTool = defineWriteTool({
  name: "sevdesk_document_tag",
  title: "Tag a sevDesk document",
  description:
    "Add a tag (Tag, Schlagwort, e.g. a project, customer or branch) to an invoice " +
    "(Rechnung), credit note (Gutschrift), order (Angebot/Auftrag) or voucher (Beleg), or " +
    "remove it. Tags are given by name, compared ignoring case as sevDesk does; adding an " +
    "unknown name creates the tag (the preview says so). Removing a tag's last use deletes the " +
    "tag in sevDesk (the preview warns). One document per call: to tag three invoices, call it " +
    "three times. Tier write. List tags with sevdesk_tags_list; find documents tagged with a " +
    "name through the tag argument of the list tools.",
  toolset: "meta",
  tier: "write",
  available: anyTaggableToolset,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    action: z.enum(["add", "remove"]).describe("add or remove the tag."),
    document: z
      .enum(TAG_DOCUMENT_KINDS)
      .describe("Document kind: invoice, credit_note, order or voucher."),
    id: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("Document id (not its number), e.g. from sevdesk_invoices_list."),
    tag: z.string().trim().min(1).max(TAG_NAME_MAX).describe("The tag's name, e.g. 'Projekt Y'."),
    ...dryRunInputShape,
  }),
  output,
  locks: () => [ACCOUNT_TAGS],
  prepare: async (args, ctx) => {
    const toolset = tagToolsetOf(args.document);
    // Checked first, so a refusal costs no sevDesk request.
    if (!ctx.config.toolsets.has(toolset)) {
      throw refused(
        `Tagging this document kind needs the ${toolset} toolset, which is not enabled ` +
          "(SEVDESK_TOOLSETS)",
      );
    }
    return planTagChange(ctx.client, args, { signal: ctx.signal, cacheOwner: ctx.config });
  },
  execute: async (args, plan, ctx) => {
    const result = await executeTagChange(ctx.client, plan.state, ctx.signal);
    const { object } = plan.state;
    const noun = documentRef({ kind: TAG_LIFECYCLE_KINDS[object.kind], id: object.id });
    const affected: SevdeskObjectRef[] = [
      { objectName: object.objectName, id: String(object.id) },
      { objectName: "TagRelation", id: String(result.relationId) },
    ];
    if (result.tagCreated === true || result.tagDeleted === true) {
      affected.push({ objectName: "Tag", id: String(result.tagId) });
    }
    const added = args.action === "add";
    const action: "added" | "removed" = added ? "added" : "removed";
    const summary = added
      ? `Tagged ${noun} with tag ${String(result.tagId)}${result.tagCreated === true ? ", which sevDesk created" : ""}.`
      : `Removed tag ${String(result.tagId)} from ${noun}${result.tagDeleted === true ? "; it was its last use, so sevDesk deleted the tag" : ""}.`;
    return {
      data: {
        action,
        document: { kind: object.kind, id: object.id },
        tag: { id: result.tagId, name: result.tagName },
        relationId: result.relationId,
        ...(result.tagCreated === undefined ? {} : { tagCreated: result.tagCreated }),
        ...(result.tagDeleted === undefined ? {} : { tagDeleted: result.tagDeleted }),
      },
      summary,
      affected,
    };
  },
});
