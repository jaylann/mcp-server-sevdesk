/**
 * Small, fully valid tools for exercising the tool framework (registry, errors, results, server
 * wiring) without any real sevDesk logic, plus a stub client that fails loudly when used.
 */
import { z } from "zod";

import { SevdeskError, type SevdeskErrorKind } from "../../src/sevdesk/errors.js";
import type { SevdeskClient } from "../../src/sevdesk/types.js";
import { defineTool } from "../../src/tools/define-tool.js";
import type { AnyToolDefinition, ToolAnnotationSet } from "../../src/tools/types.js";

export const READ_ANNOTATIONS: ToolAnnotationSet = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
export const WRITE_ANNOTATIONS: ToolAnnotationSet = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const COMMIT_ANNOTATIONS: ToolAnnotationSet = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
export const EXTERNAL_ANNOTATIONS: ToolAnnotationSet = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const SEVDESK_ERROR_KINDS = [
  "auth",
  "not_found",
  "validation",
  "rate_limited",
  "server",
  "network",
  "timeout",
  "aborted",
  "blocked",
  "unexpected_response",
] as const satisfies readonly SevdeskErrorKind[];

/** A client whose every method rejects: framework tests must not reach sevDesk. */
export function stubClient(overrides: Partial<SevdeskClient> = {}): SevdeskClient {
  const unexpected = (method: string) => () =>
    Promise.reject(new Error(`stub client: unexpected ${method} call`));
  return {
    request: unexpected("request"),
    list: unexpected("list"),
    listAll: unexpected("listAll"),
    download: unexpected("download"),
    ...overrides,
  };
}

/** What the dummy handlers observed. */
interface DummyProbe {
  /** Names of the tools whose handler ran, in call order. */
  readonly calls: string[];
  /** The signal each `sevdesk_dummy_wait` call received. */
  readonly signals: AbortSignal[];
  /** Resolves once a `sevdesk_dummy_wait` call is waiting for cancellation. */
  readonly waiting: Promise<void>;
}

export interface DummyTools {
  readonly tools: readonly AnyToolDefinition[];
  readonly probe: DummyProbe;
}

/**
 * A fresh set of dummy tools covering every tier and a few toolsets:
 *
 * - `sevdesk_dummy_echo` (read, meta): echoes `text` and `count`;
 * - `sevdesk_dummy_create` (write, contacts), `sevdesk_dummy_finalize` (commit, invoices),
 *   `sevdesk_dummy_send` (external, invoices), `sevdesk_dummy_raw_get` (read, advanced);
 * - `sevdesk_dummy_fail` (read, meta): throws a `SevdeskError` of the given kind, a plain error
 *   carrying the token (`internal`) or an `AbortError` (`abort`);
 * - `sevdesk_dummy_bad_output` (read, meta): returns data that violates its output schema;
 * - `sevdesk_dummy_progress` (read, meta): reports progress, including a non-increasing value;
 * - `sevdesk_dummy_wait` (read, meta): waits until its signal aborts (or 5 s pass).
 */
export function createDummyTools(): DummyTools {
  let markWaiting: () => void = () => undefined;
  const probe: DummyProbe = {
    calls: [],
    signals: [],
    waiting: new Promise<void>((resolve) => {
      markWaiting = resolve;
    }),
  };

  const echo = defineTool({
    name: "sevdesk_dummy_echo",
    title: "Echo (dummy)",
    description: "Echoes the given text back. Test fixture for the tool framework.",
    toolset: "meta",
    tier: "read",
    annotations: READ_ANNOTATIONS,
    input: z.strictObject({
      text: z.string().min(1).describe("Text to echo back."),
      count: z.number().int().min(0).optional().describe("How often; defaults to 1."),
    }),
    output: z.object({ text: z.string(), count: z.number().int() }),
    handler: ({ text, count }) => {
      probe.calls.push("sevdesk_dummy_echo");
      return Promise.resolve({ data: { text, count: count ?? 1 }, summary: "Echoed the text." });
    },
  });

  const create = defineTool({
    name: "sevdesk_dummy_create",
    title: "Create (dummy)",
    description: "Pretends to create a contact. Test fixture for the write tier.",
    toolset: "contacts",
    tier: "write",
    annotations: WRITE_ANNOTATIONS,
    input: z.strictObject({
      name: z.string().min(1),
      dryRun: z.boolean().optional().describe("Preview only."),
    }),
    output: z.object({ id: z.string() }),
    handler: () => {
      probe.calls.push("sevdesk_dummy_create");
      return Promise.resolve({ data: { id: "1" }, summary: "Created contact 1." });
    },
  });

  const finalize = defineTool({
    name: "sevdesk_dummy_finalize",
    title: "Finalize (dummy)",
    description: "Pretends to finalize an invoice. Test fixture for the commit tier.",
    toolset: "invoices",
    tier: "commit",
    annotations: COMMIT_ANNOTATIONS,
    input: z.strictObject({ id: z.string().min(1) }),
    output: z.object({ status: z.string() }),
    handler: () => {
      probe.calls.push("sevdesk_dummy_finalize");
      return Promise.resolve({ data: { status: "open" }, summary: "Finalized the invoice." });
    },
  });

  const send = defineTool({
    name: "sevdesk_dummy_send",
    title: "Send (dummy)",
    description: "Pretends to email an invoice. Test fixture for the external tier.",
    toolset: "invoices",
    tier: "external",
    annotations: EXTERNAL_ANNOTATIONS,
    input: z.strictObject({ id: z.string().min(1) }),
    output: z.object({ sent: z.boolean() }),
    handler: () => {
      probe.calls.push("sevdesk_dummy_send");
      return Promise.resolve({ data: { sent: true }, summary: "Sent the invoice." });
    },
  });

  const rawGet = defineTool({
    name: "sevdesk_dummy_raw_get",
    title: "Raw GET (dummy)",
    description: "Pretends to run a generic GET. Test fixture for the advanced toolset.",
    toolset: "advanced",
    tier: "read",
    annotations: READ_ANNOTATIONS,
    input: z.strictObject({ path: z.string().min(1) }),
    output: z.object({ body: z.string() }),
    handler: () => {
      probe.calls.push("sevdesk_dummy_raw_get");
      return Promise.resolve({ data: { body: "{}" }, summary: "Fetched." });
    },
  });

  const fail = defineTool({
    name: "sevdesk_dummy_fail",
    title: "Fail (dummy)",
    description: "Throws the requested kind of error. Test fixture for error mapping.",
    toolset: "meta",
    tier: "read",
    annotations: READ_ANNOTATIONS,
    input: z.strictObject({
      kind: z.enum([...SEVDESK_ERROR_KINDS, "internal", "abort"]),
      upstream: z.string().optional(),
      exceptionUuid: z.string().optional(),
    }),
    output: z.object({}),
    handler: ({ kind, upstream, exceptionUuid }, ctx) => {
      probe.calls.push("sevdesk_dummy_fail");
      if (kind === "internal") {
        throw new Error(`boom while using token ${ctx.config.token}`);
      }
      if (kind === "abort") {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const status = STATUS_BY_KIND[kind];
      throw new SevdeskError({
        kind,
        message: `Dummy ${kind} failure for GET /Contact/7`,
        ...(status === undefined ? {} : { status }),
        method: "GET",
        path: "/Contact/7",
        ...(upstream === undefined ? {} : { upstreamMessage: upstream }),
        ...(exceptionUuid === undefined ? {} : { exceptionUuid }),
      });
    },
  });

  const badOutput = defineTool({
    name: "sevdesk_dummy_bad_output",
    title: "Bad output (dummy)",
    description: "Returns data that violates its own output schema. Test fixture.",
    toolset: "meta",
    tier: "read",
    annotations: READ_ANNOTATIONS,
    input: z.strictObject({}),
    output: z.object({ text: z.string() }),
    handler: () => {
      probe.calls.push("sevdesk_dummy_bad_output");
      const data = { text: 42 } as unknown as { text: string };
      return Promise.resolve({ data, summary: "Returned malformed data." });
    },
  });

  const progress = defineTool({
    name: "sevdesk_dummy_progress",
    title: "Progress (dummy)",
    description: "Reports progress in three steps. Test fixture for progress notifications.",
    toolset: "meta",
    tier: "read",
    annotations: READ_ANNOTATIONS,
    input: z.strictObject({}),
    output: z.object({ steps: z.number().int() }),
    handler: async (_args, ctx) => {
      probe.calls.push("sevdesk_dummy_progress");
      await ctx.progress(1, 3, "Step one");
      await ctx.progress(1, 3, "Not increasing, dropped");
      await ctx.progress(2, 3);
      await ctx.progress(3, 3, "Done");
      return { data: { steps: 3 }, summary: "Ran three steps." };
    },
  });

  const wait = defineTool({
    name: "sevdesk_dummy_wait",
    title: "Wait (dummy)",
    description: "Waits until the call is cancelled. Test fixture for cancellation plumbing.",
    toolset: "meta",
    tier: "read",
    annotations: READ_ANNOTATIONS,
    input: z.strictObject({}),
    output: z.object({ cancelled: z.boolean() }),
    handler: async (_args, ctx) => {
      probe.calls.push("sevdesk_dummy_wait");
      probe.signals.push(ctx.signal);
      markWaiting();
      const cancelled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, 5_000);
        ctx.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(true);
          },
          { once: true },
        );
      });
      return { data: { cancelled }, summary: cancelled ? "Cancelled." : "Not cancelled." };
    },
  });

  return {
    tools: [echo, create, finalize, send, rawGet, fail, badOutput, progress, wait],
    probe,
  };
}

const STATUS_BY_KIND: Readonly<Record<SevdeskErrorKind, number | undefined>> = {
  auth: 401,
  not_found: 404,
  validation: 422,
  rate_limited: 429,
  server: 500,
  network: undefined,
  timeout: undefined,
  aborted: undefined,
  blocked: undefined,
  unexpected_response: 200,
};
