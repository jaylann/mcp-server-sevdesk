import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  diffToolSurface,
  dumpToolSurface,
  measureToolSurface,
  runToolSurface,
  surfaceJson,
  surfaceReport,
  type ToolSurface,
} from "../../../scripts/tool-surface.js";
import { clientView } from "../../evals/tools.js";

function empty(): ToolSurface {
  const config = () => ({ tools: [], prompts: [], instructions: "" });
  return {
    version: 1,
    configurations: {
      read: config(),
      write: config(),
      all: config(),
      "http-files": config(),
    },
  };
}

const event = {
  number: 12,
  pull_request: {
    base: { sha: "a".repeat(40) },
    head: { sha: "b".repeat(40) },
  },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("tool surface", () => {
  // Two complete captures exercise eight SDK handshakes and multi-MiB JSON serialization.
  it("captures all four configurations through MCP, including output schemas and HTTP files", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
    vi.stubEnv("SEVDESK_ALLOW", "all");
    vi.stubEnv("SEVDESK_TOOLSETS", "advanced");
    const dump = await dumpToolSurface();
    const { read, write, all, "http-files": http } = dump.configurations;
    const names = (item: typeof read) => item.tools.map((tool) => tool.name);
    expect(names(read)).not.toContain("sevdesk_invoice_create_draft");
    expect(names(write)).toContain("sevdesk_invoice_create_draft");
    expect(names(write)).not.toContain("sevdesk_invoice_finalize");
    expect(names(all)).toContain("sevdesk_invoice_finalize");
    expect(names(all)).toContain("sevdesk_api_get");
    expect(names(all)).not.toContain("sevdesk_upload_request");
    expect(names(http)).toEqual(
      expect.arrayContaining([
        "sevdesk_upload_request",
        "sevdesk_einvoice_parse",
        "sevdesk_document_save",
      ]),
    );
    for (const item of Object.values(dump.configurations)) {
      expect(item.instructions).toContain("sevDesk");
      expect(item.prompts.length).toBeGreaterThan(0);
      expect(
        item.tools.every(
          (tool) => tool.inputSchema && tool.outputSchema && tool.description && tool.annotations,
        ),
      ).toBe(true);
    }
    const clientPayload = JSON.stringify(await clientView({}));
    expect(JSON.stringify(read.modelContext)).toBe(clientPayload);
    const roundTrip = JSON.parse(surfaceJson(dump)) as ToolSurface;
    expect(JSON.stringify(roundTrip.configurations.read.modelContext)).toBe(clientPayload);
    expect(read.modelContext?.tools.every((tool) => !Object.hasOwn(tool, "outputSchema"))).toBe(
      true,
    );
    expect(dump.responses?.invoice_get).toContain("with 1 position");
    expect(dump.responses?.records_summarize).toContain("100 counted");
    for (const id of [
      "contacts_search",
      "transactions_list",
      "transactions_list_summary",
      "vouchers_list",
      "vouchers_list_summary",
      "invoices_list",
      "invoices_list_summary",
      "invoices_list_max",
      "invoices_list_summary_max",
    ] as const) {
      const text = dump.responses?.[id] ?? "";
      const data = JSON.parse(text.slice(text.indexOf("\n\n") + 2)) as {
        items: unknown[];
        limit: number;
      };
      expect(data.items, id).toHaveLength(id.endsWith("_max") ? 100 : 25);
      expect(data.limit, id).toBe(id.endsWith("_max") ? 100 : 25);
    }
    for (const [full, summary] of [
      ["transactions_list", "transactions_list_summary"],
      ["vouchers_list", "vouchers_list_summary"],
      ["invoices_list", "invoices_list_summary"],
      ["invoices_list_max", "invoices_list_summary_max"],
    ] as const) {
      const parse = (id: typeof full | typeof summary) => {
        const text = dump.responses![id]!;
        return JSON.parse(text.slice(text.indexOf("\n\n") + 2)) as {
          items: { id: number }[];
        };
      };
      const { items: fullItems, ...fullPage } = parse(full);
      const { items: summaryItems, ...summaryPage } = parse(summary);
      expect(summaryPage).toEqual(fullPage);
      expect(summaryItems.map((item) => item.id)).toEqual(fullItems.map((item) => item.id));
      expect(dump.responses![summary]!.length).toBeLessThan(dump.responses![full]!.length);
    }
    const sizes = measureToolSurface(dump);
    expect(sizes.read.tools).toBeGreaterThan(0);
    expect(sizes.write.tools).toBeGreaterThan(sizes.read.tools);
    expect(sizes.all.tools).toBeGreaterThan(sizes.write.tools);
    expect(sizes["http-files"].tools).toBeGreaterThan(sizes.all.tools);
    for (const size of Object.values(sizes)) {
      expect(size.definitions).toBeGreaterThan(0);
      expect(size.definitions).toBeLessThan(size.tools);
    }
    expect(http.instructions).toContain("uploadId");
    expect(fetch).not.toHaveBeenCalled();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00Z"));
    expect(surfaceJson(await dumpToolSurface())).toBe(surfaceJson(dump));
    expect(Date.now()).toBe(Date.parse("2030-01-01T00:00:00Z"));
    clock.mockRestore();
  }, 30_000);

  it("still dumps and reports the full catalog when response setup fails", async () => {
    const dump = await dumpToolSurface(() => Promise.reject(new Error("Fixture setup failed")));
    expect(dump.responses).toEqual({});
    expect(dump.configurations.read.tools.length).toBeGreaterThan(0);
    const head = structuredClone(dump);
    head.configurations.read.tools = head.configurations.read.tools.filter(
      (tool) => tool.name !== "sevdesk_invoices_list",
    );
    const report = await surfaceReport(dump, head, event);
    expect(report.diff).toContain("- /read/tools/sevdesk_invoices_list:");
    expect(report.tokenCost.head.responses.invoices_list).toBeNull();
    expect(report.tokenCost.head.configurations.read).toBeGreaterThan(0);
  });

  it("preserves unsorted nested schema keys through dump serialization and measurement", async () => {
    const dump = empty();
    const view = {
      system: "Instructions",
      tools: [
        {
          name: "x",
          description: "X",
          input_schema: {
            properties: { z: { description: "last", type: "string" }, a: { type: "number" } },
            type: "object" as const,
            required: ["z"],
          },
        },
      ],
    };
    dump.configurations.read.modelContext = view;
    const roundTrip: unknown = JSON.parse(surfaceJson(dump));
    const counter = { method: "exact" as const, count: vi.fn().mockResolvedValue(10) };
    await surfaceReport(roundTrip, roundTrip, event, counter);
    expect(JSON.stringify(counter.count.mock.calls[0]?.[0])).toBe(
      JSON.stringify({ kind: "context", view }),
    );
  });

  it("sorts keys and named lists, preserves schema array order and does not mutate inputs", () => {
    const base = empty();
    base.configurations.read.tools = [
      { name: "z", inputSchema: { type: "object", required: ["b", "a"] } },
      { name: "a" },
    ];
    base.configurations.read.prompts = [{ name: "z" }, { name: "a" }];
    const reordered = empty();
    reordered.configurations.read.tools = [
      { name: "a" },
      { inputSchema: { required: ["b", "a"], type: "object" }, name: "z" },
    ];
    reordered.configurations.read.prompts = [{ name: "a" }, { name: "z" }];
    expect(surfaceJson(base)).toBe(surfaceJson(reordered));
    expect(diffToolSurface(base, reordered)).toBe("");
    expect(base.configurations.read.tools[0]?.name).toBe("z");
    expect(surfaceJson(base)).toMatch(/"b",\n\s+"a"/);
  });

  it("shows additions, removals and renames by name instead of array index", () => {
    const base = empty();
    const head = empty();
    base.configurations.all.tools = [{ name: "old" }, { name: "stable" }];
    head.configurations.all.tools = [{ name: "new" }, { name: "stable" }];
    head.configurations.write.prompts = [{ name: "new_prompt", arguments: [{ name: "month" }] }];
    expect(diffToolSurface(base, head)).toBe(
      '+ /all/tools/new: {"name":"new"}\n' +
        '- /all/tools/old: {"name":"old"}\n' +
        '+ /write/prompts/new_prompt: {"arguments":[{"name":"month"}],"name":"new_prompt"}\n',
    );
  });

  it("detects nested input/output schemas, annotations, descriptions, prompts and instructions", () => {
    const base = empty();
    base.configurations.read.tools = [
      {
        name: "x",
        inputSchema: { minimum: 0 },
        outputSchema: { type: "string" },
        annotations: { readOnlyHint: true },
        description: "old",
      },
    ];
    base.configurations.read.prompts = [{ name: "p", arguments: [{ name: "x", required: false }] }];
    const head = structuredClone(base);
    head.configurations.read.tools = [
      {
        name: "x",
        inputSchema: { minimum: 1 },
        outputSchema: { type: "number" },
        annotations: { readOnlyHint: false },
        description: "new",
      },
    ];
    head.configurations.read.prompts = [{ name: "p", arguments: [{ name: "x", required: true }] }];
    head.configurations.read.instructions = "new instructions";
    const diff = diffToolSurface(base, head);
    for (const path of [
      "inputSchema/minimum",
      "outputSchema/type",
      "annotations/readOnlyHint",
      "description",
    ]) {
      expect(diff).toContain(`/read/tools/x/${path}:`);
    }
    expect(diff).toContain("- /read/tools/x/inputSchema/minimum: 0");
    expect(diff).toContain("/read/prompts/p/arguments:");
    expect(diff).toContain('+ /read/instructions: "new instructions"');
  });

  it("escapes JSON pointers and safely compares prototype-like property names", () => {
    const head = empty();
    head.configurations.all.tools = [{ name: "a/b~c" }, { name: "__proto__" }];
    expect(diffToolSurface(empty(), head)).toContain("/all/tools/a~1b~0c:");
    expect(diffToolSurface(empty(), head)).toContain("/all/tools/__proto__:");
  });

  it("rejects malformed dumps, unsupported versions and duplicate names", () => {
    expect(() => diffToolSurface({}, empty())).toThrow();
    expect(() => diffToolSurface({ ...empty(), version: 2 }, empty())).toThrow();
    const duplicate = empty();
    duplicate.configurations.read.tools = [{ name: "x" }, { name: "x" }];
    expect(() => surfaceJson(duplicate)).toThrow("Duplicate surface entry names");
  });

  it("bounds reports, records provenance and distinguishes no changes", async () => {
    expect(await surfaceReport(empty(), empty(), event)).toMatchObject({
      version: 1,
      pr: 12,
      base: "a".repeat(40),
      head: "b".repeat(40),
      changed: false,
      diff: "",
      truncated: false,
      contextCost: { base: measureToolSurface(empty()), head: measureToolSurface(empty()) },
    });
    const head = empty();
    head.configurations.read.instructions = "x".repeat(50_000);
    const report = await surfaceReport(empty(), head, event);
    expect(report.changed).toBe(true);
    expect(report.truncated).toBe(true);
    expect(report.diff).toHaveLength(45_000);
    expect(report.contextCost.head.read.instructions).toBe(50_000);
    await expect(surfaceReport(empty(), head, { number: "12" })).rejects.toThrow();
  });

  it("runs the diff/report CLI and rejects bad arguments and malformed JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sevdesk-surface-"));
    directories.push(directory);
    const dump = join(directory, "surface.json");
    const diff = join(directory, "diff.txt");
    const eventFile = join(directory, "event.json");
    const report = join(directory, "report.json");
    await writeFile(dump, surfaceJson(empty()));
    await runToolSurface(["diff", dump, dump, diff]);
    expect(await readFile(diff, "utf8")).toBe("");
    await writeFile(eventFile, JSON.stringify(event));
    await runToolSurface(["report", dump, dump, eventFile, report]);
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      changed: false,
      pr: 12,
      contextCost: { base: measureToolSurface(empty()), head: measureToolSurface(empty()) },
    });
    for (const args of [
      [],
      ["bad"],
      ["diff", dump],
      ["dump", dump, "extra"],
      ["report", dump, dump],
    ]) {
      await expect(runToolSurface(args)).rejects.toThrow("Usage:");
    }
    await writeFile(dump, "broken JSON");
    await expect(runToolSurface(["diff", dump, dump])).rejects.toThrow();
  });
});

describe("tool surface context size", () => {
  it("counts empty list result wrappers and empty instructions in every configuration", () => {
    const emptySizes = { definitions: 12, tools: 12, prompts: 14, instructions: 0 };
    expect(measureToolSurface(empty())).toEqual({
      read: emptySizes,
      write: emptySizes,
      all: emptySizes,
      "http-files": emptySizes,
    });
  });

  it("counts Unicode code points in compact list JSON and raw instruction text", () => {
    const surface = empty();
    surface.configurations.read = {
      tools: [{ name: "x", description: "ä😀" }],
      prompts: [{ name: "p", description: '\n"' }],
      instructions: 'ä😀\n"',
    };
    expect(measureToolSurface(surface).read).toEqual({
      definitions: 43,
      tools: 43,
      prompts: 47,
      instructions: 4,
    });
  });

  it("counts only name, description and input schema as tool definitions", () => {
    const surface = empty();
    surface.configurations.read.tools = [
      {
        name: "x",
        title: "X",
        description: "d",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { big: { type: "string" } } },
        annotations: { readOnlyHint: true },
        _meta: { tier: "read" },
      },
    ];
    const size = measureToolSurface(surface).read;
    expect(size.definitions).toBe(
      '{"tools":[{"name":"x","description":"d","inputSchema":{"type":"object"}}]}'.length,
    );
    expect(size.tools).toBe(JSON.stringify({ tools: surface.configurations.read.tools }).length);
    expect(size.tools).toBeGreaterThan(size.definitions);
  });

  it("includes complete schemas and prompt arguments, independent of dump layout and key order", () => {
    const surface = empty();
    surface.configurations.all.tools = [
      { name: "x", inputSchema: { type: "object" }, outputSchema: { type: "string" } },
    ];
    surface.configurations.all.prompts = [{ name: "p", arguments: [{ name: "month" }] }];
    const size = measureToolSurface(surface);
    expect(size.all.tools).toBe(
      '{"tools":[{"name":"x","inputSchema":{"type":"object"},"outputSchema":{"type":"string"}}]}'
        .length,
    );
    expect(size.all.prompts).toBe(
      '{"prompts":[{"name":"p","arguments":[{"name":"month"}]}]}'.length,
    );
    expect(size.all.definitions).toBe(
      '{"tools":[{"name":"x","inputSchema":{"type":"object"}}]}'.length,
    );
    expect(measureToolSurface(JSON.parse(surfaceJson(surface)))).toEqual(size);
    expect(size.read).toEqual({ definitions: 12, tools: 12, prompts: 14, instructions: 0 });
    expect(size.write).toEqual(size.read);
    expect(size["http-files"]).toEqual(size.read);
  });

  it("rejects malformed surfaces before measuring", () => {
    expect(() => measureToolSurface({})).toThrow();
    const surface = empty();
    surface.configurations.read.prompts = [{ name: "p" }, { name: "p" }];
    expect(() => measureToolSurface(surface)).toThrow("Duplicate surface entry names");
  });
});
