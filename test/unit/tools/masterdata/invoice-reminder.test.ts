import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceReminderTool as tool } from "../../../../src/tools/invoices/reminder.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  changingAfter,
  EMPTY,
  invoiceReadRoutes,
  patched,
  patchedRecord,
  routeTable,
  UNITS_ROUTE,
} from "./support.js";

const INVOICE = "invoices/invoice-1001.json";
const CREATE = "/Invoice/Factory/createInvoiceReminder";

const table: (readonly [string, FakeRoute])[] = [
  ["invoice", invoiceReadRoutes(1001, { fixture: INVOICE })[0] as FakeRoute],
  [
    "positions",
    invoiceReadRoutes(1001, { fixture: "invoices/invoice-positions-1001.json" })[1] as FakeRoute,
  ],
  ["units", UNITS_ROUTE],
  [
    "existing",
    {
      path: "/Invoice",
      query: {
        "origin[id]": 1001,
        "origin[objectName]": "Invoice",
        invoiceType: "MA",
        showMa: "all",
      },
      response: EMPTY,
    },
  ],
  [
    "create",
    {
      method: "POST",
      path: CREATE,
      response: { fixture: "masterdata/invoice-reminder-1102.json" },
    },
  ],
];

function routes(overrides: Partial<Record<string, FakeRoute["response"]>> = {}): FakeRoute[] {
  return [
    ...routeTable(table, overrides),
    ...invoiceReadRoutes(
      1102,
      overrides["readBack"] ?? { fixture: "masterdata/invoice-1102.json" },
      { fixture: "masterdata/invoice-positions-1102.json" },
    ),
  ];
}

function invoice(patch: Record<string, unknown>): FakeRoute["response"] {
  return patched(INVOICE, patch);
}

describe("sevdesk_invoice_create_reminder", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a write tool with create annotations in the invoices toolset", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("invoices");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("previews a reminder for an overdue invoice", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, { invoiceId: 1001 }, client);
    expect(plan.preview).toEqual({
      action: "Create a reminder (Mahnung) draft for Invoice RE-1001 (id 1001).",
      facts: [
        { label: "Invoice", value: "Invoice RE-1001 (id 1001) (Open / due)" },
        { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
        { label: "Invoice net", value: "149.02 EUR" },
        { label: "Invoice tax", value: expect.stringMatching(/ EUR$/) as string },
        { label: "Invoice gross", value: "177.33 EUR" },
        { label: "Paid so far", value: "0.00 EUR" },
        { label: "Due date", value: "2026-10-15 (23 days overdue)" },
      ],
      warnings: [
        "The reminder (Mahnung, invoice type MA) is created as a draft and not sent. Finalize " +
          "or send it with sevdesk_invoice_finalize or sevdesk_invoice_send_email.",
        "sevDesk does not accept a reminder fee (Mahngebühr) through the API on Update 2.0.",
      ],
      irreversible: false,
    });
    expect(client.writes()).toEqual([]);
    expect(client.callsTo("/Invoice")[0]?.query).toMatchObject({
      "contact[id]": 1001,
      "origin[id]": 1001,
      invoiceType: "MA",
      showMa: "all",
    });
  });

  it("creates the reminder with the invoice in query and body, and reads it back", async () => {
    const client = new FakeSevdeskClient(routes());
    const { output } = await executeWrite(tool, { invoiceId: 1001 }, client);
    expect(
      client.writes().map((call) => [call.method, call.path, call.tier, call.query, call.body]),
    ).toEqual([
      [
        "POST",
        CREATE,
        "write",
        { "invoice[id]": 1001, "invoice[objectName]": "Invoice" },
        { invoice: { id: 1001, objectName: "Invoice" } },
      ],
    ]);
    expect(output.data.reminder).toMatchObject({
      id: 1102,
      type: { code: "MA" },
      status: { code: 100 },
      reminder: { dunningLevel: 1 },
    });
    expect(output.data.invoiceId).toBe(1001);
    expect(output.data.positions).toHaveLength(1);
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "1102" }]);
    expect(output.summary).toBe(
      "Created reminder draft 1102 for invoice 1001; it is not sent yet " +
        "(sevdesk_invoice_finalize or sevdesk_invoice_send_email).",
    );
  });

  it("shows the current dunning level and treats a missing payment term as due at once", async () => {
    const client = new FakeSevdeskClient(
      routes({ invoice: invoice({ timeToPay: null, dunningLevel: "1", status: "750" }) }),
    );
    const plan = await prepareWrite(tool, { invoiceId: 1001 }, client);
    expect(plan.preview.facts).toContainEqual({
      label: "Due date",
      value: "2026-10-01 (37 days overdue)",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Current dunning level (Mahnstufe)",
      value: "1",
    });
  });

  it.each([
    [{ invoiceDate: "2026-11-01T00:00:00+01:00" }, "is due on 2026-11-15; a reminder (Mahnung)"],
    [{ invoiceDate: "2026-10-24T00:00:00+02:00" }, "is due on 2026-11-07"],
    [{ invoiceDate: null }, "has no invoice date, so it cannot be overdue."],
    [{ status: "100" }, "is still a draft; only finalized, unpaid invoices are dunned."],
    [{ status: "1000" }, "is paid (or cancelled); there is nothing to remind of."],
    [{ status: "50" }, "has status 50; reminders are created for open or partially paid"],
    [{ invoiceType: "MA" }, "is a reminder (Mahnung); use the invoice it reminds of"],
    [{ invoiceType: "SR" }, "is a cancellation invoice (Stornorechnung), so a reminder"],
  ])("refuses %o", async (patch, message) => {
    const client = new FakeSevdeskClient(routes({ invoice: invoice(patch) }));
    await expect(prepareWrite(tool, { invoiceId: 1001 }, client)).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(message) as string,
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses when an unsent reminder draft exists, not for sent ones", async () => {
    const rows = [
      {
        id: "1102",
        invoiceType: "MA",
        status: "100",
        origin: { id: "1001", objectName: "Invoice" },
      },
      {
        id: "1103",
        invoiceType: "MA",
        status: "200",
        origin: { id: "1001", objectName: "Invoice" },
      },
      {
        id: "1104",
        invoiceType: "RE",
        status: "100",
        origin: { id: "1001", objectName: "Invoice" },
      },
      {
        id: "1105",
        invoiceType: "MA",
        status: "100",
        origin: { id: "2002", objectName: "Invoice" },
      },
    ];
    const client = new FakeSevdeskClient(routes({ existing: { body: { objects: rows } } }));
    await expect(prepareWrite(tool, { invoiceId: 1001 }, client)).rejects.toMatchObject({
      message:
        "An unsent reminder draft for Invoice RE-1001 (id 1001) exists already: invoice 1102. " +
        "Finalize or send that one (sevdesk_invoice_finalize, sevdesk_invoice_send_email), or " +
        "call again with allowDuplicate: true.",
    });
    const plan = await prepareWrite(tool, { invoiceId: 1001, allowDuplicate: true }, client);
    expect(plan.preview.warnings).toContain(
      "Creating another one (allowDuplicate): reminder draft 1102 exists already.",
    );

    const sent = new FakeSevdeskClient(routes({ existing: { body: { objects: rows.slice(1) } } }));
    await expect(prepareWrite(tool, { invoiceId: 1001 }, sent)).resolves.toBeDefined();
  });

  it("warns when the reminder scan was cut", async () => {
    const objects = Array.from({ length: 5001 }, (_, index) => ({ id: String(40_000 + index) }));
    const client = new FakeSevdeskClient(routes({ existing: { body: { objects } } }));
    const plan = await prepareWrite(tool, { invoiceId: 1001 }, client);
    expect(plan.preview.warnings).toContain(
      "Not every reminder could be checked for an unsent draft for this invoice.",
    );
  });

  it("reports the reminder when the read-back fails", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Invoice/1102",
        response: { error: new SevdeskError({ kind: "server", status: 500, message: "x" }) },
      },
      ...routes(),
    ]);
    await expect(executeWrite(tool, { invoiceId: 1001 }, client)).rejects.toMatchObject({
      kind: "server",
      completedWrites: [{ objectName: "Invoice", id: "1102" }],
    });
  });

  it("refuses to claim a draft when the read-back is no MA draft", async () => {
    const notMa = new FakeSevdeskClient(
      routes({ readBack: patched("masterdata/invoice-1102.json", { invoiceType: "RE" }) }),
    );
    await expect(executeWrite(tool, { invoiceId: 1001 }, notMa)).rejects.toMatchObject({
      kind: "unexpected_response",
      message:
        "sevDesk created reminder 1102, but not as the expected draft: it has type RE instead " +
        "of MA. Check it with sevdesk_invoice_get before doing anything else.",
      completedWrites: [{ objectName: "Invoice", id: "1102" }],
    });
    const sent = new FakeSevdeskClient(
      routes({ readBack: patched("masterdata/invoice-1102.json", { status: "200" }) }),
    );
    await expect(executeWrite(tool, { invoiceId: 1001 }, sent)).rejects.toMatchObject({
      message: expect.stringContaining("its status is 200, not 100 (draft)") as string,
    });
  });

  it("lists the dunned invoice in affected when sevDesk changed it", async () => {
    const base = new FakeSevdeskClient(routes());
    const client = changingAfter(
      base,
      "/Invoice/1001",
      1,
      patchedRecord(INVOICE, { dunningLevel: "1", update: "2026-11-07T13:00:00+01:00" }),
    );
    const { output } = await executeWrite(tool, { invoiceId: 1001 }, client);
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1102" },
      { objectName: "Invoice", id: "1001" },
    ]);
  });
});
