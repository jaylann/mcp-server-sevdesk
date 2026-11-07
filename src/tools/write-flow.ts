/**
 * The call flow every write tool runs through (see `WriteToolDefinition`):
 *
 * 0. arguments with characters a human would not see (`findHiddenCharacters`; line feeds allowed)
 *    are refused, so what reaches sevDesk is what the human sees;
 * 1. `prepare` with a read-only client: reads, preconditions, the preview (checked against
 *    `previewSchema`, then sanitized for display);
 * 2. dry run (`dryRun: true` or `SEVDESK_DRY_RUN=1`): return the preview, stop. Never asks;
 * 3. `commit`/`external` with `SEVDESK_CONFIRM`:
 *    - `elicit`: ask with an MCP elicitation through the SDK's multi-round-trip flow
 *      (`inputRequired`). The round's signed `requestState` binds tool, argument hash, preview
 *      hash, a single-use nonce and the call id; on the retry `prepare` runs again and the human
 *      is asked again when the preview changed. On 2025-era connections the SDK's legacy shim
 *      sends a real `elicitation/create` and re-enters this flow, so one code path serves both
 *      eras. Clients without form elicitation get an actionable error;
 *    - `browser`: a pending approval on the local approval page (`approval-server.ts`), opened
 *      in the user's browser by the server and logged to stderr; the model only gets a short
 *      reference code, never the page's URL, and calls again with the same arguments after the
 *      human decided;
 *    - `off`: no confirmation (config requires `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`);
 * 4. audit `executing` (fail closed: no line, no request), `execute` with a tier-scoped client,
 *    audit `executed` or `failed`.
 *
 * Results are wrapped as `{status, result?, preview?, approval?}` (`writeOutputSchema`). A
 * `confirm`-style argument never gates anything: approval only ever comes from the client's
 * elicitation answer or the approval page.
 */
import { randomUUID } from "node:crypto";

import {
  type CallToolResult,
  inputRequired,
  type InputRequiredResult,
  inputResponse,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { ApprovalLimitError, type ApprovalTicket } from "../safety/approval-server.js";
import type { AuditApproval, AuditEvent } from "../safety/audit.js";
import { findHiddenCharacters } from "../safety/fence.js";
import { argumentsHash, previewHash } from "../safety/hashing.js";
import { displayPreview, previewSchema, previewText } from "../safety/preview.js";
import { confirmStateSchema } from "../safety/runtime.js";
import { requiresConfirmation, type WriteTier } from "../safety/tiers.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { readOnlyClient, tierScopedClient } from "../sevdesk/scoped-client.js";
import type { ErasedWriteTool, RegistryDeps } from "./registry.js";
import { errorResult, successResult } from "./result.js";
import {
  type HiddenCharacterProblem,
  hiddenCharactersResult,
  outputValidationFailedResult,
  type ToolErrorContext,
} from "./tool-errors.js";
import type { ConfirmationPreview, ToolContext, WritePlan } from "./types.js";
import { DRY_RUN_ARGUMENT } from "./write-input.js";

/** Everything the registry knows about one write call. */
export interface WriteCall {
  readonly request: ServerContext;
  /** The plain context; the flow derives the prepare/execute contexts from it. */
  readonly context: ToolContext;
  readonly deps: RegistryDeps;
  readonly errorContext: ToolErrorContext;
  /**
   * The client capabilities that apply to this request, resolved like the SDK does: the
   * request's `_meta` envelope on the 2026-07-28 era, the `initialize` declaration on a 2025-era
   * connection (`undefined` on per-request legacy instances, which cannot elicit).
   */
  readonly clientCapabilities: unknown;
}

/** What a write call returns to the SDK: a result, or an input request (elicitation round). */
export type WriteCallResult = CallToolResult | InputRequiredResult;

const WRITE_STATUSES = ["done", "dry_run", "approval_pending", "declined"] as const;
type WriteStatus = (typeof WRITE_STATUSES)[number];

/** The `inputRequests` key of the confirmation elicitation. */
const CONFIRM_INPUT_KEY = "confirm";

/** The form the human fills in: one boolean, off by default. */
const APPROVE_FORM_SCHEMA = {
  type: "object" as const,
  properties: {
    approve: {
      type: "boolean" as const,
      title: "Approve this action",
      description:
        "Switch on and submit to let the assistant do exactly what is described above. " +
        "Leave it off, decline or cancel to stop; then nothing is changed.",
      default: false,
    },
  },
  required: ["approve"],
};

const approveAnswerSchema = z.object({ approve: z.literal(true) });

/** Plain words for the confirmed tiers, shown to the human. */
const HUMAN_TIER_TEXT: Readonly<Record<WriteTier, string>> = {
  write: "changes reversible records",
  commit: "legally binding bookkeeping",
  external: "reaches people outside sevDesk",
};

const RECORD_CHANGED_NOTICE =
  "The record changed after you were asked, so this is a new request. Check the details again.";

const approvalSchema = z.object({
  reference: z
    .string()
    .describe("Short code shown on the approval page, so the user can tell which request it is."),
  expiresAt: z.string().describe("When the approval request expires (ISO 8601, UTC)."),
  opened: z
    .boolean()
    .describe(
      "Whether the page was opened in the user's browser; otherwise its link is in the server log.",
    ),
});

const wrappedSchemas = new WeakMap<z.ZodObject, z.ZodObject>();

/**
 * The output schema every write tool advertises: an object with `status` and, depending on it,
 * `result` (the tool's own output, only when `done`), `preview` (dry run, pending approval,
 * declined) and `approval` (pending approval). Built once per tool output schema.
 */
export function writeOutputSchema(output: z.ZodObject): z.ZodObject {
  let schema = wrappedSchemas.get(output);
  if (schema === undefined) {
    schema = z.object({
      status: z
        .enum(WRITE_STATUSES)
        .describe(
          "done: the change was made (see result). dry_run: nothing was sent (see preview). " +
            "approval_pending: the user must approve on the approval page (see approval), then " +
            "call the tool again with the same arguments. declined: the user did not approve; " +
            "nothing was changed.",
        ),
      result: output.optional().describe("The changed record; only when status is done."),
      preview: previewSchema.optional().describe("What the call does or would do."),
      approval: approvalSchema.optional(),
    });
    wrappedSchemas.set(output, schema);
  }
  return schema;
}

/** Runs one call of a write tool. Throws like a handler; the registry maps errors. */
export async function runWriteTool(
  tool: ErasedWriteTool,
  args: unknown,
  call: WriteCall,
): Promise<WriteCallResult> {
  const { deps, context } = call;
  const parsed = args as Readonly<Record<string, unknown>>;
  // Before anything else, dry runs included: text the human cannot see must not reach sevDesk.
  const hidden = hiddenCharacterProblems(parsed, []);
  if (hidden.length > 0) {
    return hiddenCharactersResult(tool.name, hidden);
  }
  const dryRun = deps.config.dryRun || parsed[DRY_RUN_ARGUMENT] === true;
  const argsHash = argumentsHash(tool.name, parsed);

  const plan = await tool.prepare(args, {
    ...context,
    client: readOnlyClient(context.client, dryRun ? "running a dry run" : "preparing a write"),
  });
  const checked = previewSchema.safeParse(plan.preview);
  if (!checked.success) {
    return outputValidationFailedResult(call.errorContext, checked.error);
  }
  const action: Action = {
    tool,
    call,
    args,
    plan,
    argsHash,
    previewHash: previewHash(plan.preview),
    preview: displayPreview(plan.preview),
  };

  if (dryRun) {
    await audit(action, {
      event: "dry_run",
      callId: randomUUID(),
      preview: action.preview,
      previewHash: action.previewHash,
    });
    return wrapped(action, "dry_run", dryRunSummary(action));
  }
  if (!requiresConfirmation(tool.tier)) {
    return execute(action, randomUUID(), "not_required");
  }
  switch (deps.config.confirm) {
    case "off":
      return execute(action, randomUUID(), "confirmation_off");
    case "elicit": {
      const decision = await confirmByElicitation(action);
      return decision.approved ? execute(action, decision.callId, "elicit") : decision.result;
    }
    case "browser": {
      const decision = await confirmByBrowser(action);
      return decision.approved ? execute(action, decision.callId, "browser") : decision.result;
    }
  }
}

/** One write call after `prepare`: what the confirmation and the execution work with. */
interface Action {
  readonly tool: ErasedWriteTool;
  readonly call: WriteCall;
  readonly args: unknown;
  readonly plan: WritePlan<unknown>;
  readonly argsHash: string;
  readonly previewHash: string;
  /** Sanitized for display. */
  readonly preview: ConfirmationPreview;
}

type Decision =
  | { readonly approved: true; readonly callId: string }
  | { readonly approved: false; readonly result: WriteCallResult };

function stop(result: WriteCallResult): Decision {
  return { approved: false, result };
}

/**
 * Every string in the (validated) arguments, recursively, that contains characters a human would
 * not see in the preview, the approval page or the audit log (`findHiddenCharacters`; line feeds
 * are allowed). Such text would be sent to sevDesk as it is while the human approves a cleaned-up
 * version, so the flow refuses it.
 */
function hiddenCharacterProblems(value: unknown, path: PropertyKey[]): HiddenCharacterProblem[] {
  if (typeof value === "string") {
    const codePoints = findHiddenCharacters(value, { allowNewlines: true });
    return codePoints.length === 0 ? [] : [{ path, codePoints }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index) => hiddenCharacterProblems(item, [...path, index]));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      hiddenCharacterProblems(item, [...path, key]),
    );
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Elicitation
// ---------------------------------------------------------------------------------------------

async function confirmByElicitation(action: Action): Promise<Decision> {
  const { tool, call } = action;
  const { nonces } = call.deps.safety;
  const rawState = call.request.mcpReq.requestState();
  if (rawState === undefined) {
    if (!supportsFormElicitation(call.clientCapabilities)) {
      return stop(errorResult(noElicitationText(tool.name)));
    }
    return stop(await askByElicitation(action, randomUUID(), undefined));
  }

  // The SDK verified the HMAC before entering (`requestState.verify`); a string here means no
  // verifier was wired, which is refused like any malformed state.
  const state = confirmStateSchema.safeParse(rawState);
  if (!state.success || state.data.tool !== tool.name || state.data.argsHash !== action.argsHash) {
    await audit(action, {
      event: "confirmation_refused",
      callId: state.success ? state.data.callId : randomUUID(),
      reason: "mismatch",
    });
    return stop(errorResult(mismatchText(tool.name)));
  }
  if (!nonces.consume(state.data.nonce)) {
    await audit(action, {
      event: "confirmation_refused",
      callId: state.data.callId,
      reason: "replayed_or_expired",
    });
    return stop(errorResult(replayText(tool.name)));
  }
  const { callId } = state.data;
  const answer = inputResponse(call.request.mcpReq.inputResponses, CONFIRM_INPUT_KEY);
  if (answer.kind !== "elicit") {
    // The retry carried no usable answer (a client bug or a dropped, wrapped response): ask again.
    return stop(await askByElicitation(action, callId, undefined));
  }
  const approved =
    answer.action === "accept" && approveAnswerSchema.safeParse(answer.content).success;
  if (!approved) {
    await audit(action, { event: "declined", callId });
    return stop(declinedResult(action));
  }
  if (state.data.previewHash !== action.previewHash) {
    return stop(await askByElicitation(action, callId, RECORD_CHANGED_NOTICE));
  }
  return { approved: true, callId };
}

async function askByElicitation(
  action: Action,
  callId: string,
  notice: string | undefined,
): Promise<InputRequiredResult> {
  const { tool, call } = action;
  const { codec, nonces } = call.deps.safety;
  const requestState = await codec.mint(
    {
      v: 1,
      tool: tool.name,
      argsHash: action.argsHash,
      previewHash: action.previewHash,
      nonce: nonces.issue(),
      callId,
    },
    call.request,
  );
  await audit(action, {
    event: "confirmation_requested",
    callId,
    preview: action.preview,
    previewHash: action.previewHash,
  });
  return inputRequired({
    inputRequests: {
      [CONFIRM_INPUT_KEY]: inputRequired.elicit({
        message: elicitationMessage(action, notice),
        requestedSchema: APPROVE_FORM_SCHEMA,
      }),
    },
    requestState,
  });
}

/**
 * The confirmation text: an optional notice, the sanitized preview ("Label: value" facts,
 * warnings, "This cannot be undone." when irreversible) and which tool asks.
 */
function elicitationMessage(
  action: Pick<Action, "tool" | "preview">,
  notice: string | undefined,
): string {
  const { tool } = action;
  const blocks = [
    ...(notice === undefined ? [] : [notice]),
    "Your AI assistant wants to make this change in sevDesk:",
    previewText(action.preview),
    `Tool: ${tool.name} (${HUMAN_TIER_TEXT[tool.tier]}). Nothing happens unless you approve.`,
  ];
  return blocks.join("\n\n");
}

/**
 * Whether declared client capabilities cover a form-mode elicitation: `elicitation.form`, or a
 * bare `elicitation: {}` (the 2025 meaning), as the SDK's own capability gate reads them.
 */
function supportsFormElicitation(capabilities: unknown): boolean {
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const elicitation: unknown = (capabilities as Record<string, unknown>)["elicitation"];
  if (typeof elicitation !== "object" || elicitation === null) return false;
  const modes = elicitation as Record<string, unknown>;
  return modes["form"] !== undefined || modes["url"] === undefined;
}

// ---------------------------------------------------------------------------------------------
// Browser approval
// ---------------------------------------------------------------------------------------------

async function confirmByBrowser(action: Action): Promise<Decision> {
  const { tool, call } = action;
  const { approvals } = call.deps.safety;
  const existing = approvals.current(tool.name, action.argsHash);
  if (existing === undefined) {
    return stop(await requestBrowserApproval(action, randomUUID(), undefined));
  }
  if (existing.status === "pending") {
    if (existing.previewHash === action.previewHash) {
      return stop(pendingResult(action, existing, false));
    }
    return stop(await requestBrowserApproval(action, existing.callId, RECORD_CHANGED_NOTICE));
  }
  // Decided: take it now (single use), with no await since `current`, so no other call can. If
  // it expired in between, it is gone: ask again rather than act on the stale snapshot.
  const taken = approvals.take(existing.id);
  if (taken === undefined) {
    return stop(await requestBrowserApproval(action, existing.callId, undefined));
  }
  if (taken.status === "rejected") {
    await audit(action, { event: "declined", callId: taken.callId });
    return stop(declinedResult(action));
  }
  if (taken.previewHash !== action.previewHash) {
    return stop(await requestBrowserApproval(action, taken.callId, RECORD_CHANGED_NOTICE));
  }
  return { approved: true, callId: taken.callId };
}

async function requestBrowserApproval(
  action: Action,
  callId: string,
  notice: string | undefined,
): Promise<CallToolResult> {
  const { tool, call } = action;
  let ticket;
  try {
    ticket = await call.deps.safety.approvals.create({
      toolName: tool.name,
      toolTitle: tool.title,
      tier: tool.tier,
      tierText: HUMAN_TIER_TEXT[tool.tier],
      argsHash: action.argsHash,
      previewHash: action.previewHash,
      preview: action.preview,
      callId,
      ...(notice === undefined ? {} : { notice }),
    });
  } catch (error) {
    if (error instanceof ApprovalLimitError) {
      return errorResult(
        `${tool.name} needs the user's approval, but ${String(error.limit)} approval requests are ` +
          "already waiting in the user's browser. Ask the user to approve or reject those first " +
          "(or wait until they expire, at most 10 minutes), then call the tool again. Nothing " +
          "was sent to sevDesk.",
      );
    }
    logToStderr(tool.name, `approval page could not be started: ${errorCode(error)}`);
    return errorResult(
      `${tool.name} needs the user's approval, but the local approval page could not be started ` +
        "(see the server log). Nothing was sent to sevDesk. Tell the user; they can retry or " +
        "switch SEVDESK_CONFIRM to elicit if their client supports confirmation prompts.",
    );
  }
  await audit(action, {
    event: "confirmation_requested",
    callId,
    preview: action.preview,
    previewHash: action.previewHash,
    reference: ticket.reference,
  });
  return pendingResult(action, ticket, notice !== undefined);
}

/**
 * The `approval_pending` result. It carries the non-secret reference code, never the page URL
 * (a capability): the server opened the page itself or wrote the link to its log.
 */
function pendingResult(action: Action, ticket: ApprovalTicket, changed: boolean): CallToolResult {
  const { reference, expiresAt, opened } = ticket;
  const where = opened
    ? `An approval page was opened in the user's browser (reference ${reference}). Ask the user ` +
      "to approve or reject it there"
    : `The approval page (reference ${reference}) could not be opened in the user's browser; ` +
      "its link is in the MCP server's log (stderr). Ask the user to open it from there and " +
      "approve or reject it";
  const summary =
    (changed ? "The record changed since the last approval request, so it needs a new one. " : "") +
    `Nothing has been changed yet. ${where}, then call ${action.tool.name} again with exactly ` +
    `the same arguments before ${expiresAt}.`;
  return wrapped(action, "approval_pending", summary, { reference, expiresAt, opened });
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

async function execute(
  action: Action,
  callId: string,
  approval: AuditApproval,
): Promise<CallToolResult> {
  const { tool, call } = action;
  const { context } = call;
  try {
    await call.deps.safety.audit.record(
      auditEvent(action, { event: "executing", callId, approval, previewHash: action.previewHash }),
    );
  } catch (error) {
    logToStderr(tool.name, `audit log: could not write the executing line: ${errorCode(error)}`);
    return errorResult(
      `${tool.name} was not run: the audit log (SEVDESK_AUDIT_LOG) could not be written, and ` +
        "changes are only made when they can be logged. Nothing was sent to sevDesk. Ask the " +
        "user to check the audit log path and its permissions.",
    );
  }

  let output;
  try {
    output = await tool.execute(action.args, action.plan, {
      ...context,
      client: tierScopedClient(context.client, tool.tier),
    });
  } catch (error) {
    await audit(action, {
      event: "failed",
      callId,
      error: errorKind(error),
      affected: error instanceof SevdeskError ? error.completedWrites : [],
    });
    throw error;
  }
  const data = await tool.output.safeParseAsync(output.data);
  if (!data.success) {
    await audit(action, {
      event: "failed",
      callId,
      error: "output_invalid",
      affected: output.affected ?? [],
    });
    return outputValidationFailedResult(call.errorContext, data.error, { changedData: true });
  }
  await audit(action, { event: "executed", callId, affected: output.affected ?? [] });
  return wrapped(action, "done", output.summary, undefined, data.data, output.extraContent);
}

// ---------------------------------------------------------------------------------------------
// Results, audit
// ---------------------------------------------------------------------------------------------

function wrapped(
  action: Action,
  status: WriteStatus,
  summary: string,
  approval?: { readonly reference: string; readonly expiresAt: string; readonly opened: boolean },
  result?: unknown,
  extraContent?: Parameters<typeof successResult>[0]["extraContent"],
): CallToolResult {
  const data =
    status === "done"
      ? { status, result }
      : { status, preview: action.preview, ...(approval === undefined ? {} : { approval }) };
  return successResult(
    { summary, data, ...(extraContent === undefined ? {} : { extraContent }) },
    { structured: action.call.deps.structuredOutput },
  );
}

function declinedResult(action: Action): CallToolResult {
  return wrapped(
    action,
    "declined",
    "The user did not approve this action, so nothing was changed in sevDesk. Do not call " +
      `${action.tool.name} again for it unless the user asks you to.`,
  );
}

function dryRunSummary(action: Action): string {
  const asks =
    requiresConfirmation(action.tool.tier) && action.call.deps.config.confirm !== "off"
      ? " (the user will be asked to approve it)"
      : "";
  return (
    `Dry run: nothing was sent to sevDesk. The preview shows what ${action.tool.name} would do; ` +
    `call it without dryRun to make the change${asks}.`
  );
}

function noElicitationText(toolName: string): string {
  return (
    `${toolName} needs the user's approval, but this MCP client cannot show confirmation ` +
    "prompts (it does not support MCP elicitation). Nothing was sent to sevDesk. Tell the user: " +
    "to use this tool, set SEVDESK_CONFIRM=browser in the server configuration (approval on a " +
    "local web page) and restart the server, or use a client that supports elicitation. " +
    "dryRun: true still previews the change."
  );
}

function mismatchText(toolName: string): string {
  return (
    "This confirmation belongs to a different call (another tool or other arguments), so it " +
    `was not accepted. Nothing was sent to sevDesk. Call ${toolName} again to ask the user afresh.`
  );
}

function replayText(toolName: string): string {
  return (
    "This confirmation was already used or has expired, so it was not accepted again. Nothing " +
    `was sent to sevDesk. If the user still wants the action, call ${toolName} again to ask afresh.`
  );
}

type EventFields = Pick<AuditEvent, "event" | "callId"> &
  Partial<
    Pick<
      AuditEvent,
      "approval" | "preview" | "previewHash" | "affected" | "error" | "reason" | "reference"
    >
  >;

function auditEvent(action: Action, fields: EventFields): AuditEvent {
  return {
    ...fields,
    tool: action.tool.name,
    tier: action.tool.tier,
    argsHash: action.argsHash,
    args: action.args,
  };
}

/** Best-effort audit line (everything except `executing`): a failure is logged, not fatal. */
async function audit(action: Action, fields: EventFields): Promise<void> {
  try {
    await action.call.deps.safety.audit.record(auditEvent(action, fields));
  } catch (error) {
    logToStderr(
      action.tool.name,
      `audit log: could not write the ${fields.event} line: ${errorCode(error)}`,
    );
  }
}

function errorKind(error: unknown): string {
  if (error instanceof SevdeskError) return error.kind;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "internal";
}

/** A short, path- and token-free reason for stderr (`code` of system errors). */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.name : "unknown error";
}

function logToStderr(toolName: string, message: string): void {
  console.error(`mcp-server-sevdesk: ${toolName}: ${message}`);
}
