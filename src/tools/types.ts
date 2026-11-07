import type { ResourceLink } from "@modelcontextprotocol/server";
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
 * A content block a handler may add after the JSON text block. Deliberately narrow: only
 * `resource_link`s, which point the client at a `sevdesk://` resource (e.g. a PDF) instead of
 * putting file content into what the model reads. Widen it only with the same rule in mind.
 */
type ExtraContentBlock = ResourceLink;

/**
 * A handler's successful result. `data` must match the tool's output schema; `summary` is one
 * short, trusted sentence (no upstream text) shown before the JSON.
 */
export interface ToolOutput<O> {
  readonly data: O;
  readonly summary: string;
  /**
   * Optional blocks appended to the result's `content` after the JSON text block, in order. They
   * are not part of `structuredContent` (which stays `data`) and not validated against the
   * output schema.
   */
  readonly extraContent?: readonly ExtraContentBlock[];
}

export type ToolInputSchema = z.ZodObject;
export type ToolOutputSchema = z.ZodObject;

/** The configuration slice that decides which tools a server registers. */
export type ToolSelectionConfig = Pick<Config, "toolsets" | "allowedTiers" | "outputDir">;

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
  /**
   * Effects on the local machine, outside sevDesk. Only `read`-tier tools may declare it: such
   * a tool changes nothing in sevDesk (so it needs no write tier) but does modify its
   * environment, so it must set `readOnlyHint: false`, and a `read` tool may set
   * `readOnlyHint: false` only together with this flag (checked by `validateToolDefinition`).
   * `"writes-files"`: creates files (only inside `SEVDESK_OUTPUT_DIR`).
   */
  readonly localEffects?: "writes-files";
  /**
   * Extra registration condition on top of toolset and tier, e.g. "SEVDESK_OUTPUT_DIR is set".
   * A tool for which it returns false is not registered (see `selectTools`).
   */
  readonly available?: (config: ToolSelectionConfig) => boolean;
  /** Strict object schema (unknown keys are rejected), flat, object root. */
  readonly input: I;
  /** Object-root schema of `ToolOutput.data`. */
  readonly output: O;
  readonly handler: (args: z.output<I>, ctx: ToolContext) => Promise<ToolOutput<z.output<O>>>;
}

/** A tool with its schema types erased, for registries and lists. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;
