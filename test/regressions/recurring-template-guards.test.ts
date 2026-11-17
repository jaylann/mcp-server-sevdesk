/**
 * A recurring invoice template (Abo-Rechnung, type WKR) never becomes, or is treated as, an
 * invoice of its own through this server's other tools.
 *
 * sevDesk saves a template with `saveInvoice` like a draft (status 100, no number, spec/deviations.md
 * D-111, D-112) and deletes one at status 100 and 50. A tool that only checked the status would
 * finalize, send, book, cancel, update or delete it, or create a reminder or a credit note from it,
 * and a finalized template would put an invoice without a customer's order into the books while
 * sevDesk keeps billing from it. So the template that `sevdesk_invoice_create_recurring` leaves
 * behind (automatic generation on, D-132) is created here through MCP, and every tool that takes
 * an invoice id must refuse it before any data-changing request, at the status the tool saves
 * with and at the other statuses a template can have (200 active, 50 deactivated). The drafts
 * sevDesk generates from it are type RE and go through those tools like any draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { transactionBookTool } from "../../src/tools/banking/transaction-book.js";
import { creditNoteFromInvoiceTool } from "../../src/tools/credit-notes/from-invoice.js";
import { documentDeleteDraftTool } from "../../src/tools/documents/delete-draft-tool.js";
import { documentSetLayoutTool } from "../../src/tools/documents/layout-tool.js";
import { invoiceUpdateDraftTool } from "../../src/tools/invoices/draft-update.js";
import { INVOICE_LIFECYCLE_TOOLS } from "../../src/tools/invoices/lifecycle-tools.js";
import { invoiceCreateRecurringTool } from "../../src/tools/invoices/recurring-create.js";
import { invoiceEndRecurringTool } from "../../src/tools/invoices/recurring-status.js";
import { invoiceUpdateRecurringTool } from "../../src/tools/invoices/recurring-update.js";
import { invoiceReminderTool } from "../../src/tools/invoices/reminder.js";
import { approve } from "../helpers/confirm-client.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultText,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import { invoiceUpdateRoutes } from "../unit/tools/drafts/routes.js";
import { templateChangeRoutes } from "../unit/tools/invoices/recurring-manage-routes.js";
import {
  recurringCreateArgs,
  recurringCreateRoutes,
  SETTINGS_ON,
  templateRow as storedTemplate,
} from "../unit/tools/invoices/recurring-routes.js";
import {
  accountRoute,
  accountRow,
  positionRoutes,
  transactionLogRoute,
  transactionRoute,
  transactionRow,
} from "../unit/tools/lifecycle/helpers.js";

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
  documentSetLayoutTool,
  invoiceReminderTool,
  creditNoteFromInvoiceTool,
  transactionBookTool,
];

/** The template as the tool's read-back shows it, at `status`, with automatic generation on. */
function templateRow(status: string): Record<string, unknown> {
  return storedTemplate({ ...SETTINGS_ON, status });
}

/**
 * Every read of template 2301 answers `row` (with and without an embedded contact); payment
 * account 4001, and the free bank transaction 5101 on account 4002 for the booking.
 */
function templateRoutes(row: Record<string, unknown>): FakeRoute[] {
  return [
    { path: "/Invoice/2301", response: { body: { objects: [row] } } },
    ...positionRoutes(),
    accountRoute(accountRow(4001)),
    transactionRoute(transactionRow()),
    transactionLogRoute(),
    accountRoute(accountRow(4002)),
  ];
}

/** The refusal of a document created from the template (`derived-documents.ts`). */
const derivedRefusal = (what: string) =>
  "Invoice 2301 is a recurring invoice template (Abo-Rechnung); use one of the invoices it " +
  `created, so ${what} cannot be created from it.`;

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
  [
    "sevdesk_invoice_update_draft",
    { id: 2301, header: "Neu" },
    "Change a recurring invoice template with sevdesk_invoice_update_recurring.",
  ],
  [
    "sevdesk_document_delete_draft",
    { kind: "invoice", id: 2301 },
    "recurring invoice template (WKR, Abo-Rechnung), not a draft",
  ],
  [
    "sevdesk_document_set_layout",
    { kind: "invoice", id: 2301, language: "en_US" },
    "is a recurring invoice template (WKR, Abo-Rechnung); its layout is not set here.",
  ],
  ["sevdesk_invoice_create_reminder", { invoiceId: 2301 }, derivedRefusal("a reminder")],
  ["sevdesk_credit_note_create_from_invoice", { invoiceId: 2301 }, derivedRefusal("a credit note")],
  [
    "sevdesk_transaction_book",
    { id: 5101, allocations: [{ kind: "invoice", id: 2301 }] },
    "is a recurring invoice template (WKR, Abo-Rechnung); sevDesk creates invoices from it, and " +
      "a template cannot be paid.",
  ],
];

describe("a template made by sevdesk_invoice_create_recurring", () => {
  it("is refused by every tool that would finalize, send, book, cancel, change, delete or derive from it", async () => {
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
        // Every tool names the template, the draft update at every status too (it checks the
        // type before the status, so it never says "reset it to a draft").
        expect(resultText(result), name).toContain(refusal);
      }
      expect(prompts).toHaveLength(0);
      expect(writesOf(fake)).toEqual([]);
    },
  );
});

describe("a template changed and ended by the template tools", () => {
  it("is still refused by every other invoice tool", async () => {
    const { client, fake } = await writeHarness({
      tools: [...TOOLS, invoiceUpdateRecurringTool, invoiceEndRecurringTool],
      routes: [
        ...templateChangeRoutes(),
        accountRoute(accountRow(4001)),
        // The free bank transaction 5101 on account 4002 for the booking attempt.
        transactionRoute(transactionRow()),
        transactionLogRoute(),
        accountRoute(accountRow(4002)),
      ],
      connect: { era: "modern", transport: "http", answer: approve },
    });
    for (const [name, args] of [
      ["sevdesk_invoice_update_recurring", { id: 2301, interval: "quarterly", header: "Neu" }],
      ["sevdesk_invoice_end_recurring", { id: 2301 }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).not.toBe(true);
      expect(resultData(result), name).toMatchObject({ status: "done" });
    }
    const saves = [
      { method: "POST", path: "/Invoice/Factory/saveInvoice" },
      { method: "POST", path: "/Invoice/Factory/saveInvoice" },
    ];
    expect(writesOf(fake)).toEqual(saves);

    for (const [name, args, refusal] of ATTEMPTS) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      expect(resultText(result), name).toContain(refusal);
    }
    expect(writesOf(fake)).toEqual(saves);
  });
});

/**
 * Issue #91: the invoices sevDesk generates from a template are regular invoices (type RE) whose
 * `origin` names the template. They must keep working with the lifecycle tools: no tool may take
 * the origin for a template.
 */
describe("an invoice generated from a template (RE, origin: the template)", () => {
  const generated = (status: string): Record<string, unknown> => ({
    ...templateRow(status),
    invoiceType: "RE",
    origin: { id: "2300", objectName: "Invoice" },
  });

  it.each(["100", "200"])("status %s: no tool refuses it as a template", async (status) => {
    const { client, fake } = await writeHarness({
      tools: TOOLS,
      routes: [...templateRoutes(generated(status)), ...invoiceUpdateRoutes],
      connect: { era: "modern", transport: "http", answer: approve },
    });
    for (const [name, args] of ATTEMPTS) {
      const result = await client.callTool({ name, arguments: { ...args, dryRun: true } });
      const text = resultText(result);
      expect(text, name).not.toContain("recurring invoice template");
      expect(text, name).not.toContain("WKR");
    }
    expect(writesOf(fake)).toEqual([]);
  });

  it("a draft of it can be finalized, changed and deleted (dry runs)", async () => {
    const { client } = await writeHarness({
      tools: TOOLS,
      routes: [...templateRoutes(generated("100")), ...invoiceUpdateRoutes],
      connect: { era: "modern", transport: "http", answer: approve },
    });
    for (const [name, args] of [
      ["sevdesk_invoice_update_draft", { id: 2301, header: "Neu" }],
      ["sevdesk_document_delete_draft", { kind: "invoice", id: 2301 }],
    ] as const) {
      const result = await client.callTool({ name, arguments: { ...args, dryRun: true } });
      expect(result.isError, `${name}: ${resultText(result)}`).not.toBe(true);
    }
  });
});
