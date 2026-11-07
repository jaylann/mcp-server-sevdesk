import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { partUpdateTool as tool } from "../../../../src/tools/parts/update.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";

const OK = { body: { objects: { id: "6001", objectName: "Part" } } };
const EMPTY = { body: { objects: [] } };

/** Part 6001: ART-001, net 42.01 / gross 49.99 at 19 %, unit 1, stock 100, tracking off. */
function routes(extra: FakeRoute[] = []): FakeRoute[] {
  return [
    ...extra,
    { path: "/Part/6001", response: { fixture: "parts/part-6001.json" } },
    { path: "/Part", query: { partNumber: "ART-002" }, response: EMPTY },
    { path: "/Unity", response: { fixture: "meta/units.json" } },
    { method: "PUT", path: "/Part/6001", response: OK },
  ];
}

/** Part 6002: inactive, tracking on, net 80 / gross 95.2, purchase 40.5, unit 9. */
function routes6002(): FakeRoute[] {
  return [
    { path: "/Part/6002", response: { fixture: "parts/part-6002.json" } },
    { path: "/Part/6002/getStock", response: { fixture: "parts/part-stock-6002.json" } },
    { method: "PUT", path: "/Part/6002", response: OK },
  ];
}

describe("sevdesk_part_update", () => {
  it("is a write tool with update annotations", () => {
    expect(tool.tier).toBe("write");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("changes name, number, price and unit and keeps everything else", async () => {
    const client = new FakeSevdeskClient(routes());
    const { plan, output } = await executeWrite(
      tool,
      { id: 6001, name: "Testartikel Pro", partNumber: "ART-002", price: "50", unitId: 4 },
      client,
    );
    expect(plan.preview).toEqual({
      action: "Update part Testartikel (id 6001): name, part number, price, unit.",
      facts: [
        { label: "Part", value: "Testartikel (id 6001, ART-001)" },
        { label: "Name", value: "Testartikel → Testartikel Pro" },
        { label: "Part number", value: "ART-001 → ART-002" },
        { label: "Price net", value: "42.01 EUR → 50.00 EUR" },
        { label: "Price gross", value: "49.99 EUR → 59.50 EUR (computed)" },
        { label: "Unit", value: "1 → kg (id 4)" },
      ],
      warnings: [],
      irreversible: false,
    });
    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      [
        "PUT",
        "/Part/6001",
        "write",
        {
          name: "Testartikel Pro",
          partNumber: "ART-002",
          priceNet: 50,
          priceGross: 59.5,
          taxRate: 19,
          unity: { id: 4, objectName: "Unity" },
        },
      ],
    ]);
    expect(output.data.part.id).toBe(6001);
    expect(output.affected).toEqual([{ objectName: "Part", id: "6001" }]);
    expect(output.summary).toBe("Updated part 6001.");
  });

  it("recomputes the gross price when only the tax rate changes", async () => {
    const client = new FakeSevdeskClient(routes());
    const { plan } = await executeWrite(tool, { id: 6001, taxRate: 7 }, client);
    expect(client.writes()[0]?.body).toEqual({ priceNet: 42.01, priceGross: 44.95, taxRate: 7 });
    expect(plan.preview.facts).toContainEqual({ label: "Tax rate", value: "19 % → 7 %" });
    expect(plan.preview.facts).toContainEqual({
      label: "Price gross",
      value: "49.99 EUR → 44.95 EUR (computed)",
    });
    expect(plan.preview.warnings).toEqual([
      "The tax rate changes and no new price was given: the net price stays, the gross price " +
        "is recomputed.",
    ]);
  });

  it("takes a gross price and computes the net price", async () => {
    const client = new FakeSevdeskClient(routes());
    await executeWrite(tool, { id: 6001, price: "59.50", priceType: "gross" }, client);
    expect(client.writes()[0]?.body).toEqual({ priceNet: 50, priceGross: 59.5, taxRate: 19 });
  });

  it("changes stock, tracking, status, purchase price and texts of another part", async () => {
    const client = new FakeSevdeskClient(routes6002());
    const { plan } = await executeWrite(
      tool,
      {
        id: 6002,
        stock: 0,
        stockEnabled: false,
        active: true,
        pricePurchase: "41",
        description: "Neu",
        internalComment: "Neue Notiz",
      },
      client,
    );
    expect(client.writes()[0]?.body).toEqual({
      pricePurchase: 41,
      stock: 0,
      stockEnabled: false,
      status: 100,
      text: "Neu",
      internalComment: "Neue Notiz",
    });
    expect(plan.preview.facts.slice(1)).toEqual([
      { label: "Purchase price", value: "40.50 EUR → 41.00 EUR" },
      { label: "Stock", value: "7.5 → 0" },
      { label: "Stock tracking", value: "on → off" },
      { label: "Status", value: "inactive → active" },
      { label: "Description", value: "(empty) → Neu" },
      { label: "Internal note", value: "Nur nach Absprache → Neue Notiz" },
    ]);
  });

  it("deactivates a part", async () => {
    const client = new FakeSevdeskClient(routes());
    await executeWrite(tool, { id: 6001, active: false }, client);
    expect(client.writes()[0]?.body).toEqual({ status: 50 });
  });

  it("refuses an update that changes nothing", async () => {
    const client = new FakeSevdeskClient(routes());
    await expect(
      prepareWrite(
        tool,
        {
          id: 6001,
          name: "Testartikel",
          price: "42.010",
          taxRate: "19.00",
          unitId: 1,
          stock: 100,
          stockEnabled: false,
          active: true,
          description: "Beschreibung des Testartikels",
        },
        client,
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "Nothing to change: part 6001 already has these values.",
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses a part number used by another part, accepts its own", async () => {
    const taken = new FakeSevdeskClient(
      routes([
        {
          path: "/Part",
          query: { partNumber: "DL-010" },
          response: { fixture: "parts/parts-list.json" },
        },
      ]),
    );
    await expect(
      prepareWrite(tool, { id: 6001, partNumber: "DL-010" }, taken),
    ).rejects.toMatchObject({
      message: "The part number is already used by part 6002.",
    });
    const own = new FakeSevdeskClient(
      routes([
        {
          path: "/Part",
          query: { partNumber: "ART-001" },
          response: { fixture: "parts/parts-list.json" },
        },
      ]),
    );
    await expect(
      prepareWrite(tool, { id: 6001, partNumber: "ART-001" }, own),
    ).rejects.toMatchObject({
      message: "Nothing to change: part 6001 already has these values.",
    });
  });

  it("needs a tax rate for a price when sevDesk has none", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Part/7001",
        response: { body: { objects: [{ id: "7001", name: "Ohne", taxRate: null }] } },
      },
      { method: "PUT", path: "/Part/7001", response: OK },
    ]);
    await expect(prepareWrite(tool, { id: 7001, price: "10" }, client)).rejects.toMatchObject({
      message: "Part 7001 has no tax rate in sevDesk: give taxRate together with the price.",
    });
    // With a tax rate given, the price and the new rate are sent.
    const { plan } = await executeWrite(tool, { id: 7001, price: "10", taxRate: 19 }, client);
    expect(client.writes()[0]?.body).toEqual({ priceNet: 10, priceGross: 11.9, taxRate: 19 });
    expect(plan.preview.facts).toContainEqual({ label: "Price net", value: "(none) → 10.00 EUR" });
    expect(plan.preview.facts).toContainEqual({ label: "Tax rate", value: "(none) → 19 %" });
  });

  it("sends only the tax rate for a part without prices", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Part/7002",
        response: { body: { objects: [{ id: "7002", name: "Ohne", taxRate: "19" }] } },
      },
      { method: "PUT", path: "/Part/7002", response: OK },
    ]);
    const { plan } = await executeWrite(tool, { id: 7002, taxRate: 7 }, client);
    expect(client.writes()[0]?.body).toEqual({ taxRate: 7 });
    expect(plan.preview.warnings).toEqual([]);
  });

  it("refuses an unknown unit and surfaces a missing part", async () => {
    const client = new FakeSevdeskClient([...routes(), { path: "/Part/9999", response: EMPTY }]);
    await expect(prepareWrite(tool, { id: 6001, unitId: 99 }, client)).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("Unit 99 does not exist") as string,
    });
    await expect(prepareWrite(tool, { id: 9999, name: "X" }, client)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("passes a failed PUT through and reports the part when the read-back fails", async () => {
    const rejected = new SevdeskError({ kind: "validation", status: 422, message: "x" });
    const failing = new FakeSevdeskClient(
      routes([{ method: "PUT", path: "/Part/6001", response: { error: rejected } }]),
    );
    await expect(executeWrite(tool, { id: 6001, name: "Neu" }, failing)).rejects.toBe(rejected);

    // The read-back after the PUT fails: the GET route answers the first (prepare) read only.
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, { id: 6001, name: "Neu" }, client);
    const broken = new FakeSevdeskClient([
      {
        path: "/Part/6001",
        response: { error: new SevdeskError({ kind: "timeout", message: "x" }) },
      },
      { method: "PUT", path: "/Part/6001", response: OK },
    ]);
    await expect(
      tool.execute(tool.input.parse({ id: 6001, name: "Neu" }), plan, {
        client: broken,
        config: {} as never,
        signal: new AbortController().signal,
        progress: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({
      kind: "timeout",
      completedWrites: [{ objectName: "Part", id: "6001" }],
    });
  });
});
