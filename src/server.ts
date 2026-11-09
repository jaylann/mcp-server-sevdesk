import { McpServer, type McpServerFactory, type ProtocolEra } from "@modelcontextprotocol/server";

import { tierKey } from "./accounts/resolver.js";
import type { AccountResolver } from "./accounts/types.js";
import type { Config, Settings } from "./config.js";
import { buildInstructions } from "./instructions.js";
import { registerResources } from "./resources/index.js";
import { createSafetyRuntime, type SafetyRuntime } from "./safety/runtime.js";
import type { TransferStore } from "./safety/transfer-types.js";
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

/** One account (stdio, bearer): every request is served with `config` and `client`. */
export interface ServerDeps {
  readonly config: Config;
  readonly client: SevdeskClient;
  /** Catalog to select from; defaults to {@link ALL_TOOLS}. Tests pass their own tools. */
  readonly tools?: readonly AnyToolDefinition[];
  /**
   * Confirmation and audit state; defaults to a fresh {@link createSafetyRuntime} per factory.
   * Tests pass one with a fake clock.
   */
  readonly safety?: SafetyRuntime;
  /**
   * Remote file transfer (HTTP with `deployment.files`): uploads and download links shared by
   * every instance. Undefined over stdio.
   */
  readonly transfer?: TransferStore | undefined;
}

/**
 * Several accounts (OAuth): each request is served with the account context `accounts` resolves
 * from its `AuthInfo` (see `src/accounts/resolver.ts`).
 */
export interface AccountServerDeps {
  /** What every account shares; the default safety runtime is built from it. */
  readonly settings: Settings;
  readonly accounts: AccountResolver;
  /** Catalog to select from; defaults to {@link ALL_TOOLS}. */
  readonly tools?: readonly AnyToolDefinition[];
  /**
   * Shared by every account (approvals and elicitation states are scoped per principal inside
   * it). Defaults to `createSafetyRuntime(settings)`, whose browser approvals use the local page:
   * the HTTP mode passes a runtime with the approvals inbox channel instead.
   */
  readonly safety?: SafetyRuntime;
  /**
   * Remote file transfer (HTTP with `deployment.files`): uploads and download links shared by
   * every instance. Undefined over stdio.
   */
  readonly transfer?: TransferStore | undefined;
}

/**
 * A server factory for both serving entries, plus {@link ServerFactory.close} for shutdown. All
 * instances it builds share one {@link SafetyRuntime}.
 */
export type ServerFactory = McpServerFactory & {
  /** Stops what the factory started (the local approval server, if any; cached accounts). */
  readonly close: () => Promise<void>;
};

/**
 * Builds the factory both serving entries take (`serveStdio`, `createMcpHandler`). The catalog is
 * validated once, here, and the confirmation state (request-state key, nonces, approvals, audit
 * log) is created once, so every instance shares it; each call of the factory then creates a
 * fresh instance for the era the entry reports (one per stdio connection, one per HTTP request).
 *
 * - {@link ServerDeps}: the tools are selected and the instructions built once.
 * - {@link AccountServerDeps}: each request is served with its account's config and client; the
 *   selected tools and instructions are cached per tier set (accounts of one resolver differ only
 *   in tiers, account and token). The tool definitions and the registry are the same either way.
 *
 * Throws {@link ToolDefinitionError} for an invalid tool.
 */
export function createServerFactory(deps: ServerDeps | AccountServerDeps): ServerFactory {
  if ("accounts" in deps) return accountServerFactory(deps);
  const prepared = prepare(deps);
  const factory: McpServerFactory = (context) => instantiate(prepared, context.era);
  return Object.assign(factory, { close: () => prepared.safety.close() });
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
  readonly config: Config;
  readonly client: SevdeskClient;
  readonly tools: readonly AnyToolDefinition[];
  readonly instructions: string;
  readonly safety: SafetyRuntime;
  readonly transfer: TransferStore | undefined;
}

/** What one tier set exposes: the selected tools and their instructions. */
interface Surface {
  readonly tools: readonly AnyToolDefinition[];
  readonly instructions: string;
}

function validatedCatalog(tools: readonly AnyToolDefinition[]): readonly AnyToolDefinition[] {
  const catalog = assertUniqueNames(tools);
  // defineTool already validated shipped tools; this also covers definitions built without it.
  for (const tool of catalog) {
    const problems = validateToolDefinition(tool);
    if (problems.length > 0) {
      throw new ToolDefinitionError(tool.name, problems);
    }
  }
  return catalog;
}

function surfaceOf(catalog: readonly AnyToolDefinition[], config: Config): Surface {
  const tools = selectTools(catalog, config);
  return { tools, instructions: buildInstructions(tools, config) };
}

function prepare(deps: ServerDeps): PreparedServer {
  const catalog = validatedCatalog(deps.tools ?? ALL_TOOLS);
  return {
    config: deps.config,
    client: deps.client,
    ...surfaceOf(catalog, deps.config),
    safety: deps.safety ?? createSafetyRuntime(deps.config),
    transfer: deps.transfer,
  };
}

function accountServerFactory(deps: AccountServerDeps): ServerFactory {
  const catalog = validatedCatalog(deps.tools ?? ALL_TOOLS);
  const safety = deps.safety ?? createSafetyRuntime(deps.settings);
  /** By tier set: at most one entry per subset of the four tiers. */
  const surfaces = new Map<string, Surface>();
  const factory: McpServerFactory = (context) => {
    const { config, client } = deps.accounts.resolve(context.authInfo);
    const key = tierKey(config.allowedTiers);
    let surface = surfaces.get(key);
    if (surface === undefined) {
      surface = surfaceOf(catalog, config);
      surfaces.set(key, surface);
    }
    return instantiate(
      { config, client, ...surface, safety, transfer: deps.transfer },
      context.era,
    );
  };
  return Object.assign(factory, {
    close: async () => {
      deps.accounts.close();
      await safety.close();
    },
  });
}

function instantiate(prepared: PreparedServer, era: ProtocolEra | undefined): McpServer {
  const { config, client } = prepared;
  const server = new McpServer(SERVER_INFO, {
    // Declared up front so tools/list and resources/list are valid when empty; neither list
    // changes at runtime.
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    instructions: prepared.instructions,
    maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    // Elicitation rounds (multi-round-trip): the signed state is verified before a retried call
    // reaches the write flow; tampered or expired state, or state minted for another principal,
    // is refused by the SDK (-32602).
    requestState: { verify: (state, ctx) => prepared.safety.codec.verify(state, ctx) },
  });
  registerTools(server, prepared.tools, {
    config,
    client,
    structuredOutput: resolveStructuredOutput(config.structuredOutput, era),
    safety: prepared.safety,
    transfer: prepared.transfer,
  });
  registerResources(server, { config, client });
  return server;
}
