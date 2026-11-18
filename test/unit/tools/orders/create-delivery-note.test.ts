import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { orderCreateDeliveryNoteTool as tool } from "../../../../src/tools/orders/create-delivery-note.js";
import { ACCOUNT_ORDER_NUMBERS } from "../../../../src/tools/types.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  counterRoutes,
  derivedReadRoutes,
  derivedRow,
  discountRow,
  discountsOf,
  NEXT_ORDER_NUMBER,
  positionsOf,
  sentOffer,
} from "../../../write-cases/orders.js";
import {
  documentRoute,
  orderRow,
  positionRoutes,
  type Row,
  StagedClient,
} from "../lifecycle/helpers.js";

const CREATE = "/Order/Factory/createPackingListFromOrder";
/** Order confirmation 3002 (recorded keys): AB-1002, accepted (500). */
const confirmation = orderRow();

function list(rows: readonly Row[]): FakeRoute {
  return { path: "/Order", response: { body: { objects: rows } } };
}

function staged(
  source: Row = confirmation,
  earlier: readonly Row[] = [],
  options: { readonly discounts?: readonly Row[]; readonly afterFirst?: readonly FakeRoute[] } = {},
): StagedClient {
  const id = String(source["id"]);
  const readBack = derivedRow("3201", "LI", "LI-1001", id);
  return new StagedClient(
    [
      documentRoute("order", source),
      positionsOf(id),
      discountsOf(id, options.discounts),
      list(earlier),
    ],
    [
      ...(options.afterFirst ?? []),
      { method: "POST", path: CREATE, response: { body: { objects: readBack } } },
      ...derivedReadRoutes(readBack),
      documentRoute("order", source),
      // The LI counter still offers the new number: it is moved on once (#134).
      ...counterRoutes("LI", "LI-1001"),
      ...positionRoutes(),
    ],
  );
}

function failing(kind: SevdeskError["kind"]): { readonly error: SevdeskError } {
  return { error: new SevdeskError({ kind, message: `The request failed (${kind}).` }) };
}

async function refusal(source: Row): Promise<string> {
  const client = staged(source);
  const error = await prepareWrite(tool, { orderId: Number(source["id"]) }, client).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(client.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

describe("sevdesk_order_create_delivery_note (D-107)", () => {
  it("is a write tool of the orders toolset that locks the LI number range and the source", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("orders");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.locks?.(tool.input.parse({ orderId: 3002 }))).toEqual([
      ACCOUNT_ORDER_NUMBERS.LI,
      { objectName: "Order", id: "3002" },
    ]);
  });

  it("previews the source with its positions, in English only", async () => {
    const client = staged();
    const plan = await prepareWrite(tool, { orderId: 3002 }, client);
    // The preview only reads: the counter is neither peeked nor reserved before the call runs.
    expect(client.calls.filter((call) => call.path === NEXT_ORDER_NUMBER)).toEqual([]);
    expect(plan.preview.warnings[1]).toBe(
      "sevDesk gives the delivery note the next number of the LI range without moving its " +
        "counter, so that number is then reserved on the LI counter, which moves the counter " +
        "past it; otherwise the next delivery note could get the same number. A number is " +
        "reserved on every real create, also for a draft that is deleted later, which can leave " +
        "a gap in the LI numbers. Calls that number delivery notes run one at a time per " +
        "account. The result names other delivery notes with the same number.",
    );
    expect(plan.preview.action).toBe(
      "Create a delivery note (Lieferschein, LI) draft from order 3002 (Auftragsbestätigung).",
    );
    expect(plan.preview.facts).toEqual(
      expect.arrayContaining([
        { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
        { label: "Creates", value: "delivery note (Lieferschein, LI) as a draft" },
        expect.objectContaining({ label: "Position 1" }) as unknown,
      ]),
    );
    expect(plan.preview.warnings[0]).toContain("sevDesk leaves the order itself unchanged");
    expect(plan).not.toHaveProperty("previewDe");
  });

  it("creates the delivery note with the source in query and body, reads it back and moves the LI counter on", async () => {
    const client = staged();
    const { output } = await executeWrite(tool, { orderId: 3002 }, client);
    expect(
      client.writes().map((call) => [call.method, call.path, call.tier, call.query, call.body]),
    ).toEqual([
      [
        "POST",
        CREATE,
        "write",
        { "order[id]": 3002, "order[objectName]": "Order" },
        { id: 3002, objectName: "Order" },
      ],
      ["GET", NEXT_ORDER_NUMBER, "write", { orderType: "LI", useNextNumber: "true" }, undefined],
    ]);
    expect(output.data.notes).toEqual([
      "The new delivery note's number (order.number) was reserved on sevDesk's LI number " +
        "counter, which moves the counter past it so that the next delivery note does not get it " +
        "again.",
    ]);
    expect(output.data.order).toMatchObject({
      id: 3201,
      type: { code: "LI" },
      status: { code: 100 },
      origin: { id: 3002 },
    });
    expect(output.data.sourceOrderStatus).toMatchObject({ code: 500 });
    // The source is unchanged: only the delivery note is affected.
    expect(output.affected).toEqual([{ objectName: "Order", id: "3201" }]);
    expect(output.summary).toBe(
      "Created delivery note draft 3201 from order 3002; finalize it with sevdesk_order_finalize.",
    );
  });

  it("accepts sent and accepted offers and order confirmations that are drafts, sent or accepted", async () => {
    for (const source of [
      sentOffer,
      { ...sentOffer, status: "500" },
      orderRow({ status: "100" }),
      orderRow({ status: "200" }),
      orderRow({ status: "500" }),
    ]) {
      const client = staged(source);
      const { output } = await executeWrite(tool, { orderId: Number(source["id"]) }, client);
      // The source is left alone, whatever its status.
      expect(output.affected).toEqual([{ objectName: "Order", id: "3201" }]);
    }
  });

  it("creates one from an accepted offer (M2: the customer accepted by phone)", async () => {
    const accepted = { ...sentOffer, status: "500" };
    const client = staged(accepted);
    const { plan, output } = await executeWrite(tool, { orderId: 3001 }, client);
    expect(plan.preview.action).toBe(
      "Create a delivery note (Lieferschein, LI) draft from order 3001 (Angebot).",
    );
    expect(client.writes().map((call) => call.query)).toEqual([
      { "order[id]": 3001, "order[objectName]": "Order" },
      { orderType: "LI", useNextNumber: "true" },
    ]);
    expect(output.data.sourceOrderStatus).toMatchObject({ code: 500 });
  });

  it("refuses offer drafts, rejected offers and other statuses", async () => {
    expect(await refusal({ ...sentOffer, status: "100" })).toBe(
      "Order 3001 is a draft offer that was never sent, so nothing was offered to the customer " +
        "yet to deliver on. Send it first (sevdesk_order_finalize, or sevdesk_order_send_email).",
    );
    expect(await refusal({ ...sentOffer, status: "300" })).toBe(
      "Order 3001 has status 300, Rejected / cancelled; delivery notes are created from sent or " +
        "accepted offers (200, 500) or from order confirmations.",
    );
    expect(await refusal({ ...sentOffer, status: "1000" })).toMatch(
      /^Order 3001 has status 1000, .*; delivery notes are created from sent or accepted offers/,
    );
    expect(await refusal(orderRow({ status: "1000" }))).toBe(
      "Order 3002 has status 1000, Calculated (invoiced); delivery notes are created from order " +
        "confirmations that are drafts, sent or accepted (100, 200, 500).",
    );
  });

  it("refuses delivery notes as the source", async () => {
    expect(await refusal(orderRow({ orderType: "LI" }))).toBe(
      "Order 3002 is a delivery note (Lieferschein, LI); delivery notes are created from offers " +
        "(AN) and order confirmations (AB) only.",
    );
  });

  it("refuses when a delivery note draft from the order exists, unless allowDuplicate", async () => {
    const earlier = [
      derivedRow("3150", "LI", "LI-0999", "3002"),
      // A finalized delivery note from the same order: a partial delivery, not a duplicate.
      { ...derivedRow("3151", "LI", "LI-0998", "3002"), status: "200" },
    ];
    const client = staged(confirmation, earlier);
    await expect(prepareWrite(tool, { orderId: 3002 }, client)).rejects.toMatchObject({
      kind: "validation",
      message:
        "A delivery note draft from order 3002 exists already: order 3150. Finish or delete " +
        "that draft (sevdesk_order_get), or call again with allowDuplicate: true to create " +
        "another one.",
    });
    const plan = await prepareWrite(tool, { orderId: 3002, allowDuplicate: true }, client);
    expect(plan.preview.warnings).toContain(
      "Creating another one (allowDuplicate): delivery note draft 3150 from this order exists " +
        "already.",
    );
  });

  it("names finalized delivery notes from the order without refusing (review of #112, L1)", async () => {
    const earlier = [
      { ...derivedRow("3151", "LI", "LI-0998", "3002"), status: "200" },
      { ...derivedRow("3152", "LI", "LI-0999", "3002"), status: "1000" },
      // From another order: ignored.
      { ...derivedRow("3153", "LI", "LI-0997", "3009"), status: "200" },
    ];
    const plan = await prepareWrite(tool, { orderId: 3002 }, staged(confirmation, earlier));
    expect(plan.preview.warnings).toContain(
      "Created from this order already and no longer a draft: delivery note 3151, delivery note " +
        "3152. Create another one only for a further (partial) delivery.",
    );
    expect(plan.preview.warnings.join("\n")).not.toContain("allowDuplicate");
    // Without earlier delivery notes there is no such warning.
    const fresh = await prepareWrite(tool, { orderId: 3002 }, staged());
    expect(fresh.preview.warnings.join("\n")).not.toContain("Created from this order already");
  });

  it("shows the order's document discounts (review of #112, L5)", async () => {
    const client = staged(confirmation, [], {
      discounts: [discountRow("3002", { percentage: "0", value: "20", isNet: null })],
    });
    const plan = await prepareWrite(tool, { orderId: 3002 }, client);
    // Read once, with the content the preview lists (D-116).
    expect(client.calls.filter((call) => call.path === "/Order/3002/getDiscounts")).toHaveLength(1);
    // Order 3002 has gross prices: a fixed amount comes off the gross total there (D-116,
    // recorded 2026-11-18).
    expect(plan.preview.facts).toContainEqual({
      label: "Discount on the whole document (Rabatt)",
      value: "20.00 EUR gross\nText: Treuerabatt",
    });
    expect(plan.preview.warnings).toContain(
      "The order carries discounts or surcharges on the whole document (listed above). sevDesk " +
        "copies a discount to the delivery note with the same totals; a surcharge was not " +
        "checked. Check the new draft with sevdesk_order_get before finalizing it.",
    );
  });

  describe("after the request, a failure names what exists (review of #112, M1)", () => {
    it("names the delivery note, not the untouched source, when it cannot be read back", async () => {
      const client = staged(confirmation, [], {
        afterFirst: [{ path: "/Order/3201", response: failing("timeout") }],
      });
      await expect(executeWrite(tool, { orderId: 3002 }, client)).rejects.toMatchObject({
        kind: "timeout",
        completedWrites: [{ objectName: "Order", id: "3201" }],
      });
      expect(client.writes()).toHaveLength(1);
    });

    it("names the delivery note when cancelled during the number check", async () => {
      const client = staged(confirmation, [], {
        afterFirst: [
          { path: "/Order", query: { orderNumber: "LI-1001" }, response: failing("aborted") },
        ],
      });
      await expect(executeWrite(tool, { orderId: 3002 }, client)).rejects.toMatchObject({
        kind: "aborted",
        completedWrites: [{ objectName: "Order", id: "3201" }],
      });
    });
  });
});
