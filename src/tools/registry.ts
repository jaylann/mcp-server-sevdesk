/**
 * Tool selection and registration: which tools a server instance exposes, and the wrapper every
 * tool call runs through (tier re-check, argument validation, context, output validation, result
 * formatting, error mapping).
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  type McpServer,
  type ProtocolEra,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { Config, StructuredOutputMode } from "../config.js";
import type { SafetyRuntime } from "../safety/runtime.js";
import type { Tier, WriteTier } from "../safety/tiers.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { successResult } from "./result.js";
import {
  cancelledResult,
  invalidArgumentsResult,
  outputValidationFailedResult,
  tierNotAllowedResult,
  type ToolErrorContext,
  toolErrorResult,
} from "./tool-errors.js";
import type { ToolsetName } from "./toolsets.js";
import type {
  AnyToolDefinition,
  ToolAnnotationSet,
  ToolContext,
  ToolOutput,
  ToolSelectionConfig,
  WritePlan,
} from "./types.js";
import { runWriteTool, type WriteCallResult, writeOutputSchema } from "./write-flow.js";

export interface RegistryDeps {
  readonly config: Config;
  readonly client: SevdeskClient;
  /**
   * Advertise each tool's `outputSchema` and return `structuredContent`; resolved once per server
   * instance with {@link resolveStructuredOutput}.
   */
  readonly structuredOutput: boolean;
  /**
   * Confirmation and audit state shared by every instance of one server factory (see
   * `createSafetyRuntime`); write tools cannot run without it.
   */
  readonly safety: SafetyRuntime;
}

/**
 * The tools a server exposes for `config`: those in an enabled toolset and an allowed tier whose
 * own `available` condition (if any) holds, sorted by name (code-unit order, locale independent)
 * so `tools/list` is stable. Tools of other tiers are not registered at all; the call wrapper
 * re-checks the tier as a second layer.
 */
export function selectTools(
  all: readonly AnyToolDefinition[],
  config: ToolSelectionConfig,
): AnyToolDefinition[] {
  return all
    .filter(
      (tool) =>
        config.toolsets.has(tool.toolset) &&
        config.allowedTiers.has(tool.tier) &&
        (tool.available?.(config) ?? true),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Whether a server instance advertises `outputSchema` and sends `structuredContent`.
 *
 * - `on` / `off`: always / never.
 * - `auto`: only for the modern era (protocol 2026-07-28 and later). Both serving entries pin an
 *   era per instance and pass it to the factory (`McpRequestContext.era`): `createMcpHandler`
 *   builds one instance per HTTP request, `serveStdio` one per connection. 2025-era clients,
 *   which today include all Claude clients, get the JSON text block only, because Claude clients
 *   have open bugs with tools that declare `outputSchema` (anthropics/claude-ai-mcp #673, #485,
 *   #1016). An instance built without an era (outside a serving entry) counts as legacy.
 */
export function resolveStructuredOutput(
  mode: StructuredOutputMode,
  era: ProtocolEra | undefined,
): boolean {
  switch (mode) {
    case "on":
      return true;
    case "off":
      return false;
    case "auto":
      return era === "modern";
  }
}

/**
 * Registers `tools` on `server`, each with its title, description, strict input JSON Schema, all
 * four annotations (plus `title`) and, when `deps.structuredOutput` is set, its output schema
 * (for write tools the wrapped one, see `writeOutputSchema`). The callback never throws: every
 * failure becomes an `isError` result.
 */
export function registerTools(
  server: McpServer,
  tools: readonly AnyToolDefinition[],
  deps: RegistryDeps,
): void {
  for (const definition of tools) {
    const tool: ErasedTool = definition;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: advertiseOnly(tool.input),
        ...(deps.structuredOutput ? { outputSchema: advertiseOnly(advertisedOutput(tool)) } : {}),
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args, request) => runTool(tool, args, request, server, deps),
    );
  }
}

/** What every tool has, with its schema generics erased, as the call wrapper sees it. */
interface ErasedToolBase {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly toolset: ToolsetName;
  readonly tier: Tier;
  readonly annotations: ToolAnnotationSet;
  readonly input: z.ZodObject;
  readonly output: z.ZodObject;
}

interface ErasedReadTool extends ErasedToolBase {
  readonly tier: "read";
  readonly handler: (args: unknown, ctx: ToolContext) => Promise<ToolOutput<unknown>>;
}

/** A write tool with its schema generics erased (see `WriteToolDefinition`). */
export interface ErasedWriteTool extends ErasedToolBase {
  readonly tier: WriteTier;
  readonly prepare: (args: unknown, ctx: ToolContext) => Promise<WritePlan<unknown>>;
  readonly execute: (
    args: unknown,
    plan: WritePlan<unknown>,
    ctx: ToolContext,
  ) => Promise<ToolOutput<unknown>>;
}

type ErasedTool = ErasedReadTool | ErasedWriteTool;

/** The output schema a tool advertises: its own, or for write tools the wrapped one. */
function advertisedOutput(tool: ErasedTool): z.ZodObject {
  return tool.tier === "read" ? tool.output : writeOutputSchema(tool.output);
}

/**
 * A Standard Schema that advertises a zod schema's JSON Schema in `tools/list` (zod's own
 * conversion, so a strict input keeps `additionalProperties: false`) but accepts any value, so
 * the SDK leaves validation to {@link runTool}:
 *
 * - input: the SDK would turn a failed validation into an `isError` result too, but with zod's
 *   raw issue text; validating ourselves lets the result name unknown arguments, list the
 *   accepted ones and say that nothing was sent to sevDesk;
 * - output: `runTool` already validated the data and sends zod's parsed output; a second parse
 *   by the SDK would only repeat the work (and could reject output of non-idempotent schemas).
 */
function advertiseOnly(schema: z.ZodObject): StandardSchemaWithJSON {
  const { jsonSchema } = schema["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "mcp-server-sevdesk",
      validate: (value) => ({ value }),
      jsonSchema: {
        input: (options) => jsonSchema.input(options),
        output: (options) => jsonSchema.output(options),
      },
    },
  };
}

async function runTool(
  tool: ErasedTool,
  args: unknown,
  request: ServerContext,
  server: McpServer,
  deps: RegistryDeps,
): Promise<WriteCallResult> {
  const errorContext: ToolErrorContext = {
    toolName: tool.name,
    tier: tool.tier,
    config: deps.config,
  };
  // Second layer of the tier model: such a tool should not even be registered.
  if (!deps.config.allowedTiers.has(tool.tier)) {
    return tierNotAllowedResult(errorContext);
  }

  const signal = request.mcpReq.signal;
  try {
    const parsed = await tool.input.safeParseAsync(args ?? {});
    if (!parsed.success) {
      return invalidArgumentsResult(tool.name, parsed.error, Object.keys(tool.input.shape));
    }
    const context: ToolContext = {
      client: deps.client,
      config: deps.config,
      signal,
      progress: progressReporter(request),
    };
    if (tool.tier !== "read") {
      return await runWriteTool(tool, parsed.data, {
        request,
        context,
        deps,
        errorContext,
        clientCapabilities: clientCapabilities(request, server),
      });
    }
    const output = await tool.handler(parsed.data, context);
    const data = await tool.output.safeParseAsync(output.data);
    if (!data.success) {
      return outputValidationFailedResult(errorContext, data.error);
    }
    return successResult(
      {
        summary: output.summary,
        data: data.data,
        ...(output.extraContent === undefined ? {} : { extraContent: output.extraContent }),
      },
      { structured: deps.structuredOutput },
    );
  } catch (error) {
    return signal.aborted ? cancelledResult(errorContext) : toolErrorResult(error, errorContext);
  }
}

/**
 * The client capabilities that apply to `request`, resolved like the SDK resolves them for its
 * own input-request gate: a 2026-07-28 request carries them in its `_meta` envelope; a 2025-era
 * connection declared them in `initialize` (per-request legacy instances have none).
 */
function clientCapabilities(request: ServerContext, server: McpServer): unknown {
  const envelope = request.mcpReq.envelope as Readonly<Record<string, unknown>> | undefined;
  // The SDK names this accessor as the source for 2025-era connections; modern requests use the
  // envelope above.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities();
}

/**
 * `ToolContext.progress` for one call: sends `notifications/progress` only when the request
 * carried a `progressToken`, drops values that do not increase (the spec requires increasing
 * progress) and never rejects, since a lost progress update must not fail the call.
 */
function progressReporter(request: ServerContext): ToolContext["progress"] {
  const progressToken = request.mcpReq._meta?.progressToken;
  if (progressToken === undefined) {
    return () => Promise.resolve();
  }
  let last = Number.NEGATIVE_INFINITY;
  return async (progress, total, message) => {
    if (!(progress > last)) {
      return;
    }
    last = progress;
    try {
      await request.mcpReq.notify({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          ...(total === undefined ? {} : { total }),
          ...(message === undefined ? {} : { message }),
        },
      });
    } catch {
      // Best effort: the client may already be gone.
    }
  };
}
