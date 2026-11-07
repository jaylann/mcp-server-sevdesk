import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { orderCreateDraftTool } from "../../../../src/tools/orders/draft-create.js";
import { orderUpdateDraftTool } from "../../../../src/tools/orders/draft-update.js";
import type { AnyWriteToolDefinition } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  orderCreateArgs,
  orderCreateRoutes,
  orderUpdateRoutes,
  saveOrderRoute,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

async function rejection(
  tool: AnyWriteToolDefinition,
  args: unknown,
  table: readonly FakeRoute[],
): Promise<SevdeskError> {
  const client = new FakeSevdeskClient(table);
  const error = await prepareWrite(tool, args, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect(client.writes()).toEqual([]);
  return error as SevdeskError;
}

function storedOrder(fields: Record<string, unknown>): FakeRoute {
  const stored = loadFixture("drafts/order-3102-draft.json").body as {
    objects: Record<string, unknown>[];
  };
  return {
    path: "/Order/3102",
    response: { body: { objects: [{ ...stored.objects[0], ...fields }] } },
  };
}

describe("sevdesk_order_create_draft (community order bodies, fake data)", () => {
  const tool = orderCreateDraftTool;

  it("is a write-tier create tool in the orders toolset", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("orders");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("prepares an offer: version 0, multi-line address, type header, no number", async () => {
    const client = new FakeSevdeskClient(orderCreateRoutes);
    const plan = await prepareWrite(tool, orderCreateArgs, client);
    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toEqual({
      order: {
        objectName: "Order",
        mapAll: true,
        orderType: "AN",
        version: 0,
        status: 100,
        contact: { id: 1001, objectName: "Contact" },
        contactPerson: { id: 2001, objectName: "SevUser" },
        orderDate: "07.11.2026",
        header: "Angebot",
        currency: "EUR",
        showNet: true,
        taxRule: { id: 1, objectName: "TaxRule" },
        taxRate: 0,
        taxText: "Umsatzsteuerpflichtige Umsätze",
        smallSettlement: false,
        address: "Musterfirma GmbH, Buchhaltung\nMusterstraße 1\n12345 Musterstadt",
        addressCountry: { id: 1, objectName: "StaticCountry" },
      },
      orderPosSave: [
        {
          objectName: "OrderPos",
          mapAll: true,
          quantity: 3,
          price: "10.00",
          name: "Beratung",
          unity: { id: 1, objectName: "Unity" },
          taxRate: 19,
          positionNumber: 0,
        },
        {
          objectName: "OrderPos",
          mapAll: true,
          quantity: 1,
          price: "25.00",
          name: "Paket",
          unity: { id: 1, objectName: "Unity" },
          taxRate: 19,
          positionNumber: 1,
          text: "Zweite Zeile\nund eine dritte",
        },
      ],
      orderPosDelete: null,
    });
    expect(plan.preview.action).toBe(
      "Create a draft Angebot (AN) for Musterfirma GmbH (contact 1001) with 2 positions, gross " +
        "65.45 EUR.",
    );
  });

  it.each([
    ["order_confirmation", "AB", "Auftragsbestätigung"],
    ["delivery_note", "LI", "Lieferschein"],
  ])("maps %s to %s with the header %s", async (orderType, code, header) => {
    const client = new FakeSevdeskClient(orderCreateRoutes);
    const plan = await prepareWrite(tool, { ...orderCreateArgs, orderType }, client);
    expect(plan.state.body.order).toMatchObject({ orderType: code, header });
  });

  it("sends optional positions and terms, and leaves optional positions out of the total", async () => {
    const client = new FakeSevdeskClient(orderCreateRoutes);
    const plan = await prepareWrite(
      tool,
      {
        ...orderCreateArgs,
        paymentTerms: "14 Tage netto",
        deliveryTerms: "frei Haus",
        positions: [
          { name: "Basis", quantity: 1, unitPrice: 100, taxRate: 19 },
          { name: "Option Wartung", quantity: 1, unitPrice: 50, taxRate: 19, optional: true },
          { name: "Rabattiert", quantity: 2, unitPrice: 10, taxRate: 19, discountPercent: 10 },
        ],
      },
      client,
    );
    expect(plan.state.body.order).toMatchObject({
      paymentTerms: "14 Tage netto",
      deliveryTerms: "frei Haus",
    });
    expect(plan.state.body.orderPosSave?.[1]).toMatchObject({ optional: true });
    expect(plan.state.body.orderPosSave?.[2]).toMatchObject({ discount: 10 });
    expect(plan.state.body.orderPosSave?.[0]).not.toHaveProperty("optional");
    expect(plan.state.expected).toEqual({ net: "118.00", tax: "22.42", gross: "140.42" });
    expect(plan.preview.facts).toContainEqual({
      label: "Position 2",
      value:
        "Option Wartung: 1 × 50.00 EUR net, 19 % VAT → net 50.00 EUR (optional, not in the total)",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Payment terms", value: "14 Tage netto" });
  });

  it("warns about a possible duplicate offer", async () => {
    const duplicate: FakeRoute = {
      path: "/Order",
      query: { "contact[id]": 1001 },
      response: {
        body: {
          objects: [
            {
              id: "3050",
              objectName: "Order",
              orderType: "AN",
              status: "200",
              currency: "EUR",
              sumGross: "65.45",
              orderDate: "2026-11-07T00:00:00+01:00",
            },
            {
              id: "3051",
              objectName: "Order",
              orderType: "AN",
              status: "100",
              currency: "EUR",
              sumGross: "65.45",
              orderDate: "2026-11-07T00:00:00+01:00",
            },
          ],
        },
      },
    };
    const client = new FakeSevdeskClient(withRoutes(orderCreateRoutes, duplicate));
    const plan = await prepareWrite(tool, orderCreateArgs, client);
    expect(plan.preview.warnings).toEqual([
      "Possible duplicate: orders 3050, 3051 for the same contact, date (2026-11-07) and gross " +
        "total (65.45 EUR) already exist. Check it before creating another one.",
    ]);
  });

  it("saves once, reads the order back and reports it as affected", async () => {
    const client = new FakeSevdeskClient(orderCreateRoutes);
    const { output } = await executeWrite(tool, orderCreateArgs, client);
    expect(client.writes().map(({ method, path, tier }) => ({ method, path, tier }))).toEqual([
      { method: "POST", path: "/Order/Factory/saveOrder", tier: "write" },
    ]);
    expect(output.affected).toEqual([{ objectName: "Order", id: "3101" }]);
    expect(output.data.order).toMatchObject({
      id: 3101,
      type: { code: "AN" },
      status: { code: 100 },
      totals: { gross: { amount: "65.45", currency: "EUR" } },
    });
    expect(output.summary).toBe(
      "Created draft order 3101 (AN, 2 positions, gross 65.45 EUR). See notes.",
    );
    expect(output.data.notes?.[0]).toMatch(/^The order has no number yet/);
  });

  it("requires a known order type", () => {
    expect(tool.input.safeParse({ ...orderCreateArgs, orderType: "AN" }).success).toBe(false);
    expect(
      tool.input.safeParse({ contactId: 1001, positions: orderCreateArgs.positions }).success,
    ).toBe(false);
  });
});

describe("sevdesk_order_update_draft (community order shapes, fake data)", () => {
  const tool = orderUpdateDraftTool;

  it("is a write-tier update tool", () => {
    expect(tool.tier).toBe("write");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("carries the stored order over, keeps its number and replaces the positions", async () => {
    const client = new FakeSevdeskClient(orderUpdateRoutes);
    const plan = await prepareWrite(
      tool,
      {
        id: 3102,
        paymentTerms: "30 Tage netto",
        positions: [{ name: "Workshop", quantity: 3, unitPrice: 100, taxRate: 19 }],
      },
      client,
    );
    expect(plan.state.body.order).toEqual({
      id: 3102,
      objectName: "Order",
      mapAll: true,
      orderNumber: "AN-1007",
      orderType: "AN",
      version: 0,
      status: 100,
      contact: { id: 1001, objectName: "Contact" },
      contactPerson: { id: 2001, objectName: "SevUser" },
      orderDate: "03.11.2026",
      header: "Angebot AN-1007",
      headText: "<p>Gerne bieten wir Ihnen an:</p>",
      footText: "<p>Das Angebot ist 30 Tage gültig.</p>",
      currency: "EUR",
      showNet: true,
      taxRule: { id: 1, objectName: "TaxRule" },
      taxRate: 0,
      taxText: "Umsatzsteuer 19%",
      smallSettlement: false,
      address: "Musterfirma GmbH\nMusterstraße 1\n12345 Musterstadt",
      addressCountry: { id: 1, objectName: "StaticCountry" },
      deliveryTerms: "Lieferung frei Haus",
      paymentTerms: "30 Tage netto",
    });
    expect(plan.state.body.orderPosDelete).toEqual([{ id: 9201, objectName: "OrderPos" }]);
    expect(plan.state.body.orderPosSave).toHaveLength(1);
    expect(plan.preview.action).toBe(
      "Update draft Angebot 3102 for Musterfirma GmbH (contact 1001): change payment terms, positions.",
    );
    expect(plan.preview.facts.slice(0, 3)).toEqual([
      { label: "Order", value: "3102 (Angebot, number AN-1007, draft)" },
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      { label: "Payment terms", value: "14 Tage netto → 30 Tage netto" },
    ]);
  });

  it("saves once and reads the order back", async () => {
    const client = new FakeSevdeskClient(orderUpdateRoutes);
    const { output } = await executeWrite(tool, { id: 3102, header: "Angebot Workshop" }, client);
    expect(client.writes().map(({ method, path, tier }) => ({ method, path, tier }))).toEqual([
      { method: "POST", path: "/Order/Factory/saveOrder", tier: "write" },
    ]);
    expect(client.writes()[0]?.body).toMatchObject({
      order: { id: 3102, header: "Angebot Workshop" },
      orderPosSave: null,
      orderPosDelete: null,
    });
    expect(output.affected).toEqual([{ objectName: "Order", id: "3102" }]);
    expect(output.data.notes).toBeUndefined();
    expect(output.summary).toBe("Updated draft order 3102 (AN, 1 position, gross 238.00 EUR).");
  });

  it("fails loudly when sevDesk saved a different order", async () => {
    const client = new FakeSevdeskClient(withRoutes(orderUpdateRoutes, saveOrderRoute));
    const error = await executeWrite(tool, { id: 3102, header: "X" }, client).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).completedWrites).toEqual([{ objectName: "Order", id: "3101" }]);
  });

  it.each([
    [
      "a sent offer",
      { status: "200" },
      "Order 3102 is not a draft (status: Delivered (sent)); only drafts can be changed. Create a " +
        "new draft (sevdesk_order_create_draft) instead.",
    ],
    [
      "an unknown order type",
      { orderType: "XX" },
      "Order 3102 has an order type this tool does not know; edit it in sevDesk.",
    ],
  ])("refuses %s", async (_label, fields, message) => {
    const error = await rejection(
      tool,
      { id: 3102, header: "X" },
      withRoutes(orderUpdateRoutes, storedOrder(fields)),
    );
    expect(error.message).toBe(message);
  });

  it("refuses an update without changes", async () => {
    const error = await rejection(tool, { id: 3102 }, orderUpdateRoutes);
    expect(error.message).toBe(
      "Nothing to change: give at least one field of the order besides id.",
    );
  });

  it("changes the price mode together with new positions", async () => {
    const client = new FakeSevdeskClient(orderUpdateRoutes);
    const plan = await prepareWrite(
      tool,
      {
        id: 3102,
        priceMode: "gross",
        positions: [{ name: "Workshop", quantity: 2, unitPrice: 119, taxRate: 19 }],
      },
      client,
    );
    expect(plan.state.body.order.showNet).toBe(false);
    expect(plan.state.expected).toEqual({ net: "200.00", tax: "38.00", gross: "238.00" });
    expect(plan.preview.facts).toContainEqual({ label: "Prices entered as", value: "net → gross" });
  });

  it("refuses to change a stored free-text address in part", async () => {
    const error = await rejection(
      tool,
      { id: 3102, addressCity: "Beispielstadt" },
      orderUpdateRoutes,
    );
    expect(error.message).toMatch(/^The stored address of this draft is free text/);
  });

  it("takes a given address as multi-line text", async () => {
    const client = new FakeSevdeskClient(orderUpdateRoutes);
    const plan = await prepareWrite(
      tool,
      {
        id: 3102,
        addressName: "Musterfirma GmbH",
        addressStreet: "Neue Str. 3",
        addressZip: "12345",
        addressCity: "Musterstadt",
      },
      client,
    );
    expect(plan.state.body.order).toMatchObject({
      address: "Musterfirma GmbH\nNeue Str. 3\n12345 Musterstadt",
      addressCountry: { id: 1, objectName: "StaticCountry" },
    });
  });
});
