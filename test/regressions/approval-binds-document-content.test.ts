/**
 * An approval must cover the document it makes binding, not just the facts its preview shows.
 *
 * The finalize, send and enshrine previews show a document's number, party, dates and totals, but
 * not its texts, address, positions or other dates. A model with the `write` tier can edit a draft
 * without confirmation, so it could change the foot text (say, to other bank details) after the
 * human approved finalizing or sending, and retry with the old approval: the preview and its hash
 * stayed the same (security review 2026-11, finding 1). The first fix hashed the display DTO, which
 * cuts texts at 2,000 characters, keeps only the date of `update` and has no positions, and left
 * voucher finalization out (wave 2).
 *
 * Guard: these tools return a `binding` that the approval covers with the previews: a hash of the
 * raw record and its raw positions (`documentBinding`), or for voucher finalization of the exact
 * save payload and the stored voucher. Draft edits and the tools that consume a document lock the
 * same record (`locks`), so an edit cannot slip in between the last check and the write.
 */
import { describe, expect, it } from "vitest";

import { previewHash } from "../../src/safety/hashing.js";
import { invoiceUpdateDraftTool } from "../../src/tools/invoices/draft-update.js";
import { bookPaymentTool } from "../../src/tools/lifecycle/book-payment.js";
import { enshrineTool } from "../../src/tools/lifecycle/enshrine.js";
import { finalizeTool } from "../../src/tools/lifecycle/finalize.js";
import { resetTool } from "../../src/tools/lifecycle/reset.js";
import { sendEmailTool } from "../../src/tools/lifecycle/send-email.js";
import { orderUpdateDraftTool } from "../../src/tools/orders/draft-update.js";
import type { AnyWriteToolDefinition } from "../../src/tools/types.js";
import { voucherUpdateDraftTool } from "../../src/tools/vouchers/draft-update.js";
import { voucherFinalizeTool } from "../../src/tools/vouchers/finalize.js";
import { approve } from "../helpers/confirm-client.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import { prepareWrite } from "../helpers/write-tools.js";
import {
  documentRoute,
  invoiceRow,
  positionRoutes,
  type Row,
  writeRoute,
} from "../unit/tools/lifecycle/helpers.js";
import {
  accountsRoute,
  draftRow,
  guidanceRoute,
  positionRow,
  positionsRoute,
  regularRoute,
  version2Route,
  voucherRoute,
} from "../unit/tools/vouchers/routes.js";

closeWriteHarnessesAfterEach();

const ATTACKER_FOOTER = "Bitte überweisen Sie an IBAN DE00 1234 5678 9012 3456 78.";
const LONG_FOOTER = `${"Zahlbar innerhalb von 14 Tagen. ".repeat(70)}IBAN DE02 1203 0000 0000 2020 51`;

function draft(overrides: Row = {}): Row {
  return invoiceRow({
    status: "100",
    invoiceNumber: null,
    sendType: null,
    sendDate: null,
    footText: "Vielen Dank für Ihren Auftrag.",
    update: "2026-11-11T09:00:00+01:00",
    ...overrides,
  });
}

function open(overrides: Row = {}): Row {
  return invoiceRow({ status: "200", footText: "Vielen Dank für Ihren Auftrag.", ...overrides });
}

function position(overrides: Row = {}): Row {
  return {
    id: "7001",
    objectName: "InvoicePos",
    invoice: { id: "1001", objectName: "Invoice" },
    name: "Beratung",
    text: "Beratung im November",
    quantity: "1",
    price: "100",
    ...overrides,
  };
}

function client(row: Row, positions: readonly Row[] = [position()]): FakeSevdeskClient {
  return new FakeSevdeskClient([
    documentRoute("invoice", row),
    ...positionRoutes({ "/InvoicePos": positions }),
  ]);
}

describe("approval binds the document content", () => {
  it("asks again when the foot text changes after the human was asked (finalize)", async () => {
    const row = draft();
    const {
      client: mcp,
      fake,
      prompts,
    } = await writeHarness({
      tools: [finalizeTool("invoice")],
      routes: [
        documentRoute("invoice", row),
        ...positionRoutes(),
        writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
      ],
      connect: {
        era: "modern",
        transport: "http",
        answer: (params) => {
          // While the human reads the first prompt, the model edits the draft's foot text.
          if (prompts.length === 1) row["footText"] = ATTACKER_FOOTER;
          return approve(params);
        },
      },
    });

    const result = await mcp.callTool({
      name: "sevdesk_invoice_finalize",
      arguments: { id: 1001 },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.message).toMatch(/^The record changed after you were asked/);
    expect(resultData(result)).toMatchObject({ status: "done" });
    expect(writesOf(fake)).toEqual([{ method: "PUT", path: "/Invoice/1001/sendBy" }]);
  });

  it("asks once when nothing changed", async () => {
    const {
      client: mcp,
      fake,
      prompts,
    } = await writeHarness({
      tools: [finalizeTool("invoice")],
      routes: [
        documentRoute("invoice", draft()),
        ...positionRoutes(),
        writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
      ],
      connect: { era: "modern", transport: "http", answer: approve },
    });

    const result = await mcp.callTool({
      name: "sevdesk_invoice_finalize",
      arguments: { id: 1001 },
    });

    expect(prompts).toHaveLength(1);
    expect(resultData(result)).toMatchObject({ status: "done" });
    expect(writesOf(fake)).toHaveLength(1);
  });

  const edits: readonly [string, Row, readonly Row[]][] = [
    ["the foot text", draft({ footText: ATTACKER_FOOTER }), [position()]],
    ["the head text", draft({ headText: "Neue Bankverbindung, siehe unten." }), [position()]],
    ["the address", draft({ address: "Andere Firma\nPostfach 1\n12345 Irgendwo" }), [position()]],
    ["the delivery date", draft({ deliveryDate: "2026-09-15T00:00:00+02:00" }), [position()]],
    // Wave 2: what the display DTO could not tell apart.
    [
      "the foot text after character 2,000, same length",
      draft({ footText: LONG_FOOTER.replace("2020 51", "6666 66") }),
      [position()],
      // (the base case below uses LONG_FOOTER)
    ],
    [
      "the update time on the same day",
      draft({ update: "2026-11-11T17:30:00+01:00" }),
      [position()],
    ],
    ["a position text, same total", draft(), [position({ text: "Bitte an IBAN DE00 … zahlen" })]],
  ];

  it.each(edits)("changes the finalize approval hash when %s changes", async (label, row, rows) => {
    const tool = finalizeTool("invoice");
    const base = label.startsWith("the foot text after")
      ? draft({ footText: LONG_FOOTER })
      : draft();
    const before = await prepareWrite(tool, { id: 1001 }, client(base));
    const after = await prepareWrite(tool, { id: 1001 }, client(row, rows));

    // The previews alone cannot tell the two documents apart …
    expect(after.preview).toEqual(before.preview);
    expect(after.previewDe).toEqual(before.previewDe);
    // … the binding, which the approval covers, can.
    expect(after.binding).not.toBe(before.binding);
    expect(previewHash(after.preview, after.previewDe, after.binding)).not.toBe(
      previewHash(before.preview, before.previewDe, before.binding),
    );
  });

  it("binds sending and enshrining to the content as well", async () => {
    const send = sendEmailTool("invoice");
    const enshrine = enshrineTool("invoice");
    const args = { id: 1001, to: "kunde@example.com", subject: "Rechnung", text: "Anbei." };
    const plans = async (row: Row) => ({
      send: await prepareWrite(send, args, client(row)),
      enshrine: await prepareWrite(enshrine, { id: 1001 }, client(row)),
    });

    const before = await plans(open());
    const after = await plans(open({ footText: ATTACKER_FOOTER }));

    expect(after.send.preview).toEqual(before.send.preview);
    expect(after.send.binding).not.toBe(before.send.binding);
    expect(after.enshrine.preview).toEqual(before.enshrine.preview);
    expect(after.enshrine.binding).not.toBe(before.enshrine.binding);
  });

  it("binds voucher finalization to dates the preview leaves out (wave 2)", async () => {
    const plan = (row: Row) =>
      prepareWrite(
        voucherFinalizeTool,
        { id: 2101 },
        new FakeSevdeskClient([
          voucherRoute(row),
          positionsRoute(2101, [positionRow()]),
          version2Route,
          regularRoute,
          guidanceRoute,
          accountsRoute,
        ]),
      );
    const before = await plan(draftRow());
    const after = await plan(draftRow({ paymentDeadline: "2027-01-01T00:00:00+01:00" }));

    expect(after.preview).toEqual(before.preview);
    expect(after.binding).toBeDefined();
    expect(after.binding).not.toBe(before.binding);
  });
});

describe("draft edits and the actions that consume a document lock the same record", () => {
  const lockKeys = (tool: AnyWriteToolDefinition, args: Record<string, unknown>) =>
    (tool.locks?.(args) ?? []).map(({ objectName, id }) => `${objectName}:${id}`);

  it.each([
    ["invoice", invoiceUpdateDraftTool, "Invoice:1001"],
    ["order", orderUpdateDraftTool, "Order:1001"],
    ["voucher", voucherUpdateDraftTool, "Voucher:1001"],
  ] as const)("%s draft updates", (_kind, tool, key) => {
    expect(lockKeys(tool, { id: 1001 })).toEqual([key]);
  });

  it("finalize, send, enshrine, reset and payments", () => {
    for (const tool of [
      finalizeTool("invoice"),
      sendEmailTool("invoice"),
      enshrineTool("invoice"),
      resetTool("invoice"),
      bookPaymentTool("invoice"),
    ]) {
      expect(lockKeys(tool, { id: 1001 }), tool.name).toContain("Invoice:1001");
    }
    expect(lockKeys(voucherFinalizeTool, { id: 1001 })).toEqual(["Voucher:1001"]);
  });
});
