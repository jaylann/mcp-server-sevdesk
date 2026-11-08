import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";
import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";

/**
 * - `replay` (default): answers come only from cassettes; a case without a current cassette is
 *   skipped as "stale cassette". Never calls a model.
 * - `record`: cases with a current cassette replay, the others call the Anthropic API
 *   (`ANTHROPIC_API_KEY`) and write a new cassette.
 */
export type EvalsMode = "replay" | "record";

/** `EVALS_MODE` (set by `vitest.evals.config.ts`); anything but `record` is refused. */
export function evalsMode(env: NodeJS.ProcessEnv = process.env): EvalsMode {
  const raw = env["EVALS_MODE"]?.trim() || "replay";
  if (raw !== "replay" && raw !== "record") {
    throw new Error(`EVALS_MODE must be replay or record, got "${raw}".`);
  }
  return raw;
}

/** Where cassettes live: `<model>/<case id>.json`, one per case and model. */
const CASSETTE_DIR = fileURLToPath(new URL("cassettes/", import.meta.url));

const jsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof jsonObjectSchema>;

const recordedResponseSchema = z.strictObject({
  /** The model that answered, as the API reported it. */
  model: z.string(),
  stopReason: z.string().nullable(),
  /** Text and tool_use blocks in answer order; thinking blocks are not kept. */
  content: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("text"), text: z.string() }),
      z.strictObject({ type: z.literal("tool_use"), name: z.string(), input: jsonObjectSchema }),
    ]),
  ),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative(),
    cacheReadInputTokens: z.number().int().nonnegative(),
  }),
});
export type RecordedResponse = z.infer<typeof recordedResponseSchema>;

const cassetteSchema = z.strictObject({
  caseId: z.string(),
  model: z.string(),
  /** {@link requestKey} of the request that was sent. */
  key: z.string().regex(/^[0-9a-f]{64}$/),
  recordedAt: z.string(),
  response: recordedResponseSchema,
});
export type Cassette = z.infer<typeof cassetteSchema>;

/** Parses tool input from the API into a JSON object (anything else becomes `{}`). */
export function toJsonObject(input: unknown): JsonObject {
  const parsed = jsonObjectSchema.safeParse(JSON.parse(JSON.stringify(input ?? {})));
  return parsed.success ? parsed.data : {};
}

/**
 * SHA-256 of the canonical JSON of the whole request: model, system prompt, tools, messages and
 * the remaining parameters. Any change to a tool description, schema, the instructions, a prompt
 * or the model makes the recorded answer stale.
 */
export function requestKey(request: object): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function cassettePath(model: string, caseId: string, root = CASSETTE_DIR): string {
  return join(root, model, `${caseId}.json`);
}

export type CassetteLookup =
  | { readonly status: "current"; readonly cassette: Cassette }
  | { readonly status: "stale"; readonly cassette: Cassette }
  | { readonly status: "missing" };

/**
 * The cassette of `caseId` for `model`: `current` when it was recorded for exactly this request
 * (`key`), `stale` when the request changed since, `missing` when there is none. A cassette that
 * does not parse throws: it was edited by hand or written by a broken recorder.
 */
export async function lookupCassette(
  model: string,
  caseId: string,
  key: string,
  root = CASSETTE_DIR,
): Promise<CassetteLookup> {
  const path = cassettePath(model, caseId, root);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return { status: "missing" };
    }
    throw error;
  }
  const parsed = cassetteSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Invalid cassette ${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.key === key
    ? { status: "current", cassette: parsed.data }
    : { status: "stale", cassette: parsed.data };
}

/**
 * Writes `cassette` as JSON formatted with the repository's Prettier settings, so a recording
 * passes `pnpm format:check` as is (replaces an older one of the same case and model).
 */
export async function writeCassette(cassette: Cassette, root = CASSETTE_DIR): Promise<string> {
  const path = cassettePath(cassette.model, cassette.caseId, root);
  await mkdir(dirname(path), { recursive: true });
  const options = (await resolveConfig(path)) ?? {};
  const text = await format(JSON.stringify(cassetteSchema.parse(cassette)), {
    ...options,
    parser: "json",
  });
  await writeFile(path, text, "utf8");
  return path;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
