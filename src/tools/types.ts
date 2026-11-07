import type { ResourceLink } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { Config } from "../config.js";
import type { WriteTier } from "../safety/tiers.js";
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
 * @public Named for tool authors; structurally a {@link ToolContext}.
 *
 * Context of {@link WriteToolDefinition.prepare}. Same shape as {@link ToolContext}, but its
 * client refuses every request that changes data (`blocked`), so preparing, previewing and dry
 * runs can never write.
 */
export type PrepareContext = ToolContext;

/**
 * @public Named for tool authors; structurally a {@link ToolContext}.
 *
 * Context of {@link WriteToolDefinition.execute}. Its client stamps the tool's tier on every
 * request that changes data, so tools never pass `tier` themselves; the HTTP client then refuses
 * requests the tier does not cover (a `write` tool cannot reach a `commit` endpoint).
 */
export type ExecuteContext = ToolContext;

/**
 * A content block a handler may add after the JSON text block. Deliberately narrow: only
 * `resource_link`s, which point the client at a `sevdesk://` resource (e.g. a PDF) instead of
 * putting file content into what the model reads. Widen it only with the same rule in mind.
 */
type ExtraContentBlock = ResourceLink;

/** A sevDesk record a write created or changed, for the audit log and read-back. */
export interface SevdeskObjectRef {
  /** sevDesk's `objectName`, e.g. `Invoice`, `CreditNote`, `Contact`. */
  readonly objectName: string;
  readonly id: string;
}

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
  /**
   * Write tools: every record the call created or changed (required by convention for
   * `execute`, ignored for reads). The framework writes them to the audit log.
   */
  readonly affected?: readonly SevdeskObjectRef[];
}

/** One labelled fact in a confirmation, e.g. `{ label: "Total (gross)", value: "1,190.00 EUR" }`. */
export interface ConfirmationFact {
  /** Trusted text written by us. */
  readonly label: string;
  /**
   * May contain sevDesk text (a customer name, a document number). The framework sanitizes it
   * (invisible and bidi characters stripped, length capped) before a human sees it, but build it
   * with `cleanText` anyway.
   */
  readonly value: string;
}

/**
 * What a human approves before a `commit`/`external` action, and what a dry run returns. Shown
 * in the elicitation form, on the local approval page and in dry-run results, so it must say
 * exactly what will happen, in plain words, with the amounts and recipients involved.
 *
 * Determinism rule: for an unchanged sevDesk state and the same arguments, `prepare` must return
 * an identical preview (no clock times, no random ids, stable order). The framework prepares
 * again after the approval and asks again when the preview changed, so the human always approves
 * what actually runs.
 */
export interface ConfirmationPreview {
  /**
   * One trusted sentence in the imperative, e.g. "Finalize invoice RE-1042 (draft → open) and
   * mark it as sent by post." Identifiers from sevDesk only through `cleanText`.
   */
  readonly action: string;
  /** Key facts, most important first: record, customer, amounts, dates, recipients. */
  readonly facts: readonly ConfirmationFact[];
  /**
   * Consequences the human must read, trusted text, e.g. "The invoice number is assigned and
   * the invoice becomes legally binding." Empty when there are none.
   */
  readonly warnings: readonly string[];
  /** True when the action cannot be undone at all (enshrine, an email that was sent). */
  readonly irreversible: boolean;
}

/** The result of {@link WriteToolDefinition.prepare}. */
export interface WritePlan<S> {
  readonly preview: ConfirmationPreview;
  /**
   * Whatever `execute` needs from the reads `prepare` made (e.g. the current invoice, the
   * resolved contact person), so `execute` does not read it again. Not shown to anyone.
   */
  readonly state: S;
}

export type ToolInputSchema = z.ZodObject;
export type ToolOutputSchema = z.ZodObject;

/** The configuration slice that decides which tools a server registers. */
export type ToolSelectionConfig = Pick<Config, "toolsets" | "allowedTiers" | "outputDir">;

/** What every tool declares, whatever its tier. */
interface ToolDefinitionBase<I extends ToolInputSchema, O extends ToolOutputSchema> {
  /** `sevdesk_<resource>_<verb>`, snake_case, ≤ 64 chars. */
  readonly name: string;
  readonly title: string;
  /**
   * What the tool does, when to use it, and the German terms users say (Rechnung, Beleg, …).
   * ≤ 2,048 characters. No instructions that depend on upstream data.
   */
  readonly description: string;
  readonly toolset: ToolsetName;
  readonly annotations: ToolAnnotationSet;
  /**
   * Extra registration condition on top of toolset and tier, e.g. "SEVDESK_OUTPUT_DIR is set".
   * A tool for which it returns false is not registered (see `selectTools`).
   */
  readonly available?: (config: ToolSelectionConfig) => boolean;
  /** Strict object schema (unknown keys are rejected), flat, object root. */
  readonly input: I;
  /**
   * Object-root schema of `ToolOutput.data`. For write tools this is the result of a completed
   * call; the framework wraps it (status, preview, approval) for dry runs and confirmations.
   */
  readonly output: O;
}

/** A tool that changes nothing in sevDesk. Declared with `defineTool`. */
export interface ReadToolDefinition<
  I extends ToolInputSchema = ToolInputSchema,
  O extends ToolOutputSchema = ToolOutputSchema,
> extends ToolDefinitionBase<I, O> {
  readonly tier: "read";
  /**
   * Effects on the local machine, outside sevDesk: such a tool changes nothing in sevDesk (so it
   * needs no write tier) but does modify its environment, so it must set `readOnlyHint: false`,
   * and a `read` tool may set `readOnlyHint: false` only together with this flag (checked by
   * `validateToolDefinition`). `"writes-files"`: creates files (only inside `SEVDESK_OUTPUT_DIR`).
   */
  readonly localEffects?: "writes-files";
  readonly handler: (args: z.output<I>, ctx: ToolContext) => Promise<ToolOutput<z.output<O>>>;
}

/**
 * A tool that changes something in sevDesk. Declared with `defineWriteTool`. Its input must
 * include `dryRunInputShape` (`src/tools/write-input.ts`).
 *
 * The framework (`src/tools/write-flow.ts`) runs every call as:
 * 1. validate the arguments;
 * 2. `prepare` with a read-only client: reads, checks preconditions, builds the preview;
 * 3. dry run (`dryRun: true` or `SEVDESK_DRY_RUN=1`): return the preview, stop;
 * 4. `commit`/`external`: ask a human (elicitation or the approval page) and stop until the
 *    approval arrives; then `prepare` again and ask again if the preview changed;
 * 5. audit "executing", `execute` with a tier-scoped client, audit the outcome.
 *
 * Neither function retries a write, and neither catches errors to hide them.
 */
export interface WriteToolDefinition<
  I extends ToolInputSchema = ToolInputSchema,
  O extends ToolOutputSchema = ToolOutputSchema,
  S = unknown,
> extends ToolDefinitionBase<I, O> {
  readonly tier: WriteTier;
  /**
   * Reads what the action needs and decides whether it is possible. When it is not (wrong
   * status, amount above the open amount, unknown tax rule …), throws a `SevdeskError` of kind
   * `validation` with a trusted, actionable message; nothing was sent. Must follow the
   * determinism rule of {@link ConfirmationPreview}.
   */
  readonly prepare: (args: z.output<I>, ctx: PrepareContext) => Promise<WritePlan<S>>;
  /**
   * Performs exactly the writes the preview describes, then reads the result back and returns
   * it, with every created or changed record in `affected`. Runs only after `prepare` succeeded
   * (and, for confirmed tiers, after approval), never in a dry run.
   */
  readonly execute: (
    args: z.output<I>,
    plan: WritePlan<S>,
    ctx: ExecuteContext,
  ) => Promise<ToolOutput<z.output<O>>>;
}

/** @public Any tool definition. */
export type ToolDefinition<
  I extends ToolInputSchema = ToolInputSchema,
  O extends ToolOutputSchema = ToolOutputSchema,
> =
  | ReadToolDefinition<I, O>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | WriteToolDefinition<I, O, any>;

/** A tool with its schema types erased, for registries and lists. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/** A write tool with its schema types erased. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWriteToolDefinition = WriteToolDefinition<any, any, any>;

/** Narrows a tool definition to a write tool. */
export function isWriteTool(tool: AnyToolDefinition): tool is AnyWriteToolDefinition {
  return tool.tier !== "read";
}
