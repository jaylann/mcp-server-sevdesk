import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { partCreateTool as tool } from "../../../../src/tools/parts/create.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";

const EMPTY = { body: { objects: [] } };

function routes(overrides: Partial<Record<string, FakeRoute["response"]>> = {}): FakeRoute[] {
  const table: [string, FakeRoute][] = [
    ["byNumber", { path: "/Part", query: { partNumber: "DL-020" }, response: EMPTY }],
    ["units", { path: "/Unity", response: { fixture: "meta/units.json" } }],
    [
      "post",
      { method: "POST", path: "/Part", response: { fixture: "masterdata/part-create-6101.json" } },
    ],
    ["read", { path: "/Part/6101", response: { fixture: "masterdata/part-6101.json" } }],
  ];
  return table.map(([key, route]) => {
    const response = overrides[key];
    return response === undefined ? route : { ...route, response };
  });
}

const args = {
  name: "Beratungspaket",
  partNumber: "DL-020",
  price: "119",
  priceMode: "gross",
  unitId: 9,
  description: "Vier Stunden Beratung vor Ort",
};

describe("sevdesk_part_create", () => {
  it("is a write tool with create annotations", () => {
    expect(tool.tier).toBe("write");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("previews the part with both prices, unit and defaults", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, args, client);
    expect(plan.preview).toEqual({
      action: "Create the part Beratungspaket (DL-020).",
      facts: [
        { label: "Name", value: "Beratungspaket" },
        { label: "Part number (Artikelnummer)", value: "DL-020" },
        { label: "Price net", value: "100.00 EUR (computed)" },
        { label: "Price gross", value: "119.00 EUR" },
        { label: "Tax rate", value: "19 %" },
        { label: "Unit (Einheit)", value: "Std (id 9)" },
        { label: "Stock (Bestand)", value: "0, stock tracking off" },
        { label: "Description", value: "Vier Stunden Beratung vor Ort" },
      ],
      warnings: [],
      irreversible: false,
    });
    expect(client.writes()).toEqual([]);
  });

  it("sends net and gross price with the tax rate, never price, and reads the part back", async () => {
    const client = new FakeSevdeskClient(routes());
    const { output } = await executeWrite(tool, args, client);
    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      [
        "POST",
        "/Part",
        "write",
        {
          name: "Beratungspaket",
          partNumber: "DL-020",
          text: "Vier Stunden Beratung vor Ort",
          stock: 0,
          stockEnabled: false,
          unity: { id: 9, objectName: "Unity" },
          priceNet: 100,
          priceGross: 119,
          taxRate: 19,
          status: 100,
        },
      ],
    ]);
    expect(output.data.part).toMatchObject({
      id: 6101,
      partNumber: "DL-020",
      priceNet: { amount: "100.00", currency: "EUR" },
      priceGross: { amount: "119.00", currency: "EUR" },
      unitId: 9,
    });
    expect(output.affected).toEqual([{ objectName: "Part", id: "6101" }]);
    expect(output.summary).toBe("Created part 6101.");
  });

  it("sends 0 values, purchase price, stock tracking and internal note as given (B16)", async () => {
    const client = new FakeSevdeskClient(routes());
    const { plan } = await executeWrite(
      tool,
      {
        name: "Gratisartikel",
        partNumber: "DL-020",
        price: 0,
        taxRate: 0,
        pricePurchase: "12.5",
        stock: "3.25",
        stockEnabled: true,
        internalComment: "Nur intern",
      },
      client,
    );
    expect(client.writes()[0]?.body).toEqual({
      name: "Gratisartikel",
      partNumber: "DL-020",
      stock: 3.25,
      stockEnabled: true,
      unity: { id: 1, objectName: "Unity" },
      priceNet: 0,
      priceGross: 0,
      pricePurchase: 12.5,
      taxRate: 0,
      status: 100,
      internalComment: "Nur intern",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Purchase price (Einkaufspreis)",
      value: "12.50 EUR",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Unit (Einheit)", value: "Stk (id 1)" });
    expect(plan.preview.facts).toContainEqual({
      label: "Stock (Bestand)",
      value: "3.25, stock tracking on",
    });
  });

  it("warns when the part has no price", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, { name: "X", partNumber: "DL-020" }, client);
    expect(plan.preview.warnings).toEqual([
      "The part has no sales price; documents will need one per position.",
    ]);
    expect(plan.preview.facts.map((fact) => fact.label)).not.toContain("Price net");
  });

  it("refuses a part number that is taken (exact match)", async () => {
    const client = new FakeSevdeskClient(
      routes({
        byNumber: { body: { objects: [{ id: "6001", name: "A", partNumber: "DL-020" }] } },
      }),
    );
    await expect(prepareWrite(tool, args, client)).rejects.toMatchObject({
      kind: "validation",
      message:
        "The part number is already used by part 6001. Choose another part number, or change " +
        "that part with sevdesk_part_update.",
    });
    const prefix = new FakeSevdeskClient(
      routes({
        byNumber: { body: { objects: [{ id: "6001", name: "A", partNumber: "DL-0200" }] } },
      }),
    );
    await expect(prepareWrite(tool, args, prefix)).resolves.toBeDefined();
  });

  it("refuses an unknown unit", async () => {
    const client = new FakeSevdeskClient(routes());
    await expect(prepareWrite(tool, { ...args, unitId: 99 }, client)).rejects.toMatchObject({
      kind: "validation",
      message:
        "Unit 99 does not exist in this sevDesk account. Look units up with " +
        "sevdesk_reference_lookup kind=units (1 = Stk).",
    });
  });

  it("validates amounts strictly", () => {
    const parse = (extra: Record<string, unknown>) =>
      tool.input.safeParse({ name: "A", partNumber: "B", ...extra });
    expect(parse({ price: "1,50" }).success).toBe(false);
    expect(parse({ price: "1.505" }).success).toBe(false);
    expect(parse({ price: "-1" }).success).toBe(false);
    expect(parse({ taxRate: "101" }).success).toBe(false);
    expect(parse({ taxRate: 7 }).data?.taxRate).toBe("7");
    expect(parse({}).data).toMatchObject({
      taxRate: "19",
      unitId: 1,
      stock: "0",
      stockEnabled: false,
      priceMode: "net",
    });
    expect(parse({ price: "1", priceMode: "brutto" }).success).toBe(false);
  });

  it("reports the created part when the read-back fails", async () => {
    const client = new FakeSevdeskClient(
      routes({ read: { error: new SevdeskError({ kind: "network", message: "x" }) } }),
    );
    await expect(executeWrite(tool, args, client)).rejects.toMatchObject({
      kind: "network",
      completedWrites: [{ objectName: "Part", id: "6101" }],
    });

    const unreadable = new FakeSevdeskClient(
      routes({ read: { body: { objects: [{ id: "x" }] } } }),
    );
    await expect(executeWrite(tool, args, unreadable)).rejects.toMatchObject({
      kind: "unexpected_response",
      completedWrites: [{ objectName: "Part", id: "6101" }],
    });
  });

  it("wraps non-sevDesk read-back failures with the created part", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, args, client);
    const broken = {
      request: (request: Parameters<FakeSevdeskClient["request"]>[0]) =>
        request.method === "GET" ? Promise.reject(new TypeError("bug")) : client.request(request),
      list: client.list.bind(client),
      listAll: client.listAll.bind(client),
      download: client.download.bind(client),
    };
    await expect(
      tool.execute(tool.input.parse(args), plan, {
        client: broken,
        config: {} as never,
        signal: new AbortController().signal,
        progress: () => Promise.resolve(),
        files: {} as never,
      }),
    ).rejects.toMatchObject({
      kind: "unexpected_response",
      message: "The part was saved, but reading it back failed unexpectedly.",
      completedWrites: [{ objectName: "Part", id: "6101" }],
    });
  });
});
