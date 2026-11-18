import { describe, expect, it } from "vitest";

import { tagsListTool as tool } from "../../../../src/tools/documents/tags-list.js";
import { invoicesListTool } from "../../../../src/tools/invoices/list.js";
import type { ToolsetName } from "../../../../src/tools/toolsets.js";
import { testConfig } from "../../../helpers/config.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { invoiceRow } from "../lifecycle/helpers.js";
import { relationRow, tagRow, tagsRoute, tagUsesRoute } from "./tag-support.js";

/** `n` relations of tag `tagId` on invoices 1…n. */
function manyRelations(n: number, tagId: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, index) =>
    relationRow(100_000 + index, tagId, "Invoice", index + 1),
  );
}

async function list(args: Record<string, unknown>, routes: readonly FakeRoute[]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  return { client, result };
}

describe("sevdesk_tags_list", () => {
  it("is a read tool in meta, registered with any document toolset", () => {
    expect(tool).toMatchObject({
      toolset: "meta",
      tier: "read",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    const has = (...toolsets: ToolsetName[]) =>
      tool.available?.(testConfig({ toolsets: new Set(toolsets) }));
    expect(has("meta", "contacts")).toBe(false);
    expect(has("meta", "credit-notes")).toBe(true);
  });

  it("pages the recorded tags with an explicit limit and counts uses per kind from the relations", async () => {
    const relations: FakeRoute = {
      path: "/TagRelation",
      response: {
        body: {
          objects: [
            relationRow(8101, 5888323, "Invoice", 1001),
            relationRow(8102, 5888323, "Voucher", 2001),
            relationRow(8103, 5888323, "Invoice", 1002),
            relationRow(8104, 5888328, "CreditNote", 3001),
          ],
        },
      },
    };
    const { client, result } = await list({ limit: 5 }, [
      { path: "/Tag", response: { fixture: "recorded/2026-11-16/tags/tags-list.json" } },
      relations,
    ]);
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(client.callsTo("/Tag")[0]?.query).toEqual({ limit: 5, offset: 0, countAll: true });
    expect(client.callsTo("/TagRelation")[0]?.query).toMatchObject({ limit: 1000, offset: 0 });
    const byId = new Map(result.data.items.map((item) => [item.id, item]));
    expect(byId.get(5888323)).toEqual({
      id: 5888323,
      name: "Mustertag 4",
      uses: 3,
      usedOn: { invoice: 2, voucher: 1 },
    });
    expect(byId.get(5888328)).toMatchObject({ uses: 1, usedOn: { credit_note: 1 } });
    expect(byId.get(5888327)).toMatchObject({ uses: 0, usedOn: {} });
    expect(result.data).toMatchObject({
      total: 6,
      hasMore: true,
      nextOffset: 5,
      usesComplete: true,
    });
    expect(result.summary).toBe("Tags 1–5 of 6; more may follow (nextOffset 5).");
  });

  it("keeps untrusted names out of the summary and cleans them in the data", async () => {
    const { result } = await list({}, [
      tagsRoute([tagRow(7001, "  Projekt​ Y  ")]),
      { path: "/TagRelation", response: { body: { objects: [] } } },
    ]);
    expect(result.data.items[0]?.name).toBe("Projekt Y");
    expect(result.summary).not.toContain("Projekt");
  });

  it("says when the cap cut the counts short", async () => {
    const { result } = await list({}, [
      tagsRoute([tagRow(7001, "Projekt Y")]),
      { path: "/TagRelation", response: { body: { objects: manyRelations(10_001, 7001) } } },
    ]);
    expect(result.data.usesComplete).toBe(false);
    expect(result.data.items[0]?.uses).toBe(10_000);
    expect(result.summary).toContain("Uses are lower bounds");
  });
});

describe("the tag filter of the list tools", () => {
  it("keeps rows on sevDesk's word beyond 10,000 uses and says so", async () => {
    const client = new FakeSevdeskClient([
      tagsRoute([tagRow(7001, "Projekt Y")]),
      tagUsesRoute(7001, manyRelations(10_001, 7001)),
      {
        path: "/Invoice",
        response: { body: { objects: [invoiceRow({ id: "20001" })] } },
      },
    ]);
    const result = await invoicesListTool.handler(
      invoicesListTool.input.parse({ tag: "Projekt Y" }),
      testContext(client),
    );
    expect(result.data.items.map((item) => item.id)).toEqual([20001]);
    expect(result.data.tagFilter).toEqual({ tagId: 7001, rowsChecked: false });
    expect(result.summary).toContain("The tag has more than 10,000 uses");
  });

  it("finds the tag by a spelling with other accents and case (CAFE → Café)", async () => {
    const client = new FakeSevdeskClient([
      tagsRoute([tagRow(7002, "Filiale München"), tagRow(7001, "Café")]),
      tagUsesRoute(7001, [relationRow(8101, 7001, "Invoice", 1001)]),
      { path: "/Invoice", response: { body: { objects: [invoiceRow()] } } },
    ]);
    const result = await invoicesListTool.handler(
      invoicesListTool.input.parse({ tag: "CAFE" }),
      testContext(client),
    );
    expect(result.data.items.map((item) => item.id)).toEqual([1001]);
    expect(result.data.tagFilter).toEqual({ tagId: 7001, rowsChecked: true });
    expect(client.callsTo("/Invoice")[0]?.query).toMatchObject({ "tags[0][id]": 7001 });
  });

  it("refuses a name several tags fold to when none is spelled exactly so", async () => {
    const client = new FakeSevdeskClient([
      tagsRoute([tagRow(7001, "Café"), tagRow(7003, "Cafe")]),
      { path: "/Invoice", response: { body: { objects: [invoiceRow()] } } },
    ]);
    await expect(
      invoicesListTool.handler(invoicesListTool.input.parse({ tag: "cafe" }), testContext(client)),
    ).rejects.toThrow("Several tags have this name (compared ignoring case, accents and ß/ss).");
    expect(client.callsTo("/Invoice")).toEqual([]);
  });

  it("leaves the lists unchanged without a tag (no tag requests, no tagFilter)", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Invoice", response: { body: { objects: [invoiceRow()] } } },
    ]);
    const result = await invoicesListTool.handler(
      invoicesListTool.input.parse({}),
      testContext(client),
    );
    expect(client.calls.map((call) => call.path)).toEqual(["/Invoice"]);
    expect(result.data).not.toHaveProperty("tagFilter");
  });
});
