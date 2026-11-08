import Anthropic from "@anthropic-ai/sdk";

import { type RecordedResponse, toJsonObject } from "./cassette.js";
import type { ClientView } from "./tools.js";

/** Model the evals run against unless `EVAL_MODEL` names another one. */
const DEFAULT_MODEL = "claude-sonnet-5-5";

/** Room for (adaptive) thinking plus a tool call; a cut-off answer counts as "no tool". */
const MAX_TOKENS = 8_000;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** `EVAL_MODEL`, or {@link DEFAULT_MODEL}. Model ids also name the cassette folder. */
export function evalModel(env: NodeJS.ProcessEnv = process.env): string {
  const model = env["EVAL_MODEL"]?.trim() || DEFAULT_MODEL;
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(model)) {
    throw new Error(`EVAL_MODEL must be a model id such as ${DEFAULT_MODEL}.`);
  }
  return model;
}

/** `EVAL_EFFORT` (low … max), or undefined for the model's default effort. */
export function evalEffort(env: NodeJS.ProcessEnv = process.env): Effort | undefined {
  const raw = env["EVAL_EFFORT"]?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const effort = EFFORTS.find((value) => value === raw);
  if (effort === undefined) {
    throw new Error(`EVAL_EFFORT must be one of ${EFFORTS.join(", ")}.`);
  }
  return effort;
}

/**
 * The single Messages API request of one case: the server instructions as the system prompt, the
 * advertised tools, the user's prompt as the only message, `tool_choice: auto` (the model may
 * also answer without a tool). The system block carries a cache breakpoint, so cases that share
 * an env reuse the cached tools and instructions while recording. No sampling parameters: the
 * current API rejects them, and the cassettes make runs repeatable instead.
 */
export function buildRequest(
  view: ClientView,
  prompt: string,
  model: string,
  effort: Effort | undefined,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: [{ type: "text", text: view.system, cache_control: { type: "ephemeral" } }],
    tools: [...view.tools],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: prompt }],
    ...(effort === undefined ? {} : { output_config: { effort } }),
  };
}

/**
 * Sends `request` and keeps what the evals need: text and `tool_use` blocks (thinking blocks and
 * signatures are dropped), the stop reason and token usage. Uses `ANTHROPIC_API_KEY`. No refusal
 * fallback on purpose: a fallback model would answer in the evaluated model's place.
 */
export async function callModel(
  client: Anthropic,
  request: Anthropic.MessageCreateParamsNonStreaming,
): Promise<RecordedResponse> {
  const message = await client.messages.create(request);
  const content: RecordedResponse["content"] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({ type: "tool_use", name: block.name, input: toJsonObject(block.input) });
    }
  }
  return {
    model: message.model,
    stopReason: message.stop_reason,
    content,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}

/** USD per million tokens (Anthropic API list prices, 2026-10), for the cost estimate. */
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/**
 * Estimated cost of one recorded answer: uncached input at the input price, cache writes at
 * 1.25× and cache reads at 0.1× of it, output (thinking included) at the output price. Undefined
 * for models without a price here.
 */
export function estimateCostUsd(
  model: string,
  usage: RecordedResponse["usage"],
): number | undefined {
  const price = PRICES[model];
  if (price === undefined) {
    return undefined;
  }
  const input =
    usage.inputTokens + usage.cacheCreationInputTokens * 1.25 + usage.cacheReadInputTokens * 0.1;
  return (input * price.input + usage.outputTokens * price.output) / 1_000_000;
}
