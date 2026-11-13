/**
 * Standalone counter: only Node built-ins, no server/helper/package imports or dependency install.
 * Local/PR estimates only. Federated exact counting lives in the trusted comment workflow.
 * node scripts/tool-surface-tokens.ts base.json head.json report.json
 */
import { constants } from "node:fs";
import { open, realpath, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const TOKEN_MODEL = "claude-opus-5-5";
export const CONFIGURATIONS = ["read", "write", "all", "http-files"] as const;
export const RESPONSE_IDS = [
  "invoice_get",
  "records_summarize",
  "contacts_search",
  "transactions_list",
  "transactions_list_summary",
  "vouchers_list",
  "vouchers_list_summary",
  "invoices_list",
  "invoices_list_summary",
  "invoices_list_max",
  "invoices_list_summary_max",
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

/** Offline estimator: credentials and network access belong only to the trusted publisher. */
export function createTokenCounter(): TokenCounter {
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
  // Reject symlinks/special files without blocking, then validate and read the same descriptor.
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new Error("Invalid counting input file.");
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid counting input file.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
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
  await countCapturedReport(process.argv.slice(2));
}
