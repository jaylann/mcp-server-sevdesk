/**
 * Helpers for unit-testing write tools without MCP: run `prepare` and `execute` with the same
 * client wrappers the framework uses (read-only for `prepare`, tier-scoped for `execute`), with
 * arguments parsed by the tool's own input schema and output checked against its output schema.
 *
 * Confirmation, dry runs and the audit log are the framework's job and are tested through MCP in
 * `test/integration/`; these helpers skip them.
 */
import type { z } from "zod";

import type { Config } from "../../src/config.js";
import { readOnlyClient, tierScopedClient } from "../../src/sevdesk/scoped-client.js";
import type { SevdeskClient } from "../../src/sevdesk/types.js";
import type {
  ToolContext,
  ToolInputSchema,
  ToolOutput,
  ToolOutputSchema,
  WritePlan,
  WriteToolDefinition,
} from "../../src/tools/types.js";
import { allEnabledConfig } from "./config.js";

function context(client: SevdeskClient, config: Partial<Config>): ToolContext {
  return {
    client,
    config: allEnabledConfig(config),
    signal: new AbortController().signal,
    progress: () => Promise.resolve(),
  };
}

/**
 * Parses `args` with the tool's input schema and runs `prepare` with a read-only client. Rejects
 * like `prepare` (e.g. a `validation` SevdeskError) or when `prepare` tried to write.
 */
export async function prepareWrite<I extends ToolInputSchema, O extends ToolOutputSchema, S>(
  tool: WriteToolDefinition<I, O, S>,
  args: unknown,
  client: SevdeskClient,
  config: Partial<Config> = {},
): Promise<WritePlan<S>> {
  const parsed = tool.input.parse(args);
  const ctx = context(readOnlyClient(client, "preparing a write"), config);
  return tool.prepare(parsed, ctx);
}

/** What {@link executeWrite} observed. */
export interface WriteRun<S, D> {
  readonly plan: WritePlan<S>;
  readonly output: ToolOutput<D>;
}

/**
 * {@link prepareWrite}, then `execute` with a client scoped to the tool's tier, as after an
 * approval. Throws when the output does not match the tool's output schema.
 */
export async function executeWrite<I extends ToolInputSchema, O extends ToolOutputSchema, S>(
  tool: WriteToolDefinition<I, O, S>,
  args: unknown,
  client: SevdeskClient,
  config: Partial<Config> = {},
): Promise<WriteRun<S, z.output<O>>> {
  const plan = await prepareWrite(tool, args, client, config);
  const parsed = tool.input.parse(args);
  const output = await tool.execute(
    parsed,
    plan,
    context(tierScopedClient(client, tool.tier), config),
  );
  tool.output.parse(output.data);
  return { plan, output };
}
