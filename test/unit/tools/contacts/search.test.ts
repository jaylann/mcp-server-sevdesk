import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { contactsSearchTool as tool } from "../../../../src/tools/contacts/search.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const listRoute: FakeRoute = {
  path: "/Contact",
  query: { depth: "1" },
  response: { fixture: "contacts/contacts-list.json" },
};

async function search(args: Record<string, unknown>, routes: readonly FakeRoute[] = [listRoute]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  return { client, result };
}

describe("sevdesk_contacts_search (community: recorded Contact shape, fake data)", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("contacts");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("always sends depth=1 so persons are included, and only GETs", async () => {
    const { client, result } = await search({});
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      method: "GET",
      path: "/Contact",
      query: { depth: "1", limit: 25, offset: 0, countAll: true },
    });
    expect(client.methods().every((method) => method === "GET")).toBe(true);
    expect(result.data.items.map((item) => item.kind)).toContain("person");
  });

  it("maps filters to sevDesk's parameter names, the category by name to its id", async () => {
    const { client } = await search({
      query: "Muster",
      customerNumber: "K-1001",
      category: "customer",
    });
    expect(client.calls[0]?.query).toMatchObject({
      depth: "1",
      name: "Muster",
      customerNumber: "K-1001",
      "category[id]": 3,
      "category[objectName]": "Category",
    });
  });

  it("returns compact DTOs that satisfy the output schema", async () => {
    const { result } = await search({ limit: 2 });
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.items).toEqual([
      expect.objectContaining({
        id: 1001,
        kind: "organisation",
        displayName: "Musterfirma GmbH",
        link: "https://my.sevdesk.de/crm/detail/id/1001",
      }),
      expect.objectContaining({ id: 1002, kind: "person", displayName: "Dr. Max Mustermann" }),
    ]);
  });

  it("pages with total, hasMore and nextOffset", async () => {
    const first = await search({ limit: 4 });
    expect(first.result.data).toMatchObject({ total: 6, offset: 0, limit: 4, hasMore: true });
    expect(first.result.data.nextOffset).toBe(4);
    expect(first.result.summary).toBe("Contacts 1–4 of 6; more may follow (nextOffset 4).");

    const last = await search({ limit: 4, offset: 4 });
    expect(last.result.data.items.map((item) => item.id)).toEqual([1005, 1006]);
    expect(last.result.data.hasMore).toBe(false);
    expect(last.result.data.nextOffset).toBeUndefined();
    expect(last.result.summary).toBe("Contacts 5–6 of 6.");
  });

  it("uses sevDesk's countAll total for hasMore on a recorded page", async () => {
    const { result } = await search({ limit: 2 }, [
      { ...listRoute, response: { fixture: "contacts/contacts-page.json" } },
    ]);
    expect(result.data).toMatchObject({ total: 140, hasMore: true, nextOffset: 2 });
  });

  it("continues after a short page at offset + rows received, not + limit", async () => {
    const objects = Array.from({ length: 20 }, (_, index) => ({
      id: String(5000 + index),
      name: "Musterfirma GmbH",
    }));
    const { result } = await search({ limit: 25, offset: 25 }, [
      { ...listRoute, response: { body: { total: "60", objects } } },
    ]);
    expect(result.data).toMatchObject({ total: 60, hasMore: true, nextOffset: 45 });
    expect(result.summary).toBe("Contacts 26–45 of 60; more may follow (nextOffset 45).");
  });

  it("without a total, treats any non-empty page as possibly not the last", async () => {
    const objects = [
      { id: "1001", name: "Musterfirma GmbH" },
      { id: "1002", surename: "Max", familyname: "Mustermann" },
      { id: "1003", name: "Beispiel Lieferant AG" },
    ];
    // `total: null` simulates a response without a usable count (the client reports undefined).
    const short = await search({ limit: 25 }, [
      { ...listRoute, response: { body: { total: null, objects } } },
    ]);
    expect(short.result.data.total).toBeUndefined();
    expect(short.result.data).toMatchObject({ hasMore: true, nextOffset: 3 });
    expect(short.result.summary).toBe("Contacts 1–3; more may follow (nextOffset 3).");

    const end = await search({ limit: 25, offset: 3 }, [
      { ...listRoute, response: { body: { total: null, objects: [] } } },
    ]);
    expect(end.result.data).toMatchObject({ items: [], hasMore: false });
    expect(end.result.data.nextOffset).toBeUndefined();
    expect(end.result.summary).toBe("No more contacts after offset 3.");
  });

  it("de-duplicates contacts sevDesk returns twice", async () => {
    const row = { id: "1001", name: "Musterfirma GmbH" };
    const { result } = await search({}, [
      {
        ...listRoute,
        response: { body: { objects: [row, row, { id: "1002", surename: "Max" }] } },
      },
    ]);
    expect(result.data.items.map((item) => item.id)).toEqual([1001, 1002]);
  });

  it("keeps upstream text out of the trusted summary", async () => {
    const { result } = await search({ query: "Musterfirma" });
    expect(result.summary).not.toMatch(/Muster/);
  });

  it("says when nothing matched", async () => {
    const { result } = await search({}, [{ ...listRoute, response: { body: { objects: [] } } }]);
    expect(result.data).toMatchObject({ items: [], total: 0, hasMore: false });
    expect(result.summary).toBe("No contacts matched.");
  });

  it("says when the offset is past the last match", async () => {
    const { result } = await search({ offset: 10 });
    expect(result.data).toMatchObject({ items: [], total: 6, hasMore: false });
    expect(result.summary).toBe("No contacts at offset 10; there are 6 matches in total.");
  });

  it("rejects unknown arguments, raw category ids and out-of-range limits", () => {
    expect(tool.input.safeParse({ name: "x" }).success).toBe(false);
    expect(tool.input.safeParse({ category: 3 }).success).toBe(false);
    expect(tool.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ limit: 101 }).success).toBe(false);
    expect(tool.input.safeParse({ offset: -1 }).success).toBe(false);
    expect(tool.input.safeParse({ query: "   " }).success).toBe(false);
  });

  it("lets sevDesk errors propagate for the framework to map", async () => {
    const error = new SevdeskError({ kind: "auth", message: "token rejected", status: 401 });
    await expect(search({}, [{ ...listRoute, response: { error } }])).rejects.toBe(error);
  });
});
