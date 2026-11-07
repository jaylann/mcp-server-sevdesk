/**
 * Small, fully valid tools for exercising the tool framework (registry, errors, results, server
 * wiring) without any real sevDesk logic, plus a stub client that fails loudly when used.
 */
import { z } from "zod";

import { SevdeskError, type SevdeskErrorKind } from "../../src/sevdesk/errors.js";
import type { SevdeskClient } from "../../src/sevdesk/types.js";
import { defineTool, defineWriteTool } from "../../src/tools/define-tool.js";
import {
  type AnyToolDefinition,
  type AnyWriteToolDefinition,
  isWriteTool,
  type ToolAnnotationSet,
  type ToolContext,
} from "../../src/tools/types.js";
import { dryRunInputShape } from "../../src/tools/write-input.js";
import type { WriteToolCase } from "./write-cases.js";

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

/** What the dummy commit/external tools read in `prepare` (`GET /Invoice/{id}`). */
interface DummyInvoice {
  readonly invoiceNumber: string;
  readonly contactName: string;
  readonly sumGross: string;
}

async function readDummyInvoice(ctx: ToolContext, id: number): Promise<DummyInvoice> {
  const objects = await ctx.client.request({ method: "GET", path: `/Invoice/${id}` });
  const [invoice] = objects as DummyInvoice[];
  if (invoice === undefined) {
    throw new SevdeskError({ kind: "not_found", message: `Invoice ${id} does not exist.` });
  }
  return invoice;
}

/** A dummy invoice body for `GET /Invoice/{id}` routes. */
export function dummyInvoiceBody(overrides: Partial<DummyInvoice> = {}): unknown {
  return {
    objects: [
      { invoiceNumber: "RE-1042", contactName: "Muster GmbH", sumGross: "1190.00", ...overrides },
    ],
  };
}

/**
 * Write-tool cases (see `WriteToolCase`) for the dummy write tools of `dummies`, so the generic
 * safety tests cover every tier even before real tools exist.
 */
export function dummyWriteCases(dummies: DummyTools): WriteToolCase[] {
  const tool = (name: string): AnyWriteToolDefinition => {
    const found = dummies.tools.find((candidate) => candidate.name === name);
    if (found === undefined || !isWriteTool(found)) throw new Error(`no dummy write tool ${name}`);
    return found;
  };
  const invoice = { path: "/Invoice/7", response: { body: dummyInvoiceBody() } } as const;
  return [
    {
      label: "dummy: create a contact (write)",
      tool: tool("sevdesk_dummy_create"),
      args: { name: "Muster GmbH" },
      routes: [{ method: "POST", path: "/Contact", response: { body: { objects: { id: "1" } } } }],
      writes: [{ method: "POST", path: "/Contact" }],
    },
    {
      label: "dummy: finalize an invoice (commit)",
      tool: tool("sevdesk_dummy_finalize"),
      args: { id: 7 },
      routes: [
        invoice,
        { method: "PUT", path: "/Invoice/7/sendBy", response: { body: { objects: { id: "7" } } } },
      ],
      writes: [{ method: "PUT", path: "/Invoice/7/sendBy" }],
    },
    {
      label: "dummy: email an invoice (external)",
      tool: tool("sevdesk_dummy_send"),
      args: { id: 7 },
      routes: [
        invoice,
        {
          method: "POST",
          path: "/Invoice/7/sendViaEmail",
          response: { body: { objects: { id: "7" } } },
        },
      ],
      writes: [{ method: "POST", path: "/Invoice/7/sendViaEmail" }],
    },
  ];
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
 * - `sevdesk_dummy_create` (write, contacts: `POST /Contact`), `sevdesk_dummy_finalize`
 *   (commit, invoices: reads `GET /Invoice/{id}` for its preview, then `PUT …/sendBy`) and
 *   `sevdesk_dummy_send` (external, invoices: same read, then `POST …/sendViaEmail`); see
 *   {@link dummyWriteCases};
 * - `sevdesk_dummy_raw_get` (read, advanced);
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

  const create = defineWriteTool({
    name: "sevdesk_dummy_create",
    title: "Create (dummy)",
    description: "Pretends to create a contact. Test fixture for the write tier.",
    toolset: "contacts",
    tier: "write",
    annotations: WRITE_ANNOTATIONS,
    input: z.strictObject({ name: z.string().min(1), ...dryRunInputShape }),
    output: z.object({ id: z.string() }),
    prepare: ({ name }) =>
      Promise.resolve({
        preview: {
          action: "Create a contact.",
          facts: [{ label: "Name", value: name }],
          warnings: [],
          irreversible: false,
        },
        state: null,
      }),
    execute: async ({ name }, _plan, ctx) => {
      probe.calls.push("sevdesk_dummy_create");
      await ctx.client.request({ method: "POST", path: "/Contact", body: { name } });
      return {
        data: { id: "1" },
        summary: "Created contact 1.",
        affected: [{ objectName: "Contact", id: "1" }],
      };
    },
  });

  const finalize = defineWriteTool({
    name: "sevdesk_dummy_finalize",
    title: "Finalize (dummy)",
    description: "Pretends to finalize an invoice. Test fixture for the commit tier.",
    toolset: "invoices",
    tier: "commit",
    annotations: COMMIT_ANNOTATIONS,
    input: z.strictObject({ id: z.number().int().positive(), ...dryRunInputShape }),
    output: z.object({ status: z.string() }),
    prepare: async ({ id }, ctx) => {
      const invoice = await readDummyInvoice(ctx, id);
      return {
        preview: {
          action: `Finalize invoice ${invoice.invoiceNumber} and mark it as sent.`,
          facts: [
            { label: "Customer", value: invoice.contactName },
            { label: "Total (gross)", value: `${invoice.sumGross} EUR` },
          ],
          warnings: ["The invoice becomes legally binding."],
          irreversible: false,
        },
        state: invoice,
      };
    },
    execute: async ({ id }, _plan, ctx) => {
      probe.calls.push("sevdesk_dummy_finalize");
      await ctx.client.request({ method: "PUT", path: `/Invoice/${id}/sendBy`, body: {} });
      return {
        data: { status: "open" },
        summary: "Finalized the invoice.",
        affected: [{ objectName: "Invoice", id: String(id) }],
      };
    },
  });

  const send = defineWriteTool({
    name: "sevdesk_dummy_send",
    title: "Send (dummy)",
    description: "Pretends to email an invoice. Test fixture for the external tier.",
    toolset: "invoices",
    tier: "external",
    annotations: EXTERNAL_ANNOTATIONS,
    input: z.strictObject({ id: z.number().int().positive(), ...dryRunInputShape }),
    output: z.object({ sent: z.boolean() }),
    prepare: async ({ id }, ctx) => {
      const invoice = await readDummyInvoice(ctx, id);
      return {
        preview: {
          action: `Email invoice ${invoice.invoiceNumber} to the customer.`,
          facts: [{ label: "Customer", value: invoice.contactName }],
          warnings: [],
          irreversible: true,
        },
        state: invoice,
      };
    },
    execute: async ({ id }, _plan, ctx) => {
      probe.calls.push("sevdesk_dummy_send");
      await ctx.client.request({
        method: "POST",
        path: `/Invoice/${id}/sendViaEmail`,
        body: { toEmail: "kunde@example.com" },
      });
      return {
        data: { sent: true },
        summary: "Sent the invoice.",
        affected: [{ objectName: "Invoice", id: String(id) }],
      };
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
