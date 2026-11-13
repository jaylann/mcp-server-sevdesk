/** Token costs for the legacy Claude view; the counter is injectable and never needs sevDesk. */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const TOKEN_MODEL = "claude-opus-5-5";
const CHARACTERS_PER_TOKEN = 2.3;

export const modelContextSchema = z.strictObject({
  system: z.string(),
  tools: z.array(
    z.strictObject({
      name: z.string(),
      description: z.string(),
      input_schema: z.object({ type: z.literal("object") }).catchall(z.json()),
    }),
  ),
});

export type TokenInput =
  | { kind: "context"; view: z.infer<typeof modelContextSchema> }
  | { kind: "response"; text: string };

export interface TokenCounter {
  readonly method: "exact" | "estimated";
  count(input: TokenInput): Promise<number>;
}

type CountTokens = (request: Anthropic.MessageCountTokensParams) => Promise<number>;

/**
 * Without a key, estimate Unicode code points / 2.3 (measured in #61). With a key, subtract
 * the same one-character user-message baseline as the issue's prototype. Responses count
 * the text blocks only, without client-specific tool-result envelopes. Provider failures
 * fail the exact run, leaving the independent estimated comment available; never log SDK
 * errors, which may carry request headers. Tests inject the API boundary.
 */
export function createTokenCounter(apiKey?: string, countTokens?: CountTokens): TokenCounter {
  if (!apiKey) {
    return {
      method: "estimated",
      count: (input) => {
        const text =
          input.kind === "response"
            ? input.text
            : JSON.stringify({ tools: input.view.tools }) + input.view.system;
        return Promise.resolve(Math.round(Array.from(text).length / CHARACTERS_PER_TOKEN));
      },
    };
  }
  const api =
    countTokens ??
    ((request) =>
      new Anthropic({ apiKey }).messages
        .countTokens(request)
        .then((result) => result.input_tokens));
  const messages = (text: string): Anthropic.MessageParam[] => [{ role: "user", content: text }];
  let baseline: Promise<number> | undefined;
  return {
    method: "exact",
    count: async (input) => {
      try {
        baseline ??= api({ model: TOKEN_MODEL, messages: messages("x") });
        const overhead = await baseline;
        const total = await api({
          model: TOKEN_MODEL,
          ...(input.kind === "context"
            ? { system: input.view.system, tools: input.view.tools, messages: messages("x") }
            : { messages: messages(input.text) }),
        });
        if (!Number.isSafeInteger(total) || !Number.isSafeInteger(overhead) || total < overhead) {
          throw new Error("Invalid token count.");
        }
        return total - overhead;
      } catch {
        throw new Error("Token counting failed; see the independent estimated report.");
      }
    },
  };
}
