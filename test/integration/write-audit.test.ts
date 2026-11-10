/**
 * The audit log through MCP: which lines a write call produces, that they share one call id
 * across the confirmation, that nothing runs when the `executing` line cannot be written, and
 * that failures record their kind and completed writes.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { bothPreviews } from "../../src/domain/preview-text.js";
import { SevdeskError, withCompletedWrites } from "../../src/sevdesk/errors.js";
import { defineWriteTool } from "../../src/tools/define-tool.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";
import { dryRunInputShape } from "../../src/tools/write-input.js";
import { decideInBrowser } from "../helpers/approval-browser.js";
import { TEST_TOKEN } from "../helpers/config.js";
import {
  COMMIT_ANNOTATIONS,
  createDummyTools,
  dummyInvoiceBody,
  WRITE_ANNOTATIONS,
} from "../helpers/dummy-tools.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultText,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";

closeWriteHarnessesAfterEach();

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function auditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sevdesk-write-audit-"));
  dirs.push(dir);
  return join(dir, "audit.jsonl");
}

async function auditLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function dummy(name: string): AnyToolDefinition {
  return createDummyTools().tools.find((tool) => tool.name === name)!;
}

const invoiceRoutes: FakeRoute[] = [
  { path: "/Invoice/7", response: { body: dummyInvoiceBody() } },
  { method: "PUT", path: "/Invoice/7/sendBy", response: { body: { objects: { id: "7" } } } },
];

describe("audit lines", () => {
  it("records request, execution and result of an approved call under one call id", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes,
      config: { auditLogPath: path },
    });

    await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    const lines = await auditLines(path);
    expect(lines.map((line) => line["event"])).toEqual([
      "confirmation_requested",
      "executing",
      "executed",
    ]);
    const [requested, executing, executed] = lines;
    expect(new Set(lines.map((line) => line["callId"])).size).toBe(1);
    expect(requested).toMatchObject({
      tool: "sevdesk_dummy_finalize",
      tier: "commit",
      argsHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      args: { id: 7 },
      preview: { action: "Finalize invoice RE-1042 and mark it as sent." },
    });
    expect(executing).toMatchObject({ approval: "elicit" });
    expect(executing).not.toHaveProperty("preview");
    expect(executed).toMatchObject({ affected: [{ objectName: "Invoice", id: "7" }] });
    expect(String(requested?.["ts"])).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("records a declined confirmation", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes,
      config: { auditLogPath: path },
      connect: { answer: () => ({ action: "decline" }) },
    });

    await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect((await auditLines(path)).map((line) => line["event"])).toEqual([
      "confirmation_requested",
      "declined",
    ]);
  });

  it("records a dry run with its preview", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes,
      config: { auditLogPath: path },
    });

    await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7, dryRun: true } });

    const [line] = await auditLines(path);
    expect(line).toMatchObject({
      event: "dry_run",
      args: { id: 7, dryRun: true },
      preview: expect.any(Object) as unknown,
    });
  });

  it("links browser request, approval and execution with one call id", async () => {
    const path = await auditPath();
    const { client, lastApprovalUrl } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes,
      config: { auditLogPath: path, confirm: "browser" },
    });
    await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });
    const url = lastApprovalUrl();
    await decideInBrowser(url, "approve");

    await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    const lines = await auditLines(path);
    expect(lines.map((line) => line["event"])).toEqual([
      "confirmation_requested",
      "approval_decided",
      "executing",
      "executed",
    ]);
    expect(new Set(lines.map((line) => line["callId"])).size).toBe(1);
    const reference = lines[0]?.["reference"];
    expect(reference).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(lines[1]).toMatchObject({ decision: "approved", reference });
    expect(lines[1]).not.toHaveProperty("args");
    expect(lines[1]?.["previewHash"]).toBe(lines[0]?.["previewHash"]);
    expect(lines[2]).toMatchObject({ approval: "browser", previewHash: lines[0]?.["previewHash"] });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(url.slice(-43));
    expect(text).not.toContain("127.0.0.1");
  });

  it("records write-tier calls as not needing approval, and never the token", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [dummy("sevdesk_dummy_create")],
      routes: [{ method: "POST", path: "/Contact", response: { body: { objects: { id: "1" } } } }],
      config: { auditLogPath: path },
    });

    await client.callTool({ name: "sevdesk_dummy_create", arguments: { name: TEST_TOKEN } });

    const text = await readFile(path, "utf8");
    expect(text).not.toContain(TEST_TOKEN);
    const lines = await auditLines(path);
    expect(lines.map((line) => line["event"])).toEqual(["executing", "executed"]);
    expect(lines[0]).toMatchObject({ approval: "not_required", args: { name: "[REDACTED]" } });
  });

  it("never records upload ids: an upload: argument is redacted, a path stays as it is", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [dummy("sevdesk_dummy_create")],
      routes: [{ method: "POST", path: "/Contact", response: { body: { objects: { id: "1" } } } }],
      config: { auditLogPath: path },
    });
    const id = "Ab3_-".repeat(8) + "xyz";

    await client.callTool({ name: "sevdesk_dummy_create", arguments: { name: `upload:${id}` } });
    await client.callTool({
      name: "sevdesk_dummy_create",
      arguments: { name: "Belege/RE-4711.pdf" },
    });

    expect(await readFile(path, "utf8")).not.toContain(id);
    const requests = (await auditLines(path)).filter((line) => line["event"] === "executing");
    expect(requests.map((line) => line["args"])).toEqual([
      { name: "upload:[REDACTED]" },
      { name: "Belege/RE-4711.pdf" },
    ]);
  });

  it("records confirmation_off when SEVDESK_CONFIRM=off", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes,
      config: { auditLogPath: path, confirm: "off" },
    });

    await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect((await auditLines(path))[0]).toMatchObject({
      event: "executing",
      approval: "confirmation_off",
    });
  });

  it("writes no file when SEVDESK_AUDIT_LOG is unset", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [dummy("sevdesk_dummy_finalize")],
      routes: invoiceRoutes,
    });

    await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(await auditLines(path)).toEqual([]);
  });
});

describe("fail closed", () => {
  it.each(["sevdesk_dummy_create", "sevdesk_dummy_finalize"])(
    "%s does not run when the executing line cannot be written",
    async (name) => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const dir = await mkdtemp(join(tmpdir(), "sevdesk-write-audit-"));
      dirs.push(dir);
      const blocked = join(dir, "a-directory");
      await mkdir(blocked);
      const { client, fake } = await writeHarness({
        tools: [dummy(name)],
        routes: [
          ...invoiceRoutes,
          { method: "POST", path: "/Contact", response: { body: { objects: { id: "1" } } } },
        ],
        config: { auditLogPath: blocked },
      });

      const result = await client.callTool({
        name,
        arguments: name === "sevdesk_dummy_create" ? { name: "A" } : { id: 7 },
      });

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain(
        "the audit log (SEVDESK_AUDIT_LOG) could not be written",
      );
      expect(resultText(result)).toContain("Nothing was sent to sevDesk");
      expect(writesOf(fake)).toEqual([]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("could not write the executing"));
      if (name === "sevdesk_dummy_finalize") {
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining("could not write the confirmation_requested line"),
        );
      }
    },
  );
});

describe("failures", () => {
  const twoStep = defineWriteTool({
    name: "sevdesk_dummy_two_step",
    title: "Two steps (dummy)",
    description: "Creates a contact, then an address that fails. Test fixture for half writes.",
    toolset: "contacts",
    tier: "write",
    annotations: WRITE_ANNOTATIONS,
    input: z.strictObject({ ...dryRunInputShape }),
    output: z.object({ id: z.string() }),
    prepare: () =>
      Promise.resolve({
        preview: {
          action: "Create a contact with an address.",
          facts: [],
          warnings: [],
          irreversible: false,
        },
        state: null,
      }),
    execute: async (_args, _plan, ctx) => {
      await ctx.client.request({ method: "POST", path: "/Contact", body: {} });
      try {
        await ctx.client.request({ method: "POST", path: "/ContactAddress", body: {} });
      } catch (error) {
        throw withCompletedWrites(error as SevdeskError, [{ objectName: "Contact", id: "123" }]);
      }
      return { data: { id: "123" }, summary: "Created.", affected: [] };
    },
  });

  const badOutput = defineWriteTool({
    name: "sevdesk_dummy_bad_write",
    title: "Bad write output (dummy)",
    description: "Finalizes, then returns malformed data. Test fixture for output validation.",
    toolset: "invoices",
    tier: "commit",
    annotations: COMMIT_ANNOTATIONS,
    input: z.strictObject({ ...dryRunInputShape }),
    output: z.object({ status: z.string() }),
    prepare: () =>
      Promise.resolve({
        ...bothPreviews(() => ({
          action: "Finalize invoice 7.",
          facts: [],
          warnings: [],
          irreversible: false,
        })),
        state: null,
      }),
    execute: async (_args, _plan, ctx) => {
      await ctx.client.request({ method: "PUT", path: "/Invoice/7/sendBy", body: {} });
      return {
        data: { status: 42 } as unknown as { status: string },
        summary: "Finalized.",
        affected: [{ objectName: "Invoice", id: "7" }],
      };
    },
  });

  it("records the error kind and the completed writes, and tells the model what exists", async () => {
    const path = await auditPath();
    const { client, fake } = await writeHarness({
      tools: [twoStep],
      routes: [
        { method: "POST", path: "/Contact", response: { body: { objects: { id: "123" } } } },
        {
          method: "POST",
          path: "/ContactAddress",
          response: {
            error: new SevdeskError({
              kind: "validation",
              status: 422,
              message: "sevDesk rejected the address.",
            }),
          },
        },
      ],
      config: { auditLogPath: path },
    });

    const result = await client.callTool({ name: "sevdesk_dummy_two_step", arguments: {} });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(
      "Before this failed, the call had already created or changed: Contact 123. Do not repeat " +
        "the call; fix or finish it with the matching update tool.",
    );
    expect(resultText(result)).not.toMatch(/nothing was sent/i);
    expect(writesOf(fake)).toHaveLength(2);
    const lines = await auditLines(path);
    expect(lines.map((line) => line["event"])).toEqual(["executing", "failed"]);
    expect(lines[1]).toMatchObject({
      error: "validation",
      affected: [{ objectName: "Contact", id: "123" }],
    });
  });

  it("records a failure without completed writes as an empty list", async () => {
    const path = await auditPath();
    const { client } = await writeHarness({
      tools: [twoStep],
      routes: [
        {
          method: "POST",
          path: "/Contact",
          response: { error: new SevdeskError({ kind: "server", status: 500, message: "boom" }) },
        },
      ],
      config: { auditLogPath: path },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await client.callTool({ name: "sevdesk_dummy_two_step", arguments: {} });

    expect(result.isError).toBe(true);
    expect((await auditLines(path))[1]).toMatchObject({
      event: "failed",
      error: "server",
      affected: [],
    });
  });

  it("records output that fails validation after the write, and says the change was made", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const path = await auditPath();
    const { client, fake } = await writeHarness({
      tools: [badOutput],
      routes: [{ method: "PUT", path: "/Invoice/7/sendBy", response: { body: { objects: {} } } }],
      config: { auditLogPath: path, confirm: "off" },
    });

    const result = await client.callTool({ name: "sevdesk_dummy_bad_write", arguments: {} });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("The change itself was sent to sevDesk");
    expect(writesOf(fake)).toHaveLength(1);
    expect((await auditLines(path))[1]).toMatchObject({
      event: "failed",
      error: "output_invalid",
      affected: [{ objectName: "Invoice", id: "7" }],
    });
  });

  it("refuses a malformed preview before asking anyone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = defineWriteTool({
      ...badOutput,
      name: "sevdesk_dummy_broken_preview",
      prepare: () =>
        Promise.resolve({
          ...bothPreviews(() => ({ action: "", facts: [], warnings: [], irreversible: false })),
          state: null,
        }),
    });
    const { client, fake, prompts } = await writeHarness({ tools: [broken], routes: [] });

    const result = await client.callTool({ name: "sevdesk_dummy_broken_preview", arguments: {} });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Internal output validation failed");
    expect(prompts).toEqual([]);
    expect(writesOf(fake)).toEqual([]);
  });

  it("records an internal error kind for unexpected exceptions", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const path = await auditPath();
    const crashing = defineWriteTool({
      ...twoStep,
      name: "sevdesk_dummy_crash",
      execute: () => Promise.reject(new TypeError("bug")),
    });
    const { client } = await writeHarness({
      tools: [crashing],
      routes: [],
      config: { auditLogPath: path },
    });

    await client.callTool({ name: "sevdesk_dummy_crash", arguments: {} });

    expect((await auditLines(path))[1]).toMatchObject({ event: "failed", error: "internal" });
  });
});
