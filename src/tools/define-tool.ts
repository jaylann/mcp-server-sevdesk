import { z } from "zod";

import { isTier, type Tier, TIERS } from "../safety/tiers.js";
import { isToolsetName, TOOLSETS } from "./toolsets.js";
import type {
  ToolAnnotationSet,
  ToolDefinition,
  ToolInputSchema,
  ToolOutputSchema,
} from "./types.js";

/** `sevdesk_<resource>_<verb>[_…]`: lowercase snake_case with at least two segments after the prefix. */
const TOOL_NAME_PATTERN = /^sevdesk_[a-z0-9]+(?:_[a-z0-9]+)+$/;
/** Some clients (Claude among them) reject longer tool names. */
const MAX_TOOL_NAME_LENGTH = 64;
const MIN_DESCRIPTION_LENGTH = 20;
export const MAX_DESCRIPTION_LENGTH = 2_048;
/** The JSON Schema dialect the MCP SDK advertises tool schemas in. */
export const JSON_SCHEMA_TARGET = "draft-2020-12";

const ANNOTATION_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const satisfies readonly (keyof ToolAnnotationSet)[];

/**
 * The parts of a tool definition that {@link validateToolDefinition} checks: everything except
 * the handler, typed loosely so the checks also hold for definitions that bypassed the type
 * system (casts, JavaScript, `AnyToolDefinition`).
 */
export interface ToolMetadata {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly toolset: string;
  readonly tier: string;
  readonly annotations: { readonly [K in keyof ToolAnnotationSet]?: unknown };
  readonly input: unknown;
  readonly output: unknown;
}

/** Thrown by {@link defineTool} with every problem found, so all can be fixed in one go. */
export class ToolDefinitionError extends Error {
  readonly toolName: string;
  readonly problems: readonly string[];

  constructor(toolName: string, problems: readonly string[]) {
    super(
      `Invalid tool definition ${JSON.stringify(toolName)}:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n"),
    );
    this.name = "ToolDefinitionError";
    this.toolName = toolName;
    this.problems = problems;
  }
}

/**
 * Declares a tool and validates it at definition (module load) time, so a broken definition fails
 * every test run instead of misbehaving in a client. Throws {@link ToolDefinitionError}; see
 * {@link validateToolDefinition} for the rules. Keeps the schema generics intact for the handler.
 */
export function defineTool<I extends ToolInputSchema, O extends ToolOutputSchema>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  const problems = validateToolDefinition(definition);
  if (problems.length > 0) {
    throw new ToolDefinitionError(definition.name, problems);
  }
  return Object.freeze(definition);
}

/**
 * Checks a tool definition and returns every problem found (empty when valid):
 *
 * - name matches {@link TOOL_NAME_PATTERN} and has at most {@link MAX_TOOL_NAME_LENGTH} chars;
 * - title is not blank; description has {@link MIN_DESCRIPTION_LENGTH}–{@link MAX_DESCRIPTION_LENGTH}
 *   chars; toolset and tier are known;
 * - all four annotations are booleans and agree with the tier: `read` ⇒ read-only and not
 *   destructive; every other tier ⇒ not read-only; `commit` ⇒ destructive; `external` ⇒ open world;
 * - input is a strict zod object (unknown keys rejected, see {@link isStrictObject}) whose JSON
 *   Schema has an object root without a top-level union; output is a zod object that converts to
 *   JSON Schema.
 */
export function validateToolDefinition(definition: ToolMetadata): string[] {
  const problems: string[] = [];
  const { name, title, description, toolset, tier, annotations } = definition;

  if (!TOOL_NAME_PATTERN.test(name)) {
    problems.push(`name must match ${TOOL_NAME_PATTERN.source} (sevdesk_<resource>_<verb>).`);
  }
  if (name.length > MAX_TOOL_NAME_LENGTH) {
    problems.push(`name has ${name.length} chars; the maximum is ${MAX_TOOL_NAME_LENGTH}.`);
  }
  if (title.trim() === "") {
    problems.push("title must not be empty.");
  }
  if (description.trim().length < MIN_DESCRIPTION_LENGTH) {
    problems.push(`description must have at least ${MIN_DESCRIPTION_LENGTH} chars.`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(
      `description has ${description.length} chars; the maximum is ${MAX_DESCRIPTION_LENGTH}.`,
    );
  }
  if (!isToolsetName(toolset)) {
    problems.push(`toolset "${toolset}" is unknown (expected one of ${TOOLSETS.join(", ")}).`);
  }

  for (const key of ANNOTATION_KEYS) {
    if (typeof annotations[key] !== "boolean") {
      problems.push(`annotations.${key} must be set explicitly to true or false.`);
    }
  }
  if (isTier(tier)) {
    problems.push(...annotationTierProblems(tier, annotations));
  } else {
    problems.push(`tier "${tier}" is unknown (expected one of ${TIERS.join(", ")}).`);
  }

  problems.push(...inputSchemaProblems(definition.input));
  problems.push(...outputSchemaProblems(definition.output));
  return problems;
}

/**
 * Whether a zod object rejects unknown keys. Zod v4 keeps an object's unknown-key policy in its
 * definition's `catchall` (`schema._zod.def.catchall`): absent for the default "strip" mode,
 * `ZodUnknown` for `.loose()`/`.passthrough()`, and `ZodNever` for `z.strictObject()`/`.strict()`.
 * Only the last one rejects unknown keys. This reads zod internals; the metadata lint test
 * cross-checks it against the public JSON Schema output (`additionalProperties: false`).
 */
export function isStrictObject(schema: z.ZodObject): boolean {
  return schema._zod.def.catchall?._zod.def.type === "never";
}

function annotationTierProblems(tier: Tier, annotations: ToolMetadata["annotations"]): string[] {
  const problems: string[] = [];
  const mismatch = (key: keyof ToolAnnotationSet, expected: boolean): void => {
    if (annotations[key] !== expected) {
      problems.push(`tier "${tier}" requires annotations.${key} = ${String(expected)}.`);
    }
  };
  if (tier === "read") {
    mismatch("readOnlyHint", true);
    mismatch("destructiveHint", false);
  } else {
    mismatch("readOnlyHint", false);
  }
  if (tier === "commit") {
    mismatch("destructiveHint", true);
  }
  if (tier === "external") {
    mismatch("openWorldHint", true);
  }
  return problems;
}

function inputSchemaProblems(input: unknown): string[] {
  if (!(input instanceof z.ZodObject)) {
    return ["input must be a zod object schema, e.g. z.strictObject({ … })."];
  }
  const problems: string[] = [];
  if (!isStrictObject(input)) {
    problems.push(
      "input must reject unknown keys: use z.strictObject({ … }) or z.object({ … }).strict().",
    );
  }
  const json = toJsonSchema(input, "input", problems);
  if (json !== undefined) {
    if (json["type"] !== "object") {
      problems.push("input JSON Schema must have an object root (type: object).");
    }
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      if (keyword in json) {
        problems.push(
          `input JSON Schema must not have a top-level ${keyword}; keep the root flat.`,
        );
      }
    }
  }
  return problems;
}

function outputSchemaProblems(output: unknown): string[] {
  if (!(output instanceof z.ZodObject)) {
    return ["output must be a zod object schema, e.g. z.object({ … })."];
  }
  const problems: string[] = [];
  toJsonSchema(output, "output", problems);
  return problems;
}

function toJsonSchema(
  schema: z.ZodObject,
  io: "input" | "output",
  problems: string[],
): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(schema, { io, target: JSON_SCHEMA_TARGET });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    problems.push(`${io} schema cannot be converted to JSON Schema: ${reason}`);
    return undefined;
  }
}
