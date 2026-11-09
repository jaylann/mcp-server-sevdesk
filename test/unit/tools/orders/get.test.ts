import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { orderGetTool as tool } from "../../../../src/tools/orders/get.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const orderRoute: FakeRoute = {
  path: "/Order/3002",
  query: { embed: "contact" },
  response: { fixture: "orders/order-3002.json" },
};
const positionsRoute: FakeRoute = {
  path: "/OrderPos",
  query: { "order[id]": 3002, "order[objectName]": "Order" },
  response: { fixture: "orders/order-positions-3002.json" },
};
const unitsRoute: FakeRoute = { path: "/Unity", response: { fixture: "meta/units.json" } };
const relatedRoute: FakeRoute = {
  path: "/Order/3002/getRelatedObjects",
  query: { includeItself: false },
  response: { fixture: "orders/order-related-3002.json" },
};
const routes = [orderRoute, positionsRoute, unitsRoute, relatedRoute];

async function get(withRoutes: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(withRoutes);
  const result = await tool.handler(tool.input.parse({ id: 3002 }), testContext(client));
  return { client, result };
}

describe("sevdesk_order_get (community: recorded Order shapes, fake data)", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("orders");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.openWorldHint).toBe(false);
  });

  it("returns the order with origin, terms and positions (gross-entered prices)", async () => {
    const { client, result } = await get();
    expect(client.methods().every((method) => method === "GET")).toBe(true);
    expect(client.calls.every((call) => !call.sideEffect)).toBe(true);
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.order).toMatchObject({
      id: 3002,
      number: "AB-1002",
      type: { code: "AB" },
      status: { code: 500, label: "Accepted" },
      priceMode: "gross",
      version: 1,
      origin: { objectName: "Order", id: 3001 },
      paymentTerms: "14 Tage netto",
      deliveryTerms: "Lieferung frei Haus",
      address: { countryId: 1 },
      headText: "<p>Gerne bieten wir Ihnen an:</p>",
      link: "https://my.sevdesk.de/om/detail/type/AB/id/3002",
    });
    expect(result.data.positions).toEqual([
      {
        id: 9001,
        number: 0,
        name: "Testartikel",
        partId: 6001,
        quantity: "2",
        unit: { id: 1, name: "Stk" },
        unitPriceNet: { amount: "42.01", currency: "EUR" },
        unitPriceGross: { amount: "49.9919", currency: "EUR" },
        taxRate: "19",
        totals: {
          net: { amount: "84.02", currency: "EUR" },
          tax: { amount: "15.96", currency: "EUR" },
          gross: { amount: "99.98", currency: "EUR" },
        },
      },
      {
        id: 9002,
        number: 1,
        name: "Optionale Einweisung",
        quantity: "1",
        unit: { id: 9, name: "Std" },
        // showNet "0": price is the gross price.
        unitPriceGross: { amount: "119.00", currency: "EUR" },
        taxRate: "19",
        totals: {
          net: { amount: "100.00", currency: "EUR" },
          tax: { amount: "19.00", currency: "EUR" },
          gross: { amount: "119.00", currency: "EUR" },
        },
        optional: true,
      },
    ]);
  });

  it("lists related documents from a numeric-key object, without the order itself", async () => {
    const { result } = await get();
    expect(result.data.related).toEqual([
      {
        objectName: "Invoice",
        id: 1010,
        number: "RE-1010",
        typeCode: "RE",
        status: { code: 1000, label: "Paid" },
        link: "https://my.sevdesk.de/fi/detail/type/RE/id/1010",
      },
      { objectName: "Order", id: 3005, number: "LI-1005", typeCode: "LI" },
    ]);
    expect(result.summary).toBe(
      "Order 3002 (Order confirmation, status Accepted) with 2 positions. 2 related documents.",
    );
  });

  it("reads related documents sent as a list, including credit notes and unknown kinds", async () => {
    const { result } = await get([
      orderRoute,
      positionsRoute,
      unitsRoute,
      {
        ...relatedRoute,
        response: {
          body: {
            objects: [
              { id: "2001", objectName: "CreditNote", creditNoteNumber: "GU-1", status: "100" },
              { id: "3006", objectName: "Order", orderType: "AN", status: "500" },
              { id: "1", objectName: "Letter", status: "100" },
            ],
          },
        },
      },
    ]);
    expect(result.data.related).toEqual([
      {
        objectName: "CreditNote",
        id: 2001,
        number: "GU-1",
        status: { code: 100, label: "Draft" },
        link: "https://my.sevdesk.de/cn/edit/type/CN/id/2001",
      },
      {
        objectName: "Order",
        id: 3006,
        typeCode: "AN",
        status: { code: 500, label: "Accepted" },
        link: "https://my.sevdesk.de/om/detail/type/AN/id/3006",
      },
      { objectName: "Letter", id: 1, status: { code: 100, label: "unknown" } },
    ]);
    expect(result.summary).toMatch(/ 3 related documents\.$/);
  });

  it("still returns the order when related documents cannot be read", async () => {
    for (const response of [
      { error: new SevdeskError({ kind: "server", message: "x" }) },
      { body: { objects: "nope" } },
      { body: { objects: { a: { id: "1" } } } },
    ]) {
      const { result } = await get([
        orderRoute,
        positionsRoute,
        unitsRoute,
        { ...relatedRoute, response },
      ]);
      expect(result.data.related).toBeUndefined();
      expect(result.summary).toBe(
        "Order 3002 (Order confirmation, status Accepted) with 2 positions. Related documents " +
          "could not be read.",
      );
    }
  });

  it("passes a cancellation through instead of hiding it", async () => {
    const client = new FakeSevdeskClient([
      orderRoute,
      positionsRoute,
      unitsRoute,
      {
        ...relatedRoute,
        response: { error: new SevdeskError({ kind: "aborted", message: "cancelled" }) },
      },
    ]);
    await expect(
      tool.handler(tool.input.parse({ id: 3002 }), testContext(client)),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("reports partial positions", async () => {
    const objects = Array.from({ length: 10_001 }, (_, index) => ({
      id: String(index + 1),
      order: { id: "3002", objectName: "Order" },
    }));
    const { result } = await get([
      orderRoute,
      { path: "/OrderPos", response: { body: { objects } } },
      unitsRoute,
      relatedRoute,
    ]);
    expect(result.data.positionsComplete).toBe(false);
    expect(result.summary).toBe(
      "Order 3002 (Order confirmation, status Accepted) with 10000 positions. Partial: sevDesk " +
        "had more positions than could be read. 2 related documents.",
    );
  });
});
