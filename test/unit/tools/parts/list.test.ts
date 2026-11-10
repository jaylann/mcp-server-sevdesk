import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { partsListTool as tool } from "../../../../src/tools/parts/list.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const listRoute: FakeRoute = { path: "/Part", response: { fixture: "parts/parts-list.json" } };

async function list(args: Record<string, unknown>, routes: readonly FakeRoute[] = [listRoute]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  return { client, result };
}

describe("sevdesk_parts_list (community: recorded Part shape, fake data)", () => {
  it("is a read tool in the parts toolset with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("parts");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("sends sevDesk's partNumber and name filters with an explicit limit", async () => {
    const { client } = await list({ partNumber: "ART-001", name: "Testartikel", limit: 10 });
    expect(client.calls).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/Part",
        query: { partNumber: "ART-001", name: "Testartikel", limit: 10, offset: 0, countAll: true },
      }),
    ]);
  });

  it("returns compact parts with exact prices; price (= gross in the recording) is ignored", async () => {
    const { result } = await list({});
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.items).toEqual([
      {
        id: 6001,
        partNumber: "ART-001",
        name: "Testartikel",
        unitId: 1,
        categoryId: 1,
        priceNet: { amount: "42.01", currency: "EUR" },
        priceGross: { amount: "49.99", currency: "EUR" },
        taxRate: "19",
        stock: "100",
        stockEnabled: false,
        active: true,
      },
      {
        id: 6002,
        partNumber: "DL-010",
        name: "Beratungsstunde",
        unitId: 9,
        priceNet: { amount: "80.00", currency: "EUR" },
        priceGross: { amount: "95.20", currency: "EUR" },
        pricePurchase: { amount: "40.50", currency: "EUR" },
        taxRate: "19",
        stock: "7.5",
        stockEnabled: true,
        active: false,
      },
    ]);
    expect(result.data).toMatchObject({ total: 2, hasMore: false });
    expect(result.summary).toBe("Parts 1–2 of 2.");
  });

  it("pages with nextOffset", async () => {
    const { result } = await list({ limit: 1 });
    expect(result.data).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 });
    expect(result.summary).toBe("Parts 1–1 of 2; more may follow (nextOffset 1).");
  });

  it("handles parts with missing fields and unknown status", async () => {
    const { result } = await list({}, [
      { path: "/Part", response: { body: { objects: [{ id: "6100", status: "75", name: " " }] } } },
    ]);
    expect(result.data.items).toEqual([
      { id: 6100, name: "(unnamed part 6100)", stockEnabled: false },
    ]);
  });

  it("validates input and passes errors through", async () => {
    expect(tool.input.safeParse({ partNumber: "" }).success).toBe(false);
    expect(tool.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ query: "x" }).success).toBe(false);
    const error = new SevdeskError({
      kind: "auth",
      message: "The sevDesk API token was rejected.",
    });
    await expect(list({}, [{ path: "/Part", response: { error } }])).rejects.toBe(error);
    await expect(
      list({}, [
        { path: "/Part", response: { body: { objects: [{ id: "6100", stock: "viel" }] } } },
      ]),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
  });
});
