/**
 * Regression (spec/deviations.md D-092): `saveOrder` accepts `costCentre` without an error and
 * drops it; the order reads back without one. Offering a cost centre on orders would therefore
 * report a booking that never happened. So no order request carries `costCentre`: the order draft
 * tools take no such argument, the strict order body refuses the key, and an update of an order
 * whose record shows a cost centre (made in the web app) does not carry it over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveOrderBodySchema } from "../../src/domain/drafts/payloads.js";
import { orderCreateDraftTool } from "../../src/tools/orders/draft-create.js";
import { orderUpdateDraftTool } from "../../src/tools/orders/draft-update.js";
import { storedCostCentre } from "../helpers/cost-centres.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";
import { executeWrite } from "../helpers/write-tools.js";
import {
  orderCreateArgs,
  orderCreateRoutes,
  orderUpdateRoutes,
  withRoutes,
} from "../unit/tools/drafts/routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The stored order 3102 with a cost centre, as a web-app order could show one. */
function storedOrderWithCentre(): FakeRoute[] {
  const stored = loadFixture("drafts/order-3102-draft.json").body as {
    objects: Record<string, unknown>[];
  };
  const row = { ...stored.objects[0], costCentre: storedCostCentre(344959) };
  return [
    { path: "/Order/3102", query: { embed: "contact" }, response: { body: { objects: [row] } } },
    { path: "/Order/3102", response: { body: { objects: [row] } } },
  ];
}

function carriesCostCentre(client: FakeSevdeskClient): boolean {
  return client.calls.some(
    (call) =>
      JSON.stringify(call.body ?? null).includes("costCentre") ||
      Object.keys(call.query).some((key) => key.startsWith("costCentre")),
  );
}

describe("no order request carries costCentre (D-092)", () => {
  it("the order draft tools take no costCentre argument", () => {
    expect(
      orderCreateDraftTool.input.safeParse({ ...orderCreateArgs, costCentre: 344959 }).success,
    ).toBe(false);
    expect(orderUpdateDraftTool.input.safeParse({ id: 3102, costCentre: "MCP1" }).success).toBe(
      false,
    );
  });

  it("the strict saveOrder body refuses the key", () => {
    const body = {
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
        smallSettlement: false,
      },
      orderPosSave: null,
      orderPosDelete: null,
    };
    expect(saveOrderBodySchema.safeParse(body).success).toBe(true);
    const withCentre = {
      ...body,
      order: { ...body.order, costCentre: { id: 344959, objectName: "CostCentre" } },
    };
    expect(saveOrderBodySchema.safeParse(withCentre).success).toBe(false);
  });

  it("creating an order sends no costCentre", async () => {
    const client = new FakeSevdeskClient(orderCreateRoutes);
    await executeWrite(orderCreateDraftTool, orderCreateArgs, client);
    // The number reservation and the save.
    expect(client.writes().map((call) => call.path)).toContain("/Order/Factory/saveOrder");
    expect(carriesCostCentre(client)).toBe(false);
  });

  it("updating an order whose record shows a cost centre does not carry it over", async () => {
    const client = new FakeSevdeskClient(withRoutes(orderUpdateRoutes, ...storedOrderWithCentre()));
    await executeWrite(orderUpdateDraftTool, { id: 3102, header: "Angebot Workshop" }, client);
    expect(client.writes()).toHaveLength(1);
    expect(client.writes()[0]?.body).toMatchObject({ order: { id: 3102 } });
    expect(carriesCostCentre(client)).toBe(false);
  });
});
