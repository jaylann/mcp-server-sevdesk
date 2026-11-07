/**
 * MCP resources over a real in-process client: the `sevdesk://` document file templates and the
 * static reference resources, per toolset configuration and protocol era.
 */
import { Buffer } from "node:buffer";

import type { Client } from "@modelcontextprotocol/client";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../src/config.js";
import { STATUS_CODES, TAX_RULES } from "../../src/domain/reference-data.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import type { ToolsetName } from "../../src/tools/toolsets.js";
import { testConfig } from "../helpers/config.js";
import { connectInProcess, type ConnectOptions } from "../helpers/connect.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";

function content(fixture: string): string {
  return (loadFixture(fixture).body as { objects: { content: string } }).objects.content;
}

const ROUTES: FakeRoute[] = [
  {
    path: "/Invoice/12/getPdf",
    query: { preventSendBy: true },
    response: { fixture: "documents/invoice-pdf.json" },
  },
  {
    path: "/CreditNote/12/getPdf",
    query: { preventSendBy: true },
    response: { fixture: "documents/credit-note-pdf.json" },
  },
  {
    path: "/Order/12/getPdf",
    query: { preventSendBy: true },
    response: { fixture: "documents/order-pdf.json" },
  },
  { path: "/Invoice/12/getXml", response: { fixture: "documents/invoice-xml.json" } },
  { path: "/Invoice/13/getXml", response: { body: { objects: "" } } },
  {
    path: "/Invoice/404/getPdf",
    response: {
      error: new SevdeskError({
        kind: "not_found",
        message: "sevDesk found no invoice.",
        status: 404,
      }),
    },
  },
  { path: "/Invoice/15/getPdf", response: { body: { objects: { pdf: "JVBERi0=" } } } },
  {
    path: "/Invoice/16/getPdf",
    response: {
      error: new SevdeskError({
        kind: "auth",
        message: "sevDesk rejected the API token (HTTP 401).",
        status: 401,
      }),
    },
  },
];

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function setup(overrides: Partial<Config> = {}, options: ConnectOptions = {}) {
  const fake = new FakeSevdeskClient(ROUTES);
  const client = await connectInProcess({ config: testConfig(overrides), client: fake }, options);
  clients.push(client);
  return { client, fake };
}

async function readError(client: Client, uri: string): Promise<ProtocolError> {
  const error: unknown = await client.readResource({ uri }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(ProtocolError.isInstance(error)).toBe(true);
  return error as ProtocolError;
}

describe("resources capability", () => {
  it("is declared without list_changed", async () => {
    const { client } = await setup();
    expect(client.getServerCapabilities()?.resources).toEqual({ listChanged: false });
  });
});

describe("resources/templates/list", () => {
  it("lists the four document file templates with their media types", async () => {
    const { client } = await setup();

    const { resourceTemplates } = await client.listResourceTemplates();

    expect(
      resourceTemplates.map(({ name, uriTemplate, mimeType }) => ({ name, uriTemplate, mimeType })),
    ).toEqual([
      {
        name: "invoice-pdf",
        uriTemplate: "sevdesk://invoices/{id}/pdf",
        mimeType: "application/pdf",
      },
      {
        name: "credit-note-pdf",
        uriTemplate: "sevdesk://credit-notes/{id}/pdf",
        mimeType: "application/pdf",
      },
      { name: "order-pdf", uriTemplate: "sevdesk://orders/{id}/pdf", mimeType: "application/pdf" },
      {
        name: "invoice-xml",
        uriTemplate: "sevdesk://invoices/{id}/xml",
        mimeType: "application/xml",
      },
    ]);
    for (const template of resourceTemplates) {
      expect(template.title).toBeTruthy();
      expect(template.description).toBeTruthy();
    }
  });

  it.each([
    [["meta"], []],
    [
      ["meta", "invoices"],
      ["invoice-pdf", "invoice-xml"],
    ],
    [
      ["meta", "credit-notes", "orders"],
      ["credit-note-pdf", "order-pdf"],
    ],
  ] as const)("toolsets %j → %j", async (toolsets, expected) => {
    const { client } = await setup({ toolsets: new Set<ToolsetName>(toolsets) });
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.name)).toEqual(expected);
  });
});

describe("resources/list", () => {
  it("lists only the reference resources: documents are not enumerated", async () => {
    const { client, fake } = await setup();

    const { resources } = await client.listResources();

    expect(resources.map(({ uri, name, mimeType }) => ({ uri, name, mimeType }))).toEqual([
      {
        uri: "sevdesk://reference/tax-rules",
        name: "reference-tax-rules",
        mimeType: "application/json",
      },
      {
        uri: "sevdesk://reference/status-codes",
        name: "reference-status-codes",
        mimeType: "application/json",
      },
    ]);
    expect(fake.calls).toEqual([]);
  });
});

describe("resources/read: document files", () => {
  it.each([
    ["sevdesk://invoices/12/pdf", "/Invoice/12/getPdf", "documents/invoice-pdf.json"],
    ["sevdesk://credit-notes/12/pdf", "/CreditNote/12/getPdf", "documents/credit-note-pdf.json"],
    ["sevdesk://orders/12/pdf", "/Order/12/getPdf", "documents/order-pdf.json"],
  ])("%s → PDF blob, fetched with preventSendBy", async (uri, path, fixture) => {
    const { client, fake } = await setup();

    const result = await client.readResource({ uri });

    expect(result.contents).toEqual([{ uri, mimeType: "application/pdf", blob: content(fixture) }]);
    expect(fake.calls.map((call) => [call.path, call.query])).toEqual([
      [path, { preventSendBy: true }],
    ]);
  });

  it("serves the e-invoice XML as an application/xml blob", async () => {
    const { client } = await setup();
    const xml = (loadFixture("documents/invoice-xml.json").body as { objects: string }).objects;

    const result = await client.readResource({ uri: "sevdesk://invoices/12/xml" });

    expect(result.contents).toEqual([
      {
        uri: "sevdesk://invoices/12/xml",
        mimeType: "application/xml",
        blob: Buffer.from(xml, "utf8").toString("base64"),
      },
    ]);
  });

  it("works for legacy (2025-era) clients too", async () => {
    const { client } = await setup({}, { era: "legacy" });
    const result = await client.readResource({ uri: "sevdesk://invoices/12/pdf" });
    expect(result.contents[0]).toMatchObject({ mimeType: "application/pdf" });
  });

  it("is not cached: every read goes to sevDesk", async () => {
    const { client, fake } = await setup();
    await client.readResource({ uri: "sevdesk://invoices/12/pdf" });
    await client.readResource({ uri: "sevdesk://invoices/12/pdf" });
    expect(fake.calls).toHaveLength(2);
  });

  it.each([
    "sevdesk://invoices/abc/pdf",
    "sevdesk://invoices/0/pdf",
    "sevdesk://invoices/012/pdf",
    "sevdesk://invoices/99999999999999999/pdf",
    "sevdesk://invoices/1%2F2/pdf",
  ])("refuses the invalid id in %s without calling sevDesk", async (uri) => {
    const { client, fake } = await setup();

    const error = await readError(client, uri);

    expect(error.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(error.message).toContain("must be a positive whole number");
    expect(fake.calls).toEqual([]);
  });

  it("reports a missing document as resource not found", async () => {
    const { client } = await setup();
    const error = await readError(client, "sevdesk://invoices/404/pdf");
    expect(error.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(error.data).toEqual({ uri: "sevdesk://invoices/404/pdf" });
    expect(error.message).toContain("sevDesk found no invoice.");
  });

  it("reports an invoice without e-invoice XML as resource not found", async () => {
    const { client } = await setup();
    const error = await readError(client, "sevdesk://invoices/13/xml");
    expect(error.data).toEqual({ uri: "sevdesk://invoices/13/xml" });
    expect(error.message).toContain("no e-invoice XML for invoice 13");
  });

  it("reports an unexpected body as an internal error and logs it", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = await setup();

    const error = await readError(client, "sevdesk://invoices/15/pdf");

    expect(error.code).toBe(ProtocolErrorCode.InternalError);
    expect(error.message).toContain("unexpected format");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("resource invoice_pdf 15"));
  });

  it("passes the trusted message of other sevDesk errors on", async () => {
    const { client } = await setup();
    const error = await readError(client, "sevdesk://invoices/16/pdf");
    expect(error.code).toBe(ProtocolErrorCode.InternalError);
    expect(error.message).toContain("sevDesk rejected the API token (HTTP 401).");
  });

  it("does not serve templates of disabled toolsets", async () => {
    const { client, fake } = await setup({ toolsets: new Set<ToolsetName>(["meta", "orders"]) });

    const error = await readError(client, "sevdesk://invoices/12/pdf");

    expect(error.data).toEqual({ uri: "sevdesk://invoices/12/pdf" });
    expect(fake.calls).toEqual([]);
    await expect(client.readResource({ uri: "sevdesk://orders/12/pdf" })).resolves.toBeDefined();
  });

  it("does not match other URI shapes", async () => {
    const { client } = await setup();
    for (const uri of [
      "sevdesk://invoices/12/pdf?download=1",
      "sevdesk://invoices/12/pdf/extra",
      "sevdesk://vouchers/12/pdf",
    ]) {
      const error = await readError(client, uri);
      expect(error.data).toEqual({ uri });
    }
  });
});

describe("resources/read: reference data", () => {
  it("serves the tax rules as JSON", async () => {
    const { client } = await setup();

    const result = await client.readResource({ uri: "sevdesk://reference/tax-rules" });

    expect(result.contents).toHaveLength(1);
    const [entry] = result.contents;
    expect(entry).toMatchObject({
      uri: "sevdesk://reference/tax-rules",
      mimeType: "application/json",
    });
    const text = entry !== undefined && "text" in entry ? entry.text : "";
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify({ taxRules: TAX_RULES })));
  });

  it("serves the status codes as JSON", async () => {
    const { client } = await setup({}, { era: "legacy" });

    const result = await client.readResource({ uri: "sevdesk://reference/status-codes" });

    const [entry] = result.contents;
    const text = entry !== undefined && "text" in entry ? entry.text : "";
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify({ statusCodes: STATUS_CODES })));
  });

  it("are not exposed without the meta toolset", async () => {
    const config = testConfig({ toolsets: new Set<ToolsetName>(["invoices"]) });
    const fake = new FakeSevdeskClient([]);
    const client = await connectInProcess({ config, client: fake });
    clients.push(client);

    const { resources } = await client.listResources();

    expect(resources).toEqual([]);
  });
});
