import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { orderCreateDeliveryNoteTool as tool } from "../../../../src/tools/orders/create-delivery-note.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  derivedReadRoutes,
  derivedRow,
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

function staged(source: Row = confirmation, earlier: readonly Row[] = []): StagedClient {
  const id = String(source["id"]);
  const readBack = derivedRow("3201", "LI", "LI-1001", id);
  return new StagedClient(
    [documentRoute("order", source), positionsOf(id), list(earlier)],
    [
      { method: "POST", path: CREATE, response: { body: { objects: readBack } } },
      ...derivedReadRoutes(readBack),
      documentRoute("order", source),
      ...positionRoutes(),
    ],
  );
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
  it("is a write tool of the orders toolset that locks the source", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("orders");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.locks?.(tool.input.parse({ orderId: 3002 }))).toEqual([
      { objectName: "Order", id: "3002" },
    ]);
  });

  it("previews the source with its positions, in English only", async () => {
    const plan = await prepareWrite(tool, { orderId: 3002 }, staged());
    expect(plan.preview.action).toBe(
      "Create a delivery note (Lieferschein, LI) draft from order AB-1002 (Auftragsbestätigung).",
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

  it("creates the delivery note with the source in query and body, and reads it back", async () => {
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

  it("accepts a sent offer and order confirmations that are drafts, sent or accepted", async () => {
    for (const source of [
      sentOffer,
      orderRow({ status: "100" }),
      orderRow({ status: "200" }),
      orderRow({ status: "500" }),
    ]) {
      const client = staged(source);
      await expect(
        executeWrite(tool, { orderId: Number(source["id"]) }, client),
      ).resolves.toBeDefined();
    }
  });

  it("refuses offer drafts, rejected and accepted offers, and other statuses", async () => {
    expect(await refusal({ ...sentOffer, status: "100" })).toBe(
      "Order 3001 is a draft offer that was never sent, so nothing was offered to the customer " +
        "yet to deliver on. Send it first (sevdesk_order_finalize, or sevdesk_order_send_email).",
    );
    expect(await refusal({ ...sentOffer, status: "300" })).toBe(
      "Order 3001 has status 300, Rejected / cancelled; delivery notes are created from sent " +
        "offers (200) or from order confirmations.",
    );
    expect(await refusal({ ...sentOffer, status: "500" })).toBe(
      "Order 3001 is an accepted offer. Create its order confirmation first " +
        "(sevdesk_order_create_confirmation) and the delivery note from that confirmation.",
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
});
