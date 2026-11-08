import type Anthropic from "@anthropic-ai/sdk";

import { loadConfig } from "../../src/config.js";
import { TEST_TOKEN } from "../helpers/config.js";
import { connectInProcess } from "../helpers/connect.js";
import { canonicalJson } from "./canonical-json.js";

/**
 * The `SEVDESK_*` variables of one eval scenario, as a user would set them in the MCP client
 * config (the token is added here). Unset variables take the server's defaults.
 */
export type EvalEnv = Readonly<Record<string, string>>;

/** What a model sees of the server for one {@link EvalEnv}. */
export interface ClientView {
  /** The server's generated `instructions`, used verbatim as the system prompt. */
  readonly system: string;
  /** Every tool `tools/list` advertises, in the Messages API custom-tool shape, in list order. */
  readonly tools: readonly Anthropic.Tool[];
}

const views = new Map<string, Promise<ClientView>>();

/**
 * The tools and instructions a client sees for `env`, built exactly as a client gets them: the
 * configuration comes from `loadConfig` (so tiers, toolsets and the `SEVDESK_FILE_DIRS` /
 * `SEVDESK_OUTPUT_DIR` conditions apply as in production), a real MCP client connects in process
 * and reads `tools/list` and the `instructions`. The client speaks the 2025 protocol era, as
 * today's Claude clients do. Nothing reaches sevDesk (stub client, fake token). Cached per env.
 */
export function clientView(env: EvalEnv): Promise<ClientView> {
  const key = canonicalJson(env);
  let view = views.get(key);
  if (view === undefined) {
    view = buildView(env);
    views.set(key, view);
  }
  return view;
}

async function buildView(env: EvalEnv): Promise<ClientView> {
  const config = loadConfig({ ...env, SEVDESK_API_TOKEN: TEST_TOKEN });
  const client = await connectInProcess({ config }, { era: "legacy" });
  try {
    const { tools } = await client.listTools();
    return {
      system: client.getInstructions() ?? "",
      tools: tools.map((tool) => {
        // The advertised schema as is; only an absent `required` is left out rather than undefined.
        const { required, ...schema } = tool.inputSchema;
        return {
          name: tool.name,
          description: tool.description ?? "",
          input_schema: { ...schema, ...(required === undefined ? {} : { required }) },
        };
      }),
    };
  } finally {
    await client.close();
  }
}
