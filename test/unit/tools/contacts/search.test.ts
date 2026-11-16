import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { contactsSearchTool as tool } from "../../../../src/tools/contacts/search.js";
import {
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  testContext,
} from "../../../helpers/fake-client.js";

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

describe("sevdesk_contacts_search by custom field value (D-086)", () => {
  const FIND = "/Contact/Factory/findContactsByCustomFieldValue";
  const settingsRoute: FakeRoute = {
    path: "/ContactCustomFieldSetting",
    response: { fixture: "contacts/custom-field-settings.json" },
  };
  function findRoute(response: FakeRoute["response"] = { fixture: "contacts/contacts-list.json" }) {
    return {
      path: FIND,
      query: { "customFieldSetting[id]": "19498" },
      response,
    } satisfies FakeRoute;
  }

  it("resolves the field by name and asks sevDesk with the setting id alone, GETs only", async () => {
    const { client, result } = await search(
      { customField: { name: " kundennr  EXTERN ", value: " ext-4711 " } },
      [settingsRoute, findRoute()],
    );
    expect(client.methods().every((method) => method === "GET")).toBe(true);
    expect(client.callsTo(FIND)).toEqual([
      expect.objectContaining({
        query: {
          value: "ext-4711",
          "customFieldSetting[id]": 19498,
          "customFieldSetting[objectName]": "ContactCustomFieldSetting",
          limit: 1000,
          offset: 0,
          countAll: true,
        },
      }),
    ]);
    // The spec's required customFieldName is not needed with the id (recorded) and not sent.
    expect(client.callsTo(FIND)[0]?.query).not.toHaveProperty("customFieldName");
    expect(result.data).toMatchObject({ total: 6, offset: 0, limit: 25, hasMore: false });
    expect(result.data.items.map((item) => item.id)).toEqual(
      [...result.data.items.map((item) => item.id)].sort((a, b) => a - b),
    );
    expect(result.summary).toBe("Contacts 1–6 of 6 with this value in custom field 19498.");
  });

  it("pages the matches itself and keeps detail=summary", async () => {
    const { client, result } = await search(
      {
        customField: { settingId: 19498, value: "EXT-4711" },
        limit: 2,
        offset: 2,
        detail: "summary",
      },
      [settingsRoute, findRoute()],
    );
    expect(client.callsTo(FIND)).toHaveLength(1);
    expect(result.data).toMatchObject({
      total: 6,
      offset: 2,
      limit: 2,
      hasMore: true,
      nextOffset: 4,
    });
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items[0]).not.toHaveProperty("link");
    expect(result.summary).toBe(
      "Contacts 3–4 of 6 with this value in custom field 19498; more follow (nextOffset 4).",
    );
  });

  it("says when no contact has the value, and when the offset is past the matches", async () => {
    const none = await search({ customField: { settingId: 19498, value: "EXT" } }, [
      settingsRoute,
      findRoute({ body: { objects: [] } }),
    ]);
    expect(none.result.data).toMatchObject({ items: [], total: 0, hasMore: false });
    expect(none.result.summary).toBe("No contacts have this value in that custom field.");
    const past = await search({ customField: { settingId: 19498, value: "x" }, offset: 10 }, [
      settingsRoute,
      findRoute(),
    ]);
    expect(past.result.summary).toBe("No contacts at offset 10; 6 matched.");
  });

  it("reads the whole match set once and cuts a huge one at 1000, saying so", async () => {
    // D-086 (recorded 2026-11-17): the endpoint ignores limit and offset and answers every
    // match. A recorded-page route answers all rows whatever the limit, as sevDesk does.
    const [row] = (
      loadFixture("contacts/contacts-list.json").body as { objects: Record<string, unknown>[] }
    ).objects;
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...row, id: String(20_000 + index) }));
    const { client, result } = await search(
      { customField: { settingId: 19498, value: "x" }, offset: 975 },
      [settingsRoute, findRoute({ body: { objects: rows(1500), total: "1500" } })],
    );
    expect(client.callsTo(FIND)).toHaveLength(1);
    expect(client.callsTo(FIND)[0]?.query).toMatchObject({ offset: 0 });
    expect(result.data).not.toHaveProperty("total");
    expect(result.data).toMatchObject({ offset: 975, hasMore: false });
    expect(result.data.items.at(-1)?.id).toBe(20_999);
    expect(result.summary).toMatch(
      /The result was cut: sevDesk found more matches than the 1000 kept here; give a more specific value\.$/,
    );

    const exact = await search({ customField: { settingId: 19498, value: "x" } }, [
      settingsRoute,
      findRoute({ body: { objects: rows(1000), total: "1000" } }),
    ]);
    expect(exact.result.data).toMatchObject({ total: 1000, hasMore: true, nextOffset: 25 });
    expect(exact.result.summary).not.toMatch(/cut/);
  });

  it.each([
    [{ query: "Muster" }, "query"],
    [{ customerNumber: "K-1001" }, "customerNumber"],
    [{ category: "customer" }, "category"],
  ])("refuses customField together with %o before any request", async (extra, name) => {
    const client = new FakeSevdeskClient([settingsRoute, findRoute()]);
    const args = tool.input.parse({ customField: { settingId: 19498, value: "x" }, ...extra });
    await expect(tool.handler(args, testContext(client))).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(`customField is not combined with ${name}`) as string,
    });
    expect(client.calls).toEqual([]);
  });

  it.each([
    [{ name: "Unbekannt", value: "x" }, "no custom field of this account has that name"],
    [{ name: "PROJEKT", value: "x" }, "2 custom fields have that name (settings 19500, 19501)"],
    [{ settingId: 99, value: "x" }, "custom field 99 is not one of this account's custom fields"],
    [
      { settingId: 19498, name: "Branche", value: "x" },
      "give the field either by settingId or by name",
    ],
    [{ value: "x" }, "give the field either by settingId or by name"],
  ])("refuses %o without searching", async (customField, message) => {
    const client = new FakeSevdeskClient([settingsRoute, findRoute()]);
    await expect(
      tool.handler(tool.input.parse({ customField }), testContext(client)),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(message) as string,
    });
    expect(client.callsTo(FIND)).toEqual([]);
  });

  it("refuses a name when the account has more fields than could be read", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/ContactCustomFieldSetting",
        response: { body: { objects: [{ id: "1", name: "Kundennr extern" }], total: "1001" } },
      },
      findRoute(),
    ]);
    await expect(
      tool.handler(
        tool.input.parse({ customField: { name: "Kundennr extern", value: "x" } }),
        testContext(client),
      ),
    ).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("more custom fields than could be read") as string,
    });
  });

  it("checks the argument's shape", () => {
    const parse = (customField: unknown) => tool.input.safeParse({ customField }).success;
    expect(parse({ settingId: 19498, value: "" })).toBe(false);
    // No stored value is longer than sevDesk's 100 characters (D-086).
    expect(parse({ settingId: 19498, value: "x".repeat(101) })).toBe(false);
    expect(parse({ name: "x".repeat(31), value: "x" })).toBe(false);
    expect(parse({ settingId: 0, value: "x" })).toBe(false);
    expect(parse({ settingId: 19498, value: "x", other: 1 })).toBe(false);
    expect(parse({ settingId: 19498, value: "x".repeat(100) })).toBe(true);
  });
});
