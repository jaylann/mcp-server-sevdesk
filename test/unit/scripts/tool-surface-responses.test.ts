import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  captureResponses,
  expandRecordedRows,
  RESPONSE_CALLS,
} from "../../../scripts/tool-surface-responses.js";
import { createTokenCounter, RESPONSE_IDS } from "../../../scripts/tool-surface-tokens.js";
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
  it("keeps each summary call immediately after its full counterpart in both vocabularies", () => {
    expect(RESPONSE_CALLS).toEqual({
      invoice_get: { name: "sevdesk_invoice_get", arguments: { id: 138793718 } },
      records_summarize: {
        name: "sevdesk_records_summarize",
        arguments: { subject: "invoices", groupBy: "month" },
      },
      contacts_search: { name: "sevdesk_contacts_search", arguments: {} },
      transactions_list: { name: "sevdesk_transactions_list", arguments: {} },
      transactions_list_summary: {
        name: "sevdesk_transactions_list",
        arguments: { detail: "summary" },
      },
      vouchers_list: { name: "sevdesk_vouchers_list", arguments: {} },
      vouchers_list_summary: { name: "sevdesk_vouchers_list", arguments: { detail: "summary" } },
      invoices_list: { name: "sevdesk_invoices_list", arguments: {} },
      invoices_list_summary: { name: "sevdesk_invoices_list", arguments: { detail: "summary" } },
      invoices_list_max: { name: "sevdesk_invoices_list", arguments: { limit: 100 } },
      invoices_list_summary_max: {
        name: "sevdesk_invoices_list",
        arguments: { detail: "summary", limit: 100 },
      },
    });
    expect(Object.keys(RESPONSE_CALLS)).toEqual([
      "invoice_get",
      "records_summarize",
      "contacts_search",
      "transactions_list",
      "transactions_list_summary",
      "vouchers_list",
      "vouchers_list_summary",
      "invoices_list",
      "invoices_list_summary",
      "invoices_list_max",
      "invoices_list_summary_max",
    ]);
    expect(RESPONSE_IDS).toEqual(Object.keys(RESPONSE_CALLS));
  });

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
    expect(responses.invoices_list_summary).toBeUndefined();
    expect(responses.invoices_list_summary_max).toBeUndefined();
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
    expect(listData(before.invoices_list_summary).items).toHaveLength(25);
    expect(listData(after.invoices_list_summary).items).toHaveLength(10);
    const maximum = listData(before.invoices_list_max).items;
    expect(maximum).toHaveLength(100);
    expect(new Set(maximum.map((item) => item.id)).size).toBe(100);
    expect(after.invoices_list_max).toBe(before.invoices_list_max);
    expect(after.invoices_list_summary_max).toBe(before.invoices_list_summary_max);
    const counter = createTokenCounter();
    expect(await counter.count({ kind: "response", text: after.invoices_list! })).toBeLessThan(
      await counter.count({ kind: "response", text: before.invoices_list! }),
    );
  });

  it("omits summary captures when a base tool does not support detail", async () => {
    const responses = await captureResponses([
      { ...invoicesListTool, input: invoicesListTool.input.omit({ detail: true }) },
    ]);
    expect(Object.keys(responses)).toEqual(["invoices_list", "invoices_list_max"]);
  });
});
