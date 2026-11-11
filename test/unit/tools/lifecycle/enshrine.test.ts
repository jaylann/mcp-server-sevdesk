import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { enshrineTool } from "../../../../src/tools/lifecycle/enshrine.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  type Row,
  StagedClient,
  writeRoute,
} from "./helpers.js";

const ENSHRINED = "2026-11-07T10:00:00+01:00";

function invoiceClient(before: Row = invoiceRow()): StagedClient {
  return new StagedClient(
    [documentRoute("invoice", before)],
    [
      writeRoute("PUT", "/Invoice/1001/enshrine", "enshrine.json"),
      documentRoute("invoice", { ...before, enshrined: ENSHRINED }),
    ],
  );
}

describe("sevdesk_invoice_enshrine (spec invoiceEnshrine; community answer {objects: null})", () => {
  const tool = enshrineTool("invoice");

  it("is a commit tool", () => {
    expect(tool.name).toBe("sevdesk_invoice_enshrine");
    expect(tool.tier).toBe("commit");
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it("enshrines with an empty PUT and returns the invoice read back", async () => {
    const client = invoiceClient();

    const { output } = await executeWrite(tool, { id: 1001 }, client);

    expect(client.writes()).toEqual([
      expect.objectContaining({ method: "PUT", path: "/Invoice/1001/enshrine", tier: "commit" }),
    ]);
    expect(client.writes()[0]).not.toHaveProperty("body");
    expect(output.data["invoice"]).toMatchObject({ id: 1001, enshrined: true });
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "1001" }]);
    expect(output.summary).toBe("Invoice 1001 enshrined (festgeschrieben).");
  });

  it("asks for confirmation with an irreversible GoBD warning", async () => {
    const plan = await prepareWrite(tool, { id: 1001 }, invoiceClient());

    expect(plan.preview.irreversible).toBe(true);
    expect(plan.preview.action).toBe(
      "Enshrine invoice RE-1001 (festschreiben, GoBD): lock it permanently.",
    );
    expect(plan.preview.warnings[0]).toBe(
      "Irreversible (GoBD): the invoice can never be changed, deleted or reset to draft again; " +
        "corrections are then only possible with a cancellation (Storno) or a credit note.",
    );
    expect(plan.previewDe.action).toBe("Rechnung RE-1001 festschreiben (GoBD): dauerhaft sperren.");
    expect(plan.previewDe.warnings[0]).toBe(
      "Nicht umkehrbar (GoBD): Die Rechnung kann nie wieder geändert, gelöscht oder auf Entwurf " +
        "zurückgesetzt werden; Korrekturen sind dann nur noch mit einem Storno oder einer " +
        "Gutschrift möglich.",
    );
    expect(plan.previewDe.irreversible).toBe(true);
  });

  it.each([
    ["an enshrined invoice", invoiceRow({ enshrined: ENSHRINED }), "already enshrined"],
    ["a draft", invoiceRow({ status: "100" }), "is a draft"],
  ])("refuses %s without writing", async (_label, invoice, message) => {
    const client = invoiceClient(invoice);
    const error = await prepareWrite(tool, { id: 1001 }, client).catch((e: unknown) => e);
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain(message);
    expect(client.writes()).toEqual([]);
  });
});

describe("sevdesk_credit_note_enshrine", () => {
  it("enshrines a credit note and names the new-document correction path", async () => {
    const tool = enshrineTool("creditNote");
    const client = new StagedClient(
      [documentRoute("creditNote", creditNoteRow())],
      [
        writeRoute("PUT", "/CreditNote/2001/enshrine", "enshrine.json"),
        documentRoute("creditNote", creditNoteRow({ enshrined: ENSHRINED })),
      ],
    );

    const { plan, output } = await executeWrite(tool, { id: 2001 }, client);

    expect(plan.preview.warnings[0]).toContain("only possible with a new document");
    expect(plan.previewDe.warnings[0]).toContain("nur noch mit einem neuen Dokument möglich");
    expect(client.writes()[0]).toMatchObject({ path: "/CreditNote/2001/enshrine" });
    expect(output.data["creditNote"]).toMatchObject({ enshrined: true });
    expect(output.affected).toEqual([{ objectName: "CreditNote", id: "2001" }]);
  });
});
