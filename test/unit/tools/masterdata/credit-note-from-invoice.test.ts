import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteFromInvoiceTool as tool } from "../../../../src/tools/credit-notes/from-invoice.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  changingAfter,
  creditNoteReadRoutes,
  directContext,
  EMPTY,
  invoiceReadRoutes,
  patched,
  patchedRecord,
  routeTable,
} from "./support.js";

const INVOICE = "masterdata/invoice-1004.json";
const CREDIT_NOTE = "masterdata/credit-note-2101.json";
const CREATE = "/CreditNote/Factory/createFromInvoice";
const byContact = { "contact[id]": 1001, "contact[objectName]": "Contact" };

const table: (readonly [string, FakeRoute])[] = [
  ["invoice", invoiceReadRoutes(1004, { fixture: INVOICE })[0] as FakeRoute],
  [
    "cancellations",
    {
      path: "/Invoice",
      query: { "origin[id]": 1004, "origin[objectName]": "Invoice", ...byContact },
      response: EMPTY,
    },
  ],
  ["existing", { path: "/CreditNote", query: byContact, response: EMPTY }],
  [
    "create",
    {
      method: "POST",
      path: CREATE,
      response: { fixture: "masterdata/credit-note-from-invoice-2101.json" },
    },
  ],
  ["readBack", creditNoteReadRoutes(2101, { fixture: CREDIT_NOTE })[0] as FakeRoute],
  [
    "readBackPositions",
    creditNoteReadRoutes(2101, EMPTY, {
      fixture: "masterdata/credit-note-positions-2101.json",
    })[1] as FakeRoute,
  ],
  ["units", { path: "/Unity", response: { fixture: "meta/units.json" } }],
];

function routes(
  overrides: Partial<Record<string, FakeRoute["response"]>> = {},
  extra: FakeRoute[] = [],
): FakeRoute[] {
  return routeTable(table, overrides, extra);
}

function invoice(patch: Record<string, unknown>): FakeRoute["response"] {
  return patched(INVOICE, patch);
}

const sr = (id: string, origin: unknown) => ({ id, invoiceType: "SR", status: "1000", origin });
const invoiceRef = { id: "1004", objectName: "Invoice" };

describe("sevdesk_credit_note_create_from_invoice", () => {
  it("is a write tool with create annotations in the credit-notes toolset", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("credit-notes");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("previews a credit note for a paid invoice", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, { invoiceId: 1004 }, client);
    expect(plan.preview).toEqual({
      action: "Create a credit note (Gutschrift) draft from Invoice RE-1004 (id 1004).",
      facts: [
        { label: "Invoice", value: "Invoice RE-1004 (id 1004) (Paid)" },
        { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
        { label: "Invoice net", value: "100.00 EUR" },
        { label: "Invoice tax", value: "19.00 EUR" },
        { label: "Invoice gross", value: "119.00 EUR" },
        { label: "Paid so far", value: "119.00 EUR" },
      ],
      warnings: [
        "The credit note (Gutschrift) is created as a draft with all positions of the invoice; " +
          "adjust it if only part is refunded, then finalize it with " +
          "sevdesk_credit_note_finalize.",
      ],
      irreversible: false,
    });
    expect(client.writes()).toEqual([]);
    // Credit notes are listed by contact only: an origin filter would hide underachievement
    // credit notes, which carry only refSrcInvoice.
    expect(client.callsTo("/CreditNote")[0]?.query).toEqual({
      ...byContact,
      limit: 1000,
      offset: 0,
      countAll: true,
    });
  });

  it("creates the credit note, verifies the draft and reads it back", async () => {
    const client = new FakeSevdeskClient(routes());
    const { output } = await executeWrite(tool, { invoiceId: 1004 }, client);
    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      ["POST", CREATE, "write", { invoice: { id: 1004, objectName: "Invoice" } }],
    ]);
    expect(output.data.creditNote).toMatchObject({
      id: 2101,
      status: { code: 100 },
      sourceInvoiceId: 1004,
    });
    expect(output.data.positions).toHaveLength(1);
    expect(output.data.invoiceId).toBe(1004);
    // The invoice did not change, so only the credit note is affected.
    expect(output.affected).toEqual([{ objectName: "CreditNote", id: "2101" }]);
    expect(output.summary).toBe(
      "Created credit note draft 2101 from invoice 1004; finalize it with " +
        "sevdesk_credit_note_finalize.",
    );
  });

  it("lists the invoice in affected when sevDesk changed it", async () => {
    const base = new FakeSevdeskClient(routes());
    const client = changingAfter(
      base,
      "/Invoice/1004",
      1,
      patchedRecord(INVOICE, { update: "2026-11-07T11:00:00+01:00" }),
    );
    const { output } = await executeWrite(tool, { invoiceId: 1004 }, client);
    expect(output.affected).toEqual([
      { objectName: "CreditNote", id: "2101" },
      { objectName: "Invoice", id: "1004" },
    ]);
  });

  it("refuses to claim a draft when the read-back is not one", async () => {
    const notDraft = new FakeSevdeskClient(
      routes({ readBack: patched(CREDIT_NOTE, { status: "200" }) }),
    );
    await expect(executeWrite(tool, { invoiceId: 1004 }, notDraft)).rejects.toMatchObject({
      kind: "unexpected_response",
      message:
        "sevDesk created credit note 2101, but not as the expected draft: its status is 200, " +
        "not 100 (draft). Check it with sevdesk_credit_note_get before doing anything else.",
      completedWrites: [{ objectName: "CreditNote", id: "2101" }],
    });

    const unlinked = new FakeSevdeskClient(
      routes({ readBack: patched(CREDIT_NOTE, { origin: null, refSrcInvoice: null }) }),
    );
    await expect(executeWrite(tool, { invoiceId: 1004 }, unlinked)).rejects.toMatchObject({
      message: expect.stringContaining(
        "it does not refer to the invoice it was created from",
      ) as string,
      completedWrites: [{ objectName: "CreditNote", id: "2101" }],
    });
  });

  it("suggests cancelling for unpaid invoices", async () => {
    for (const status of ["200", "750"]) {
      const client = new FakeSevdeskClient(routes({ invoice: invoice({ status }) }));
      const plan = await prepareWrite(tool, { invoiceId: 1004 }, client);
      expect(plan.preview.warnings).toContain(
        "The invoice is not fully paid: to void it completely, cancelling it (Storno, " +
          "sevdesk_invoice_cancel) is usually the right correction.",
      );
    }
  });

  it.each([
    [{ status: "100" }, "is still a draft: change it with sevdesk_invoice_update_draft"],
    [{ status: "500" }, "has status 500; credit notes are created from open"],
    [{ invoiceType: "SR" }, "is a cancellation invoice (Stornorechnung), so a credit note"],
    [{ invoiceType: "MA" }, "is a reminder (Mahnung); use the invoice it reminds of"],
    [{ invoiceType: "WKR", status: "50" }, "is a recurring invoice template (Abo-Rechnung)"],
    [{ invoiceType: "XY" }, "is of type XY, so a credit note cannot be created from it."],
  ])("refuses %o", async (patch, message) => {
    const client = new FakeSevdeskClient(routes({ invoice: invoice(patch) }));
    await expect(prepareWrite(tool, { invoiceId: 1004 }, client)).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(message) as string,
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses a cancelled invoice (an SR points to it), D-037", async () => {
    const rows = [
      sr("1009", invoiceRef),
      sr("1010", { id: "9999", objectName: "Invoice" }),
      { id: "1011", invoiceType: "RE", status: "100", origin: invoiceRef },
      sr("1012", { id: "1004", objectName: "Order" }),
    ];
    const client = new FakeSevdeskClient(
      routes({ cancellations: { body: { objects: rows } }, invoice: invoice({ paidAmount: 0 }) }),
    );
    await expect(prepareWrite(tool, { invoiceId: 1004 }, client)).rejects.toMatchObject({
      kind: "validation",
      message:
        "Invoice RE-1004 (id 1004) was cancelled (Storno) by cancellation invoice 1009; its " +
        "revenue is already reversed, so a credit note would reverse it twice. Use " +
        "sevdesk_invoice_get on the cancellation invoice to check.",
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses an unverifiable invoice that looks cancelled, warns otherwise", async () => {
    const many = {
      body: { objects: Array.from({ length: 5001 }, (_, i) => ({ id: String(20_000 + i) })) },
    };
    const looksCancelled = new FakeSevdeskClient(
      routes({ cancellations: many, invoice: invoice({ paidAmount: 0 }) }),
    );
    await expect(prepareWrite(tool, { invoiceId: 1004 }, looksCancelled)).rejects.toMatchObject({
      message: expect.stringContaining(
        "is marked paid but nothing was paid, which is how a cancelled invoice looks",
      ) as string,
    });

    // Paid, or a foreign-currency invoice whose paid amount is unknown: only a warning.
    const paid = new FakeSevdeskClient(routes({ cancellations: many }));
    const foreign = new FakeSevdeskClient(
      routes({ cancellations: many, invoice: invoice({ currency: "USD", paidAmount: 0 }) }),
    );
    await expect(prepareWrite(tool, { invoiceId: 1004 }, foreign)).resolves.toBeDefined();
    const plan = await prepareWrite(tool, { invoiceId: 1004 }, paid);
    expect(plan.preview.warnings).toContain(
      "Not every invoice could be checked for a cancellation (Storno) of this invoice.",
    );

    const settled = new FakeSevdeskClient(routes({ invoice: invoice({ paidAmount: 0 }) }));
    const settledPlan = await prepareWrite(tool, { invoiceId: 1004 }, settled);
    expect(settledPlan.preview.warnings).toContain(
      "The invoice is marked paid but sevDesk shows no payment on it; make sure it was not " +
        "settled another way before crediting it.",
    );
  });

  it("refuses when a credit note refers to the invoice (origin or refSrcInvoice), unless allowDuplicate", async () => {
    const existing = {
      body: {
        objects: [
          { id: "2001", origin: null, refSrcInvoice: invoiceRef },
          { id: "2002", origin: invoiceRef },
          { id: "2003", origin: { id: "9999", objectName: "Invoice" }, refSrcInvoice: "1004" },
          { id: "2004", origin: { id: "9999", objectName: "Invoice" }, refSrcInvoice: null },
          { id: "2005", origin: { id: "1004", objectName: "Voucher" } },
        ],
      },
    };
    const client = new FakeSevdeskClient(routes({ existing }));
    await expect(prepareWrite(tool, { invoiceId: 1004 }, client)).rejects.toMatchObject({
      message:
        "A credit note for Invoice RE-1004 (id 1004) exists already: credit note 2001, credit " +
        "note 2002, credit note 2003. Check it with sevdesk_credit_note_get, or call again " +
        "with allowDuplicate: true to create another one (e.g. a second partial refund).",
    });
    const plan = await prepareWrite(tool, { invoiceId: 1004, allowDuplicate: true }, client);
    expect(plan.preview.warnings).toContain(
      "Creating another one (allowDuplicate): credit note 2001, credit note 2002, credit note " +
        "2003 exists already.",
    );
  });

  it("warns when the duplicate scan was cut", async () => {
    const objects = Array.from({ length: 5001 }, (_, index) => ({ id: String(30_000 + index) }));
    const client = new FakeSevdeskClient(routes({ existing: { body: { objects } } }));
    const plan = await prepareWrite(tool, { invoiceId: 1004 }, client);
    expect(plan.preview.warnings).toContain(
      "Not every credit note could be checked for an earlier one from this invoice.",
    );
  });

  it("accepts a plain credit note answer and reports it when the read-back fails", async () => {
    const plain = new FakeSevdeskClient(
      routes({ create: { body: { objects: { id: "2101", objectName: "CreditNote" } } } }),
    );
    const { output } = await executeWrite(tool, { invoiceId: 1004 }, plain);
    expect(output.data.creditNote.id).toBe(2101);

    const failing = new FakeSevdeskClient(
      routes({ readBack: { error: new SevdeskError({ kind: "timeout", message: "x" }) } }),
    );
    await expect(executeWrite(tool, { invoiceId: 1004 }, failing)).rejects.toMatchObject({
      kind: "timeout",
      completedWrites: [{ objectName: "CreditNote", id: "2101" }],
    });
  });

  it("wraps a non-sevDesk read-back failure, and lists the invoice when it cannot be re-read", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, { invoiceId: 1004 }, client);
    const broken = (path: string) => ({
      request: (request: Parameters<FakeSevdeskClient["request"]>[0]) =>
        request.path === path ? Promise.reject(new TypeError("bug")) : client.request(request),
      list: client.list.bind(client),
      listAll: client.listAll.bind(client),
      download: client.download.bind(client),
    });
    await expect(
      tool.execute(
        tool.input.parse({ invoiceId: 1004 }),
        plan,
        directContext(broken("/CreditNote/2101")),
      ),
    ).rejects.toMatchObject({
      kind: "unexpected_response",
      message: "The document was created, but reading it back failed unexpectedly.",
      completedWrites: [{ objectName: "CreditNote", id: "2101" }],
    });
    const output = await tool.execute(
      tool.input.parse({ invoiceId: 1004 }),
      plan,
      directContext(broken("/Invoice/1004")),
    );
    expect(output.affected).toEqual([
      { objectName: "CreditNote", id: "2101" },
      { objectName: "Invoice", id: "1004" },
    ]);
  });
});
