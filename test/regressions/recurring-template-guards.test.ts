/**
 * A recurring invoice template (Abo-Rechnung, type WKR) never becomes, or is treated as, an
 * invoice of its own through this server's other tools.
 *
 * sevDesk saves a template with `saveInvoice` like a draft (status 100, no number, spec/deviations.md
 * D-111, D-112) and deletes one at status 100 and 50. A tool that only checked the status would
 * finalize, send, book, cancel, update or delete it, and a finalized template would put an invoice
 * without a customer's order into the books while sevDesk keeps billing from it. So the template
 * that `sevdesk_invoice_create_recurring` leaves behind (automatic generation on, D-132) is
 * created here through MCP, and every tool that takes an invoice id must refuse it before any
 * data-changing request, at the status the tool saves with and at the other statuses a template
 * can have (200 active, 50 deactivated). The drafts sevDesk generates from it are type RE and go
 * through those tools like any draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { documentDeleteDraftTool } from "../../src/tools/documents/delete-draft-tool.js";
import { invoiceUpdateDraftTool } from "../../src/tools/invoices/draft-update.js";
import { INVOICE_LIFECYCLE_TOOLS } from "../../src/tools/invoices/lifecycle-tools.js";
import { invoiceCreateRecurringTool } from "../../src/tools/invoices/recurring-create.js";
import { approve } from "../helpers/confirm-client.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultText,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import {
  recurringCreateArgs,
  recurringCreateRoutes,
  SETTINGS_ON,
  templateRow as storedTemplate,
} from "../unit/tools/invoices/recurring-routes.js";
import { accountRoute, accountRow, positionRoutes } from "../unit/tools/lifecycle/helpers.js";

closeWriteHarnessesAfterEach();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-17T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const TOOLS = [
  invoiceCreateRecurringTool,
  ...INVOICE_LIFECYCLE_TOOLS,
  invoiceUpdateDraftTool,
  documentDeleteDraftTool,
];

/** The template as the tool's read-back shows it, at `status`, with automatic generation on. */
function templateRow(status: string): Record<string, unknown> {
  return storedTemplate({ ...SETTINGS_ON, status });
}

/** Every read of template 2301 answers `row` (with and without an embedded contact). */
function templateRoutes(row: Record<string, unknown>): FakeRoute[] {
  return [
    { path: "/Invoice/2301", response: { body: { objects: [row] } } },
    ...positionRoutes(),
    accountRoute(accountRow(4001)),
  ];
}

const email = { to: "kunde@example.com", subject: "Ihre Rechnung", text: "Guten Tag, anbei." };

/** Each tool that takes an invoice id, with valid arguments and the refusal it must give. */
const ATTEMPTS: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ["sevdesk_invoice_finalize", { id: 2301 }, "recurring invoice template (WKR, Abo-Rechnung)"],
  [
    "sevdesk_invoice_send_email",
    { id: 2301, ...email },
    "recurring invoice template (WKR, Abo-Rechnung)",
  ],
  ["sevdesk_invoice_cancel", { id: 2301 }, "recurring invoice template (WKR, Abo-Rechnung)"],
  [
    "sevdesk_invoice_book_payment",
    { id: 2301, amount: "65.45", date: "2026-11-17", checkAccountId: 4001 },
    "recurring invoice template (WKR, Abo-Rechnung)",
  ],
  ["sevdesk_invoice_enshrine", { id: 2301 }, "recurring invoice template (WKR, Abo-Rechnung)"],
  [
    "sevdesk_invoice_reset",
    { id: 2301, to: "draft" },
    "recurring invoice template (WKR, Abo-Rechnung)",
  ],
  [
    "sevdesk_invoice_reset",
    { id: 2301, to: "open" },
    "recurring invoice template (WKR, Abo-Rechnung)",
  ],
  ["sevdesk_invoice_update_draft", { id: 2301, header: "Neu" }, "is a recurring invoice (WKR)"],
  [
    "sevdesk_document_delete_draft",
    { kind: "invoice", id: 2301 },
    "recurring invoice template (WKR, Abo-Rechnung), not a draft",
  ],
];

describe("a template made by sevdesk_invoice_create_recurring", () => {
  it("is refused by every tool that would finalize, send, book, cancel, change or delete it", async () => {
    const { client, fake, prompts } = await writeHarness({
      tools: TOOLS,
      // The create's routes first; the template's routes serve the reads without `embed`.
      routes: [...recurringCreateRoutes, ...templateRoutes(templateRow("100"))],
      connect: { era: "modern", transport: "http", answer: approve },
    });
    const created = await client.callTool({
      name: "sevdesk_invoice_create_recurring",
      arguments: recurringCreateArgs,
    });
    expect(created.isError).not.toBe(true);
    expect(resultData(created)).toMatchObject({
      status: "done",
      result: {
        invoice: { id: 2301, type: { code: "WKR" }, status: { code: 100 } },
        schedule: { autoGenerate: "on", autoSendConfigured: false },
      },
    });
    expect(writesOf(fake)).toEqual([{ method: "POST", path: "/Invoice/Factory/saveInvoice" }]);
    const asked = prompts.length;

    for (const [name, args, refusal] of ATTEMPTS) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      expect(resultText(result), name).toContain(refusal);
    }
    // Nobody was asked again, and nothing but the template's own save was sent.
    expect(prompts).toHaveLength(asked);
    expect(writesOf(fake)).toEqual([{ method: "POST", path: "/Invoice/Factory/saveInvoice" }]);
  });
});

describe("a template at any status", () => {
  it.each(["100", "200", "50"])(
    "status %s: every invoice tool refuses it without a write",
    async (status) => {
      const { client, fake, prompts } = await writeHarness({
        tools: TOOLS,
        routes: templateRoutes(templateRow(status)),
        connect: { era: "modern", transport: "http", answer: approve },
      });
      for (const [name, args, refusal] of ATTEMPTS) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBe(true);
        // The draft update checks the status before the type (a template outside 100 is "not a
        // draft" there); every other tool names the template.
        if (name !== "sevdesk_invoice_update_draft" || status === "100") {
          expect(resultText(result), name).toContain(refusal);
        }
      }
      expect(prompts).toHaveLength(0);
      expect(writesOf(fake)).toEqual([]);
    },
  );
});
