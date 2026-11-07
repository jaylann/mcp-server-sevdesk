import type { z } from "zod";

import type { Config } from "../config.js";
import type { Tier } from "../safety/tiers.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import type { ToolsetName } from "./toolsets.js";

/**
 * All four MCP tool annotations, required. The spec defaults are unsafe (an omitted
 * `readOnlyHint` means "may write", an omitted `destructiveHint` means "destructive"), and clients
 * use them to decide when to ask the user, so every tool states them explicitly.
 */
export interface ToolAnnotationSet {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  /** True when the tool reaches beyond sevDesk (e.g. emails a customer). */
  readonly openWorldHint: boolean;
}

/** What a handler gets besides its validated arguments. */
export interface ToolContext {
  readonly client: SevdeskClient;
  readonly config: Config;
  /** Aborted when the MCP client cancels the call; pass it to every request. */
  readonly signal: AbortSignal;
  /** Report progress for long-running calls (no-op when the client did not ask for progress). */
  readonly progress: (done: number, total?: number, message?: string) => Promise<void>;
}

/**
 * A handler's successful result. `data` must match the tool's output schema; `summary` is one
 * short, trusted sentence (no upstream text) shown before the JSON.
 */
export interface ToolOutput<O> {
  readonly data: O;
  readonly summary: string;
}

export type ToolInputSchema = z.ZodObject;
export type ToolOutputSchema = z.ZodObject;

export interface ToolDefinition<
  I extends ToolInputSchema = ToolInputSchema,
  O extends ToolOutputSchema = ToolOutputSchema,
> {
  /** `sevdesk_<resource>_<verb>`, snake_case, ≤ 64 chars. */
  readonly name: string;
  readonly title: string;
  /**
   * What the tool does, when to use it, and the German terms users say (Rechnung, Beleg, …).
   * ≤ 2,048 characters. No instructions that depend on upstream data.
   */
  readonly description: string;
  readonly toolset: ToolsetName;
  readonly tier: Tier;
  readonly annotations: ToolAnnotationSet;
  /** Strict object schema (unknown keys are rejected), flat, object root. */
  readonly input: I;
  /** Object-root schema of `ToolOutput.data`. */
  readonly output: O;
  readonly handler: (args: z.output<I>, ctx: ToolContext) => Promise<ToolOutput<z.output<O>>>;
}

/** A tool with its schema types erased, for registries and lists. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;
