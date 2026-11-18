import { describe, expect, it } from "vitest";

import type { Tier } from "../../../../src/safety/tiers.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { documentDeleteDraftTool } from "../../../../src/tools/documents/delete-draft-tool.js";
import { selectTools } from "../../../../src/tools/registry.js";
import type { ToolsetName } from "../../../../src/tools/toolsets.js";
import { testConfig } from "../../../helpers/config.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { discountRow, discountsRoute } from "../drafts/routes.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  orderRow,
  positionRoutes,
  renderRoute,
  type Row,
  StagedClient,
  writeRoute,
} from "../lifecycle/helpers.js";

const tool = documentDeleteDraftTool;

type KindArg = "invoice" | "credit_note" | "order";
type RouteKind = "invoice" | "creditNote" | "order";

interface Case {
  readonly arg: KindArg;
  readonly kind: RouteKind;
  readonly path: string;
  readonly row: Row;
  readonly outputKey: "invoice" | "creditNote" | "order";
}

const DRAFTS: readonly Case[] = [
  {
    arg: "invoice",
    kind: "invoice",
    path: "/Invoice/1001",
    row: invoiceRow({ status: "100", invoiceNumber: null }),
    outputKey: "invoice",
  },
  {
    arg: "credit_note",
    kind: "creditNote",
    path: "/CreditNote/2001",
    row: creditNoteRow({ status: "100" }),
    outputKey: "creditNote",
  },
  {
    arg: "order",
    kind: "order",
    path: "/Order/3002",
    row: orderRow({ status: "100" }),
    outputKey: "order",
  },
];

function idOf(row: Row): number {
  return Number(row["id"]);
}

function missing(path: string): FakeRoute {
  return {
    path,
    response: {
      error: new SevdeskError({ kind: "not_found", status: 404, message: "Not found." }),
    },
  };
}

/** Prepare reads the draft; after the DELETE, the GET answers `after` (default: 404, gone). */
function staged(c: Case, after?: FakeRoute): StagedClient {
  return new StagedClient(
    [documentRoute(c.kind, c.row)],
    [writeRoute("DELETE", c.path, "document-delete.json"), after ?? missing(c.path)],
  );
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  return (error as SevdeskError).message;
}

function readsOnly(c: Case, row: Row): FakeSevdeskClient {
  return new FakeSevdeskClient(withCountryRoute([documentRoute(c.kind, row), ...positionRoutes()]));
}

const [INVOICE, CREDIT_NOTE, ORDER] = DRAFTS as [Case, Case, Case];
const INVOICE_ARGS = { kind: "invoice", id: 1001 };

describe("sevdesk_document_delete_draft", () => {
  it("is a commit tool in the meta toolset: destructive, idempotent, closed world", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("meta");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it.each(DRAFTS)("deletes a $arg draft and confirms with a GET that it is gone", async (c) => {
    const fake = staged(c);
    const { plan, output } = await executeWrite(tool, { kind: c.arg, id: idOf(c.row) }, fake);
    expect(fake.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["DELETE", c.path, "commit"],
    ]);
    // The read-back after the DELETE.
    expect(fake.after.calls.map((call) => [call.method, call.path])).toEqual([
      ["DELETE", c.path],
      ["GET", c.path],
    ]);
    expect(plan.preview.irreversible).toBe(true);
    expect(plan.previewDe.irreversible).toBe(true);
    expect(plan.binding).toMatch(/^[0-9a-f]{64}$/);
    expect(output.data).toMatchObject({
      kind: c.arg,
      deleted: true,
      [c.outputKey]: { id: idOf(c.row) },
    });
    expect(output.data.notes).toBeUndefined();
    expect(output.affected).toEqual([
      { objectName: c.path.split("/")[1], id: String(idOf(c.row)) },
    ]);
  });

  it("names the document in both previews", async () => {
    const plan = await prepareWrite(
      tool,
      { kind: "invoice", id: 1001 },
      readsOnly(INVOICE, INVOICE.row),
    );
    expect(plan.preview.action).toBe("Delete invoice 1001 (draft) from sevDesk.");
    expect(plan.previewDe.action).toBe("Rechnung 1001 (Entwurf) aus sevDesk löschen.");
    const labels = plan.preview.facts.map((fact) => fact.label);
    expect(labels).toEqual(
      expect.arrayContaining(["Invoice (Rechnung)", "Status", "Customer", "Date", "Gross"]),
    );
    expect(plan.preview.facts[0]).toEqual({
      label: "Invoice (Rechnung)",
      value: "id 1001, no number yet",
    });
    expect(plan.preview.facts.find((fact) => fact.label === "Status")?.value).toBe("Draft (100)");
    expect(plan.preview.facts.find((fact) => fact.label === "Gross")?.value).toBe("177.33 EUR");
    expect(plan.previewDe.facts).toHaveLength(plan.preview.facts.length);
    expect(plan.preview.warnings).toEqual([
      "The draft and all its positions are deleted from sevDesk; this cannot be undone.",
    ]);
    expect(plan.previewDe.warnings).toEqual([
      "Der Entwurf und alle seine Positionen werden aus sevDesk gelöscht; das lässt sich nicht " +
        "rückgängig machen.",
    ]);
  });

  it.each([CREDIT_NOTE, ORDER])(
    "says that the number of a numbered $arg draft comes back only if it was the last (D-066)",
    async (c) => {
      const plan = await prepareWrite(tool, { kind: c.arg, id: idOf(c.row) }, readsOnly(c, c.row));
      expect(plan.preview.warnings).toHaveLength(2);
      expect(plan.preview.warnings[1]).toBe(
        "If the draft's number is the last one sevDesk handed out in its number range, sevDesk " +
          "gives it to the next document again; otherwise the number stays unused and the range " +
          "has a gap.",
      );
      expect(plan.previewDe.warnings[1]).toBe(
        "Ist die Nummer des Entwurfs die zuletzt vergebene seines Nummernkreises, vergibt sevDesk " +
          "sie an das nächste Dokument erneut; sonst bleibt die Nummer unbenutzt und der " +
          "Nummernkreis hat eine Lücke.",
      );
    },
  );

  describe("an invoice draft with a number (it may have been issued and reset to draft)", () => {
    const numbered = { status: "100", invoiceNumber: "RE-1012", sendDate: null, sendType: null };

    it("warns that deleting it leaves a gap if the number was issued", async () => {
      const row = invoiceRow(numbered);
      const plan = await prepareWrite(tool, INVOICE_ARGS, readsOnly(INVOICE, row));
      expect(plan.preview.warnings).toEqual([
        "The draft and all its positions are deleted from sevDesk; this cannot be undone.",
        "This invoice draft already has a number. If that number was issued (for example, the " +
          "invoice was finalized and later reset to draft), deleting the draft leaves a gap in " +
          "the invoice number range. An issued invoice is cancelled, not deleted: finalize it " +
          "again and cancel it with sevdesk_invoice_cancel (Storno).",
      ]);
      expect(plan.previewDe.warnings).toEqual([
        "Der Entwurf und alle seine Positionen werden aus sevDesk gelöscht; das lässt sich nicht " +
          "rückgängig machen.",
        "Dieser Rechnungsentwurf hat bereits eine Nummer. Wurde sie schon vergeben (etwa weil " +
          "die Rechnung fertiggestellt und später auf Entwurf zurückgesetzt wurde), hinterlässt " +
          "das Löschen eine Lücke im Nummernkreis der Rechnungen. Eine ausgestellte Rechnung " +
          "wird nicht gelöscht, sondern storniert: Stelle sie erneut fertig und storniere sie " +
          "mit sevdesk_invoice_cancel (Storno).",
      ]);
      // The number itself is among the facts, not in the warning.
      expect(plan.preview.facts[0]).toEqual({
        label: "Invoice (Rechnung)",
        value: "RE-1012 (id 1001)",
      });
    });

    it("says more when sevDesk records it as sent, with the send date", async () => {
      const row = invoiceRow({
        ...numbered,
        sendDate: "2026-10-22T00:00:00+02:00",
        sendType: "VM",
      });
      const plan = await prepareWrite(tool, INVOICE_ARGS, readsOnly(INVOICE, row));
      expect(plan.preview.warnings[1]).toBe(
        "This invoice draft has a number, and sevDesk records it as sent on 2026-10-22: the " +
          "customer has probably received it under that number. Deleting it leaves a gap in the " +
          "invoice number range and removes an invoice the customer holds. An issued invoice is " +
          "cancelled, not deleted: finalize it again and cancel it with sevdesk_invoice_cancel " +
          "(Storno).",
      );
      expect(plan.previewDe.warnings[1]).toBe(
        "Dieser Rechnungsentwurf hat eine Nummer, und sevDesk führt ihn als versendet (am " +
          "22.10.2026): Der Kunde hat die Rechnung wahrscheinlich unter dieser Nummer erhalten. " +
          "Das Löschen hinterlässt eine Lücke im Nummernkreis der Rechnungen und entfernt eine " +
          "Rechnung, die beim Kunden liegt. Eine ausgestellte Rechnung wird nicht gelöscht, " +
          "sondern storniert: Stelle sie erneut fertig und storniere sie mit " +
          "sevdesk_invoice_cancel (Storno).",
      );
    });

    it("leaves the date out when only the send type says it was sent", async () => {
      const row = invoiceRow({ ...numbered, sendType: "VPDF" });
      const plan = await prepareWrite(tool, INVOICE_ARGS, readsOnly(INVOICE, row));
      expect(plan.preview.warnings[1]).toMatch(
        /^This invoice draft has a number, and sevDesk records it as sent: /,
      );
      expect(plan.previewDe.warnings[1]).toMatch(
        /^Dieser Rechnungsentwurf hat eine Nummer, und sevDesk führt ihn als versendet: /,
      );
    });

    it("still deletes it after the approval: a warning, not a refusal", async () => {
      const row = invoiceRow({
        ...numbered,
        sendDate: "2026-10-22T00:00:00+02:00",
        sendType: "VM",
      });
      const fake = staged({ ...INVOICE, row });
      const { output } = await executeWrite(tool, INVOICE_ARGS, fake);
      expect(fake.writes().map((call) => [call.method, call.path])).toEqual([
        ["DELETE", "/Invoice/1001"],
      ]);
      expect(output.data.deleted).toBe(true);
    });
  });

  it("leaves the number note out for a credit note draft without a number", async () => {
    const row = creditNoteRow({ status: "100", creditNoteNumber: null });
    const plan = await prepareWrite(
      tool,
      { kind: "credit_note", id: 2001 },
      readsOnly(CREDIT_NOTE, row),
    );
    expect(plan.preview.warnings).toHaveLength(1);
  });

  it("binds the approval to the stored record, its positions, discounts and layout", async () => {
    const id = 1001;
    const args = { kind: "invoice", id };
    const position = {
      id: "7001",
      objectName: "InvoicePos",
      invoice: { id: "1001", objectName: "Invoice" },
      name: "Beratung",
      quantity: "1",
      price: "100",
    };
    // `extra` routes come first, so they replace the defaults of `positionRoutes`.
    const withRows = (
      row: Row,
      rows: readonly Row[],
      extra: readonly FakeRoute[] = [],
    ): FakeSevdeskClient =>
      new FakeSevdeskClient(
        withCountryRoute([
          documentRoute("invoice", row),
          ...extra,
          ...positionRoutes({ "/InvoicePos": rows }),
        ]),
      );
    const fake = withRows(INVOICE.row, [position]);
    const base = await prepareWrite(tool, args, fake);
    // The binding read the discounts and, for a draft, the layout (`render` without reload, a
    // reading POST: no write).
    expect(fake.calls.map((call) => [call.method, call.path])).toEqual(
      expect.arrayContaining([
        ["GET", "/Invoice/1001/getDiscounts"],
        ["POST", "/Invoice/1001/render"],
      ]),
    );
    expect(fake.writes()).toEqual([]);
    const same = await prepareWrite(tool, args, withRows(INVOICE.row, [position]));
    const editedText = await prepareWrite(
      tool,
      args,
      withRows({ ...INVOICE.row, footText: "Andere Bankverbindung" }, [position]),
    );
    const editedPosition = await prepareWrite(
      tool,
      args,
      withRows(INVOICE.row, [{ ...position, price: "200" }]),
    );
    const addedDiscount = await prepareWrite(
      tool,
      args,
      withRows(
        INVOICE.row,
        [position],
        [discountsRoute("Invoice", id, [discountRow("Invoice", id)])],
      ),
    );
    const otherLanguage = await prepareWrite(
      tool,
      args,
      withRows(INVOICE.row, [position], [renderRoute("invoice", { language: "en" })]),
    );
    expect(same.binding).toBe(base.binding);
    expect(editedText.binding).not.toBe(base.binding);
    expect(editedPosition.binding).not.toBe(base.binding);
    expect(addedDiscount.binding).not.toBe(base.binding);
    expect(otherLanguage.binding).not.toBe(base.binding);
  });

  it.each([
    ["the full record", ORDER.row],
    // The read-back is a plain GET: a record this server could not map still counts as there.
    ["a record this server could not map", { id: "3002", objectName: "Order", status: "bogus" }],
  ])("says so when sevDesk still returns %s after the DELETE", async (_label, row) => {
    const fake = staged(ORDER, { path: ORDER.path, response: { body: { objects: [row] } } });
    const { output } = await executeWrite(tool, { kind: "order", id: 3002 }, fake);
    expect(fake.after.calls.map((call) => [call.method, call.path, call.query])).toEqual([
      ["DELETE", ORDER.path, {}],
      ["GET", ORDER.path, {}],
    ]);
    expect(output.data.deleted).toBe(false);
    expect(output.data.notes).toEqual([
      "sevDesk accepted the deletion, but still returns order 3002. Check it with " +
        "sevdesk_order_get.",
    ]);
    expect(output.summary).toBe(
      "Asked sevDesk to delete order 3002; it is still there. See notes.",
    );
  });

  it("counts an empty answer to the read-back as gone", async () => {
    const fake = staged(ORDER, { path: ORDER.path, response: { body: { objects: [] } } });
    const { output } = await executeWrite(tool, { kind: "order", id: 3002 }, fake);
    expect(output.data.deleted).toBe(true);
  });

  it("reports the deletion as done when the read-back fails", async () => {
    const fake = staged(CREDIT_NOTE, {
      path: CREDIT_NOTE.path,
      response: { error: new SevdeskError({ kind: "server", message: "Down." }) },
    });
    const error = (await executeWrite(tool, { kind: "credit_note", id: 2001 }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.kind).toBe("server");
    expect(error.message).toBe(
      "sevDesk accepted the deletion of credit note 2001, but the check afterwards failed: " +
        "Down. Do not delete again; check with sevdesk_credit_note_get.",
    );
    expect(error.completedWrites).toEqual([{ objectName: "CreditNote", id: "2001" }]);
  });

  it("reports the deletion as done when the read-back answer is unreadable", async () => {
    const fake = staged(CREDIT_NOTE, {
      path: CREDIT_NOTE.path,
      response: { body: { objects: "not a record" } },
    });
    const error = (await executeWrite(tool, { kind: "credit_note", id: 2001 }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toBe(
      "sevDesk accepted the deletion of credit note 2001, but the check afterwards failed: " +
        "sevDesk returned an unexpected format: expected one credit note 2001. Do not delete " +
        "again; check with sevdesk_credit_note_get.",
    );
    expect(error.completedWrites).toEqual([{ objectName: "CreditNote", id: "2001" }]);
  });

  it("reports the deletion as done when the read-back throws something else", async () => {
    const body = {
      // A failure that is no SevdeskError, thrown while the answer is read.
      get objects(): never {
        throw new TypeError("Cannot read the answer.");
      },
    };
    const fake = staged(CREDIT_NOTE, { path: CREDIT_NOTE.path, response: { body } });
    const error = (await executeWrite(tool, { kind: "credit_note", id: 2001 }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error.kind).toBe("unexpected_response");
    // Its text is not ours, so it stays out of the message.
    expect(error.message).toBe(
      "sevDesk accepted the deletion of credit note 2001, but the check afterwards failed. Do " +
        "not delete again; check with sevdesk_credit_note_get.",
    );
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.completedWrites).toEqual([{ objectName: "CreditNote", id: "2001" }]);
  });

  it("explains sevDesk's 409 for a document that is no draft anymore", async () => {
    const fake = new StagedClient(
      [documentRoute("order", ORDER.row)],
      [
        {
          method: "DELETE",
          path: "/Order/3002",
          response: {
            error: new SevdeskError({
              kind: "validation",
              status: 409,
              message: "sevDesk rejected the request.",
              upstreamMessage: "Order can only be deleted in status 100 but is status 200",
            }),
          },
        },
      ],
    );
    const error = (await executeWrite(tool, { kind: "order", id: 3002 }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      "sevDesk refused to delete order 3002: only drafts (status 100) can be deleted, and it is " +
        "no longer one (probably finalized in the meantime). Nothing was deleted; check it with " +
        "sevdesk_order_get.",
    );
    // Our own sentence, so the model sees it instead of the generic advice.
    expect(error.explained).toBe(true);
    expect(error.upstreamMessage).toContain("can only be deleted in status 100");
    expect(error.completedWrites).toEqual([]);
    // No read-back after a refusal.
    expect(fake.after.calls.map((call) => call.method)).toEqual(["DELETE"]);
  });

  it("passes other delete failures through", async () => {
    const failure = new SevdeskError({ kind: "server", message: "Down." });
    const fake = new StagedClient(
      [documentRoute("invoice", INVOICE.row)],
      [{ method: "DELETE", path: "/Invoice/1001", response: { error: failure } }],
    );
    await expect(executeWrite(tool, { kind: "invoice", id: 1001 }, fake)).rejects.toBe(failure);
  });

  it.each([
    [INVOICE, { status: "200", invoiceNumber: "RE-1001" }, "is not a draft (status 200"],
    [CREDIT_NOTE, { status: "200" }, "is not a draft (status 200"],
    [ORDER, { status: "200" }, "is not a draft (status 200"],
    [INVOICE, { status: "100", invoiceType: "WKR" }, "recurring invoice template (WKR"],
    [INVOICE, { status: "50", invoiceType: "WKR" }, "recurring invoice template (WKR"],
  ] as const)("refuses %# before any write", async (c, overrides, expected) => {
    const fake = readsOnly(c, { ...c.row, ...overrides });
    expect(await refusal(prepareWrite(tool, { kind: c.arg, id: idOf(c.row) }, fake))).toContain(
      expected,
    );
    expect(fake.writes()).toEqual([]);
  });

  it("refuses an unknown document", async () => {
    const fake = new FakeSevdeskClient(withCountryRoute([missing("/CreditNote/2001")]));
    expect(await refusal(prepareWrite(tool, { kind: "credit_note", id: 2001 }, fake))).toBe(
      "Credit note 2001 does not exist in sevDesk (or was deleted already).",
    );
  });

  it("refuses a kind whose toolset is off, before any request", async () => {
    const fake = readsOnly(ORDER, ORDER.row);
    const toolsets = new Set<ToolsetName>(["meta", "invoices"]);
    expect(await refusal(prepareWrite(tool, { kind: "order", id: 3002 }, fake, { toolsets }))).toBe(
      "Deleting order drafts needs the orders toolset, which is not enabled (SEVDESK_TOOLSETS).",
    );
    expect(fake.calls).toEqual([]);
  });

  it("rejects other kinds and ids", () => {
    expect(() => tool.input.parse({ kind: "voucher", id: 1 })).toThrow();
    expect(() => tool.input.parse({ kind: "creditNote", id: 1 })).toThrow();
    expect(() => tool.input.parse({ kind: "invoice", id: 0 })).toThrow();
  });

  describe("registration", () => {
    const names = (tiers: readonly Tier[], toolsets: readonly ToolsetName[]): string[] =>
      selectTools(
        [tool],
        testConfig({ allowedTiers: new Set(tiers), toolsets: new Set(toolsets) }),
      ).map((selected) => selected.name);

    it("needs the commit tier", () => {
      expect(names(["read", "write"], ["meta", "invoices"])).toEqual([]);
      expect(names(["read", "commit"], ["meta", "invoices"])).toEqual([
        "sevdesk_document_delete_draft",
      ]);
    });

    it("needs at least one of the three document toolsets", () => {
      expect(names(["read", "commit"], ["meta", "vouchers"])).toEqual([]);
      expect(names(["read", "commit"], ["meta", "credit-notes"])).toHaveLength(1);
      expect(names(["read", "commit"], ["meta", "orders"])).toHaveLength(1);
    });
  });
});
