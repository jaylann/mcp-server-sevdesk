import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceCancelTool as tool } from "../../../../src/tools/lifecycle/cancel.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  documentRoute,
  fixtureRow,
  invoiceRow,
  type Row,
  StagedClient,
  writeRoute,
} from "./helpers.js";

const cancellation = fixtureRow("invoice-cancel.json");
const cancelledOriginal = invoiceRow({ status: "1000", paidAmount: 0 });

function client(before: Row = invoiceRow()): StagedClient {
  return new StagedClient(
    [documentRoute("invoice", before)],
    [
      writeRoute("POST", "/Invoice/1001/cancelInvoice", "invoice-cancel.json"),
      documentRoute("invoice", cancelledOriginal),
      documentRoute("invoice", cancellation),
    ],
  );
}

describe("sevdesk_invoice_cancel (community: sevdesk-rs recorded cancelInvoice, fake values)", () => {
  it("is a commit tool", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("invoices");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("posts an empty cancelInvoice and returns both invoices read back", async () => {
    const staged = client();

    const { output } = await executeWrite(tool, { id: 1001 }, staged);

    expect(staged.writes()).toEqual([
      {
        operation: "request",
        method: "POST",
        path: "/Invoice/1001/cancelInvoice",
        query: {},
        sideEffect: false,
        tier: "commit",
      },
    ]);
    expect(staged.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /Invoice/1001",
      "GET /StaticCountry",
      "POST /Invoice/1001/cancelInvoice",
      "GET /Invoice/1001",
      "GET /Invoice/1102",
    ]);
    expect(output.data).toMatchObject({
      invoice: { id: 1001, status: { code: 1000 } },
      cancellationInvoice: {
        id: 1102,
        type: { code: "SR" },
        status: { code: 1000 },
        cancelsInvoiceId: 1001,
        totals: { gross: { amount: "-177.33", currency: "EUR" } },
      },
      cancellationInvoiceId: 1102,
    });
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "Invoice", id: "1102" },
    ]);
    expect(output.summary).toBe(
      "Invoice 1001 cancelled by cancellation invoice 1102 (status Paid).",
    );
  });

  it("shows an irreversible preview with the offsetting amount", async () => {
    const staged = client();

    const plan = await prepareWrite(tool, { id: 1001 }, staged);

    expect(staged.writes()).toEqual([]);
    expect(plan.preview.irreversible).toBe(true);
    expect(plan.preview.action).toBe(
      "Cancel invoice RE-1001 (Storno): sevDesk creates a cancellation invoice " +
        "(Stornorechnung, SR) over -177.33 EUR that offsets it.",
    );
    expect(plan.preview.warnings[0]).toContain("the cancellation cannot be undone");
    expect(plan.preview.warnings[1]).toContain('sevDesk has no "cancelled" status');
    expect(plan.previewDe.action).toBe(
      "Rechnung RE-1001 stornieren: sevDesk erstellt eine Stornorechnung (SR) über -177,33 EUR, " +
        "die sie ausgleicht.",
    );
    expect(plan.previewDe.warnings).toHaveLength(3);
    expect(plan.previewDe.warnings[1]).toContain("sevDesk kennt keinen Status „Storniert“");
    expect(plan.previewDe.irreversible).toBe(true);
  });

  it.each([
    ["a draft", invoiceRow({ status: "100" }), "is a draft"],
    [
      "a partially paid invoice",
      invoiceRow({ status: "750", paidAmount: 50 }),
      "sevdesk_credit_note_create_from_invoice",
    ],
    [
      "a paid invoice",
      invoiceRow({ status: "1000", paidAmount: 177.33 }),
      "sevdesk_credit_note_create_from_invoice",
    ],
    ["an already cancelled invoice", cancelledOriginal, "If it was cancelled before"],
    ["a cancellation invoice", cancellation, "is a cancellation invoice"],
  ])("refuses %s without writing", async (_label, invoice, message) => {
    const staged = client(invoice);
    const error = await prepareWrite(tool, { id: Number(invoice["id"]) }, staged).catch(
      (e: unknown) => e,
    );
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain(message);
    expect(staged.writes()).toEqual([]);
  });

  it("says the cancellation happened when sevDesk's answer names no invoice", async () => {
    const staged = new StagedClient(
      [documentRoute("invoice", invoiceRow())],
      [
        {
          method: "POST",
          path: "/Invoice/1001/cancelInvoice",
          response: { body: { objects: { objectName: "Invoice" } } },
        },
      ],
    );

    const error = await executeWrite(tool, { id: 1001 }, staged).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("unexpected_response");
    expect((error as SevdeskError).message).toContain("Do not cancel again");
    expect((error as SevdeskError).completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
    ]);
    expect(staged.writes()).toHaveLength(1);
  });

  it("also handles an empty answer, and reports both invoices if a read-back fails", async () => {
    const empty = new StagedClient(
      [documentRoute("invoice", invoiceRow())],
      [
        {
          method: "POST",
          path: "/Invoice/1001/cancelInvoice",
          response: { body: { objects: [] } },
        },
      ],
    );
    await expect(executeWrite(tool, { id: 1001 }, empty)).rejects.toMatchObject({
      kind: "unexpected_response",
    });

    const failing = new StagedClient(
      [documentRoute("invoice", invoiceRow())],
      [
        writeRoute("POST", "/Invoice/1001/cancelInvoice", "invoice-cancel.json"),
        documentRoute("invoice", cancelledOriginal),
        {
          path: "/Invoice/1102",
          query: { embed: "contact" },
          response: { error: new SevdeskError({ kind: "timeout", message: "Timed out." }) },
        },
      ],
    );
    const error = await executeWrite(tool, { id: 1001 }, failing).catch((e: unknown) => e);
    expect((error as SevdeskError).completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "Invoice", id: "1102" },
    ]);
  });
});
