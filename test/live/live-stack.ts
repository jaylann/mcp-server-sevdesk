/**
 * The real stack for live tests: `loadConfig` from a whitelisted environment, the real sevDesk
 * client, the shipped server factory, and an MCP client connected in process through the
 * stateless HTTP handler (as `test/helpers/connect.ts` does). Only `pnpm test:live` runs this.
 */
import type { Client } from "@modelcontextprotocol/client";
import { expect } from "vitest";
import type { ZodType } from "zod";

import { type Config, loadConfig } from "../../src/config.js";
import { createServerFactory } from "../../src/server.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import type { SevdeskClient } from "../../src/sevdesk/types.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { connectFactory } from "../helpers/connect.js";

export interface LiveStack {
  readonly mcp: Client;
  readonly config: Config;
  readonly sevdesk: SevdeskClient;
  close(): Promise<void>;
}

/** Builds and connects the stack for `env` (from `readOnlyEnv` or `writeEnv`). */
export async function connectLive(env: Readonly<Record<string, string>>): Promise<LiveStack> {
  const config = loadConfig(env);
  const sevdesk = createSevdeskClient(config);
  const mcp = await connectFactory(createServerFactory({ config, client: sevdesk }));
  return { mcp, config, sevdesk, close: () => mcp.close() };
}

export interface ToolCall {
  readonly isError: boolean;
  /** `structuredContent`, or the JSON after the summary in the text block. */
  readonly data: unknown;
  /** The text block, for error messages. */
  readonly text: string;
}

/** Calls a tool and returns its data; never throws for `isError` results. */
export async function callTool(
  mcp: Client,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<ToolCall> {
  const result = await mcp.callTool({ name, arguments: { ...args } });
  const content = Array.isArray(result.content)
    ? (result.content as { type: string; text?: string }[])
    : [];
  const text = content.find((block) => block.type === "text")?.text ?? "";
  return {
    isError: result.isError === true,
    data: result.structuredContent ?? jsonAfterSummary(text),
    text,
  };
}

/** Like {@link callTool}, but fails the test on `isError` (with the tool's own message). */
export async function callOk(
  mcp: Client,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
  const call = await callTool(mcp, name, args);
  expect(call.isError, `${name} failed: ${call.text}`).toBe(false);
  return call.data;
}

/** Validates `data` against the shipped tool's output schema. */
export function expectValidOutput(name: string, data: unknown): void {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
  expect(tool, `${name} is not a shipped tool`).toBeDefined();
  const output = tool?.output as ZodType | undefined;
  const parsed = output?.safeParse(data);
  expect(parsed?.success, `${name} output: ${parsed?.error?.message ?? ""}`).toBe(true);
}

function jsonAfterSummary(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start)) as unknown;
  } catch {
    return undefined;
  }
}

type Json = Readonly<Record<string, unknown>>;

/** `items` of a list tool's output. */
export function itemsOf(data: unknown): Json[] {
  const items = (data as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? (items as Json[]) : [];
}

/** The `status.code` of a DTO. */
export function statusCode(row: Json | undefined): number | undefined {
  const status = row?.["status"] as { code?: unknown } | undefined;
  return typeof status?.code === "number" ? status.code : undefined;
}

/**
 * Finds the id of the record a write tool reports: `affected` (if the output carries it), a
 * member named after one of `keys` (an object with `id`, or a number such as
 * `cancellationInvoiceId`), searched breadth-first through wrappers, then a top-level `id`.
 * Write tools answer `{status: "done", result: {invoice: …}}` (cancel adds
 * `cancellationInvoiceId`, reminders `reminder`), so the search goes through the wrapper.
 */
export function findId(
  data: unknown,
  objectName: string,
  keys: readonly string[],
): number | undefined {
  const queue: unknown[] = [data];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || typeof node !== "object") continue;
    const record = node as Json;
    const affected = record["affected"];
    if (Array.isArray(affected)) {
      const match = (affected as Json[]).find((ref) => ref["objectName"] === objectName);
      const id = Number(match?.["id"]);
      if (Number.isSafeInteger(id) && id > 0) return id;
    }
    for (const key of keys) {
      const member = record[key];
      if (typeof member === "number" && Number.isSafeInteger(member)) return member;
      const id = Number((member as Json | undefined)?.["id"]);
      if (member !== null && typeof member === "object" && Number.isSafeInteger(id) && id > 0)
        return id;
    }
    queue.push(...Object.values(record).filter((value) => typeof value === "object"));
  }
  const top = Number((data as Json | undefined)?.["id"]);
  return Number.isSafeInteger(top) && top > 0 ? top : undefined;
}
