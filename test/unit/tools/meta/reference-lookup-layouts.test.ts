/**
 * `sevdesk_reference_lookup` kinds `letterpapers`, `templates` and `text_templates` (#94): ids,
 * names and flags only, never a thumbnail, PDF or HTML (D-114); text templates read with one
 * request and an explicit limit (D-115).
 */
import { describe, expect, it } from "vitest";

import { referenceLookupTool as tool } from "../../../../src/tools/meta/reference-lookup.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import {
  letterpapersRoute,
  templatesRoute,
  textTemplatesRoute,
  THUMBNAIL,
} from "../../../helpers/layout-routes.js";

async function lookup(args: Record<string, unknown>, routes: readonly FakeRoute[]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  expect(tool.output.parse(result.data)).toEqual(result.data);
  return { client, result };
}

async function refusal(args: Record<string, unknown>): Promise<unknown> {
  const client = new FakeSevdeskClient([]);
  const error = await tool
    .handler(tool.input.parse(args), testContext(client))
    .catch((thrown: unknown) => thrown);
  expect(client.calls).toEqual([]);
  return error;
}

describe("sevdesk_reference_lookup: layouts and text templates", () => {
  it("lists the letterheads with id, name and flags", async () => {
    const { result } = await lookup({ kind: "letterpapers" }, [letterpapersRoute()]);

    expect(result.data).toEqual({
      kind: "letterpapers",
      source: "sevdesk",
      total: 2,
      returned: 2,
      truncated: false,
      hasMore: false,
      limit: null,
      letterpapers: [
        { id: "lp-1", name: "Briefpapier 1", default: true, custom: false, stock: true },
        { id: "lp-2", name: "Zweites Briefpapier", default: false, custom: true, stock: false },
      ],
    });
    expect(result.summary).toBe("2 of 2 letterpapers.");
    expect(JSON.stringify(result.data)).not.toContain(THUMBNAIL.slice(0, 40));
  });

  it("lists the templates of one document type and filters them by query", async () => {
    const { client, result } = await lookup(
      { kind: "templates", documentType: "credit_note", query: "mod" },
      [templatesRoute("Creditnote")],
    );

    expect(client.calls[0]?.query).toEqual({ type: "Creditnote" });
    expect(result.data).toMatchObject({ kind: "templates", total: 2, returned: 1 });
    expect(result.data["templates"]).toEqual([
      {
        id: "tpl-modern",
        name: "Modern",
        type: "Creditnote",
        default: false,
        custom: false,
        premium: true,
        stock: true,
      },
    ]);
    expect(JSON.stringify(result.data)).not.toMatch(/<html|iVBORw0KGgo|TEMPLATE_DYNAMIC/);
    expect(result.summary).toBe("1 of 2 templates matching the query.");
  });

  it("lists every text template, the text cut, with one request and an explicit limit", async () => {
    const { client, result } = await lookup({ kind: "text_templates" }, [textTemplatesRoute()]);

    expect(client.calls).toEqual([
      expect.objectContaining({
        path: "/TextTemplate",
        query: { limit: 1000, offset: 0, countAll: true },
      }),
    ]);
    expect(result.data).toMatchObject({ kind: "text_templates", total: 6, returned: 6 });
    expect((result.data["textTemplates"] as unknown[])[0]).toEqual({
      id: 9765942,
      name: "Standard",
      textType: "HEAD",
      documentType: "RE",
      category: "DOCUMENT",
      default: true,
      text: "Sehr geehrte Damen und Herren,\nwir berechnen Ihnen:",
    });
  });

  it.each([
    ["invoice", ["9765942", "9765943", "9765950"]],
    ["order", ["9765944", "9765945"]],
  ])("lists the text templates the %s drafts take", async (documentType, ids) => {
    const { result } = await lookup({ kind: "text_templates", documentType }, [
      textTemplatesRoute(),
    ]);
    expect((result.data["textTemplates"] as { id: number }[]).map((row) => String(row.id))).toEqual(
      ids,
    );
  });

  it.each([
    [{ kind: "templates" }, "kind=templates needs documentType (invoice, order or credit_note)."],
    [
      { kind: "text_templates", documentType: "credit_note" },
      "Text templates of credit notes are not offered: their type code in sevDesk is not known " +
        "yet. Leave documentType out to list every text template.",
    ],
    [
      { kind: "letterpapers", documentType: "invoice" },
      "documentType only applies to kind=templates and kind=text_templates; leave it out for " +
        "kind=letterpapers.",
    ],
    [
      { kind: "receipt_guidance", documentType: "invoice" },
      "documentType only applies to kind=templates and kind=text_templates.",
    ],
    [
      { kind: "templates", documentType: "invoice", limit: 5 },
      "limit only apply to kind=receipt_guidance; leave them out for kind=templates.",
    ],
  ])("refuses %j before any request", async (args, message) => {
    expect(await refusal(args)).toMatchObject({ kind: "validation", message });
  });
});
