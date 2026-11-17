/**
 * `headTextTemplate` and `footTextTemplate` on the invoice and order draft tools (#94): the
 * template's text goes into `headText` / `footText` as stored, the preview shows it fenced, and
 * a name that does not resolve, or a text given beside a template, is refused before any write.
 * Invoices resolve against `RE`, orders against `AN` (D-115).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceCreateDraftTool } from "../../../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../../../src/tools/invoices/draft-update.js";
import { orderCreateDraftTool } from "../../../../src/tools/orders/draft-create.js";
import { orderUpdateDraftTool } from "../../../../src/tools/orders/draft-update.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { textTemplateRow, textTemplatesRoute } from "../../../helpers/layout-routes.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  orderCreateArgs,
  orderCreateRoutes,
  orderUpdateRoutes,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

type Row = Record<string, unknown>;

function savedBody(client: FakeSevdeskClient): Row {
  const write = client.writes().find((call) => call.method === "POST");
  return write?.body as Row;
}

describe("text templates on the invoice draft tools", () => {
  it("create: copies the RE head and foot texts and shows them fenced in the preview", async () => {
    const client = new FakeSevdeskClient(withRoutes(invoiceCreateRoutes, textTemplatesRoute()));

    const { plan } = await executeWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, headTextTemplate: "standard", footTextTemplate: "English" },
      client,
    );

    expect(savedBody(client)["invoice"]).toMatchObject({
      headText: "Sehr geehrte Damen und Herren,\nwir berechnen Ihnen:",
      footText: "Please transfer the amount within 14 days.",
    });
    expect(client.callsTo("/TextTemplate")).toHaveLength(1);
    expect(plan.preview.facts).toContainEqual({
      label: "Head text from a template",
      value:
        "template `Standard` (id 9765942): `Sehr geehrte Damen und Herren, wir berechnen Ihnen:`",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Foot text from a template",
      value: "template `English` (id 9765950): `Please transfer the amount within 14 days.`",
    });
  });

  it("create: reads no text templates when none is named", async () => {
    const client = new FakeSevdeskClient(invoiceCreateRoutes);
    await prepareWrite(invoiceCreateDraftTool, invoiceCreateArgs, client);
    expect(client.callsTo("/TextTemplate")).toEqual([]);
  });

  it("update: replaces the foot text with the template's and logs the change", async () => {
    const client = new FakeSevdeskClient(withRoutes(invoiceUpdateRoutes, textTemplatesRoute()));

    const { plan } = await executeWrite(
      invoiceUpdateDraftTool,
      { id: 2102, footTextTemplate: "Standard" },
      client,
    );

    expect(savedBody(client)["invoice"]).toMatchObject({
      footText: "Bitte überweisen Sie den Betrag innerhalb von 14 Tagen.",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Closing text", value: "replaced" });
    expect(plan.preview.facts).toContainEqual({
      label: "Foot text from a template",
      value:
        "template `Standard` (id 9765943): `Bitte überweisen Sie den Betrag innerhalb von 14 Tagen.`",
    });
  });

  it.each([
    [
      "a text and a template for the same place",
      { headText: "Hallo", headTextTemplate: "Standard" },
      "Give headText or headTextTemplate, not both.",
    ],
    [
      "an unknown name",
      { footTextTemplate: "Gibt es nicht" },
      "No text template for the foot text (Fußtext) of this document type (RE) has this name",
    ],
    [
      "an order's template on an invoice",
      { headTextTemplate: "Angebot" },
      "No text template for the head text (Kopftext) of this document type (RE) has this name",
    ],
  ])("refuses %s before any write", async (_label, args, message) => {
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceCreateRoutes,
        textTemplatesRoute([
          textTemplateRow(),
          textTemplateRow({ id: "7", name: "Angebot", objectType: "AN" }),
        ]),
      ),
    );

    const error = await prepareWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, ...args },
      client,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain(message);
    expect(client.writes()).toEqual([]);
  });
});

describe("text templates on the order draft tools", () => {
  it("create: resolves an offer's head text against AN", async () => {
    const client = new FakeSevdeskClient(withRoutes(orderCreateRoutes, textTemplatesRoute()));

    await executeWrite(
      orderCreateDraftTool,
      { ...orderCreateArgs, headTextTemplate: "Standard", footTextTemplate: "Standard" },
      client,
    );

    expect(savedBody(client)["order"]).toMatchObject({
      headText: "Wir bieten Ihnen an:",
      footText: "Das Angebot gilt 30 Tage.",
    });
  });

  it("create: an order confirmation takes the AN texts too (no AB rows exist)", async () => {
    const client = new FakeSevdeskClient(withRoutes(orderCreateRoutes, textTemplatesRoute()));

    const plan = await prepareWrite(
      orderCreateDraftTool,
      { ...orderCreateArgs, type: "order_confirmation", headTextTemplate: "Standard" },
      client,
    );

    expect(plan.preview.facts).toContainEqual({
      label: "Head text from a template",
      value: "template `Standard` (id 9765944): `Wir bieten Ihnen an:`",
    });
    expect(plan.state.body.order).toMatchObject({
      orderType: "AB",
      headText: "Wir bieten Ihnen an:",
    });
  });

  it("update: replaces the head text of a draft order", async () => {
    const client = new FakeSevdeskClient(withRoutes(orderUpdateRoutes, textTemplatesRoute()));

    await executeWrite(orderUpdateDraftTool, { id: 3102, headTextTemplate: "Standard" }, client);

    expect(savedBody(client)["order"]).toMatchObject({ headText: "Wir bieten Ihnen an:" });
  });

  it("refuses an ambiguous name", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        orderUpdateRoutes,
        textTemplatesRoute([
          textTemplateRow({ objectType: "AN" }),
          textTemplateRow({ id: "8", objectType: "AN", name: "STANDARD" }),
        ]),
      ),
    );
    await expect(
      prepareWrite(orderUpdateDraftTool, { id: 3102, headTextTemplate: "Standard" }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "2 text templates for the head text (Kopftext) of this document type (AN) have this " +
        "name. Rename one in sevDesk, or pass the text itself.",
    });
  });
});

describe("the argument", () => {
  it("is offered by the invoice and order draft tools, not the credit note ones", () => {
    for (const tool of [
      invoiceCreateDraftTool,
      invoiceUpdateDraftTool,
      orderCreateDraftTool,
      orderUpdateDraftTool,
    ]) {
      expect(Object.keys(tool.input.shape)).toEqual(
        expect.arrayContaining(["headTextTemplate", "footTextTemplate"]),
      );
      expect(tool.input.safeParse({ headTextTemplate: "" }).success).toBe(false);
    }
  });
});
