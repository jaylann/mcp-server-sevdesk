/**
 * Text templates (`src/domain/text-templates.ts`): one read with an explicit limit, and the
 * refusals of a template chosen by name.
 */
import { describe, expect, it } from "vitest";

import {
  chooseTextTemplate,
  listTextTemplates,
  type TextTemplate,
} from "../../../src/domain/text-templates.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";
import { textTemplateRow, textTemplatesRoute } from "../../helpers/layout-routes.js";

function template(overrides: Partial<TextTemplate> = {}): TextTemplate {
  return {
    id: 1,
    name: "Standard",
    text: "Sehr geehrte Damen und Herren,",
    objectType: "RE",
    textType: "HEAD",
    category: "DOCUMENT",
    isDefault: true,
    ...overrides,
  };
}

describe("listTextTemplates", () => {
  it("reads every text template with one request and an explicit limit", async () => {
    const fake = new FakeSevdeskClient([textTemplatesRoute()]);

    const list = await listTextTemplates(fake);

    expect(fake.calls).toEqual([
      expect.objectContaining({
        operation: "list",
        path: "/TextTemplate",
        query: { limit: 1000, offset: 0, countAll: true },
      }),
    ]);
    expect(list.total).toBe(6);
    expect(list.truncated).toBe(false);
    expect(list.items[0]).toEqual({
      id: 9765942,
      name: "Standard",
      text: "Sehr geehrte Damen und Herren,\nwir berechnen Ihnen:",
      objectType: "RE",
      textType: "HEAD",
      category: "DOCUMENT",
      isDefault: true,
    });
    expect(list.items.map((item) => item.isDefault)).toContain(false);
  });

  it("says when sevDesk reports more rows than it sent", async () => {
    const fake = new FakeSevdeskClient([
      { path: "/TextTemplate", response: { body: { objects: [textTemplateRow()], total: 3 } } },
    ]);
    expect(await listTextTemplates(fake)).toMatchObject({ total: 3, truncated: true });
  });
});

describe("chooseTextTemplate", () => {
  const templates = [
    template(),
    template({ id: 2, textType: "FOOT", text: "Zahlbar in 14 Tagen." }),
    template({ id: 3, objectType: "AN", text: "Wir bieten an:" }),
    template({ id: 4, name: "English", textType: "FOOT", text: "Payable\r\nwithin 14 days." }),
  ];

  it("finds the template of the place and type by name, in any case", () => {
    expect(chooseTextTemplate(templates, "head", "RE", " standard ")).toEqual({
      place: "head",
      templateId: 1,
      name: "Standard",
      text: "Sehr geehrte Damen und Herren,",
    });
    expect(chooseTextTemplate(templates, "head", "AN", "Standard").templateId).toBe(3);
    expect(chooseTextTemplate(templates, "foot", "RE", "Standard").templateId).toBe(2);
  });

  it("turns Windows line ends into plain ones", () => {
    expect(chooseTextTemplate(templates, "foot", "RE", "English").text).toBe(
      "Payable\nwithin 14 days.",
    );
  });

  it.each([
    ["an unknown name", templates, "Gibt es nicht", "No text template for the head text"],
    ["a name of another type", templates, "English", "No text template for the head text"],
    [
      "a name used twice",
      [template(), template({ id: 9 })],
      "Standard",
      "2 text templates for the head text (Kopftext) of this document type (RE) have this name",
    ],
    ["a template without text", [template({ text: "  " })], "Standard", "has no text"],
    [
      "a text too long for a draft",
      [template({ text: "x".repeat(10_001) })],
      "Standard",
      "longer than 10000 characters",
    ],
    [
      "a text with invisible characters",
      [template({ text: "Bitte an IBAN​ DE00 überweisen" })],
      "Standard",
      "contains characters a human would not see",
    ],
  ])("refuses %s", (_label, list, name, message) => {
    expect(() => chooseTextTemplate(list, "head", "RE", name)).toThrow(message);
  });
});
