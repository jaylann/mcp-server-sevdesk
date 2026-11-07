import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { partGetTool as tool } from "../../../../src/tools/parts/get.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

async function get(id: number, routes: readonly FakeRoute[]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse({ id }), testContext(client));
  return { client, result };
}

describe("sevdesk_part_get (community: recorded Part shape, fake data)", () => {
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

  it("reads one part without the stock endpoint when stock tracking is off", async () => {
    const { client, result } = await get(6001, [
      { path: "/Part/6001", response: { fixture: "parts/part-6001.json" } },
    ]);
    expect(client.calls.map((call) => [call.method, call.path])).toEqual([["GET", "/Part/6001"]]);
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.part).toEqual({
      id: 6001,
      partNumber: "ART-001",
      name: "Testartikel",
      unitId: 1,
      categoryId: 1,
      priceNet: { amount: "42.01", currency: "EUR" },
      priceGross: { amount: "49.99", currency: "EUR" },
      taxRate: 19,
      stock: 100,
      stockEnabled: false,
      active: true,
      description: "Beschreibung des Testartikels",
      createdAt: "2026-02-19",
      updatedAt: "2026-02-19",
    });
    expect(result.summary).toBe("Part 6001.");
  });

  it("adds the current stock from getStock when stock tracking is on", async () => {
    const { client, result } = await get(6002, [
      { path: "/Part/6002", response: { fixture: "parts/part-6002.json" } },
      { path: "/Part/6002/getStock", response: { fixture: "parts/part-stock-6002.json" } },
    ]);
    expect(client.calls.map((call) => call.path)).toEqual(["/Part/6002", "/Part/6002/getStock"]);
    expect(client.calls.every((call) => call.method === "GET" && !call.sideEffect)).toBe(true);
    expect(result.data.part).toMatchObject({
      stock: 7.5,
      currentStock: 7,
      stockEnabled: true,
      active: false,
      internalComment: "Nur nach Absprache",
    });
    expect(result.data.part.description).toBeUndefined();
    expect(result.summary).toBe("Part 6002, current stock 7.");
  });

  it("fails loudly on an unreadable stock value", async () => {
    await expect(
      get(6002, [
        { path: "/Part/6002", response: { fixture: "parts/part-6002.json" } },
        { path: "/Part/6002/getStock", response: { body: { objects: "lots" } } },
      ]),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
  });

  it("passes not_found through and validates the id", async () => {
    const error = new SevdeskError({ kind: "not_found", message: "sevDesk found no part 1." });
    await expect(get(1, [{ path: "/Part/1", response: { error } }])).rejects.toBe(error);
    expect(tool.input.safeParse({ id: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ id: "6001" }).success).toBe(false);
  });
});
