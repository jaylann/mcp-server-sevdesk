import { TAG_DOCUMENT_KINDS, type TagDocumentKind } from "../../domain/tags.js";
import { TAG_LIFECYCLE_KINDS } from "../../domain/tags-write.js";
import { KIND_TOOLS } from "../lifecycle/shared.js";
import type { ToolsetName } from "../toolsets.js";
import type { ToolSelectionConfig } from "../types.js";

/**
 * Where the tag tools belong. Tags span invoices, credit notes, orders and vouchers, four
 * toolsets, so like `sevdesk_document_save` the tag tools sit in the always-enabled `meta`
 * toolset and are registered only when at least one of the four is enabled
 * ({@link anyTaggableToolset}); the write tool also refuses each call whose document kind's
 * toolset is disabled ({@link tagToolsetOf}).
 */
export function tagToolsetOf(kind: TagDocumentKind): ToolsetName {
  return KIND_TOOLS[TAG_LIFECYCLE_KINDS[kind]].toolset;
}

/** Whether the toolset of at least one taggable document kind is enabled. */
export function anyTaggableToolset(config: ToolSelectionConfig): boolean {
  return TAG_DOCUMENT_KINDS.some((kind) => config.toolsets.has(tagToolsetOf(kind)));
}
