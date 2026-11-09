import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { finalizeTool } from "../../../../src/tools/lifecycle/finalize.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  orderRow,
  type Row,
  StagedClient,
  writeRoute,
} from "./helpers.js";

const cases = [
  {
    kind: "invoice" as const,
    name: "sevdesk_invoice_finalize",
    toolset: "invoices",
    path: "/Invoice/1001",
    id: 1001,
    key: "invoice",
    draft: invoiceRow({ status: "100", invoiceNumber: null, sendType: null, sendDate: null }),
    done: invoiceRow({ status: "200", invoiceNumber: "RE-1101", sendType: "VPDF" }),
    fixture: "invoice-send-by.json",
    number: "RE-1101",
  },
  {
    kind: "creditNote" as const,
    name: "sevdesk_credit_note_finalize",
    toolset: "credit-notes",
    path: "/CreditNote/2001",
    id: 2001,
    key: "creditNote",
    // Credit note drafts carry their number already (sevdesk_credit_note_create_draft reserves it).
    draft: creditNoteRow({ status: "100", creditNoteNumber: "GU-1101" }),
    done: creditNoteRow({ status: "200", creditNoteNumber: "GU-1101" }),
    fixture: "credit-note-send-by.json",
    number: "GU-1101",
  },
  {
    kind: "order" as const,
    name: "sevdesk_order_finalize",
    toolset: "orders",
    path: "/Order/3002",
    id: 3002,
    key: "order",
    draft: orderRow({ status: "100", orderNumber: null }),
    done: orderRow({ status: "200", orderNumber: "AB-1101" }),
    fixture: "order-send-by.json",
    number: "AB-1101",
  },
];

function staged(kind: (typeof cases)[number], draft: Row = kind.draft): StagedClient {
  return new StagedClient(
    [documentRoute(kind.kind, draft)],
    [writeRoute("PUT", `${kind.path}/sendBy`, kind.fixture), documentRoute(kind.kind, kind.done)],
  );
}

describe.each(cases)("$name (community record shapes, fake values)", (kind) => {
  const tool = finalizeTool(kind.kind);

  it("is a commit tool with the commit annotations", () => {
    expect(tool.name).toBe(kind.name);
    expect(tool.toolset).toBe(kind.toolset);
    expect(tool.tier).toBe("commit");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("marks the draft as sent with sendDraft false, then reads it back", async () => {
    const client = staged(kind);

    const { output } = await executeWrite(tool, { id: kind.id }, client);

    expect(client.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${kind.path}`,
      `PUT ${kind.path}/sendBy`,
      `GET ${kind.path}`,
    ]);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: `${kind.path}/sendBy`,
        body: { sendType: "VPDF", sendDraft: false },
        tier: "commit",
      }),
    ]);
    const dto = output.data[kind.key] as { status: { code: number }; number?: string };
    expect(dto.status.code).toBe(200);
    expect(dto.number).toBe(kind.number);
    expect(output.affected).toEqual([{ objectName: kind.path.split("/")[1], id: String(kind.id) }]);
    expect(output.summary).toContain(`${String(kind.id)} finalized: status`);
  });

  it("prepares a preview without writing", async () => {
    const client = staged(kind);

    const plan = await prepareWrite(tool, { id: kind.id, sentVia: "post" }, client);

    expect(client.writes()).toEqual([]);
    expect(plan.preview.action).toMatch(
      /^Finalize .+: draft → (open|sent), marked as sent by post \(VP\)\.$/,
    );
    expect(plan.preview.facts).toContainEqual({ label: "Marked as sent", value: "by post (VP)" });
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.preview.warnings.join(" ")).toContain("sevDesk sends nothing to the customer");
  });

  it("refuses a document that is not a draft", async () => {
    const client = new FakeSevdeskClient([documentRoute(kind.kind, kind.done)]);

    const error = await prepareWrite(tool, { id: kind.id }, client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain("is not a draft");
    expect(client.writes()).toEqual([]);
  });
});

describe("sevdesk_invoice_finalize details", () => {
  const tool = finalizeTool("invoice");
  const kind = cases[0];
  if (kind === undefined) throw new Error("missing case");

  it.each([
    ["post", "VP"],
    ["print", "VPR"],
    ["email", "VM"],
    ["pdf_download", "VPDF"],
  ])("sends sentVia %s as sendType %s", async (sentVia, sendType) => {
    const client = staged(kind);
    await executeWrite(tool, { id: 1001, sentVia }, client);
    expect(client.writes()[0]?.body).toEqual({ sendType, sendDraft: false });
  });

  it("warns that the invoice becomes binding and may be enshrined automatically", async () => {
    const plan = await prepareWrite(tool, { id: 1001 }, staged(kind));

    expect(plan.preview.action).toBe(
      "Finalize invoice 1001 (no number yet): draft → open, marked as sent as a downloaded " +
        "PDF (VPDF).",
    );
    expect(plan.preview.facts.slice(0, 4)).toEqual([
      { label: "Invoice (Rechnung)", value: "id 1001, no number yet" },
      { label: "Type", value: "Rechnung (RE)" },
      { label: "Status", value: "Draft (100)" },
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
    ]);
    expect(plan.preview.warnings).toEqual([
      "The invoice becomes legally binding: sevDesk assigns its final number and books it. " +
        "Afterwards it can only be corrected by a reset to draft (while not enshrined), a " +
        "cancellation (Storno) or a credit note.",
      "sevDesk sends nothing to the customer: this only records how the document was sent. To " +
        "email it through sevDesk, use sevdesk_invoice_send_email instead.",
      'If the sevDesk account enshrines documents on completion (setting "Automatische ' +
        'Festschreibung"), it is also enshrined (festgeschrieben) and can never be changed or ' +
        "reset again.",
    ]);
  });

  it("is deterministic for an unchanged invoice", async () => {
    const first = await prepareWrite(tool, { id: 1001 }, staged(kind));
    const second = await prepareWrite(tool, { id: 1001 }, staged(kind));
    expect(second.preview).toEqual(first.preview);
  });

  it("warns about unexpanded placeholders in the number (D-027)", async () => {
    const client = staged(kind, invoiceRow({ status: "100", invoiceNumber: "RE-%YYYY%MM1038" }));
    const plan = await prepareWrite(tool, { id: 1001 }, client);
    expect(plan.preview.warnings.at(-1)).toContain("still contains placeholders (%…%)");
  });

  it("refuses a recurring invoice template", async () => {
    const client = staged(kind, invoiceRow({ status: "100", invoiceType: "WKR" }));
    await expect(prepareWrite(tool, { id: 1001 }, client)).rejects.toMatchObject({
      kind: "validation",
    });
  });

  it("reports the finalized invoice when the read-back fails, so the call is not repeated", async () => {
    const client = new StagedClient(
      [documentRoute("invoice", kind.draft)],
      [
        writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
        {
          path: "/Invoice/1001",
          query: { embed: "contact" },
          response: { error: new SevdeskError({ kind: "server", message: "sevDesk failed." }) },
        },
      ],
    );

    const error = await executeWrite(tool, { id: 1001 }, client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("server");
    expect((error as SevdeskError).completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
    ]);
    expect(client.writes()).toHaveLength(1);
  });

  it("does not retry or read back when sevDesk refuses the write", async () => {
    const client = new StagedClient(
      [documentRoute("invoice", kind.draft)],
      [
        {
          method: "PUT",
          path: "/Invoice/1001/sendBy",
          response: { error: new SevdeskError({ kind: "validation", message: "Refused." }) },
        },
      ],
    );

    await expect(executeWrite(tool, { id: 1001 }, client)).rejects.toMatchObject({
      kind: "validation",
      completedWrites: [],
    });
    expect(client.calls.map(({ method }) => method)).toEqual(["GET", "PUT"]);
  });

  it("accepts dryRun and rejects unknown arguments", () => {
    expect(tool.input.safeParse({ id: 1001, dryRun: true }).success).toBe(true);
    expect(tool.input.safeParse({ id: 1001, confirm: true }).success).toBe(false);
    expect(tool.input.safeParse({ id: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ id: 1001, sentVia: "fax" }).success).toBe(false);
  });
});

describe("sevdesk_order_finalize details", () => {
  it("does not warn about enshrinement for orders", async () => {
    const kind = cases[2];
    if (kind === undefined) throw new Error("missing case");
    const plan = await prepareWrite(finalizeTool("order"), { id: 3002 }, staged(kind));
    expect(plan.preview.warnings[0]).toBe(
      "The order is marked as sent (status 200) and sevDesk assigns its final number.",
    );
    expect(plan.preview.warnings.join(" ")).not.toContain("enshrine");
  });

  it("names the credit note correction path for credit notes", async () => {
    const kind = cases[1];
    if (kind === undefined) throw new Error("missing case");
    const plan = await prepareWrite(finalizeTool("creditNote"), { id: 2001 }, staged(kind));
    expect(plan.preview.warnings[0]).toBe(
      "The credit note becomes legally binding: sevDesk books it under the number the draft " +
        "carries. Afterwards it can only be corrected by a reset to draft (while not enshrined), " +
        "or a new document.",
    );
  });

  it.each([null, "", "  "])(
    "refuses a credit note draft without a number (%j): sendBy can fail half-way (recorded)",
    async (creditNoteNumber) => {
      const kind = cases[1];
      if (kind === undefined) throw new Error("missing case");
      const client = staged(kind, creditNoteRow({ status: "100", creditNoteNumber }));
      const error = await prepareWrite(finalizeTool("creditNote"), { id: 2001 }, client).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(SevdeskError);
      expect((error as SevdeskError).kind).toBe("validation");
      expect((error as SevdeskError).message).toBe(
        "Credit note 2001 is a draft without a number, and finalizing it could fail half-way in " +
          "sevDesk and leave a finalized credit note without a number. Create it again with " +
          "sevdesk_credit_note_create_draft (which takes a number from the number range) and " +
          "delete this draft in sevDesk, or give it a number in the sevDesk web app first.",
      );
      expect(client.writes()).toEqual([]);
    },
  );

  it("still finalizes an invoice draft without a number (sendBy assigns it, recorded)", async () => {
    const kind = cases[0];
    if (kind === undefined) throw new Error("missing case");
    const plan = await prepareWrite(finalizeTool("invoice"), { id: 1001 }, staged(kind));
    expect(plan.preview.action).toContain("no number yet");
  });
});
