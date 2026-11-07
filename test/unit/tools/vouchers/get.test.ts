import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { voucherGetTool as tool } from "../../../../src/tools/vouchers/get.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

function routes(id: number, overrides: { positions?: FakeRoute["response"] } = {}): FakeRoute[] {
  return [
    { path: `/Voucher/${id}`, response: { fixture: `vouchers/voucher-${id}.json` } },
    {
      path: "/VoucherPos",
      query: { "voucher[id]": id, "voucher[objectName]": "Voucher" },
      response: overrides.positions ?? { fixture: `vouchers/voucher-positions-${id}.json` },
    },
  ];
}

async function get(id: number, fakeRoutes: readonly FakeRoute[] = routes(id)) {
  const client = new FakeSevdeskClient(fakeRoutes);
  const result = await tool.handler(tool.input.parse({ id }), testContext(client));
  return { client, result };
}

describe("sevdesk_voucher_get (community: recorded Voucher/VoucherPos shapes, fake data)", () => {
  it("is a read tool in the vouchers toolset with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("vouchers");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("reads the voucher and its positions with GETs only", async () => {
    const { client } = await get(2001);
    expect(client.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/Voucher/2001"],
      ["GET", "/VoucherPos"],
    ]);
    expect(client.calls[1]?.query).toMatchObject({
      "voucher[id]": 2001,
      "voucher[objectName]": "Voucher",
      limit: 1000,
    });
  });

  it("returns the voucher with tax rule, dates, payment direction and mixed positions", async () => {
    const { result } = await get(2001);
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.voucher).toMatchObject({
      id: 2001,
      kind: "expense",
      paymentDirection: "out",
      taxRule: { id: 9, name: "Vorsteuerabziehbare Aufwendungen" },
      deliveryDate: "2026-01-10",
      enshrined: true,
      hasDocument: true,
      generation: "2.0",
      createdAt: "2026-01-12",
      updatedAt: "2026-01-13",
    });
    expect(result.data.voucher.taxType).toBeUndefined();
    expect(result.data.positions).toEqual([
      {
        id: 3001,
        comment: "Druckerpapier und Toner",
        taxRate: 19,
        net: { amount: "200.00", currency: "EUR" },
        tax: { amount: "38.00", currency: "EUR" },
        gross: { amount: "238.00", currency: "EUR" },
        generation: "2.0",
        accountDatev: { id: 3797 },
        isAsset: false,
      },
      {
        id: 3003,
        comment: "Schreibtischlampe",
        taxRate: 19,
        net: { amount: "50.50", currency: "EUR" },
        tax: { amount: "9.60", currency: "EUR" },
        gross: { amount: "60.10", currency: "EUR" },
        generation: "1.0",
        accountingType: { id: 26 },
        isAsset: true,
      },
    ]);
    expect(result.data.positionsComplete).toBe(true);
    expect(result.summary).toBe("Voucher 2001 with 2 positions.");
  });

  it("renders the recorded mix: a 2.0 voucher with a legacy 1.0 position", async () => {
    const { result } = await get(2002);
    expect(result.data.voucher).toMatchObject({
      id: 2002,
      kind: "revenue",
      paymentDirection: "in",
      generation: "2.0",
      enshrined: false,
    });
    // The recorded voucher has no `document` key, so nothing is claimed about a file.
    expect(result.data.voucher.hasDocument).toBeUndefined();
    expect(result.data.positions).toEqual([
      expect.objectContaining({ id: 3002, generation: "1.0", accountingType: { id: 26 } }),
    ]);
    expect(result.data.positions[0]?.accountDatev).toBeUndefined();
    expect(result.summary).toBe("Voucher 2002 with 1 position.");
  });

  it("drops positions of other vouchers if sevDesk ignores the voucher filter", async () => {
    const objects = Array.from({ length: 3 }, (_, index) => ({
      id: String(9000 + index),
      voucher: { id: index === 1 ? "9999" : "2002", objectName: "Voucher" },
    }));
    const { client, result } = await get(2002, routes(2002, { positions: { body: { objects } } }));
    expect(result.data.positions.map((position) => position.id)).toEqual([9000, 9002]);
    expect(result.data.positionsComplete).toBe(true);
    // First page, then the collection read again page by page (listAll) and filtered here.
    expect(client.callsTo("/VoucherPos").length).toBeGreaterThan(1);
  });

  it("reports partial positions when sevDesk has more rows than can be read", async () => {
    const objects = Array.from({ length: 10_001 }, (_, index) => ({
      id: String(100_000 + index),
      voucher: { id: "2002", objectName: "Voucher" },
    }));
    const { result } = await get(2002, routes(2002, { positions: { body: { objects } } }));
    expect(result.data.positions).toHaveLength(10_000);
    expect(result.data.positionsComplete).toBe(false);
    expect(result.summary).toBe(
      "Voucher 2002 with 10000 positions. Partial: sevDesk had more positions than could be read.",
    );
  });

  it("passes not_found through for an unknown voucher", async () => {
    const error = new SevdeskError({ kind: "not_found", message: "sevDesk found no voucher 1." });
    const client = new FakeSevdeskClient([{ path: "/Voucher/1", response: { error } }]);
    await expect(tool.handler({ id: 1 }, testContext(client))).rejects.toBe(error);
    await expect(
      tool.handler(
        { id: 2 },
        testContext(
          new FakeSevdeskClient([{ path: "/Voucher/2", response: { body: { objects: [] } } }]),
        ),
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("validates the id before sending anything", () => {
    expect(tool.input.safeParse({ id: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ id: 1.5 }).success).toBe(false);
    expect(tool.input.safeParse({ id: "2001" }).success).toBe(false);
    expect(tool.input.safeParse({}).success).toBe(false);
  });
});
