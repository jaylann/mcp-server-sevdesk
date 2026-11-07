import { describe, expect, it } from "vitest";

import {
  creditNotePdfTool,
  invoicePdfTool,
  invoiceXmlTool,
  orderPdfTool,
} from "../../../../src/tools/documents/file-tools.js";
import { dataOf, PDF_BASE64, PDF_BYTES, textOf, useHarness } from "./support.js";

const harness = useHarness();
const READ_TOOLS = [invoicePdfTool, creditNotePdfTool, orderPdfTool, invoiceXmlTool];

describe("document file read tools", () => {
  it("are truly read-only, idempotent tools of their document type's toolset", () => {
    expect(
      READ_TOOLS.map((tool) => [
        tool.name,
        tool.toolset,
        tool.tier,
        tool.localEffects,
        tool.annotations,
      ]),
    ).toEqual(
      [
        ["sevdesk_invoice_pdf", "invoices"],
        ["sevdesk_credit_note_pdf", "credit-notes"],
        ["sevdesk_order_pdf", "orders"],
        ["sevdesk_invoice_xml", "invoices"],
      ].map(([name, toolset]) => [
        name,
        toolset,
        "read",
        undefined,
        { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      ]),
    );
  });

  it("take only an id: saving to disk is sevdesk_document_save", () => {
    for (const tool of READ_TOOLS) {
      expect(Object.keys(tool.input.shape)).toEqual(["id"]);
      expect(Object.keys(tool.output.shape)).toEqual(["uri", "filename", "mimeType", "bytes"]);
      expect(tool.description).toContain("sevdesk_document_save");
    }
  });

  it("say in the description that previewing never marks the document as sent", () => {
    for (const tool of READ_TOOLS) {
      expect(tool.description).toMatch(
        /never marks the (invoice|credit note|order) as sent|the invoice is never marked as sent/,
      );
      expect(tool.description.length).toBeLessThanOrEqual(700);
    }
  });

  it("are listed only with their toolset", async () => {
    const { client } = await harness.setup({ toolsets: new Set(["meta", "orders"]) });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["sevdesk_order_pdf"]);
  });

  it("reject the former saveToDisk argument without sending anything", async () => {
    const { client, fake } = await harness.setup({ outputDir: await harness.tempDir() });

    const result = await client.callTool({
      name: "sevdesk_invoice_pdf",
      arguments: { id: 12, saveToDisk: true },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Unknown argument: `saveToDisk`");
    expect(fake.calls).toEqual([]);
  });
});

describe("sevdesk_invoice_pdf", () => {
  it("returns metadata plus a resource_link, never the file content", async () => {
    const { client, fake } = await harness.setup();

    const result = await client.callTool({ name: "sevdesk_invoice_pdf", arguments: { id: 12 } });

    expect(result.isError).toBeFalsy();
    const data = {
      uri: "sevdesk://invoices/12/pdf",
      filename: "RE-1001.pdf",
      mimeType: "application/pdf",
      bytes: PDF_BYTES.byteLength,
    };
    expect(result.content).toEqual([
      {
        type: "text",
        text:
          `Invoice 12: PDF file with ${PDF_BYTES.byteLength} bytes, available as resource ` +
          `sevdesk://invoices/12/pdf (fetched as a preview: not marked as sent).\n\n` +
          JSON.stringify(data, null, 2),
      },
      {
        type: "resource_link",
        uri: "sevdesk://invoices/12/pdf",
        name: "RE-1001.pdf",
        title: "Invoice 12 (PDF)",
        description: "PDF of invoice 12 from sevDesk.",
        mimeType: "application/pdf",
        size: PDF_BYTES.byteLength,
      },
    ]);
    expect(result.structuredContent).toEqual(data);
    const everything = JSON.stringify(result);
    expect(everything).not.toContain(PDF_BASE64.slice(0, 16));
    expect(everything).not.toContain("JVBERi0");
    expect(fake.calls).toEqual([
      {
        operation: "request",
        method: "GET",
        path: "/Invoice/12/getPdf",
        query: { preventSendBy: true },
        sideEffect: false,
      },
    ]);
  });

  it("maps a missing invoice to an actionable tool error", async () => {
    const { client } = await harness.setup();
    const result = await client.callTool({ name: "sevdesk_invoice_pdf", arguments: { id: 404 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("sevDesk has no such record (HTTP 404)");
  });

  it("rejects invalid ids before sending anything", async () => {
    const { client, fake } = await harness.setup();
    for (const id of [0, -1, 1.5, "12"]) {
      const result = await client.callTool({ name: "sevdesk_invoice_pdf", arguments: { id } });
      expect(result.isError).toBe(true);
    }
    expect(fake.calls).toEqual([]);
  });
});

describe.each([
  [
    "sevdesk_credit_note_pdf",
    "/CreditNote/12/getPdf",
    "sevdesk://credit-notes/12/pdf",
    "GU-1001.pdf",
    "Credit note 12",
  ],
  ["sevdesk_order_pdf", "/Order/12/getPdf", "sevdesk://orders/12/pdf", "AN-1001.pdf", "Order 12"],
] as const)("%s", (name, path, uri, filename, label) => {
  it("fetches with preventSendBy and links the resource", async () => {
    const { client, fake } = await harness.setup();

    const result = await client.callTool({ name, arguments: { id: 12 } });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(new RegExp(`^${label}: PDF file`));
    expect(dataOf(result)).toMatchObject({ uri, filename, mimeType: "application/pdf" });
    expect(result.content[1]).toMatchObject({ type: "resource_link", uri, name: filename });
    expect(fake.calls.map((call) => [call.path, call.query])).toEqual([
      [path, { preventSendBy: true }],
    ]);
  });
});

describe("sevdesk_invoice_xml", () => {
  it("links the XML resource and keeps the XML out of the text", async () => {
    const { client, fake } = await harness.setup();

    const result = await client.callTool({ name: "sevdesk_invoice_xml", arguments: { id: 12 } });

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      uri: "sevdesk://invoices/12/xml",
      filename: "invoice-12.xml",
      mimeType: "application/xml",
    });
    expect(result.content[1]).toMatchObject({
      type: "resource_link",
      uri: "sevdesk://invoices/12/xml",
      mimeType: "application/xml",
      title: "Invoice 12 (XML)",
    });
    expect(JSON.stringify(result)).not.toContain("Musterfirma");
    expect(fake.calls.map((call) => call.path)).toEqual(["/Invoice/12/getXml"]);
  });

  it("says clearly when an invoice is not an e-invoice", async () => {
    const { client } = await harness.setup();

    const result = await client.callTool({ name: "sevdesk_invoice_xml", arguments: { id: 13 } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("sevDesk has no e-invoice XML for invoice 13");
    expect(textOf(result)).toContain("E-Rechnung");
  });
});
