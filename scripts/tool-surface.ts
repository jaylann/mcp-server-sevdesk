/**
 * Reusable MCP surface capture and comparison (no token, sockets or sevDesk calls).
 *
 *   node --import tsx scripts/tool-surface.ts dump [output.json]
 *   node --import tsx scripts/tool-surface.ts diff base.json head.json [diff.txt]
 *   node --import tsx scripts/tool-surface.ts report base.json head.json event.json report.json
 *
 * dump writes stable JSON to stdout unless a path is supplied. Format version 1:
 * { version: 1, configurations: { read, write, all, "http-files" } }, where each value has
 * full tools/list entries, full prompts/list entries and the handshake's instructions.
 * Protocol catalogs are canonicalized and named lists sorted; model-context keys and schema
 * arrays retain client order. The modern
 * protocol is pinned by connectFactory, as in test/integration/tools-list.test.ts, so output
 * schemas are included. read/write use default toolsets; all/http-files enable every toolset
 * and tier; http-files uses OAuth and remote files, with no local folders.
 *
 * diff emits JSON-pointer paths (tools/prompts keyed by name), with -/+ JSON values. Empty
 * output means no change; changes still exit 0. report adds PR provenance from the GitHub event
 * and bounds the text for a comment; the workflow also retains the complete diff artifact.
 * contextCost retains Unicode character sizes for the full protocol catalog. New dumps also
 * capture modelContext (legacy name/description/input_schema + system) and recorded response
 * text. Reports add tokenCost.base/head using messages.countTokens with ANTHROPIC_API_KEY,
 * otherwise estimates at characters / 2.3. Missing legacy captures are null, never zero.
 * Prompt bodies, JSON-RPC and tool-result envelopes are excluded. Invalid input fails nonzero.
 * Server configuration never comes from the caller's environment.
 *
 * CI copies tool-surface*.ts into the base checkout: both revisions use the same harness and
 * the head's recorded corpus, with each revision's real server and frozen dependencies.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type { Config } from "../src/config.js";
import { createServerFactory } from "../src/server.js";
import { allEnabledConfig, testConfig, tiers } from "../test/helpers/config.js";
import { connectFactory } from "../test/helpers/connect.js";
import { stubClient } from "../test/helpers/dummy-tools.js";
import { captureResponses, RESPONSE_CALLS } from "./tool-surface-responses.js";
import {
  createTokenCounter,
  isModelContext,
  measureCapturedTokens,
  type ModelContext,
  TOKEN_MODEL,
  type TokenCounter,
} from "./tool-surface-tokens.js";

type Json = z.infer<ReturnType<typeof z.json>>;

const namedEntry = z.object({ name: z.string().min(1) }).catchall(z.json());
const entries = z.array(namedEntry).superRefine((items, ctx) => {
  if (new Set(items.map((item) => item.name)).size !== items.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate surface entry names." });
  }
});
const configuration = z.strictObject({
  tools: entries,
  prompts: entries,
  instructions: z.string(),
  modelContext: z.custom<ModelContext>(isModelContext).optional(),
});
const surfaceSchema = z.strictObject({
  version: z.literal(1),
  responses: z
    .partialRecord(
      z.enum(
        Object.keys(RESPONSE_CALLS) as [
          keyof typeof RESPONSE_CALLS,
          ...(keyof typeof RESPONSE_CALLS)[],
        ],
      ),
      z.string(),
    )
    .optional(),
  configurations: z.strictObject({
    read: configuration,
    write: configuration,
    all: configuration,
    "http-files": configuration,
  }),
});

export type ToolSurface = z.infer<typeof surfaceSchema>;

type SurfaceSizes = Record<
  keyof ToolSurface["configurations"],
  { definitions: number; tools: number; prompts: number; instructions: number }
>;

/** Measures the captured catalog without dump indentation, metadata or JSON-escaped instructions. */
export function measureToolSurface(value: unknown): SurfaceSizes {
  const surface = surfaceSchema.parse(value);
  const characters = (text: string): number => Array.from(text).length;
  const measure = (item: z.infer<typeof configuration>): SurfaceSizes["read"] => ({
    definitions: characters(
      JSON.stringify({
        tools: item.tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      }),
    ),
    tools: characters(JSON.stringify({ tools: item.tools })),
    prompts: characters(JSON.stringify({ prompts: item.prompts })),
    instructions: characters(item.instructions),
  });
  return {
    read: measure(surface.configurations.read),
    write: measure(surface.configurations.write),
    all: measure(surface.configurations.all),
    "http-files": measure(surface.configurations["http-files"]),
  };
}

type TokenSizes = Awaited<ReturnType<typeof measureCapturedTokens>>;

/** Validate the full dump before counting the legacy input captured within it. */
export async function measureTokens(value: unknown, counter: TokenCounter): Promise<TokenSizes> {
  return measureCapturedTokens(surfaceSchema.parse(value), counter);
}

/** Recursively sorts object keys without changing array semantics. */
function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key] ?? null)]),
    );
  }
  return value;
}

/** Canonical two-space JSON with a trailing newline, suitable for files and downstream reports. */
export function surfaceJson(value: ToolSurface): string {
  const parsed = surfaceSchema.parse(value);
  for (const item of Object.values(parsed.configurations)) {
    const byName = (a: { name: string }, b: { name: string }): number =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    item.tools.sort(byName);
    item.prompts.sort(byName);
  }
  // Canonicalize only the protocol catalog; the Messages API payload keeps the exact key
  // and schema order returned to clients. A round trip must not change tokenization input.
  const canonical = surfaceSchema.parse(sorted(z.json().parse(parsed)));
  for (const name of Object.keys(parsed.configurations) as (keyof typeof parsed.configurations)[]) {
    const view = parsed.configurations[name].modelContext;
    if (view !== undefined) canonical.configurations[name].modelContext = view;
  }
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

async function capture(config: Config): Promise<z.infer<typeof configuration>> {
  const factory = createServerFactory({ config, client: stubClient() });
  try {
    const client = await connectFactory(factory);
    try {
      const { tools, nextCursor: toolsCursor } = await client.listTools();
      const { prompts, nextCursor: promptsCursor } = await client.listPrompts();
      // The server currently lists in one page. Fail rather than silently drop a future page.
      if (toolsCursor !== undefined || promptsCursor !== undefined) {
        throw new Error("Surface listing is paginated; update the capture harness.");
      }
      const legacy = await connectFactory(factory, { era: "legacy" });
      try {
        const listed = await legacy.listTools();
        if (listed.nextCursor !== undefined) throw new Error("Legacy listing is paginated.");
        // Same Messages API shape as test/evals/tools.ts, retaining server list/schema order.
        const modelContext = {
          system: legacy.getInstructions() ?? "",
          tools: listed.tools.map((tool) => {
            const { required, ...schema } = tool.inputSchema;
            return {
              name: tool.name,
              description: tool.description ?? "",
              input_schema: { ...schema, ...(required === undefined ? {} : { required }) },
            };
          }),
        };
        return configuration.parse({
          tools,
          prompts,
          instructions: client.getInstructions() ?? "",
          modelContext,
        });
      } finally {
        await legacy.close();
      }
    } finally {
      await client.close();
    }
  } finally {
    await factory.close();
  }
}

/** Captures exactly the four review configurations with the real MCP SDK and a refusing client. */
export async function dumpToolSurface(responseCapture = captureResponses): Promise<ToolSurface> {
  // Fixture/session failures must not hide the catalog change that caused them. Individual
  // tool failures are isolated by captureResponses; this also covers setup/cleanup failures.
  const responses = await responseCapture().catch(() => ({}));
  return surfaceSchema.parse({
    version: 1,
    responses,
    configurations: {
      read: await capture(testConfig()),
      write: await capture(testConfig({ allowedTiers: tiers("read", "write") })),
      all: await capture(allEnabledConfig()),
      "http-files": await capture(
        allEnabledConfig({
          deployment: {
            kind: "http",
            auth: "oauth",
            publicOrigin: "https://mcp.example.com",
            approvalsUrl: undefined,
            files: { ttlSeconds: 1_800 },
          },
          account: { id: "4711" },
        }),
      ),
    },
  });
}

function keyedSurface(surface: ToolSurface): Json {
  return Object.fromEntries(
    Object.entries(surface.configurations).map(([name, item]) => [
      name,
      {
        instructions: item.instructions,
        tools: Object.fromEntries(item.tools.map((tool) => [tool.name, tool])),
        prompts: Object.fromEntries(item.prompts.map((prompt) => [prompt.name, prompt])),
      },
    ]),
  );
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return (
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
  );
}

/** Pure diff; input is validated, and list insertion order never creates spurious changes. */
export function diffToolSurface(base: unknown, head: unknown): string {
  const lines: string[] = [];
  function visit(before: Json | undefined, after: Json | undefined, path: string): void {
    if (isObject(before) && isObject(after)) {
      for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
        const segment = key.replaceAll("~", "~0").replaceAll("/", "~1");
        visit(
          Object.hasOwn(before, key) ? before[key] : undefined,
          Object.hasOwn(after, key) ? after[key] : undefined,
          `${path}/${segment}`,
        );
      }
      return;
    }
    const left = before === undefined ? undefined : JSON.stringify(sorted(before));
    const right = after === undefined ? undefined : JSON.stringify(sorted(after));
    if (left === right) return;
    if (left !== undefined) lines.push(`- ${path}: ${left}`);
    if (right !== undefined) lines.push(`+ ${path}: ${right}`);
  }
  visit(keyedSurface(surfaceSchema.parse(base)), keyedSurface(surfaceSchema.parse(head)), "");
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const eventSchema = z.object({
  number: z.number().int().positive(),
  pull_request: z.object({ base: z.object({ sha }), head: z.object({ sha }) }),
});

/** Report is untrusted data in the publishing job; provenance is checked again against GitHub. */
export async function surfaceReport(
  base: unknown,
  head: unknown,
  event: unknown,
  counter: TokenCounter = createTokenCounter(),
): Promise<{
  version: 1;
  pr: number;
  base: string;
  head: string;
  changed: boolean;
  diff: string;
  truncated: boolean;
  contextCost: { base: SurfaceSizes; head: SurfaceSizes };
  tokenCost: {
    method: TokenCounter["method"];
    model: typeof TOKEN_MODEL;
    base: TokenSizes;
    head: TokenSizes;
  };
}> {
  const { number, pull_request } = eventSchema.parse(event);
  const diff = diffToolSurface(base, head);
  const limit = 45_000;
  return {
    version: 1,
    pr: number,
    base: pull_request.base.sha,
    head: pull_request.head.sha,
    changed: diff.length > 0,
    diff: diff.slice(0, limit),
    truncated: diff.length > limit,
    contextCost: { base: measureToolSurface(base), head: measureToolSurface(head) },
    tokenCost: {
      method: counter.method,
      model: TOKEN_MODEL,
      base: await measureTokens(base, counter),
      head: await measureTokens(head, counter),
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** CLI entry, exported so tests can exercise file handling and argument failures. */
export async function runToolSurface(args: readonly string[]): Promise<void> {
  const [command, first, second, third, fourth] = args;
  if (command === "dump" && args.length <= 2) {
    const output = surfaceJson(await dumpToolSurface());
    if (first === undefined) process.stdout.write(output);
    else await writeFile(first, output);
  } else if (
    command === "diff" &&
    first !== undefined &&
    second !== undefined &&
    args.length <= 4
  ) {
    const output = diffToolSurface(await readJson(first), await readJson(second));
    if (third === undefined) process.stdout.write(output);
    else await writeFile(third, output);
  } else if (
    command === "report" &&
    first !== undefined &&
    second !== undefined &&
    third !== undefined &&
    fourth !== undefined &&
    args.length === 5
  ) {
    const report = await surfaceReport(
      await readJson(first),
      await readJson(second),
      await readJson(third),
      createTokenCounter(process.env.ANTHROPIC_API_KEY),
    );
    await writeFile(fourth, `${JSON.stringify(report)}\n`);
  } else {
    throw new Error(
      "Usage: tool-surface.ts dump [out] | diff base head [out] | report base head event out",
    );
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runToolSurface(process.argv.slice(2));
}
