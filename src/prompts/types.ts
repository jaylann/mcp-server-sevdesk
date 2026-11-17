/**
 * Types of the MCP prompts (`src/prompts/catalog.ts`): ready-made bookkeeping workflows a user
 * picks in the client (e.g. `/mcp__sevdesk__month_end_close` in Claude Code).
 *
 * Invariant: a prompt only renders text. Its handler (`prompts/get`) never calls sevDesk. The
 * only reads behind prompts are the suggestions for some of their arguments
 * (`completion/complete`, see `completions.ts`): contact and payment account names, read-only,
 * with an explicit `limit`, cached briefly per account, and only when the read tool behind them is
 * registered.
 */
import type { z } from "zod";

/**
 * @public What `completion/complete` suggests for a prompt argument (`completions.ts`): recent
 * months (`YYYY-MM`), recent months and quarters (`YYYY-Qn`), contact names, or payment account
 * names.
 */
export type CompletionKind = "month" | "period" | "contact" | "checkAccount";

/**
 * @public Clock-derived values a prompt renders with; injectable through the `now` of the
 * renderer.
 */
export interface PromptContext {
  /** Today in Europe/Berlin, `YYYY-MM-DD`. */
  readonly today: string;
}

/**
 * A tool a prompt needs before it is listed: a tool name, or `anyOf` for "at least one of
 * these".
 */
export type ToolRequirement = string | { readonly anyOf: readonly string[] };

/** @public One step of a prompt, before rendering. */
export interface PromptStep<Values> {
  /**
   * Trusted Markdown. Names a tool only in backticks and only if it is listed in `tools` (a unit
   * test checks both directions). Values derive from validated arguments; a raw argument is shown
   * only through `fenceInline`.
   */
  readonly text: string | ((values: Values) => string);
  /** Every tool the text names. The step is shown only when all of them are registered. */
  readonly tools: readonly string[];
  /**
   * What is not available when a tool of the step is missing, e.g. "Booking transactions to
   * documents". Trusted, names no tool; the renderer adds which setting enables it. Without a
   * fallback, the step is left out silently (optional detail, alternatives).
   */
  readonly fallback?: string;
}

/**
 * Prompt arguments: an object of optional strings (MCP prompt arguments are strings), each with
 * a description and a pattern or length check.
 */
export type PromptArgsSchema = z.ZodObject<Record<string, z.ZodOptional<z.ZodString>>>;

/**
 * @public A prompt as written in the catalog; {@link definePrompt} erases its type parameters.
 */
export interface PromptSpec<Args extends PromptArgsSchema, Values> {
  /** snake_case, no `sevdesk_` prefix (clients namespace prompts per server). */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /**
   * The arguments: a non-strict `z.object` of optional, pattern-checked strings (MCP prompt
   * arguments are strings). The SDK validates them before the handler runs and answers invalid
   * ones with InvalidParams; unknown keys are dropped, never echoed.
   */
  readonly args: Args;
  /**
   * What clients may suggest while the user types an argument, by argument name. Data only:
   * `registerPrompts` attaches the completers of one server instance (and so of one account), so
   * no client or account reaches the shared catalog.
   */
  readonly completions?: { readonly [Key in keyof z.output<Args>]?: CompletionKind };
  /** The prompt is listed only when every requirement is met by the registered tools. */
  readonly requires: readonly ToolRequirement[];
  /** Derives the render values (dates, labels) from the validated arguments. */
  readonly resolve: (args: z.output<Args>, context: PromptContext) => Values;
  /** The opening paragraph: what the user wants done. */
  readonly intro: (values: Values) => string;
  readonly steps: readonly PromptStep<Values>[];
}

/**
 * @public The static part of a step: what selection, rendering and the lint need without values.
 */
export interface PromptStepInfo {
  readonly tools: readonly string[];
  readonly fallback?: string;
}

/** @public The rendered texts of one `prompts/get` call, before the steps are filtered. */
export interface PromptContent {
  readonly intro: string;
  /** Index-aligned with {@link PromptDefinition.steps}. */
  readonly steps: readonly string[];
}

/** A prompt of the catalog with its type parameters erased (see {@link definePrompt}). */
export interface PromptDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly args: PromptArgsSchema;
  /** See {@link PromptSpec.completions}; empty when no argument is completed. */
  readonly completions: Readonly<Partial<Record<string, CompletionKind>>>;
  readonly requires: readonly ToolRequirement[];
  readonly steps: readonly PromptStepInfo[];
  /**
   * Renders the texts for `args`, which are parsed again with {@link PromptDefinition.args}
   * (throws a `ZodError` for invalid ones; the SDK has normally refused them already).
   */
  readonly content: (args: unknown, context: PromptContext) => PromptContent;
}

/** Builds a {@link PromptDefinition}, keeping the argument and value types checked in the spec. */
export function definePrompt<Args extends PromptArgsSchema, Values>(
  spec: PromptSpec<Args, Values>,
): PromptDefinition {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    args: spec.args,
    completions: spec.completions ?? {},
    requires: spec.requires,
    steps: spec.steps.map(({ tools, fallback }) =>
      fallback === undefined ? { tools } : { tools, fallback },
    ),
    content: (args, context) => {
      const values = spec.resolve(spec.args.parse(args ?? {}), context);
      return {
        intro: spec.intro(values),
        steps: spec.steps.map((step) =>
          typeof step.text === "string" ? step.text : step.text(values),
        ),
      };
    },
  };
}
