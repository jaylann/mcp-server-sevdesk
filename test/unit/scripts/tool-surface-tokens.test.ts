import { describe, expect, it, vi } from "vitest";

import { measureTokens, surfaceReport, type ToolSurface } from "../../../scripts/tool-surface.js";
import { RESPONSE_CALLS } from "../../../scripts/tool-surface-responses.js";
import { createTokenCounter, TOKEN_MODEL } from "../../../scripts/tool-surface-tokens.js";

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
    ) as NonNullable<ToolSurface["responses"]>,
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

  it("uses the fixed model and subtracts one shared baseline for context and response text", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(110)
      .mockResolvedValueOnce(45);
    const counter = createTokenCounter("test-key", api);
    expect(counter.method).toBe("exact");
    expect(await counter.count({ kind: "context", view })).toBe(100);
    expect(await counter.count({ kind: "response", text: 'Summary\n\n{"x":1}' })).toBe(35);
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
