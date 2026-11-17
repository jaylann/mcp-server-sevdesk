/**
 * Regression (spec/deviations.md D-103): a draft made by sevDesk's receipt recognition
 * (`sevdesk_voucher_recognize_receipt`) has no tax rule and a position without a booking account
 * (`taxRule` and `accountDatev` null), a supplier text without a contact and recognised sums. Update
 * 2.0 books a voucher only with both, so the finalize must refuse such a draft before anything is
 * sent, and the normal draft update must be able to complete it. The fixtures are shaped like the
 * recorded answer.
 */
import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { voucherUpdateDraftTool } from "../../src/tools/vouchers/draft-update.js";
import { voucherFinalizeTool } from "../../src/tools/vouchers/finalize.js";
import { type FakeRoute, FakeSevdeskClient } from "../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../helpers/write-tools.js";
import {
  accountsRoute,
  guidanceRoute,
  positionsRoute,
  recognisedPositionRow,
  recognisedRow,
  regularRoute,
  type Row,
  saveRoute,
  version2Route,
  voucherRoute,
} from "../unit/tools/vouchers/routes.js";

const ID = 2301;

function client(row: Row, positions: readonly Row[]): FakeSevdeskClient {
  const routes: FakeRoute[] = [
    voucherRoute(row),
    positionsRoute(ID, positions),
    version2Route,
    regularRoute,
    guidanceRoute,
    accountsRoute,
    saveRoute(ID),
  ];
  return new FakeSevdeskClient(routes);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect((error as SevdeskError).status).toBeUndefined();
  return (error as SevdeskError).message;
}

/** The recognised draft once its tax rule and booking account are set. */
const completed = {
  row: recognisedRow({ taxRule: { id: "9", objectName: "TaxRule" } }),
  positions: [recognisedPositionRow({ accountDatev: { id: "4266", objectName: "AccountDatev" } })],
};

describe("a draft from sevDesk's receipt recognition (D-103)", () => {
  it("cannot be finalized without a tax rule: refused before anything is sent", async () => {
    const fake = client(recognisedRow(), [recognisedPositionRow()]);
    const message = await refusal(prepareWrite(voucherFinalizeTool, { id: ID }, fake));
    expect(message).toBe(
      "Voucher 2301 has no Update 2.0 tax rule this server knows. Set one with " +
        "sevdesk_voucher_update_draft (taxRuleId) first.",
    );
    expect(fake.writes()).toEqual([]);
  });

  it("cannot be finalized while a position has no booking account", async () => {
    const fake = client(completed.row, [recognisedPositionRow()]);
    const message = await refusal(prepareWrite(voucherFinalizeTool, { id: ID }, fake));
    expect(message).toContain(
      "Position 1 of voucher 2301 has no Update 2.0 booking account (accountDatev): sevDesk's " +
        "receipt recognition leaves it empty",
    );
    expect(message).toContain("sevdesk_voucher_update_draft (positions, each with accountDatevId)");
    expect(fake.writes()).toEqual([]);
  });

  it("can be finalized once both are set", async () => {
    const plan = await prepareWrite(
      voucherFinalizeTool,
      { id: ID },
      client(completed.row, completed.positions),
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Tax rule (Steuerregel)",
      value: "9 Vorsteuerabziehbare Aufwendungen",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Belegnummer", value: "RE-2026-0042" });
  });

  it("cannot get its tax rule alone: the recognised position needs a booking account", async () => {
    const fake = client(recognisedRow(), [recognisedPositionRow()]);
    const message = await refusal(
      prepareWrite(voucherUpdateDraftTool, { id: ID, taxRuleId: 9 }, fake),
    );
    expect(message).toContain("Position 1 of voucher 2301 has no Update 2.0 booking account");
    expect(fake.writes()).toEqual([]);
  });

  it("refuses new positions without a tax rule, naming taxRuleId", async () => {
    const fake = client(recognisedRow(), [recognisedPositionRow()]);
    const message = await refusal(
      prepareWrite(
        voucherUpdateDraftTool,
        { id: ID, positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }] },
        fake,
      ),
    );
    expect(message).toContain("Pass taxRuleId to set one.");
  });

  it("is completed by the normal update: tax rule, positions replaced, supplier text and number kept", async () => {
    const fake = client(recognisedRow(), [recognisedPositionRow()]);
    const { output } = await executeWrite(
      voucherUpdateDraftTool,
      {
        id: ID,
        taxRuleId: 9,
        positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
      },
      fake,
    );

    const writes = fake.writes();
    expect(writes.map((call) => [call.method, call.path, call.tier])).toEqual([
      ["POST", "/Voucher/Factory/saveVoucher", "write"],
    ]);
    expect(writes[0]?.body).toEqual({
      voucher: {
        id: ID,
        objectName: "Voucher",
        mapAll: true,
        voucherDate: "16.11.2026",
        supplier: null,
        supplierName: "Musterlieferant GmbH",
        description: "RE-2026-0042",
        deliveryDate: "16.11.2026",
        status: 50,
        taxRule: { id: 9, objectName: "TaxRule" },
        creditDebit: "C",
        voucherType: "VOU",
        currency: "EUR",
      },
      voucherPosSave: [
        {
          objectName: "VoucherPos",
          mapAll: true,
          accountDatev: { id: 4266, objectName: "AccountDatev" },
          taxRate: 19,
          net: false,
          sumGross: 119,
          isAsset: false,
        },
      ],
      voucherPosDelete: [{ id: 3301, objectName: "VoucherPos" }],
    });
    expect(output.affected).toEqual([{ objectName: "Voucher", id: "2301" }]);
  });

  it("takes a supplier contact in place of the recognised supplier text", async () => {
    const fake = new FakeSevdeskClient([
      { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
      voucherRoute(recognisedRow()),
      positionsRoute(ID, [recognisedPositionRow()]),
      version2Route,
      regularRoute,
      guidanceRoute,
      accountsRoute,
      saveRoute(ID),
    ]);
    await executeWrite(
      voucherUpdateDraftTool,
      {
        id: ID,
        supplierId: 1001,
        taxRuleId: 9,
        positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
      },
      fake,
    );
    const body = fake.writes()[0]?.body as { voucher: Record<string, unknown> };
    expect(body.voucher["supplier"]).toEqual({ id: 1001, objectName: "Contact" });
    expect(body.voucher).not.toHaveProperty("supplierName");
  });

  it("replaces a wrongly split position with one position per tax rate", async () => {
    // Recorded 2026-11-17: 100.00 net at 19 % and 50.00 net at 7 % (gross 172.50) came back as
    // ONE position at 7 % with net 161.21, tax 11.29, gross 172.50.
    const wrong = recognisedPositionRow({
      taxRate: "7",
      sum: "161.21",
      sumNet: "161.21",
      sumTax: "11.29",
      sumGross: "172.5",
    });
    const fake = client(recognisedRow({ sumNet: "161.21", sumTax: "11.29", sumGross: "172.5" }), [
      wrong,
    ]);
    const { plan } = await executeWrite(
      voucherUpdateDraftTool,
      {
        id: ID,
        taxRuleId: 9,
        amountMode: "net",
        positions: [
          { accountDatevId: 4266, amount: "100.00", taxRate: 19 },
          { accountDatevId: 4266, amount: "50.00", taxRate: 7 },
        ],
      },
      fake,
    );

    const body = fake.writes()[0]?.body as {
      voucherPosSave: Record<string, unknown>[];
      voucherPosDelete: unknown;
    };
    expect(
      body.voucherPosSave.map((position) => [position["taxRate"], position["sumNet"]]),
    ).toEqual([
      [19, 100],
      [7, 50],
    ]);
    expect(body.voucherPosDelete).toEqual([{ id: 3301, objectName: "VoucherPos" }]);
    expect(plan.preview.facts).toContainEqual({
      label: "Total (expected)",
      value: "net 150.00 EUR, tax 22.50 EUR, gross 172.50 EUR",
    });
  });

  it("handles a recognised revenue draft the same way: refused until completed, then finalized", async () => {
    // Recorded 2026-11-17: creditDebit D gave a revenue draft with net 200, tax 38, gross 238,
    // one position at 19 % and taxRule null.
    const revenue = recognisedRow({
      creditDebit: "D",
      sumNet: "200",
      sumTax: "38",
      sumGross: "238",
    });
    const position = recognisedPositionRow({
      sum: "200",
      sumNet: "200",
      sumTax: "38",
      sumGross: "238",
    });
    const refused = await refusal(
      prepareWrite(voucherFinalizeTool, { id: ID }, client(revenue, [position])),
    );
    expect(refused).toContain("has no Update 2.0 tax rule");

    const fake = client(revenue, [position]);
    await executeWrite(
      voucherUpdateDraftTool,
      {
        id: ID,
        taxRuleId: 1,
        positions: [{ accountDatevId: 5192, amount: "238.00", taxRate: 19 }],
      },
      fake,
    );
    const body = fake.writes()[0]?.body as {
      voucher: Record<string, unknown>;
      voucherPosSave: Record<string, unknown>[];
    };
    expect(body.voucher).toMatchObject({
      creditDebit: "D",
      taxRule: { id: 1, objectName: "TaxRule" },
    });
    expect(body.voucherPosSave[0]).toMatchObject({
      accountDatev: { id: 5192, objectName: "AccountDatev" },
      taxRate: 19,
      sumGross: 238,
    });

    const plan = await prepareWrite(
      voucherFinalizeTool,
      { id: ID },
      client({ ...revenue, taxRule: { id: "1", objectName: "TaxRule" } }, [
        { ...position, accountDatev: { id: "5192", objectName: "AccountDatev" } },
      ]),
    );
    expect(plan.preview.action).toContain("Finalize draft voucher 2301 (revenue");
  });
});
