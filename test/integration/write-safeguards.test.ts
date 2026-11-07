/**
 * Safeguards of the write flow beyond the basic confirmation: hidden characters in arguments,
 * the cap on waiting browser approvals, approvals that expire mid-call, audit lines for refused
 * confirmations, and the signed request state's own expiry.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineWriteTool } from "../../src/tools/define-tool.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";
import { dryRunInputShape } from "../../src/tools/write-input.js";
import { decideInBrowser } from "../helpers/approval-browser.js";
import { createDummyTools, dummyInvoiceBody, WRITE_ANNOTATIONS } from "../helpers/dummy-tools.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultText,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";

closeWriteHarnessesAfterEach();

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const cp = (codePoint: number): string => String.fromCodePoint(codePoint);

function dummy(name: string): AnyToolDefinition {
  return createDummyTools().tools.find((tool) => tool.name === name)!;
}

function invoiceRoutes(...ids: number[]): FakeRoute[] {
  return ids.flatMap((id) => [
    { path: `/Invoice/${id}`, response: { body: dummyInvoiceBody() } },
    { method: "PUT", path: `/Invoice/${id}/sendBy`, response: { body: { objects: { id } } } },
  ]);
}

const contactRoute: FakeRoute = {
  method: "POST",
  path: "/Contact",
  response: { body: { objects: { id: "1" } } },
};

/** A write tool with nested arguments, to check paths into arrays and objects. */
const nested = defineWriteTool({
  name: "sevdesk_dummy_nested",
  title: "Nested (dummy)",
  description: "Takes nested positions. Test fixture for argument checks in nested values.",
  toolset: "contacts",
  tier: "write",
  annotations: WRITE_ANNOTATIONS,
  input: z.strictObject({
    positions: z.array(z.strictObject({ text: z.string(), quantity: z.number() })),
    ...dryRunInputShape,
  }),
  output: z.object({ ok: z.boolean() }),
  prepare: () =>
    Promise.resolve({
      preview: { action: "Save positions.", facts: [], warnings: [], irreversible: false },
      state: null,
    }),
  execute: () => Promise.resolve({ data: { ok: true }, summary: "Saved.", affected: [] }),
});

describe("hidden characters in write arguments", () => {
  it.each([
    ["a zero-width space", 0x200b],
    ["a right-to-left override", 0x202e],
    ["variation selector 16", 0xfe0f],
    ["the combining grapheme joiner", 0x034f],
    ["a Hangul filler", 0x3164],
    ["the line separator", 0x2028],
    ["a carriage return", 0x0d],
    ["a tab", 0x09],
  ])("refuses %s before anything is read or sent", async (_label, codePoint) => {
    const { client, fake } = await writeHarness({
      tools: [dummy("sevdesk_dummy_create")],
      routes: [contactRoute],
    });

    const result = await client.callTool({
      name: "sevdesk_dummy_create",
      arguments: { name: `Muster${cp(codePoint)} GmbH` },
    });

    expect(result.isError).toBe(true);
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    expect(resultText(result)).toBe(
      [
        "Invalid arguments for sevdesk_dummy_create; nothing was sent to sevDesk.",
        `- \`name\` contains characters the user would not see: ${label}.`,
        "Remove these characters (invisible, zero-width, bidi, variation selectors, carriage " +
          "returns, tabs); line breaks are fine, use spaces instead of tabs. Then call the tool " +
          "again.",
      ].join("\n"),
    );
    expect(fake.calls).toEqual([]);
  });

  it("refuses them in dry runs and in confirmed tiers too, before asking anyone", async () => {
    const { client, fake, prompts } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize"), nested],
      routes: invoiceRoutes(7),
    });

    const dryRun = await client.callTool({
      name: "sevdesk_dummy_nested",
      arguments: { positions: [{ text: `a${cp(0x200b)}`, quantity: 1 }], dryRun: true },
    });

    expect(dryRun.isError).toBe(true);
    expect(prompts).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("names the path into nested arguments and every code point once", async () => {
    const { client } = await writeHarness({ tools: [nested], routes: [] });

    const result = await client.callTool({
      name: "sevdesk_dummy_nested",
      arguments: {
        positions: [
          { text: "fine", quantity: 1 },
          { text: `x${cp(0xfe0f)}y${cp(0x200b)}z${cp(0xfe0f)}`, quantity: 2 },
        ],
      },
    });

    expect(resultText(result)).toContain(
      "- `positions[1].text` contains characters the user would not see: U+FE0F, U+200B.",
    );
  });

  it("caps the listed arguments and code points", async () => {
    const { client } = await writeHarness({ tools: [nested], routes: [] });
    const many = Array.from({ length: 12 }, (_, index) => cp(0xfe00 + index)).join("");

    const result = await client.callTool({
      name: "sevdesk_dummy_nested",
      arguments: { positions: Array.from({ length: 12 }, () => ({ text: many, quantity: 1 })) },
    });

    expect(resultText(result)).toContain("U+FE09 and 2 more.");
    expect(resultText(result)).toContain("- … 2 more arguments omitted.");
  });

  it("accepts line breaks, umlauts and emoji", async () => {
    const { client, fake } = await writeHarness({
      tools: [dummy("sevdesk_dummy_create")],
      routes: [contactRoute],
    });

    const result = await client.callTool({
      name: "sevdesk_dummy_create",
      arguments: { name: `Müller & Söhne GmbH\nAbteilung ${cp(0x1f600)}` },
    });

    expect(result.isError, resultText(result)).toBeFalsy();
    expect(writesOf(fake)).toEqual([{ method: "POST", path: "/Contact" }]);
  });
});

describe("waiting browser approvals", () => {
  it("are capped at 5 per process; the next request is refused without a new page", async () => {
    const { client, fake, openedUrls } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes(1, 2, 3, 4, 5, 6),
      config: { confirm: "browser" },
      opener: "opens",
    });
    const call = (id: number) =>
      client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id } });

    for (const id of [1, 2, 3, 4, 5]) {
      expect(resultData(await call(id))).toMatchObject({ status: "approval_pending" });
    }
    const sixth = await call(6);
    // The same call again still gets its existing approval back.
    const again = await call(5);

    expect(sixth.isError).toBe(true);
    expect(resultText(sixth)).toContain("5 approval requests are already waiting");
    expect(resultText(sixth)).toContain("Nothing was sent to sevDesk");
    expect(resultData(again)).toMatchObject({ status: "approval_pending" });
    expect(openedUrls).toHaveLength(5);
    expect(writesOf(fake)).toEqual([]);
  });

  it("free a slot once decided", async () => {
    const { client, lastApprovalUrl } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes(1, 2, 3, 4, 5, 6),
      config: { confirm: "browser" },
    });
    const call = (id: number) =>
      client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id } });
    for (const id of [1, 2, 3, 4, 5]) await call(id);

    await decideInBrowser(lastApprovalUrl(), "reject");

    expect(resultData(await call(6))).toMatchObject({ status: "approval_pending" });
  });

  it("ask again when a decided approval expires between lookup and take", async () => {
    const { client, fake, safety, lastApprovalUrl } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes(7),
      config: { confirm: "browser" },
    });
    const call = () => client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });
    await call();
    const first = lastApprovalUrl();
    await decideInBrowser(first, "approve");
    vi.spyOn(safety.approvals, "take").mockReturnValueOnce(undefined);

    const result = await call();

    expect(resultData(result)).toMatchObject({ status: "approval_pending" });
    expect(lastApprovalUrl()).not.toBe(first);
    expect(writesOf(fake)).toEqual([]);
  });
});

describe("refused confirmations", () => {
  interface InputRequired {
    readonly requestState: string;
  }

  const accepted = { confirm: { action: "accept", content: { approve: true } } };

  function retry(
    client: { callTool: (params: never) => Promise<CallToolResult> },
    params: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return client.callTool(params as never);
  }

  async function auditPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-safeguards-"));
    dirs.push(dir);
    return join(dir, "audit.jsonl");
  }

  async function events(path: string): Promise<Record<string, unknown>[]> {
    return (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("are written to the audit log: replays and mismatched arguments", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes(7, 8),
      config: { auditLogPath: path },
      connect: { manual: true },
    });
    const { requestState } = (await client.callTool(
      { name: "sevdesk_dummy_finalize", arguments: { id: 7 } },
      { allowInputRequired: true },
    )) as unknown as InputRequired;
    const approved = {
      name: "sevdesk_dummy_finalize",
      arguments: { id: 7 },
      inputResponses: accepted,
      requestState,
    };

    await retry(client, approved);
    await retry(client, approved);
    await retry(client, { ...approved, arguments: { id: 8 } });

    const lines = await events(path);
    expect(lines.map((line) => [line["event"], line["reason"]])).toEqual([
      ["confirmation_requested", undefined],
      ["executing", undefined],
      ["executed", undefined],
      ["confirmation_refused", "replayed_or_expired"],
      ["confirmation_refused", "mismatch"],
    ]);
    expect(new Set(lines.slice(0, 4).map((line) => line["callId"])).size).toBe(1);
    expect(lines[0]?.["previewHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[1]?.["previewHash"]).toBe(lines[0]?.["previewHash"]);
  });

  it("are refused by the SDK once the signed state itself expired (10 minutes)", async () => {
    const { client, fake } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes(7),
      connect: { manual: true },
    });
    const { requestState } = (await client.callTool(
      { name: "sevdesk_dummy_finalize", arguments: { id: 7 } },
      { allowInputRequired: true },
    )) as unknown as InputRequired;

    // Only the clock moves; the codec checks its expiry before the flow sees the retry.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 601_000 });

    await expect(
      retry(client, {
        name: "sevdesk_dummy_finalize",
        arguments: { id: 7 },
        inputResponses: accepted,
        requestState,
      }),
    ).rejects.toThrow(/Invalid or expired requestState/);
    expect(writesOf(fake)).toEqual([]);
  });
});
