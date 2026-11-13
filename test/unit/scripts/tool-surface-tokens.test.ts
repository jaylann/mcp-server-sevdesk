import { execFile } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { measureTokens, surfaceReport, type ToolSurface } from "../../../scripts/tool-surface.js";
import { RESPONSE_CALLS } from "../../../scripts/tool-surface-responses.js";
import {
  countCapturedReport,
  createTokenCounter,
  TOKEN_MODEL,
} from "../../../scripts/tool-surface-tokens.js";

// Intercept only the next open to exercise races/errors on a real file descriptor.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const view = {
  system: "Instructions ä😀",
  tools: [{ name: "example", description: "Example", input_schema: { type: "object" as const } }],
};
function surface(): ToolSurface {
  const config = () => ({ tools: [], prompts: [], instructions: view.system, modelContext: view });
  return {
    version: 1,
    configurations: { read: config(), write: config(), all: config(), "http-files": config() },
    responses: Object.fromEntries(
      Object.keys(RESPONSE_CALLS).map((id) => [id, 'Summary\n\n{"data":"ä😀"}']),
    ),
  };
}

describe("tool surface token counter", () => {
  it("estimates Unicode characters / 2.3 without invoking a provider", async () => {
    const counter = createTokenCounter();
    expect(counter.method).toBe("estimated");
    expect(await counter.count({ kind: "context", view })).toBe(
      Math.round(Array.from(JSON.stringify({ tools: view.tools }) + view.system).length / 2.3),
    );
    expect(await counter.count({ kind: "response", text: "😀".repeat(23) })).toBe(10);
  });

  it("measures base and head with the injected counter, preserving missing captures as null", async () => {
    const base = surface();
    const head = surface();
    head.configurations.read.modelContext = { ...view, system: "Changed instructions" };
    const count = vi
      .fn()
      .mockImplementation((input: { kind: string; view?: { system: string } }) =>
        Promise.resolve(
          input.kind === "response" ? 15 : input.view?.system === view.system ? 100 : 120,
        ),
      );
    const counter = { method: "exact" as const, count };
    const report = await surfaceReport(
      base,
      head,
      {
        number: 61,
        pull_request: { base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } },
      },
      counter,
    );
    expect(report.tokenCost).toMatchObject({
      method: "exact",
      model: TOKEN_MODEL,
      base: { configurations: { read: 100 }, responses: { invoice_get: 15 } },
      head: { configurations: { read: 120 }, responses: { invoice_get: 15 } },
    });
    delete base.responses;
    for (const config of Object.values(base.configurations)) delete config.modelContext;
    count.mockClear();
    const missing = await measureTokens(base, counter);
    expect(Object.values(missing.configurations)).toEqual([null, null, null, null]);
    expect(Object.values(missing.responses)).toEqual(Object.keys(RESPONSE_CALLS).map(() => null));
    expect(count).not.toHaveBeenCalled();
    const estimated = await measureTokens(head, createTokenCounter());
    expect(estimated.configurations.read).toBeGreaterThan(0);
    expect(estimated.responses.invoice_get).toBeGreaterThan(0);
  });
});

it("runs the isolated Node-only counter on JSON, without dependencies or head imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sevdesk-count-"));
  try {
    const script = join(directory, "counter.ts");
    const base = join(directory, "base.json");
    const head = join(directory, "head.json");
    const report = join(directory, "report.json");
    await copyFile(new URL("../../../scripts/tool-surface-tokens.ts", import.meta.url), script);
    await writeFile(base, JSON.stringify(surface()));
    const changed = surface();
    delete changed.responses!.invoice_get;
    await writeFile(head, JSON.stringify(changed));
    await writeFile(
      report,
      JSON.stringify({ version: 1, diff: "untrusted artifact text", pr: 67 }),
    );
    const { stdout } = await promisify(execFile)(process.execPath, [script, base, head, report], {
      cwd: directory,
      env: {},
    });
    expect(stdout).toBe("");
    const estimated: unknown = JSON.parse(await readFile(report, "utf8"));
    expect(estimated).toMatchObject({
      diff: "untrusted artifact text",
      pr: 67,
      tokenCost: {
        method: "estimated",
        head: { responses: { invoice_get: null } },
      },
    });
    await countCapturedReport([base, head, report], {
      method: "exact",
      count: () => Promise.resolve(123),
    });
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      tokenCost: {
        method: "exact",
        base: { configurations: { read: 123 }, responses: { invoice_get: 123 } },
        head: { responses: { invoice_get: null } },
      },
    });
    await expect(countCapturedReport([])).rejects.toThrow("Usage:");
    const link = join(directory, "link.json");
    await symlink(base, link);
    await expect(countCapturedReport([link, head, report])).rejects.toThrow(
      "Invalid counting input file",
    );
    await writeFile(report, "x".repeat(300_001));
    await expect(countCapturedReport([base, head, report])).rejects.toThrow(
      "Invalid counting input file",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reads the validated inode even when its path is replaced before the read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sevdesk-count-race-"));
  const base = join(directory, "base.json");
  const head = join(directory, "head.json");
  const report = join(directory, "report.json");
  try {
    await writeFile(base, JSON.stringify(surface()));
    await writeFile(head, JSON.stringify(surface()));
    await writeFile(report, JSON.stringify({ version: 1 }));
    const handle = await open(base, "r");
    const stat = handle.stat.bind(handle);
    const read = vi.spyOn(handle, "readFile");
    const close = vi.spyOn(handle, "close");
    vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
      const checked = await stat();
      await rename(base, join(directory, "original.json"));
      await writeFile(base, "replacement is not JSON");
      return checked;
    });
    vi.mocked(open).mockResolvedValueOnce(handle);
    await countCapturedReport([base, head, report]);
    const result = JSON.parse(await readFile(report, "utf8")) as {
      tokenCost: { base: unknown; head: unknown };
    };
    expect(result.tokenCost.base).toEqual(result.tokenCost.head);
    expect(read).toHaveBeenCalledExactlyOnceWith("utf8");
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(base, "utf8")).toBe("replacement is not JSON");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["oversized", "nonregular", "stat", "read", "parse"])(
  "closes the counting input handle after %s failure",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "sevdesk-count-close-"));
    const base = join(directory, "base.json");
    try {
      await writeFile(base, failure === "parse" ? "not JSON" : JSON.stringify(surface()));
      const handle = await open(base, "r");
      const close = vi.spyOn(handle, "close");
      const read = vi.spyOn(handle, "readFile");
      if (failure === "oversized" || failure === "nonregular") {
        const checked = await handle.stat();
        if (failure === "oversized") checked.size = 20_000_001;
        if (failure === "nonregular") vi.spyOn(checked, "isFile").mockReturnValue(false);
        vi.spyOn(handle, "stat").mockResolvedValue(checked);
      }
      if (failure === "stat") vi.spyOn(handle, "stat").mockRejectedValue(new Error("stat failed"));
      if (failure === "read") read.mockRejectedValue(new Error("read failed"));
      vi.mocked(open).mockResolvedValueOnce(handle);
      await expect(countCapturedReport([base, "unused-head", "unused-report"])).rejects.toThrow();
      expect(close).toHaveBeenCalledOnce();
      if (["oversized", "nonregular", "stat"].includes(failure))
        expect(read).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
