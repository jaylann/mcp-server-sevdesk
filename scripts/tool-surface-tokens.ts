/**
 * Standalone counter: only Node built-ins, no server/helper/package imports or dependency install.
 * CI runs this file from the PR's BASE revision in a fresh job, over untrusted JSON artifacts.
 * node scripts/tool-surface-tokens.ts base.json head.json report.json
 */
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const TOKEN_MODEL = "claude-opus-5-5";
export const CONFIGURATIONS = ["read", "write", "all", "http-files"] as const;
export const RESPONSE_IDS = [
  "invoice_get",
  "records_summarize",
  "contacts_search",
  "transactions_list",
  "vouchers_list",
  "invoices_list",
  "invoices_list_max",
] as const;

export interface ModelContext {
  system: string;
  tools: {
    name: string;
    description: string;
    input_schema: { type: "object"; [key: string]: unknown };
  }[];
}
export type TokenInput =
  { kind: "context"; view: ModelContext } | { kind: "response"; text: string };
export interface TokenCounter {
  readonly method: "exact" | "estimated";
  count(input: TokenInput): Promise<number>;
}
interface CountRequest {
  model: string;
  system?: string;
  tools?: ModelContext["tools"];
  messages: { role: "user"; content: string }[];
}
type CountTokens = (request: CountRequest) => Promise<number>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate without reconstructing objects: schema key order is part of the captured input. */
export function isModelContext(value: unknown): value is ModelContext {
  return (
    isObject(value) &&
    typeof value.system === "string" &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool: unknown) =>
        isObject(tool) &&
        Object.keys(tool).length === 3 &&
        typeof tool.name === "string" &&
        typeof tool.description === "string" &&
        isObject(tool.input_schema) &&
        tool.input_schema.type === "object",
    )
  );
}

/** Fixed origin, no redirects or SDK/env overrides. Provider errors never include request details. */
async function countWithApi(apiKey: string, request: CountRequest): Promise<number> {
  const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2026-10-21", // Same API version as the repository's pinned SDK.
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error("Token counting request failed.");
  const result: unknown = await response.json();
  if (!isObject(result) || typeof result.input_tokens !== "number")
    throw new Error("Invalid token count.");
  return result.input_tokens;
}

/**
 * A single `x` is one payload token for the fixed model. Context requests retain that message,
 * so subtract its whole count. Response text replaces it: subtract only framing (baseline - 1).
 * The injected API boundary keeps tests offline; provider failure leaves CI's estimate intact.
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
        return Promise.resolve(Math.round(Array.from(text).length / 2.3));
      },
    };
  }
  const api = countTokens ?? ((request) => countWithApi(apiKey, request));
  const messages = (text: string): CountRequest["messages"] => [{ role: "user", content: text }];
  let baseline: Promise<number> | undefined;
  return {
    method: "exact",
    count: async (input) => {
      try {
        baseline ??= api({ model: TOKEN_MODEL, messages: messages("x") });
        const calibration = await baseline;
        const overhead = calibration - (input.kind === "response" ? 1 : 0);
        const total = await api({
          model: TOKEN_MODEL,
          ...(input.kind === "context"
            ? { system: input.view.system, tools: input.view.tools, messages: messages("x") }
            : { messages: messages(input.text) }),
        });
        if (
          !Number.isSafeInteger(total) ||
          !Number.isSafeInteger(calibration) ||
          calibration < 1 ||
          total < overhead
        ) {
          throw new Error("Invalid token count.");
        }
        return total - overhead;
      } catch {
        throw new Error("Token counting failed; see the independent estimated report.");
      }
    },
  };
}

/** Missing or failed captures are null; they never erase the compatibility report. */
export async function measureCapturedTokens(value: unknown, counter: TokenCounter) {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !isObject(value.configurations) ||
    (value.responses !== undefined && !isObject(value.responses))
  )
    throw new Error("Invalid surface capture.");
  const configurations = {} as Record<(typeof CONFIGURATIONS)[number], number | null>;
  for (const name of CONFIGURATIONS) {
    const config = value.configurations[name];
    if (!isObject(config)) throw new Error("Invalid configuration capture.");
    const view = config.modelContext;
    if (view !== undefined && !isModelContext(view)) throw new Error("Invalid model context.");
    configurations[name] =
      view === undefined ? null : await counter.count({ kind: "context", view });
  }
  const responses = {} as Record<(typeof RESPONSE_IDS)[number], number | null>;
  for (const id of RESPONSE_IDS) {
    const text = value.responses?.[id];
    if (text !== undefined && typeof text !== "string")
      throw new Error("Invalid response capture.");
    responses[id] = text === undefined ? null : await counter.count({ kind: "response", text });
  }
  return { configurations, responses };
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid counting input file.");
  return JSON.parse(await readFile(path, "utf8"));
}

/** Recounts an existing report; JSON is data, never imported or evaluated. */
export async function countCapturedReport(
  args: readonly string[],
  counter = createTokenCounter(),
): Promise<void> {
  const [baseFile, headFile, reportFile] = args;
  if (args.length !== 3 || !baseFile || !headFile || !reportFile) {
    throw new Error("Usage: tool-surface-tokens.ts base.json head.json report.json");
  }
  const base = await readJson(baseFile, 20_000_000);
  const head = await readJson(headFile, 20_000_000);
  const report = await readJson(reportFile, 300_000);
  if (!isObject(report) || report.version !== 1) throw new Error("Invalid surface report.");
  const tokenCost = {
    method: counter.method,
    model: TOKEN_MODEL,
    base: await measureCapturedTokens(base, counter),
    head: await measureCapturedTokens(head, counter),
  };
  await writeFile(reportFile, `${JSON.stringify({ ...report, tokenCost })}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(await realpath(process.argv[1])).href
) {
  await countCapturedReport(
    process.argv.slice(2),
    createTokenCounter(process.env.ANTHROPIC_API_KEY),
  );
}
