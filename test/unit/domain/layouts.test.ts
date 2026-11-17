/**
 * The layout domain (`src/domain/layouts.ts`): the DocServer lists without their binary fields,
 * the parameters of a layout answer, and the language rules of D-140.
 */
import { describe, expect, it } from "vitest";

import {
  currentChoiceName,
  currentLanguage,
  languageChoice,
  languageOfTranslationCode,
  LANGUAGES,
  LAYOUT_LIST_MAX_BYTES,
  layoutValues,
  listLetterpapers,
  listTemplates,
  offeredLanguages,
  parseLayoutAnswer,
  readDocumentLayout,
  resolveLayoutOption,
} from "../../../src/domain/layouts.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";
import {
  letterpapersRoute,
  templateRow,
  templatesRoute,
  THUMBNAIL,
} from "../../helpers/layout-routes.js";
import { layoutObjects, renderRoute } from "../tools/lifecycle/helpers.js";

describe("languages", () => {
  it("offers the eight sevDesk lists, in the locale form", () => {
    expect(LANGUAGES).toEqual([
      "de_DE",
      "de_AT",
      "de_CH",
      "en_US",
      "es_ES",
      "fr_FR",
      "it_IT",
      "el_GR",
    ]);
  });

  it.each([
    ["SEVDOC_LANG_EN_US", "en_US"],
    ["SEVDOC_LANG_EL_GR", "el_GR"],
    ["SEVDOC_LANG_NL_NL", undefined],
    ["SEVDOC_LANG_en_us", undefined],
    ["LANG_EN_US", undefined],
    [undefined, undefined],
  ])("reads the translation code %s as %s", (code, expected) => {
    expect(languageOfTranslationCode(code)).toBe(expected);
  });

  it("reads an invoice's stored en and an order's en_US as the same language", () => {
    const invoice = parseLayoutAnswer(layoutObjects({ language: "en" }), "x");
    const order = parseLayoutAnswer(layoutObjects({ language: "en_US" }, "order"), "x");
    expect(currentLanguage(invoice.language)).toBe("en_US");
    expect(currentLanguage(order.language)).toBe("en_US");
    expect(languageChoice(invoice.language, "de_DE")?.value).toBe("de");
    expect(languageChoice(order.language, "de_DE")?.value).toBe("de_DE");
    expect(offeredLanguages(invoice.language)).toEqual([...LANGUAGES]);
  });

  it("knows no language for a value no choice lists", () => {
    const layout = parseLayoutAnswer(layoutObjects({ language: "xx_XX" }), "x");
    expect(currentLanguage(layout.language)).toBeUndefined();
  });
});

describe("parseLayoutAnswer", () => {
  it("reads render's top-level parameters and changeParameter's metaData alike", () => {
    const objects = layoutObjects({ template: "tpl-modern" });
    const fromRender = parseLayoutAnswer(objects, "x");
    const fromChange = parseLayoutAnswer({ result: 1, metaData: objects }, "x");
    expect(fromChange).toEqual(fromRender);
    expect(fromRender.template?.value).toBe("tpl-modern");
    expect(currentChoiceName(fromRender.template)).toBe("Modern");
    expect(Object.keys(fromRender).sort()).toEqual(["language", "letterpaper", "template"]);
  });

  it("treats an empty letterhead as none chosen, and binds it as null", () => {
    const layout = parseLayoutAnswer(layoutObjects({}, "order"), "x");
    expect(layout.letterpaper?.value).toBeUndefined();
    expect(layout.letterpaper?.choices).toHaveLength(2);
    expect(currentChoiceName(layout.letterpaper)).toBeUndefined();
    expect(layoutValues(layout)).toEqual({
      language: "de_DE",
      template: "tpl-standard",
      letterpaper: null,
    });
  });

  it("ignores the other print options, whatever their values", () => {
    const layout = parseLayoutAnswer(
      {
        parameters: [
          { key: "payPal", value: true, values: [{ value: { odd: 1 } }] },
          { key: "logoSize", value: 3, values: null },
          "not an object",
          { key: "language", value: "de", values: [] },
        ],
      },
      "x",
    );
    expect(layout).toEqual({ language: { value: "de", choices: [] } });
  });

  it.each([
    ["no parameters", { docId: "d", pdf: "JVBERi0=" }],
    ["a list", [{ parameters: [] }]],
    ["nothing", undefined],
  ])("refuses an answer with %s", (_label, objects) => {
    expect(() => parseLayoutAnswer(objects, "the layout of invoice 1")).toThrow(
      "sevDesk returned the layout of invoice 1 without its print options (parameters).",
    );
  });

  it("refuses a listed option of ours that does not fit", () => {
    expect(() =>
      parseLayoutAnswer({ parameters: [{ key: "template", values: [17] }] }, "the layout"),
    ).toThrow(SevdeskError);
  });
});

describe("readDocumentLayout", () => {
  it.each([
    ["invoice", "/Invoice/1001/render", 1001],
    ["order", "/Order/3002/render", 3002],
    ["creditNote", "/CreditNote/2001/render", 2001],
  ] as const)("reads a %s's layout with render without reload", async (kind, path, id) => {
    const fake = new FakeSevdeskClient([
      renderRoute(kind === "invoice" ? "invoice" : "order", { template: "tpl-modern" }),
    ]);
    const layout = await readDocumentLayout(fake, kind, id);
    expect(fake.calls).toEqual([
      expect.objectContaining({ method: "POST", path, body: { forceReload: false } }),
    ]);
    expect(fake.writes()).toEqual([]);
    expect(layout.template?.value).toBe("tpl-modern");
  });
});

describe("the DocServer lists", () => {
  it("reads letterheads as id, name and flags, without the PDF or the thumbnail", async () => {
    const fake = new FakeSevdeskClient([letterpapersRoute()]);

    const letterpapers = await listLetterpapers(fake);

    expect(letterpapers).toEqual([
      {
        id: "lp-1",
        name: "Briefpapier 1",
        isDefault: true,
        custom: false,
        stock: true,
        type: undefined,
        premium: undefined,
      },
      {
        id: "lp-2",
        name: "Zweites Briefpapier",
        isDefault: false,
        custom: true,
        stock: false,
        type: undefined,
        premium: undefined,
      },
    ]);
    expect(JSON.stringify(letterpapers)).not.toContain(THUMBNAIL.slice(0, 40));
    // A capped download, never a plain request (whose body has no cap).
    expect(fake.calls).toEqual([
      expect.objectContaining({
        operation: "download",
        path: "/DocServer/getLetterpapersWithThumb",
      }),
    ]);
    // No `limit` on purpose: the recorded call sent none and got every row (D-114).
    expect(fake.calls[0]?.query ?? {}).toEqual({});
  });

  it.each([
    ["invoice", "Invoice"],
    ["order", "Order"],
    ["creditNote", "Creditnote"],
  ] as const)(
    "reads the %s templates with type %s and keeps that type only",
    async (kind, type) => {
      const fake = new FakeSevdeskClient([
        templatesRoute(type, [
          templateRow(type),
          templateRow("Invoice", { id: "other", name: "Andere" }),
          templateRow(type, { id: "untyped", type: null }),
        ]),
      ]);

      const templates = await listTemplates(fake, kind);

      // The type only, no `limit` (D-114: the recorded call without one got all 147 rows).
      expect(fake.calls[0]?.query).toEqual({ type });
      expect(templates.map((template) => template.id)).toEqual(
        type === "Invoice" ? ["tpl-standard", "other", "untyped"] : ["tpl-standard", "untyped"],
      );
      expect(JSON.stringify(templates)).not.toMatch(/<html|iVBORw0KGgo/);
    },
  );

  it("reads `default` as a boolean or a number, as recorded (D-114)", async () => {
    const fake = new FakeSevdeskClient([
      templatesRoute("Order", [
        templateRow("Order", { default: 1 }),
        templateRow("Order", { id: "b", default: false }),
        templateRow("Order", { id: "c", default: "0" }),
      ]),
    ]);
    const templates = await listTemplates(fake, "order");
    expect(templates.map((template) => template.isDefault)).toEqual([true, false, false]);
  });

  it("refuses a list larger than the cap without reading it, as an expected limit", async () => {
    const fake = new FakeSevdeskClient([
      {
        path: "/DocServer/getLetterpapersWithThumb",
        response: {
          error: new SevdeskError({ kind: "unexpected_response", status: 200, message: "big" }),
        },
      },
    ]);
    await expect(listLetterpapers(fake)).rejects.toMatchObject({
      kind: "unexpected_response",
      expectedLimit: true,
      message: "sevDesk's list of the letterheads is larger than 16 MiB, so it was not read.",
    });
    expect(LAYOUT_LIST_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it.each([
    ["not JSON", new TextEncoder().encode("<html>")],
    ["no list", new TextEncoder().encode(JSON.stringify({ objects: { result: 1 } }))],
    ["the spec's top-level form", new TextEncoder().encode(JSON.stringify({ letterpapers: [] }))],
  ])("refuses an answer that is %s", async (_label, bytes) => {
    const fake = new FakeSevdeskClient([
      { path: "/DocServer/getLetterpapersWithThumb", response: { bytes } },
    ]);
    await expect(listLetterpapers(fake)).rejects.toMatchObject({ kind: "unexpected_response" });
  });
});

describe("resolveLayoutOption", () => {
  const options = [
    {
      id: "a",
      name: "Standard",
      isDefault: true,
      custom: false,
      stock: true,
      type: undefined,
      premium: undefined,
    },
    {
      id: "b",
      name: "Modern",
      isDefault: false,
      custom: false,
      stock: true,
      type: undefined,
      premium: undefined,
    },
  ];
  const what = { noun: "template", lookup: "kind=templates" };

  it("finds an option by its id first, then by its name in any case", () => {
    expect(resolveLayoutOption(options, "b", what).id).toBe("b");
    expect(resolveLayoutOption(options, "  modern ", what).id).toBe("b");
  });

  it("refuses an unknown or ambiguous name with a trusted sentence", () => {
    expect(() => resolveLayoutOption(options, "Klassisch", what)).toThrow(
      "sevDesk offers no template with this id or name for this document; " +
        "sevdesk_reference_lookup kind=templates lists the ones it offers. Nothing was changed.",
    );
    expect(() =>
      resolveLayoutOption(
        [...options, { ...options[1], id: "c" } as (typeof options)[number]],
        "Modern",
        what,
      ),
    ).toThrow("2 templates have this name");
  });
});
