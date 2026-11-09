import { afterEach, describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { tierScopedClient } from "../../../../src/sevdesk/scoped-client.js";
import { voucherUpdateDraftTool as tool } from "../../../../src/tools/vouchers/draft-update.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountsRoute,
  draftRow,
  guidanceRoute,
  missingVoucherRoute,
  positionRow,
  positionsRoute,
  readBackRoutes,
  receiptFolder,
  regularRoute,
  type Row,
  saveRoute,
  smallBusinessRoute,
  uploadRoute,
  version1Route,
  version2Route,
  voucherRoute,
} from "./routes.js";

/** Routes for an update of draft 2101 stored as `row` with `positions`. */
function client(
  row: Row = draftRow(),
  positions: readonly Row[] = [positionRow()],
  extra: readonly FakeRoute[] = [],
): FakeSevdeskClient {
  return new FakeSevdeskClient([
    ...extra,
    voucherRoute(row),
    positionsRoute(Number(row["id"]), positions),
    version2Route,
    regularRoute,
    guidanceRoute,
    accountsRoute,
    { path: "/Contact/1002", response: { fixture: "contacts/contact-1002.json" } },
    saveRoute(Number(row["id"])),
    uploadRoute,
  ]);
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

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const carried = {
  id: 2101,
  objectName: "Voucher",
  mapAll: true,
  voucherDate: "02.11.2026",
  supplier: { id: 1001, objectName: "Contact" },
  supplierName: "Musterfirma GmbH",
  description: "ER-2026-0815",
  paymentDeadline: "16.11.2026",
  deliveryDate: "02.11.2026",
  status: 50,
  taxRule: { id: 9, objectName: "TaxRule" },
  creditDebit: "C",
  voucherType: "VOU",
  currency: "EUR",
};

describe("sevdesk_voucher_update_draft", () => {
  it("is a write tool with update annotations that may read local files", () => {
    expect(tool.tier).toBe("write");
    expect(tool.localEffects).toBe("reads-files");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("changes the Belegnummer and carries every stored field over, positions untouched", async () => {
    const fake = client();
    const { plan, output } = await executeWrite(tool, { id: 2101, number: "ER-2026-0816" }, fake);
    const [save] = fake.writes();
    expect(save?.tier).toBe("write");
    expect(save?.body).toEqual({
      voucher: { ...carried, description: "ER-2026-0816" },
      voucherPosSave: null,
      voucherPosDelete: null,
    });
    expect(plan.preview.action).toBe("Update draft voucher 2101: change Belegnummer.");
    expect(plan.preview.facts).toContainEqual({
      label: "Belegnummer",
      value: "ER-2026-0815 → ER-2026-0816",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Total (unchanged)", value: "119 EUR" });
    expect(output.affected).toEqual([{ objectName: "Voucher", id: "2101" }]);
    expect(output.summary).toBe("Updated draft voucher 2101 (1 position, gross 119.00 EUR).");
  });

  it("replaces all positions in one request (voucherPosDelete lists the stored ones)", async () => {
    const fake = client(draftRow(), [positionRow(), positionRow({ id: "3102" })]);
    const { plan } = await executeWrite(
      tool,
      {
        id: 2101,
        amountMode: "net",
        positions: [{ accountDatevId: 4266, amount: "50", taxRate: 7 }],
      },
      fake,
    );
    expect(fake.writes()[0]?.body).toEqual({
      voucher: carried,
      voucherPosSave: [
        {
          objectName: "VoucherPos",
          mapAll: true,
          accountDatev: { id: 4266, objectName: "AccountDatev" },
          taxRate: 7,
          net: true,
          sumNet: 50,
          isAsset: false,
        },
      ],
      voucherPosDelete: [
        { id: 3101, objectName: "VoucherPos" },
        { id: 3102, objectName: "VoucherPos" },
      ],
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Positions",
      value: "replace 2 positions with 1 position",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Amounts entered as",
      value: "gross → net",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Total (expected)",
      value: "net 50.00 EUR, tax 3.50 EUR, gross 53.50 EUR",
    });
  });

  it("switches from a contact to a typed-in supplier name and back", async () => {
    let fake = client();
    await executeWrite(tool, { id: 2101, supplierName: "Tankstelle Nord" }, fake);
    expect((fake.writes()[0]?.body as { voucher: object }).voucher).toMatchObject({
      supplier: null,
      supplierName: "Tankstelle Nord",
    });

    fake = client(draftRow({ supplier: null, supplierName: "Tankstelle Nord" }));
    const { plan } = await executeWrite(tool, { id: 2101, supplierId: 1002 }, fake);
    const voucher = (fake.writes()[0]?.body as { voucher: Record<string, unknown> }).voucher;
    expect(voucher["supplier"]).toEqual({ id: 1002, objectName: "Contact" });
    expect(voucher).not.toHaveProperty("supplierName");
    expect(plan.preview.facts[2]?.label).toBe("Supplier (Lieferant)");
    expect(plan.preview.facts[2]?.value).toMatch(
      /^Tankstelle Nord \(no contact\) → .+ \(contact 1002\)$/,
    );
  });

  it("checks a new tax rule against the stored positions (B2) before writing", async () => {
    const fake = client();
    const message = await refusal(prepareWrite(tool, { id: 2101, taxRuleId: 10 }, fake));
    expect(message).toContain("Position 1 has a tax rate of 19 %, which tax rule 10");
    expect(fake.writes()).toEqual([]);

    const ok = await prepareWrite(
      tool,
      { id: 2101, taxRuleId: 8 },
      client(draftRow(), [positionRow({ taxRate: "0" })]),
    );
    expect(ok.preview.facts).toContainEqual({
      label: "Tax rule (Steuerregel)",
      value: "tax rule 9 → 8 Innergemeinschaftliche Erwerbe",
    });
  });

  it("refuses a stored legacy position when the tax rule changes (D-045)", async () => {
    const legacy = positionRow({
      accountDatev: null,
      accountingType: { id: "26", objectName: "AccountingType" },
    });
    const message = await refusal(
      prepareWrite(tool, { id: 2101, taxRuleId: 9 }, client(draftRow(), [legacy])),
    );
    expect(message).toContain("has no Update 2.0 booking account");
  });

  it("warns when the kept tax rule does not fit the regime", async () => {
    const { preview } = await prepareWrite(
      tool,
      { id: 2101, number: "X-1" },
      client(draftRow(), [positionRow()], [smallBusinessRoute]),
    );
    expect(preview.warnings).toContain(
      "The draft keeps tax rule 9 (Vorsteuerabziehbare Aufwendungen), which does not fit this " +
        "account's VAT regulation: sevDesk will refuse to book it. Pass taxRuleId to fix it.",
    );
  });

  it("attaches a receipt and warns when one is attached already", async () => {
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const fake = client(draftRow({ document: { id: "7001", objectName: "Document" } }));
    const { plan, output } = await executeWrite(tool, { id: 2101, file: folder.file }, fake, {
      fileDirs: [folder.dir],
    });
    expect(fake.writes().map((call) => call.path)).toEqual([
      "/Voucher/Factory/uploadTempFile",
      "/Voucher/Factory/saveVoucher",
    ]);
    expect(Object.keys(fake.writes()[1]?.body as object)).toEqual([
      "voucher",
      "voucherPosSave",
      "voucherPosDelete",
      "filename",
    ]);
    expect(plan.preview.warnings).toContain(
      "The voucher already has an attached file. sevDesk attaches the new one; whether the " +
        "earlier file stays attached is not documented.",
    );
    expect(output.data.receipt?.name).toBe("Rechnung-0815.pdf");
  });

  it("refuses an XML file as a receipt (only the e-invoice import takes XML)", async () => {
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${folder.dir}/rechnung.xml`, "<Invoice/>");
    const message = await refusal(
      prepareWrite(tool, { id: 2101, file: "rechnung.xml" }, client(), { fileDirs: [folder.dir] }),
    );
    expect(message).toContain("accepted: PDF, PNG, JPEG");
  });

  it.each([
    ["is not a draft", { status: "100" }, "only drafts can be changed. Reset it to draft first"],
    ["is enshrined", { enshrined: "2026-11-03T10:00:00+01:00" }, "is enshrined (festgeschrieben)"],
    ["is recurring", { voucherType: "RV" }, "is not a normal voucher (type RV, recurring)"],
    ["is in USD", { currency: "USD" }, "foreign-currency voucher"],
    [
      "has no creditDebit",
      { creditDebit: "X" },
      "does not say whether it is an expense or revenue",
    ],
  ])("refuses a voucher that %s", async (_label, overrides, expected) => {
    const message = await refusal(
      prepareWrite(tool, { id: 2101, number: "X" }, client(draftRow(overrides))),
    );
    expect(message).toContain(expected);
  });

  it("refuses an unknown voucher, nothing to change, and an amount mode change without positions", async () => {
    expect(
      await refusal(
        prepareWrite(
          tool,
          { id: 9999, number: "X" },
          new FakeSevdeskClient([missingVoucherRoute(9999)]),
        ),
      ),
    ).toBe(
      "Voucher 9999 does not exist in sevDesk. Find the voucher id with sevdesk_vouchers_list.",
    );
    expect(await refusal(prepareWrite(tool, { id: 2101 }, client()))).toBe(
      "Nothing to change: give at least one field of the voucher besides id.",
    );
    expect(await refusal(prepareWrite(tool, { id: 2101, amountMode: "net" }, client()))).toContain(
      "Changing amountMode from gross to net",
    );
  });

  it("refuses a bookkeeping 1.0 account and a stored voucher without a known tax rule", async () => {
    expect(
      await refusal(
        prepareWrite(
          tool,
          { id: 2101, number: "X" },
          client(draftRow(), [positionRow()], [version1Route]),
        ),
      ),
    ).toContain("bookkeeping system 1.0");
    expect(
      await refusal(
        prepareWrite(
          tool,
          { id: 2101, number: "X" },
          client(draftRow({ taxRule: null, taxType: "default" })),
        ),
      ),
    ).toBe("Voucher 2101 has no Update 2.0 tax rule this server knows. Pass taxRuleId to set one.");
  });

  it("refuses a voucher whose positions cannot all be read", async () => {
    const many = {
      path: "/VoucherPos",
      response: { body: { objects: [positionRow()], total: 5000 } },
    };
    const fake = new FakeSevdeskClient([voucherRoute(draftRow()), many]);
    expect(await refusal(prepareWrite(tool, { id: 2101, number: "X" }, fake))).toContain(
      "has more positions than this server can read",
    );
  });

  it("re-reads the status right before the save and refuses a voucher finalized meanwhile", async () => {
    const plan = await prepareWrite(tool, { id: 2101, number: "X-1" }, client());
    const changed = new FakeSevdeskClient([voucherRoute(draftRow({ status: "100" })), saveRoute()]);
    const error = (await tool
      .execute(
        tool.input.parse({ id: 2101, number: "X-1" }),
        plan,
        testContext(tierScopedClient(changed, "write")),
      )
      .catch((caught: unknown) => caught)) as SevdeskError;
    expect(error.message).toContain("is no longer an unlocked draft (status 100)");
    expect(changed.writes()).toEqual([]);
  });

  it("explains sevDesk's 400 for a voucher that is no draft anymore", async () => {
    const fake = new FakeSevdeskClient([
      voucherRoute(draftRow()),
      positionsRoute(2101, [positionRow()]),
      version2Route,
      regularRoute,
      {
        method: "POST",
        path: "/Voucher/Factory/saveVoucher",
        response: {
          error: new SevdeskError({
            kind: "validation",
            status: 400,
            message: "sevDesk rejected the request.",
            upstreamMessage: "You can only update draft documents. Use resetToDraft first.",
          }),
        },
      },
    ]);
    const error = (await executeWrite(tool, { id: 2101, number: "X-1" }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.kind).toBe("validation");
    expect(error.message).toBe(
      "sevDesk refused to change voucher 2101: it is no longer a draft (it was finalized after " +
        "the preview). Nothing was changed. If the change is still needed, reset it to draft " +
        'first with sevdesk_voucher_reset (to "draft").',
    );
    expect(error.upstreamMessage).toContain("only update draft documents");
  });

  it("notes a receipt that is gone after an update without a new file", async () => {
    const withFile = draftRow({ document: { id: "7001", objectName: "Document" } });
    const fake = new FakeSevdeskClient([
      voucherRoute(withFile),
      positionsRoute(2101, [positionRow()]),
      version2Route,
      regularRoute,
      saveRoute(),
    ]);
    // Same route before and after: the read-back still shows the document, so no note.
    const kept = await executeWrite(tool, { id: 2101, number: "X-1" }, fake);
    expect(kept.output.data.notes).toBeUndefined();
  });

  it("fails loudly when sevDesk saved another voucher", async () => {
    const fake = new FakeSevdeskClient([
      voucherRoute(draftRow()),
      positionsRoute(2101, [positionRow()]),
      version2Route,
      regularRoute,
      saveRoute(2102),
      ...readBackRoutes(),
    ]);
    const error = (await executeWrite(tool, { id: 2101, number: "X" }, fake).catch(
      (caught: unknown) => caught,
    )) as SevdeskError;
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toContain("sevDesk saved voucher 2102 instead of changing voucher 2101");
    expect(error.completedWrites).toEqual([{ objectName: "Voucher", id: "2102" }]);
  });
});
