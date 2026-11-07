/**
 * MCP resources this server exposes. Like tools, they follow the configuration: document file
 * templates appear only when their document type's toolset is enabled, reference data with the
 * `meta` toolset. All resources are reads, so the read tier (always enabled) covers them.
 */
import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config.js";
import { DOCUMENT_FILE_KINDS, type DocumentFileKind } from "../domain/document-files.js";
import { DOCUMENT_FILE_TOOLSETS } from "../tools/documents/kinds.js";
import { registerDocumentFileResources, type ResourceDeps } from "./document-files.js";
import { registerReferenceResources } from "./reference.js";

/** The document file kinds whose resource templates `config` exposes. */
export function selectDocumentFileKinds(
  config: Pick<Config, "toolsets" | "allowedTiers">,
): DocumentFileKind[] {
  if (!config.allowedTiers.has("read")) {
    return [];
  }
  return DOCUMENT_FILE_KINDS.filter((kind) => config.toolsets.has(DOCUMENT_FILE_TOOLSETS[kind]));
}

/** Registers every resource `deps.config` exposes on `server`. */
export function registerResources(server: McpServer, deps: ResourceDeps): void {
  if (deps.config.toolsets.has("meta") && deps.config.allowedTiers.has("read")) {
    registerReferenceResources(server);
  }
  registerDocumentFileResources(server, selectDocumentFileKinds(deps.config), deps);
}
