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
import type { FileAccess } from "../../src/safety/file-access.js";
import { localFileAccess } from "../../src/safety/file-sources.js";
import type { WriteTier } from "../../src/safety/tiers.js";
import { readOnlyClient, tierScopedClient } from "../../src/sevdesk/scoped-client.js";
import type { SevdeskClient } from "../../src/sevdesk/types.js";
import type {
  ToolContext,
  ToolInputSchema,
  ToolOutput,
  ToolOutputSchema,
  WritePlanOf,
  WriteToolDefinition,
} from "../../src/tools/types.js";
import { allEnabledConfig } from "./config.js";

/**
 * `files` defaults to the local folders of the config, as over stdio; tests of remote file
 * transfer pass a `remoteFileAccess`.
 */
function context(client: SevdeskClient, config: Partial<Config>, files?: FileAccess): ToolContext {
  const full = allEnabledConfig(config);
  return {
    client,
    config: full,
    signal: new AbortController().signal,
    progress: () => Promise.resolve(),
    files: files ?? localFileAccess(full),
  };
}

/**
 * Parses `args` with the tool's input schema and runs `prepare` with a read-only client. Rejects
 * like `prepare` (e.g. a `validation` SevdeskError) or when `prepare` tried to write.
 */
export async function prepareWrite<
  I extends ToolInputSchema,
  O extends ToolOutputSchema,
  S,
  T extends WriteTier,
>(
  tool: WriteToolDefinition<I, O, S, T>,
  args: unknown,
  client: SevdeskClient,
  config: Partial<Config> = {},
  files?: FileAccess,
): Promise<WritePlanOf<S, T>> {
  const parsed = tool.input.parse(args);
  const ctx = context(readOnlyClient(client, "preparing a write"), config, files);
  return tool.prepare(parsed, ctx);
}

/** What {@link executeWrite} observed. */
export interface WriteRun<P, D> {
  readonly plan: P;
  readonly output: ToolOutput<D>;
}

/**
 * {@link prepareWrite}, then `execute` with a client scoped to the tool's tier, as after an
 * approval. Throws when the output does not match the tool's output schema.
 */
export async function executeWrite<
  I extends ToolInputSchema,
  O extends ToolOutputSchema,
  S,
  T extends WriteTier,
>(
  tool: WriteToolDefinition<I, O, S, T>,
  args: unknown,
  client: SevdeskClient,
  config: Partial<Config> = {},
  files?: FileAccess,
): Promise<WriteRun<WritePlanOf<S, T>, z.output<O>>> {
  const parsed = tool.input.parse(args);
  // Production shares the account config across phases, while wrapping the client separately.
  const ctx = context(client, config, files);
  const plan = await tool.prepare(parsed, {
    ...ctx,
    client: readOnlyClient(client, "preparing a write"),
  });
  const output = await tool.execute(parsed, plan, {
    ...ctx,
    client: tierScopedClient(client, tool.tier),
  });
  tool.output.parse(output.data);
  return { plan, output };
}
