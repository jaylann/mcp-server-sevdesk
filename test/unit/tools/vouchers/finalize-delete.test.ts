import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { readOnlyClient, tierScopedClient } from "../../../../src/sevdesk/scoped-client.js";
import { voucherDeleteDraftTool } from "../../../../src/tools/vouchers/draft-delete.js";
import { voucherFinalizeTool } from "../../../../src/tools/vouchers/finalize.js";
import { testContext } from "../../../helpers/fake-client.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { StagedClient } from "../lifecycle/helpers.js";
import {
  accountsRoute,
  draftRow,
  guidanceRoute,
  missingVoucherRoute,
  positionRow,
  positionsRoute,
  regularRoute,
  type Row,
  saveRoute,
  smallBusinessRoute,
  version1Route,
  version2Route,
  voucherRoute,
  writeRoute,
} from "./routes.js";

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  return (error as SevdeskError).message;
}

function finalizeClient(
  row: Row = draftRow(),
  positions: readonly Row[] = [positionRow()],
  extra: readonly FakeRoute[] = [],
): StagedClient {
  const before = [
    ...extra,
    voucherRoute(row),
    positionsRoute(2101, positions),
    version2Route,
    regularRoute,
    guidanceRoute,
    accountsRoute,
  ];
  const after = [
    saveRoute(),
    voucherRoute({ ...row, status: "100" }),
    positionsRoute(2101, positions),
  ];
  return new StagedClient(before, after);
}

describe("sevdesk_voucher_finalize", () => {
  const tool = voucherFinalizeTool;

  it("is a commit tool", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("books the draft with saveVoucher, its id, status 100 and the positions untouched", async () => {
    const fake = finalizeClient();
    const { plan, output } = await executeWrite(tool, { id: 2101 }, fake);

    const writes = fake.writes();
    expect(writes.map((call) => [call.method, call.path, call.tier])).toEqual([
      ["POST", "/Voucher/Factory/saveVoucher", "commit"],
    ]);
    expect(writes[0]?.body).toEqual({
      voucher: {
        id: 2101,
        objectName: "Voucher",
        mapAll: true,
        voucherDate: "02.11.2026",
        supplier: { id: 1001, objectName: "Contact" },
        supplierName: "Musterfirma GmbH",
        description: "ER-2026-0815",
        paymentDeadline: "16.11.2026",
        deliveryDate: "02.11.2026",
        status: 100,
        taxRule: { id: 9, objectName: "TaxRule" },
        creditDebit: "C",
        voucherType: "VOU",
        currency: "EUR",
      },
      voucherPosSave: null,
      voucherPosDelete: null,
    });
    expect(plan.preview.action).toBe(
      "Finalize draft voucher 2101 (expense, gross 119 EUR): draft → open, booked.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Position 1",
      value: "6815 Bürobedarf (account 4266): 119 EUR gross, 19 % VAT; Druckerpapier und Toner",
    });
    expect(plan.preview.warnings).toContain(
      "The voucher has no receipt file attached; GoBD expects the receipt with the voucher.",
    );
    expect(plan.previewDe.action).toBe(
      "Belegentwurf 2101 fertigstellen (Ausgabe, brutto 119 EUR): Entwurf → offen, verbucht.",
    );
    expect(plan.previewDe.facts).toContainEqual({
      label: "Position 1",
      value: "6815 Bürobedarf (Konto 4266): 119 EUR brutto, 19 % USt.; Druckerpapier und Toner",
    });
    expect(plan.previewDe.facts).toContainEqual({
      label: "Status",
      value: "Entwurf 50 → offen 100",
    });
    expect(plan.previewDe.facts).toContainEqual({
      label: "Art",
      value: "Ausgabe: Die Zahlung geht vom Bankkonto ab",
    });
    expect(plan.previewDe.warnings).toContain(
      "An diesem Beleg hängt keine Belegdatei; nach den GoBD gehört der Originalbeleg dazu.",
    );
    expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
    expect(output.data.voucher.status).toEqual({ code: 100, label: "Unpaid / due" });
    expect(output.data.notes).toBeUndefined();
    expect(output.summary).toBe("Finalized voucher 2101 (1 position, gross 119.00 EUR).");
  });

  it("notes a read-back that is still a draft", async () => {
    const fake = new StagedClient(
      [
        voucherRoute(draftRow()),
        positionsRoute(2101, [positionRow()]),
        version2Route,
        regularRoute,
        guidanceRoute,
        accountsRoute,
      ],
      [saveRoute(), voucherRoute(draftRow()), positionsRoute(2101, [positionRow()])],
    );
    const { output } = await executeWrite(tool, { id: 2101 }, fake);
    expect(output.data.notes).toEqual([
      "The voucher reads back with status 50 (Draft), not 100. Check it in sevDesk.",
    ]);
  });

  it("is blocked for a write-tier client, and a draft body passes the write tier", async () => {
    const fake = new FakeSevdeskClient([saveRoute()]);
    const plan = await prepareWrite(tool, { id: 2101 }, finalizeClient());
    await expect(
      tierScopedClient(fake, "write").request({
        method: "POST",
        path: "/Voucher/Factory/saveVoucher",
        body: plan.state.body,
      }),
    ).rejects.toMatchObject({ kind: "blocked" });
    const draftBody = { ...plan.state.body, voucher: { ...plan.state.body.voucher, status: 50 } };
    await expect(
      tierScopedClient(fake, "write").request({
        method: "POST",
        path: "/Voucher/Factory/saveVoucher",
        body: draftBody,
      }),
    ).resolves.toBeDefined();
    await expect(
      readOnlyClient(fake, "test").request({
        method: "POST",
        path: "/Voucher/Factory/saveVoucher",
        body: draftBody,
      }),
    ).rejects.toMatchObject({ kind: "blocked" });
  });

  it("refuses at execute when the voucher changed after the preview (nothing sent)", async () => {
    const plan = await prepareWrite(tool, { id: 2101 }, finalizeClient());
    const changed = new FakeSevdeskClient([voucherRoute(draftRow({ status: "100" })), saveRoute()]);
    const error = (await tool
      .execute(
        tool.input.parse({ id: 2101 }),
        plan,
        testContext(tierScopedClient(changed, "commit")),
      )
      .catch((caught: unknown) => caught)) as SevdeskError;
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error.kind).toBe("validation");
    expect(error.message).toBe(
      "Voucher 2101 is no longer an unlocked draft (status 100): it changed after the preview. " +
        "Nothing was sent to sevDesk; check it with sevdesk_voucher_get and prepare the call again.",
    );
    expect(changed.writes()).toEqual([]);
    const enshrined = new FakeSevdeskClient([
      voucherRoute(draftRow({ enshrined: "2026-11-03T10:00:00+01:00" })),
    ]);
    const second = (await tool
      .execute(
        tool.input.parse({ id: 2101 }),
        plan,
        testContext(tierScopedClient(enshrined, "commit")),
      )
      .catch((caught: unknown) => caught)) as SevdeskError;
    expect(second.message).toContain("(status 50, enshrined)");
  });

  it("notes when the attached receipt is gone after the finalize", async () => {
    const withFile = draftRow({ document: { id: "7001", objectName: "Document" } });
    const fake = new StagedClient(
      [
        voucherRoute(withFile),
        positionsRoute(2101, [positionRow()]),
        version2Route,
        regularRoute,
        guidanceRoute,
        accountsRoute,
      ],
      [
        saveRoute(),
        voucherRoute({ ...withFile, status: "100", document: null }),
        positionsRoute(2101, [positionRow()]),
      ],
    );
    const { output } = await executeWrite(tool, { id: 2101 }, fake);
    expect(output.data.notes).toEqual([
      "The voucher had a receipt file attached before this call, and sevDesk's answer after the " +
        "save does not show it anymore. Check the voucher in sevDesk and attach the receipt " +
        "again if it is missing.",
    ]);
  });

  it("names the voucher as written when the save answer has no id", async () => {
    const fake = new StagedClient(
      [
        voucherRoute(draftRow()),
        positionsRoute(2101, [positionRow()]),
        version2Route,
        regularRoute,
        guidanceRoute,
        accountsRoute,
      ],
      [
        {
          method: "POST",
          path: "/Voucher/Factory/saveVoucher",
          response: { body: { objects: { voucherPos: [] } } },
        },
      ],
    );
    const error = (await executeWrite(tool, { id: 2101 }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toBe(
      "sevDesk accepted the save of voucher 2101, but its answer did not name the voucher, so " +
        "it could not be read back. Do not repeat the call; check the voucher with " +
        "sevdesk_voucher_get.",
    );
    expect(error.completedWrites).toEqual([{ objectName: "Voucher", id: "2101" }]);
  });

  it("refuses a voucher that is already open", async () => {
    const message = await refusal(
      prepareWrite(tool, { id: 2101 }, finalizeClient(draftRow({ status: "100" }))),
    );
    expect(message).toBe(
      "Voucher 2101 is already finalized (status 100); there is nothing to do. Book its " +
        "payment with sevdesk_voucher_book_payment.",
    );
  });

  it("refuses a draft without positions or with a legacy position (D-045)", async () => {
    expect(await refusal(prepareWrite(tool, { id: 2101 }, finalizeClient(draftRow(), [])))).toBe(
      "Voucher 2101 has no positions. Add them with sevdesk_voucher_update_draft first.",
    );
    const legacy = positionRow({
      accountDatev: null,
      accountingType: { id: "26", objectName: "AccountingType" },
    });
    expect(
      await refusal(prepareWrite(tool, { id: 2101 }, finalizeClient(draftRow(), [legacy]))),
    ).toContain("Position 1 of voucher 2101 has no Update 2.0 booking account");
  });

  it("refuses a draft without a Belegnummer before anything is confirmed (D-080)", async () => {
    for (const description of [null, "", "  "]) {
      const client = finalizeClient(draftRow({ description }));
      expect(await refusal(prepareWrite(tool, { id: 2101 }, client))).toBe(
        "Voucher 2101 has no Belegnummer, and sevDesk books no voucher without one. Set it with " +
          "sevdesk_voucher_update_draft (number) first: the receipt's invoice or receipt number, " +
          "or your own reference if it has none.",
      );
    }
  });

  it("refuses a tax rule that does not fit the regime, with the fix", async () => {
    const message = await refusal(
      prepareWrite(
        tool,
        { id: 2101 },
        finalizeClient(draftRow(), [positionRow()], [smallBusinessRoute]),
      ),
    );
    expect(message).toContain("Kleinunternehmer regulation (§19 UStG), so tax rule 9");
    expect(message).toContain(
      "Change the tax rule of voucher 2101 with sevdesk_voucher_update_draft (taxRuleId) first.",
    );
  });

  it("refuses a rule of the other direction and an account the guidance rejects (B2)", async () => {
    expect(
      await refusal(
        prepareWrite(
          tool,
          { id: 2101 },
          finalizeClient(draftRow({ taxRule: { id: "1", objectName: "TaxRule" } })),
        ),
      ),
    ).toContain("which is not a rule for expense vouchers");
    const wrongAccount = positionRow({ accountDatev: { id: "5192", objectName: "AccountDatev" } });
    const message = await refusal(
      prepareWrite(tool, { id: 2101 }, finalizeClient(draftRow(), [wrongAccount])),
    );
    expect(message).toContain("Position 1: account 5192 (no. 4400) cannot be used for expense");
  });

  it("refuses a bookkeeping 1.0 account", async () => {
    const fake = new FakeSevdeskClient([
      voucherRoute(draftRow()),
      positionsRoute(2101, [positionRow()]),
      version1Route,
    ]);
    expect(await refusal(prepareWrite(tool, { id: 2101 }, fake))).toContain(
      "bookkeeping system 1.0",
    );
  });
});

describe("sevdesk_voucher_delete_draft", () => {
  const tool = voucherDeleteDraftTool;

  it("is a commit tool (a human confirms), destructive and idempotent", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("deletes a draft and confirms it is gone", async () => {
    const fake = new StagedClient(
      [voucherRoute(draftRow())],
      [writeRoute("DELETE", "/Voucher/2101", "voucher-delete.json"), missingVoucherRoute(2101)],
    );
    const { plan, output } = await executeWrite(tool, { id: 2101 }, fake);
    expect(fake.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["DELETE", "/Voucher/2101", "commit"],
    ]);
    expect(plan.preview.action).toBe("Delete voucher 2101 (draft) from sevDesk.");
    expect(plan.preview.irreversible).toBe(true);
    expect(plan.preview.facts.slice(0, 4)).toEqual([
      { label: "Voucher (Beleg)", value: "ER-2026-0815 (id 2101)" },
      { label: "Type", value: "Beleg (VOU)" },
      { label: "Status", value: "Draft (50)" },
      { label: "Kind", value: "expense (Ausgabe)" },
    ]);
    expect(plan.previewDe.action).toBe("Beleg 2101 (Entwurf) aus sevDesk löschen.");
    expect(plan.previewDe.irreversible).toBe(true);
    expect(plan.previewDe.facts.slice(0, 4)).toEqual([
      { label: "Beleg", value: "ER-2026-0815 (ID 2101)" },
      { label: "Typ", value: "Beleg (VOU)" },
      { label: "Status", value: "Entwurf (50)" },
      { label: "Art", value: "Ausgabe" },
    ]);
    expect(plan.previewDe.warnings).toEqual([
      "Der Entwurf und alle seine Positionen werden aus sevDesk gelöscht; das lässt sich nicht " +
        "rückgängig machen.",
    ]);
    expect(output.data).toMatchObject({ deleted: true, voucher: { id: 2101 } });
    expect(output.summary).toBe("Deleted draft voucher 2101.");
    expect(output.affected).toEqual([{ objectName: "Voucher", id: "2101" }]);
  });

  it("says so when sevDesk still returns the voucher", async () => {
    const fake = new StagedClient(
      [voucherRoute(draftRow())],
      [writeRoute("DELETE", "/Voucher/2101", "voucher-delete.json"), voucherRoute(draftRow())],
    );
    const { output } = await executeWrite(tool, { id: 2101 }, fake);
    expect(output.data.deleted).toBe(false);
    expect(output.data.notes?.[0]).toContain("still returns voucher 2101");
  });

  it("reports the deletion as done when the check afterwards fails", async () => {
    const fake = new StagedClient(
      [voucherRoute(draftRow())],
      [
        writeRoute("DELETE", "/Voucher/2101", "voucher-delete.json"),
        {
          path: "/Voucher/2101",
          response: { error: new SevdeskError({ kind: "server", message: "Down." }) },
        },
      ],
    );
    const error = (await executeWrite(tool, { id: 2101 }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.kind).toBe("server");
    expect(error.message).toContain("accepted the deletion of voucher 2101, but the check");
    expect(error.completedWrites).toEqual([{ objectName: "Voucher", id: "2101" }]);
  });

  it("explains sevDesk's 409 for a voucher that is no draft anymore", async () => {
    const fake = new StagedClient(
      [voucherRoute(draftRow())],
      [
        {
          method: "DELETE",
          path: "/Voucher/2101",
          response: {
            error: new SevdeskError({
              kind: "validation",
              status: 409,
              message: "sevDesk rejected the request.",
              upstreamMessage: "Voucher can only be deleted in status 50 but is status 100",
            }),
          },
        },
      ],
    );
    const error = (await executeWrite(tool, { id: 2101 }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      "sevDesk refused to delete voucher 2101: only drafts (status 50) can be deleted, and it " +
        "is no longer one (probably finalized in the meantime). Nothing was deleted; check it " +
        "with sevdesk_voucher_get.",
    );
    expect(error.upstreamMessage).toContain("only be deleted in status 50");
    expect(error.completedWrites).toEqual([]);
  });

  it("passes other delete failures through", async () => {
    const failure = new SevdeskError({ kind: "server", message: "Down." });
    const fake = new StagedClient(
      [voucherRoute(draftRow())],
      [{ method: "DELETE", path: "/Voucher/2101", response: { error: failure } }],
    );
    await expect(executeWrite(tool, { id: 2101 }, fake)).rejects.toBe(failure);
  });

  it("warns that an attached receipt may stay", async () => {
    const fake = new FakeSevdeskClient([
      voucherRoute(draftRow({ document: { id: "7001", objectName: "Document" } })),
    ]);
    const { preview, previewDe } = await prepareWrite(tool, { id: 2101 }, fake);
    expect(preview.warnings[1]).toContain("attached receipt file");
    expect(previewDe.warnings[1]).toBe(
      "Am Beleg hängt eine Belegdatei; ob sevDesk sie mitlöscht oder unter den Dokumenten " +
        "behält, ist nicht dokumentiert.",
    );
  });

  it.each([
    ["an open voucher", { status: "100" }, "is not a draft (status 100, Unpaid / due)"],
    ["an enshrined voucher", { enshrined: "2026-11-03T10:00:00+01:00" }, "can never be deleted"],
  ])("refuses %s", async (_label, overrides, expected) => {
    const fake = new FakeSevdeskClient([voucherRoute(draftRow(overrides))]);
    expect(await refusal(prepareWrite(tool, { id: 2101 }, fake))).toContain(expected);
  });

  it("refuses an unknown voucher", async () => {
    const fake = new FakeSevdeskClient([missingVoucherRoute(2101)]);
    expect(await refusal(prepareWrite(tool, { id: 2101 }, fake))).toBe(
      "Voucher 2101 does not exist in sevDesk (or was deleted already).",
    );
  });
});
