import { McpServer, type McpServerFactory, type ProtocolEra } from "@modelcontextprotocol/server";

import type { Config } from "./config.js";
import { buildInstructions } from "./instructions.js";
import { registerResources } from "./resources/index.js";
import type { SevdeskClient } from "./sevdesk/types.js";
import { ToolDefinitionError, validateToolDefinition } from "./tools/define-tool.js";
import { ALL_TOOLS, assertUniqueNames } from "./tools/index.js";
import { registerTools, resolveStructuredOutput, selectTools } from "./tools/registry.js";
import type { AnyToolDefinition } from "./tools/types.js";
import { PACKAGE_NAME, VERSION } from "./version.js";

/** Identity advertised in the MCP `initialize` / discovery exchange. */
export const SERVER_INFO = { name: PACKAGE_NAME, title: "sevDesk", version: VERSION };

/**
 * Upper bound on array elements plus object members in one `tools/call` payload, enforced by the
 * SDK before any validation (a cheap guard against oversized arguments).
 */
const MAX_TOOL_INPUT_ELEMENTS = 10_000;

export interface ServerDeps {
  readonly config: Config;
  readonly client: SevdeskClient;
  /** Catalog to select from; defaults to {@link ALL_TOOLS}. Tests pass their own tools. */
  readonly tools?: readonly AnyToolDefinition[];
}

/**
 * Builds the factory both serving entries take (`serveStdio`, `createMcpHandler`). The catalog is
 * validated, selected for the configuration and turned into instructions once, here; each call
 * of the factory then creates a fresh instance for the era the entry reports (one per stdio
 * connection, one per HTTP request). Throws {@link ToolDefinitionError} for an invalid tool.
 */
export function createServerFactory(deps: ServerDeps): McpServerFactory {
  const prepared = prepare(deps);
  return (context) => instantiate(prepared, context.era);
}

/**
 * Creates one fully configured server instance: {@link SERVER_INFO}, generated instructions, the
 * tools selected for `deps.config` and the matching resources (`src/resources/`: document file
 * templates of enabled toolsets, reference data). `era` decides structured output in `auto` mode (see
 * `resolveStructuredOutput`); without it the instance behaves as legacy. Prefer
 * {@link createServerFactory} for serving, which does the preparation once.
 */
export function createServer(deps: ServerDeps, era?: ProtocolEra): McpServer {
  return instantiate(prepare(deps), era);
}

interface PreparedServer {
  readonly deps: ServerDeps;
  readonly tools: readonly AnyToolDefinition[];
  readonly instructions: string;
}

function prepare(deps: ServerDeps): PreparedServer {
  const catalog = assertUniqueNames(deps.tools ?? ALL_TOOLS);
  // defineTool already validated shipped tools; this also covers definitions built without it.
  for (const tool of catalog) {
    const problems = validateToolDefinition(tool);
    if (problems.length > 0) {
      throw new ToolDefinitionError(tool.name, problems);
    }
  }
  const tools = selectTools(catalog, deps.config);
  return { deps, tools, instructions: buildInstructions(tools, deps.config) };
}

function instantiate(prepared: PreparedServer, era: ProtocolEra | undefined): McpServer {
  const { config, client } = prepared.deps;
  const server = new McpServer(SERVER_INFO, {
    // Declared up front so tools/list and resources/list are valid when empty; neither list
    // changes at runtime.
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    instructions: prepared.instructions,
    maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
  });
  registerTools(server, prepared.tools, {
    config,
    client,
    structuredOutput: resolveStructuredOutput(config.structuredOutput, era),
  });
  registerResources(server, { config, client });
  return server;
}
