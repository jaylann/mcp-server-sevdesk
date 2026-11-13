import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    const api = vi.fn();
    const counter = createTokenCounter(undefined, api);
    expect(counter.method).toBe("estimated");
    expect(await counter.count({ kind: "context", view })).toBe(
      Math.round(Array.from(JSON.stringify({ tools: view.tools }) + view.system).length / 2.3),
    );
    expect(await counter.count({ kind: "response", text: "😀".repeat(23) })).toBe(10);
    expect(api).not.toHaveBeenCalled();
  });

  it("uses the fixed model and subtracts the calibration for context but only framing for responses", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(110)
      .mockResolvedValueOnce(45);
    const counter = createTokenCounter("test-key", api);
    expect(counter.method).toBe("exact");
    expect(await counter.count({ kind: "context", view })).toBe(100);
    expect(await counter.count({ kind: "response", text: 'Summary\n\n{"x":1}' })).toBe(36);
    expect(api.mock.calls).toEqual([
      [{ model: TOKEN_MODEL, messages: [{ role: "user", content: "x" }] }],
      [
        {
          model: TOKEN_MODEL,
          system: view.system,
          tools: view.tools,
          messages: [{ role: "user", content: "x" }],
        },
      ],
      [{ model: TOKEN_MODEL, messages: [{ role: "user", content: 'Summary\n\n{"x":1}' }] }],
    ]);
  });

  it("counts the one-token calibration payload as one response token, not zero", async () => {
    const api = vi.fn().mockResolvedValue(10);
    expect(await createTokenCounter("test-key", api).count({ kind: "response", text: "x" })).toBe(
      1,
    );
  });

  it("uses only the fixed count endpoint and sanitizes fetch failures", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"input_tokens":10}'));
    // Each HTTP response body is consumed once.
    fetch.mockImplementation(() => Promise.resolve(new Response('{"input_tokens":10}')));
    expect(await createTokenCounter("test-key").count({ kind: "response", text: "x" })).toBe(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages/count_tokens",
      expect.objectContaining({
        redirect: "error",
        headers: {
          "x-api-key": "test-key",
          "anthropic-version": "2026-10-21",
          "content-type": "application/json",
        },
      }),
    );
    fetch.mockResolvedValue(new Response("sensitive provider response", { status: 401 }));
    await expect(
      createTokenCounter("test-key").count({ kind: "response", text: "x" }),
    ).rejects.toThrow(/^Token counting failed; see the independent estimated report\.$/);
  });

  it("does not expose provider errors or silently relabel failed exact counts", async () => {
    const api = vi.fn().mockRejectedValue(new Error("sensitive provider request"));
    const counter = createTokenCounter("test-key", api);
    await expect(counter.count({ kind: "context", view })).rejects.toThrow(
      /^Token counting failed; see the independent estimated report\.$/,
    );
  });

  it.each([-1, 1.5, Number.NaN])("rejects invalid exact counts (%s)", async (invalid) => {
    const api = vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(invalid);
    await expect(
      createTokenCounter("test-key", api).count({ kind: "context", view }),
    ).rejects.toThrow("Token counting failed");
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
      env: { ANTHROPIC_API_KEY: "" },
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
