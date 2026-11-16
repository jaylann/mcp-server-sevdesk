/**
 * `sevdesk_document_delete_draft` never sends a DELETE for a document that is not a draft.
 *
 * sevDesk refuses to delete invoices, orders and credit notes outside status 100 with 409
 * (spec/deviations.md D-109, D-074), but it deletes recurring invoice templates (WKR) at status
 * 100 and 50 (D-112), and a refusal that depends on sevDesk alone would leave the safety of a
 * GoBD-relevant record to an upstream check. So the tool refuses every non-draft, every template
 * and every kind whose toolset is off before any data-changing request, and binds the approval to
 * the stored draft: an edit between the preview and the approval asks the human again.
 */
import { describe, expect, it } from "vitest";

import { documentDeleteDraftTool } from "../../src/tools/documents/delete-draft-tool.js";
import type { ToolsetName } from "../../src/tools/toolsets.js";
import { approve } from "../helpers/confirm-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultText,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  orderRow,
  positionRoutes,
  type Row,
  writeRoute,
} from "../unit/tools/lifecycle/helpers.js";

closeWriteHarnessesAfterEach();

type Kind = "invoice" | "creditNote" | "order";

const PATHS: Readonly<Record<Kind, string>> = {
  invoice: "/Invoice/1001",
  creditNote: "/CreditNote/2001",
  order: "/Order/3002",
};

const ARGS: Readonly<Record<Kind, { kind: string; id: number }>> = {
  invoice: { kind: "invoice", id: 1001 },
  creditNote: { kind: "credit_note", id: 2001 },
  order: { kind: "order", id: 3002 },
};

const NON_DRAFTS: readonly [string, Kind, Row][] = [
  ["an open invoice", "invoice", invoiceRow()],
  ["a paid invoice", "invoice", invoiceRow({ status: "1000", paidAmount: "177.33" })],
  ["an open credit note", "creditNote", creditNoteRow()],
  ["a sent order", "order", orderRow({ status: "200" })],
  ["an accepted order", "order", orderRow()],
  ["an active recurring template", "invoice", invoiceRow({ status: "200", invoiceType: "WKR" })],
  [
    "a recurring template at status 100",
    "invoice",
    invoiceRow({ status: "100", invoiceType: "WKR" }),
  ],
  ["a deactivated recurring template", "invoice", invoiceRow({ status: "50", invoiceType: "WKR" })],
];

describe("the draft delete never sends a DELETE for a non-draft", () => {
  it.each(NON_DRAFTS)("refuses %s without a write", async (_label, kind, row) => {
    const { client, fake, prompts } = await writeHarness({
      tools: [documentDeleteDraftTool],
      routes: [
        documentRoute(kind, row),
        ...positionRoutes(),
        writeRoute("DELETE", PATHS[kind], "document-delete.json"),
      ],
      connect: { era: "modern", transport: "http", answer: approve },
    });
    const result = await client.callTool({
      name: "sevdesk_document_delete_draft",
      arguments: ARGS[kind],
    });
    expect(result.isError).toBe(true);
    expect(prompts).toHaveLength(0);
    expect(writesOf(fake)).toEqual([]);
  });

  it("refuses a kind whose toolset is off without reading or writing", async () => {
    const { client, fake } = await writeHarness({
      tools: [documentDeleteDraftTool],
      routes: [documentRoute("order", orderRow({ status: "100" })), ...positionRoutes()],
      config: { toolsets: new Set<ToolsetName>(["meta", "invoices"]) },
      connect: { era: "modern", transport: "http", answer: approve },
    });
    const result = await client.callTool({
      name: "sevdesk_document_delete_draft",
      arguments: ARGS.order,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("needs the orders toolset");
    expect(fake.calls).toEqual([]);
  });

  it("asks again when the draft changes after the human was asked", async () => {
    const row = invoiceRow({ status: "100", invoiceNumber: null, footText: "Danke." });
    const { client, fake, prompts } = await writeHarness({
      tools: [documentDeleteDraftTool],
      routes: [
        documentRoute("invoice", row),
        ...positionRoutes(),
        writeRoute("DELETE", PATHS.invoice, "document-delete.json"),
      ],
      connect: {
        era: "modern",
        transport: "http",
        answer: (params) => {
          // While the human reads the first prompt, the draft is edited.
          if (prompts.length === 1) row["footText"] = "Andere Bankverbindung.";
          return approve(params);
        },
      },
    });
    await client.callTool({ name: "sevdesk_document_delete_draft", arguments: ARGS.invoice });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.message).toMatch(/^The record changed after you were asked/);
    expect(writesOf(fake)).toEqual([{ method: "DELETE", path: PATHS.invoice }]);
  });
});
