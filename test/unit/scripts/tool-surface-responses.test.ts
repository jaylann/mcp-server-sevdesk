import { describe, expect, it } from "vitest";
import { z } from "zod";

import { captureResponses, expandRecordedRows } from "../../../scripts/tool-surface-responses.js";
import { createTokenCounter } from "../../../scripts/tool-surface-tokens.js";
import { ALL_TOOLS } from "../../../src/tools/index.js";
import { invoiceGetTool } from "../../../src/tools/invoices/get.js";
import { invoicesListTool } from "../../../src/tools/invoices/list.js";

function listData(text: string | undefined): { items: { id: number }[]; limit: number } {
  expect(text).toBeDefined();
  return JSON.parse(text!.slice(text!.indexOf("\n\n") + 2)) as {
    items: { id: number }[];
    limit: number;
  };
}

describe("recorded response corpus", () => {
  it("expands recorded shapes deterministically with distinct ids and leaves input untouched", () => {
    const recorded = [
      { id: "100", label: "a", nested: { value: 0 } },
      { id: "103", label: "b" },
    ];
    const original = structuredClone(recorded);
    for (const size of [25, 100]) {
      const expanded = expandRecordedRows(recorded, size);
      expect(expanded).toHaveLength(size);
      expect(new Set(expanded.map((value) => (value as { id: string }).id)).size).toBe(size);
      expect(expanded.slice(0, 2)).toEqual(recorded);
      expect(expandRecordedRows(recorded, size)).toEqual(expanded);
      expect(recorded).toEqual(original);
    }
  });

  it("keeps successful calls when tools are missing, erroring or have no fixture route", async () => {
    const tools = ALL_TOOLS.filter((tool) => tool.name !== "sevdesk_invoices_list").map((tool) =>
      tool.name === "sevdesk_invoice_get"
        ? { ...invoiceGetTool, handler: () => Promise.reject(new Error("failure")) }
        : tool,
    );
    const responses = await captureResponses(tools);
    expect(responses.invoice_get).toBeUndefined();
    expect(responses.invoices_list).toBeUndefined();
    expect(responses.invoices_list_max).toBeUndefined();
    expect(listData(responses.contacts_search).items).toHaveLength(25);
    expect(responses.records_summarize).toContain("100 counted");
    const missingRoute = {
      ...invoiceGetTool,
      handler: async (_args: unknown, ctx: Parameters<typeof invoiceGetTool.handler>[1]) => {
        await ctx.client.request({ method: "GET", path: "/Invoice/999999" });
        throw new Error("Unreachable");
      },
    };
    expect(await captureResponses([missingRoute])).toEqual({});
  });

  it("measures a default-limit change and captures 100 distinct invoice rows", async () => {
    const before = await captureResponses([invoicesListTool]);
    const after = await captureResponses([
      {
        ...invoicesListTool,
        input: invoicesListTool.input.extend({
          limit: z.number().int().min(1).max(100).default(10),
        }),
      },
    ]);
    expect(listData(before.invoices_list).items).toHaveLength(25);
    expect(listData(after.invoices_list).items).toHaveLength(10);
    const maximum = listData(before.invoices_list_max).items;
    expect(maximum).toHaveLength(100);
    expect(new Set(maximum.map((item) => item.id)).size).toBe(100);
    expect(after.invoices_list_max).toBe(before.invoices_list_max);
    const counter = createTokenCounter();
    expect(await counter.count({ kind: "response", text: after.invoices_list! })).toBeLessThan(
      await counter.count({ kind: "response", text: before.invoices_list! }),
    );
  });
});
