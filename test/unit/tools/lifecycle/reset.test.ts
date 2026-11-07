import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { resetTool } from "../../../../src/tools/lifecycle/reset.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  type Row,
  StagedClient,
  writeRoute,
} from "./helpers.js";

const tool = resetTool("invoice");
const paid = invoiceRow({ status: "1000", paidAmount: 177.33, payDate: "2026-10-10" });
const ENSHRINED = "2026-10-02T10:00:00+02:00";

function client(before: Row, endpoint: "resetToOpen" | "resetToDraft", after: Row): StagedClient {
  return new StagedClient(
    [documentRoute("invoice", before)],
    [
      writeRoute("PUT", `/Invoice/1001/${endpoint}`, "invoice-reset.json"),
      documentRoute("invoice", after),
    ],
  );
}

async function refusal(before: Row, to: "open" | "draft"): Promise<string> {
  const staged = client(before, to === "open" ? "resetToOpen" : "resetToDraft", before);
  const error = await prepareWrite(tool, { id: 1001, to }, staged).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(staged.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

describe("sevdesk_invoice_reset (spec resetToOpen/resetToDraft; behaviour per sevdesk-rs)", () => {
  it("is a commit tool that needs the target", () => {
    expect(tool.name).toBe("sevdesk_invoice_reset");
    expect(tool.tier).toBe("commit");
    expect(tool.input.safeParse({ id: 1001 }).success).toBe(false);
    expect(tool.input.safeParse({ id: 1001, to: "paid" }).success).toBe(false);
  });

  it("resets a paid invoice to open and says its payments are unlinked", async () => {
    const staged = client(paid, "resetToOpen", invoiceRow());

    const { plan, output } = await executeWrite(tool, { id: 1001, to: "open" }, staged);

    expect(staged.writes()).toEqual([
      expect.objectContaining({ method: "PUT", path: "/Invoice/1001/resetToOpen", tier: "commit" }),
    ]);
    expect(staged.writes()[0]).not.toHaveProperty("body");
    expect(plan.preview.action).toBe(
      "Reset invoice RE-1001 to open (Paid → open 200) and unlink all its payments.",
    );
    expect(plan.preview.facts).toContainEqual({ label: "Paid so far", value: "177.33 EUR" });
    expect(plan.preview.warnings[0]).toContain(
      "linked bank transactions are unlinked and return to unbooked (status 100)",
    );
    expect(plan.preview.irreversible).toBe(false);
    expect(output.data["invoice"]).toMatchObject({ status: { code: 200 } });
    expect(output.summary).toBe("Invoice 1001 reset to open: status Open / due (200).");
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "1001" }]);
  });

  it("allows resetting an enshrined paid invoice to open, with a warning", async () => {
    const enshrinedPaid = { ...paid, enshrined: ENSHRINED };
    const plan = await prepareWrite(
      tool,
      { id: 1001, to: "open" },
      client(enshrinedPaid, "resetToOpen", invoiceRow()),
    );
    expect(plan.preview.warnings.at(-1)).toContain("The invoice is enshrined");
  });

  it("resets an open invoice to draft with a GoBD warning", async () => {
    const staged = client(invoiceRow(), "resetToDraft", invoiceRow({ status: "100" }));

    const { plan, output } = await executeWrite(tool, { id: 1001, to: "draft" }, staged);

    expect(staged.writes()[0]?.path).toBe("/Invoice/1001/resetToDraft");
    expect(plan.preview.action).toBe("Reset invoice RE-1001 to draft (open 200 → draft 100).");
    expect(plan.preview.warnings[1]).toContain("cancel it (sevdesk_invoice_cancel)");
    expect(output.data["invoice"]).toMatchObject({ status: { code: 100 } });
  });

  it("refuses resets sevDesk would refuse or that make no sense", async () => {
    expect(await refusal(invoiceRow(), "open")).toContain("already open with no payments");
    expect(await refusal(invoiceRow({ status: "100" }), "open")).toContain("cannot raise");
    expect(await refusal(invoiceRow({ status: "1000", paidAmount: 0 }), "open")).toContain(
      "cancelled invoice",
    );
    expect(await refusal(paid, "draft")).toContain("Reset it to open first");
    expect(await refusal(invoiceRow({ enshrined: ENSHRINED }), "draft")).toContain(
      "never resets an enshrined document to draft",
    );
    expect(await refusal(invoiceRow({ status: "100" }), "draft")).toContain("already a draft");
  });
});

describe("sevdesk_credit_note_reset", () => {
  it("resets a paid credit note to open and an open one to draft", async () => {
    const creditNoteTool = resetTool("creditNote");
    const toOpen = new StagedClient(
      [documentRoute("creditNote", creditNoteRow({ status: "1000" }))],
      [
        writeRoute("PUT", "/CreditNote/2001/resetToOpen", "credit-note-reset.json"),
        documentRoute("creditNote", creditNoteRow()),
      ],
    );
    const { plan, output } = await executeWrite(creditNoteTool, { id: 2001, to: "open" }, toOpen);
    expect(toOpen.writes()[0]?.path).toBe("/CreditNote/2001/resetToOpen");
    expect(plan.preview.warnings[0]).toContain("Every payment booked on this credit note");
    expect(output.data["creditNote"]).toMatchObject({ status: { code: 200 } });

    const toDraft = new StagedClient(
      [documentRoute("creditNote", creditNoteRow())],
      [
        writeRoute("PUT", "/CreditNote/2001/resetToDraft", "credit-note-reset.json"),
        documentRoute("creditNote", creditNoteRow({ status: "100" })),
      ],
    );
    const draft = await executeWrite(creditNoteTool, { id: 2001, to: "draft" }, toDraft);
    expect(toDraft.writes()[0]?.path).toBe("/CreditNote/2001/resetToDraft");
    expect(draft.plan.preview.warnings[1]).toContain("issue a new document instead");
  });
});
