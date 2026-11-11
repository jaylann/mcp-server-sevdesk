import type { ResourceLink } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { Config } from "../config.js";
import type { FileAccess } from "../safety/file-access.js";
import type { WriteTier } from "../safety/tiers.js";
import type { ConfirmationPreview, SevdeskObjectRef } from "../safety/write-types.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import type { ToolsetName } from "./toolsets.js";

// The record a write changes and the preview a human confirms are defined in `src/safety/`, which
// `src/domain/` and `src/safety/` may import; tool authors keep importing them from here.
export type { ConfirmationPreview, SevdeskObjectRef } from "../safety/write-types.js";

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
  /**
   * The only way a tool reads or hands out files: local folders, or uploads and download links
   * of the calling principal in HTTP mode. Built per call by the registry.
   */
  readonly files: FileAccess;
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

/**
 * A lock key (see `WriteToolDefinition.locks`) for all of an account's bookings: tools that book
 * or undo payments take it besides their own records, so they run one at a time per account. A
 * transaction reset only learns which documents it unbooks by reading, so per-record keys alone
 * let a payment on one of them interleave with it and be erased (security review 2026-11, wave 2).
 */
export const ACCOUNT_BOOKINGS: SevdeskObjectRef = { objectName: "Bookings", id: "account" };

/**
 * A lock key for an account's credit note number range: every tool that gives a new credit note
 * a number takes it. `createFromInvoice` hands out the counter's current value without advancing
 * it (`src/domain/drafts/numbering.ts`), so two creations that interleave, also from different
 * invoices, got the same number before either moved the counter on (review 2026-11, round 3).
 */
export const ACCOUNT_CREDIT_NOTE_NUMBERS: SevdeskObjectRef = {
  objectName: "CreditNoteNumbers",
  id: "account",
};

/**
 * A lock key for an account's customer numbers (Kundennummern): creating a contact and setting a
 * contact's customer number check first that the number (and, on create, the name and e-mail) is
 * not in use, then write. Two such calls at once both passed the check (review 2026-11, round 3).
 */
export const ACCOUNT_CONTACT_NUMBERS: SevdeskObjectRef = {
  objectName: "ContactNumbers",
  id: "account",
};

/** The same for part numbers (Artikelnummern): creating a part, or giving one another number. */
export const ACCOUNT_PART_NUMBERS: SevdeskObjectRef = { objectName: "PartNumbers", id: "account" };

/**
 * A lock key for creating voucher drafts in an account: a new voucher is refused when one with
 * the same supplier, number, date and gross exists already, then it is created. Two identical
 * creations at once both passed that check and left two drafts (review 2026-11, round 3).
 */
export const ACCOUNT_VOUCHER_DRAFTS: SevdeskObjectRef = {
  objectName: "VoucherDrafts",
  id: "account",
};

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

/** The result of {@link WriteToolDefinition.prepare}. */
export interface WritePlan<S> {
  /** English: what the model, dry runs, the audit log and a client's own prompt show. */
  readonly preview: ConfirmationPreview;
  /**
   * The same preview in German, for the approval pages (`src/domain/preview-text.ts`; build both
   * with `bothPreviews`). Required by type for `commit` and `external` tools (see
   * {@link WriteToolDefinition.prepare}); other tiers never reach a page. It must have as many
   * facts and warnings as `preview` and the same `irreversible`: the flow refuses a pair that
   * differs, and an approval covers both texts.
   */
  readonly previewDe?: ConfirmationPreview;
  /**
   * A digest of content the action depends on but the preview does not show in full (e.g. a
   * document's printed texts, address and positions, see `documentBinding`). The approval covers
   * it together with the previews: when it changes between the confirmation and the approved
   * retry, the human is asked again instead of the action running on content nobody approved.
   */
  readonly binding?: string;
  /**
   * Whatever `execute` needs from the reads `prepare` made (e.g. the current invoice, the
   * resolved contact person), so `execute` does not read it again. Not shown to anyone.
   */
  readonly state: S;
}

/** What `prepare` must add for tier `T`: the German preview when a human confirms the tool. */
type PlanExtra<T extends WriteTier> = T extends "write"
  ? unknown
  : { readonly previewDe: ConfirmationPreview };

/**
 * The plan `prepare` returns for a tool of tier `T`: a {@link WritePlan}, with `previewDe`
 * required for `commit` and `external`.
 */
export type WritePlanOf<S, T extends WriteTier> = WritePlan<S> & PlanExtra<T>;

export type ToolInputSchema = z.ZodObject;
export type ToolOutputSchema = z.ZodObject;

/** The configuration slice that decides which tools a server registers. */
export type ToolSelectionConfig = Pick<
  Config,
  "toolsets" | "allowedTiers" | "outputDir" | "fileDirs" | "deployment"
>;

/**
 * @public Named for tool authors; `localEffects` takes these values.
 *
 * Effects of a tool outside sevDesk, on files (see `ToolDefinitionBase.localEffects`). All go only
 * through `ToolContext.files` ({@link FileAccess}, `src/safety/file-sources.ts`).
 * - `"reads-files"`: reads files: inside `SEVDESK_FILE_DIRS` (`readConfinedFile`) or, over HTTP
 *   with file transfer, the caller's own uploads. Reading changes nothing, so a `read` tool with
 *   this flag stays `readOnlyHint: true`.
 * - `"writes-files"`: hands files out: new files inside `SEVDESK_OUTPUT_DIR` (`writeNewFile`,
 *   never overwriting) or, over HTTP with file transfer, download links of the caller's account.
 *   A `read` tool with this flag changes nothing in sevDesk but does modify its environment, so
 *   it must set `readOnlyHint: false` (and stays non-destructive: it never overwrites).
 * - `"opens-upload"`: opens an upload page on this server (`requestUpload`: a ticket in the
 *   transfer store, of which an account holds only a few at a time). Like a download link it
 *   changes the server's state and nothing in sevDesk, so a `read` tool with this flag must set
 *   `readOnlyHint: false` too (review 2026-11, round 3).
 */
export type LocalEffect = "reads-files" | "writes-files" | "opens-upload";

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
   * Extra registration condition on top of toolset and tier, e.g. "files can be delivered"
   * (`canDeliverFiles`).
   * A tool for which it returns false is not registered (see `selectTools`).
   */
  readonly available?: (config: ToolSelectionConfig) => boolean;
  /**
   * Declared effects on the local machine (see {@link LocalEffect}). Required for every tool that
   * reads or writes local files or opens an upload page; the metadata lint keeps the reviewed
   * list of such tools. A `read` tool may set `readOnlyHint: false` only together with
   * `"writes-files"` or `"opens-upload"`, and then must (checked by `validateToolDefinition`).
   */
  readonly localEffects?: LocalEffect;
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
  readonly handler: (args: z.output<I>, ctx: ToolContext) => Promise<ToolOutput<z.output<O>>>;
}

/**
 * A tool that changes something in sevDesk. Declared with `defineWriteTool`. Its input must
 * include `dryRunInputShape` (`src/tools/write-input.ts`).
 *
 * The framework (`src/tools/write-flow.ts`) runs every call as:
 * 1. validate the arguments;
 * 2. `prepare` with a read-only client: reads, checks preconditions, builds the preview (in
 *    English, and for `commit`/`external` also in German for the approval pages);
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
  T extends WriteTier = WriteTier,
> extends ToolDefinitionBase<I, O> {
  readonly tier: T;
  /**
   * Reads what the action needs and decides whether it is possible. When it is not (wrong
   * status, amount above the open amount, unknown tax rule …), throws a `SevdeskError` of kind
   * `validation` with a trusted, actionable message; nothing was sent. Must follow the
   * determinism rule of {@link ConfirmationPreview}. A `commit` or `external` tool (tier `T`)
   * must return `previewDe` as well: it does not compile without it.
   */
  readonly prepare: (args: z.output<I>, ctx: PrepareContext) => Promise<WritePlanOf<S, T>>;
  /**
   * The records whose state `prepare` checks and `execute` changes in a way that must not
   * interleave with another call (e.g. a payment's document and bank transaction: the open
   * amount is checked, then booked). Calls of the same account that share a record run one at a
   * time, from `prepare` to the end of `execute` (`RecordLocks`), so the second one reads what the
   * first one booked. Besides records, a key can stand for something account-wide that is
   * checked and then taken, e.g. a number range ({@link ACCOUNT_CREDIT_NOTE_NUMBERS}). Omit only
   * for tools whose checks do not depend on such state: the metadata lint
   * (`test/integration/metadata-lint.test.ts`) lists every write tool without locks with its
   * reason.
   */
  readonly locks?: (args: z.output<I>) => readonly SevdeskObjectRef[];
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
