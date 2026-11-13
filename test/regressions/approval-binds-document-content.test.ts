/**
 * An approval must cover the document it makes binding, and the human must see that document.
 *
 * The finalize, send and enshrine previews showed a document's number, party, dates and totals,
 * but not its texts, address, positions or other dates. A model with the `write` tier can edit a
 * draft without confirmation, so it could change the foot text (say, to other bank details) after
 * the human approved finalizing or sending, and retry with the old approval: the preview and its
 * hash stayed the same (security review 2026-11, finding 1). The first fix hashed the display DTO,
 * which cuts texts at 2,000 characters, keeps only the date of `update` and has no positions, and
 * left voucher finalization out (wave 2).
 *
 * Guard 1: these tools return a `binding` that the approval covers with the previews: a hash of
 * the raw record and its raw positions (`readDocumentContent`), or for voucher finalization of the
 * exact save payload and the stored voucher. Draft edits and the tools that consume a document
 * lock the same record (`locks`), so an edit cannot slip in between the last check and the write.
 *
 * The binding only stops an edit made after the human was asked. An edit made before (the foot
 * text is changed, then the human is asked to finalize) was approved unseen: the approval looked
 * like any other (review 2026-11, round 3).
 *
 * Guard 2: the previews list the stored content, built from the same read as the binding: the
 * address block, head and foot text, every position with its text, terms and dates, in English
 * and German. What they leave out is named in a fixed warning, and the binding still covers it.
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
import { withCountryRoute } from "../helpers/country-route.js";
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
  return new FakeSevdeskClient(
    withCountryRoute([
      documentRoute("invoice", row),
      ...positionRoutes({ "/InvoicePos": positions }),
    ]),
  );
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

  // What the previews do not show (named in their fixed "not shown" warning, or internal): the
  // binding is what tells these documents apart. Wave 2: the display DTO could not, for the
  // update time.
  const hiddenEdits: readonly [string, Row, readonly Row[]][] = [
    [
      "the update time on the same day",
      draft({ update: "2026-11-11T17:30:00+01:00" }),
      [position()],
    ],
    [
      "the contact person",
      draft({ contactPerson: { id: "7002", objectName: "SevUser" } }),
      [position()],
    ],
    [
      "the country of the address",
      draft({ addressCountry: { id: "2", objectName: "StaticCountry" } }),
      [position()],
    ],
    ["a position's unit", draft(), [position({ unity: { id: "9", objectName: "Unity" } })]],
    [
      "a position's linked article",
      draft(),
      [position({ part: { id: "6001", objectName: "Part" } })],
    ],
  ];

  it.each(hiddenEdits)(
    "changes the finalize approval hash when %s changes",
    async (_label, row, rows) => {
      const tool = finalizeTool("invoice");
      const before = await prepareWrite(tool, { id: 1001 }, client(draft()));
      const after = await prepareWrite(tool, { id: 1001 }, client(row, rows));

      // The previews alone cannot tell the two documents apart …
      expect(after.preview).toEqual(before.preview);
      expect(after.previewDe).toEqual(before.previewDe);
      // … the binding, which the approval covers, can.
      expect(after.binding).not.toBe(before.binding);
      expect(previewHash(after.preview, after.previewDe, after.binding)).not.toBe(
        previewHash(before.preview, before.previewDe, before.binding),
      );
    },
  );

  it("binds sending and enshrining to the content as well", async () => {
    const send = sendEmailTool("invoice");
    const enshrine = enshrineTool("invoice");
    const args = { id: 1001, to: "kunde@example.com", subject: "Rechnung", text: "Anbei." };
    const plans = async (row: Row) => ({
      send: await prepareWrite(send, args, client(row)),
      enshrine: await prepareWrite(enshrine, { id: 1001 }, client(row)),
    });

    const before = await plans(open());
    const after = await plans(open({ contactPerson: { id: "7002", objectName: "SevUser" } }));

    expect(after.send.preview).toEqual(before.send.preview);
    expect(after.send.binding).not.toBe(before.send.binding);
    expect(after.enshrine.preview).toEqual(before.enshrine.preview);
    expect(after.enshrine.binding).not.toBe(before.enshrine.binding);
  });

  it("binds voucher finalization to what the preview leaves out (wave 2)", async () => {
    const before = await voucherPlan(draftRow());
    // The dates are shown since round 3; the cost centre is carried over unseen.
    const after = await voucherPlan(
      draftRow({ costCentre: { id: "77", objectName: "CostCentre" } }),
    );

    expect(after.preview).toEqual(before.preview);
    expect(after.binding).toBeDefined();
    expect(after.binding).not.toBe(before.binding);
  });
});

function voucherPlan(row: Row, positions: readonly Row[] = [positionRow()]) {
  return prepareWrite(
    voucherFinalizeTool,
    { id: 2101 },
    new FakeSevdeskClient([
      voucherRoute(row),
      positionsRoute(2101, positions),
      version2Route,
      regularRoute,
      guidanceRoute,
      accountsRoute,
    ]),
  );
}

describe("the approval shows what it makes binding (review 2026-11, round 3)", () => {
  const email = { id: 1001, to: "kunde@example.com", subject: "Rechnung", text: "Anbei." };

  it("shows the human a foot text that was set before they were asked (finalize)", async () => {
    // The model wrote other bank details into the draft first (write tier, no confirmation),
    // then asks to finalize: nothing changes while the human reads, so the binding is silent.
    const {
      client: mcp,
      fake,
      prompts,
    } = await writeHarness({
      tools: [finalizeTool("invoice")],
      routes: [
        documentRoute("invoice", draft({ footText: ATTACKER_FOOTER })),
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
    expect(prompts[0]?.message).toContain(`Foot text (Fußtext): ${ATTACKER_FOOTER}`);
    expect(resultData(result)).toMatchObject({ status: "done" });
    expect(writesOf(fake)).toHaveLength(1);
  });

  it.each([
    ["finalize", finalizeTool("invoice"), { id: 1001 }, draft],
    ["send", sendEmailTool("invoice"), email, draft],
    ["send (open invoice)", sendEmailTool("invoice"), email, open],
    ["enshrine", enshrineTool("invoice"), { id: 1001 }, open],
  ] as const)("%s: the foot text is a fact in English and German", async (_n, tool, args, row) => {
    const plan = await prepareWrite(
      tool as AnyWriteToolDefinition,
      args,
      client(row({ footText: ATTACKER_FOOTER })),
    );

    expect(plan.preview.facts).toContainEqual({
      label: "Foot text (Fußtext)",
      value: ATTACKER_FOOTER,
    });
    expect(plan.previewDe?.facts).toContainEqual({ label: "Fußtext", value: ATTACKER_FOOTER });
    // What is still not shown is named, in both languages.
    expect(plan.preview.warnings.join(" ")).toContain("Not shown: the contact person");
    expect(plan.previewDe?.warnings.join(" ")).toContain("Nicht gezeigt werden:");
  });

  // Every edit a write-tier tool can make to the printed content shows in both previews.
  const shownEdits: readonly [string, Row, readonly Row[], string, string, string][] = [
    [
      "the head text",
      draft({ headText: "Neue Bankverbindung, siehe unten." }),
      [position()],
      "Head text (Kopftext)",
      "Kopftext",
      "Neue Bankverbindung, siehe unten.",
    ],
    [
      "the address",
      draft({ address: "Andere Firma\nPostfach 1\n12345 Irgendwo" }),
      [position()],
      "Address on the document",
      "Anschrift auf dem Dokument",
      "Andere Firma\nPostfach 1\n12345 Irgendwo",
    ],
    [
      "the foot text after character 2,000",
      draft({ footText: LONG_FOOTER }),
      [position()],
      "Foot text (Fußtext)",
      "Fußtext",
      LONG_FOOTER,
    ],
    [
      "a position text, same total",
      draft(),
      [position({ text: "Bitte an IBAN DE00 … zahlen" })],
      "Position 1",
      "Position 1",
      "Beratung: 1 × 100.00 EUR net\nText: Bitte an IBAN DE00 … zahlen",
    ],
    [
      "the title",
      draft({ header: "Rechnung, zahlbar an Dritte" }),
      [position()],
      "Title on the document (Betreff)",
      "Betreff auf dem Dokument",
      "Rechnung, zahlbar an Dritte",
    ],
    [
      "the tax note",
      draft({ taxText: "Bitte abweichend überweisen" }),
      [position()],
      "Tax note (Steuerhinweis)",
      "Steuerhinweis",
      "Bitte abweichend überweisen",
    ],
  ];

  it.each(shownEdits)(
    "finalize shows %s as stored",
    async (label, row, rows, labelEn, labelDe, value) => {
      const tool = finalizeTool("invoice");
      const before = await prepareWrite(tool, { id: 1001 }, client(draft()));
      const after = await prepareWrite(tool, { id: 1001 }, client(row, rows));

      expect(after.preview.facts).toContainEqual({ label: labelEn, value });
      expect(before.preview.facts).not.toContainEqual({ label: labelEn, value });
      const german = after.previewDe.facts.find((fact) => fact.label === labelDe)?.value;
      // Only the position line differs between the languages (number format, "netto").
      expect(german).toBe(
        label.startsWith("a position")
          ? "Beratung: 1 × 100,00 EUR netto\nText: Bitte an IBAN DE00 … zahlen"
          : value,
      );
      expect(after.preview).not.toEqual(before.preview);
      expect(after.previewDe).not.toEqual(before.previewDe);
    },
  );

  it("finalize shows the delivery period in both languages", async () => {
    const plan = await prepareWrite(
      finalizeTool("invoice"),
      { id: 1001 },
      client(
        draft({
          deliveryDate: "2026-09-15T00:00:00+02:00",
          deliveryDateUntil: "2026-09-30T00:00:00+02:00",
        }),
      ),
    );

    expect(plan.preview.facts).toContainEqual({
      label: "Delivery date or period (Leistungsdatum)",
      value: "2026-09-15 – 2026-09-30",
    });
    expect(plan.previewDe.facts).toContainEqual({
      label: "Leistungsdatum oder -zeitraum",
      value: "15.09.2026 – 30.09.2026",
    });
  });

  it("voucher finalize shows the dates, the asset flag and the whole comment", async () => {
    const comment = `Büromaterial ${"und Zubehör ".repeat(30)}an IBAN DE00 1234 zahlen`;
    const plan = await voucherPlan(draftRow({ deliveryDateUntil: "2026-11-30T00:00:00+01:00" }), [
      positionRow({ comment, isAsset: "1" }),
    ]);

    expect(comment.length).toBeGreaterThan(200);
    expect(plan.preview.facts).toContainEqual({
      label: "Service date or period (Leistungsdatum)",
      value: "2026-11-02 – 2026-11-30",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Payment deadline (Fälligkeit)",
      value: "2026-11-16",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Position 1",
      value:
        "6815 Bürobedarf (account 4266): 119 EUR gross, 19 % VAT, asset (Anlagegut); " + comment,
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Receipt file (Belegdatei)",
      value: "none attached",
    });
    expect(plan.previewDe.facts).toContainEqual({
      label: "Leistungsdatum oder -zeitraum",
      value: "02.11.2026 – 30.11.2026",
    });
    expect(plan.previewDe.facts).toContainEqual({ label: "Fälligkeit", value: "16.11.2026" });
    expect(plan.previewDe.facts).toContainEqual({
      label: "Position 1",
      value: "6815 Bürobedarf (Konto 4266): 119 EUR brutto, 19 % USt., Anlagegut; " + comment,
    });
    expect(plan.previewDe.facts).toContainEqual({ label: "Belegdatei", value: "keine angehängt" });
    expect(plan.previewDe.facts).toHaveLength(plan.preview.facts.length);
  });

  it("voucher finalize changes its preview when the payment deadline changes", async () => {
    const before = await voucherPlan(draftRow());
    const after = await voucherPlan(draftRow({ paymentDeadline: "2027-01-01T00:00:00+01:00" }));

    expect(after.preview).not.toEqual(before.preview);
    expect(after.previewDe.facts).toContainEqual({ label: "Fälligkeit", value: "01.01.2027" });
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
