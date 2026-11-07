/**
 * B1: `getPdf` without `preventSendBy` marks an invoice or credit note as sent and commits an
 * order (spec: "Retrieves the pdf document of an order … and commit the order"; D-023).
 *
 * Other sevDesk MCP servers exposed `getPdf` as a harmless "download PDF" read, so merely looking
 * at an invoice changed its status, and order PDFs were frozen. This server fetches every PDF as
 * a preview: the domain passes `preventSendBy` explicitly, the client forces it as well, and the
 * PDF tools and `sevdesk://…/pdf` resources only ever reach sevDesk through that path. These
 * tests drive the real client (with a scripted `fetch`) through every layer, in read-only mode,
 * and check the URL that would have gone out.
 */
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  type DocumentFileKind,
  documentFileUri,
  fetchDocumentFile,
} from "../../src/domain/document-files.js";
import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { testConfig } from "../helpers/config.js";
import { connectInProcess } from "../helpers/connect.js";
import { FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";
import { createFakeClock, createFakeFetch, envelope } from "../helpers/fake-fetch.js";

const READ_ONLY = testConfig({ readOnly: true, allowedTiers: new Set<Tier>(["read"]) });

const PDF_CASES = [
  ["invoice_pdf", "sevdesk_invoice_pdf", "/Invoice/12/getPdf", "documents/invoice-pdf.json"],
  [
    "credit_note_pdf",
    "sevdesk_credit_note_pdf",
    "/CreditNote/12/getPdf",
    "documents/credit-note-pdf.json",
  ],
  ["order_pdf", "sevdesk_order_pdf", "/Order/12/getPdf", "documents/order-pdf.json"],
] as const satisfies readonly (readonly [DocumentFileKind, string, string, string])[];

function pdfReply(fixture: string): Response {
  return envelope((loadFixture(fixture).body as { objects: unknown }).objects);
}

/** The real client in read-only mode, answering from scripted replies. */
function realClient(...replies: Response[]) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const client = createSevdeskClient(READ_ONLY, {
    fetch: fake.fetch,
    sleep: clock.sleep,
    now: clock.now,
    monotonicNow: clock.now,
    random: () => 0.5,
  });
  return { client, fake };
}

function expectPreviewOnly(fake: ReturnType<typeof createFakeFetch>, path: string): void {
  expect(fake.requests).toHaveLength(1);
  const [request] = fake.requests;
  expect(request?.method).toBe("GET");
  expect(request?.url.pathname).toBe(`/api/v1${path}`);
  expect(request?.url.searchParams.get("preventSendBy")).toBe("true");
  expect(request?.url.searchParams.has("download")).toBe(false);
  expect([...(request?.url.searchParams.keys() ?? [])]).toEqual(["preventSendBy"]);
}

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("B1: every PDF path sends the literal preventSendBy=true", () => {
  describe("domain", () => {
    it.each(PDF_CASES)("%s declares preventSendBy itself", async (kind, _tool, path, fixture) => {
      const fake = new FakeSevdeskClient([{ path, response: { fixture } }]);

      await fetchDocumentFile(fake, kind, 12);

      expect(fake.calls).toEqual([
        {
          operation: "request",
          method: "GET",
          path,
          query: { preventSendBy: true },
          sideEffect: false,
        },
      ]);
    });

    it.each(PDF_CASES)(
      "%s goes out as a preview through the real client",
      async (kind, _tool, path, fixture) => {
        const { client, fake } = realClient(pdfReply(fixture));

        await fetchDocumentFile(client, kind, 12);

        expectPreviewOnly(fake, path);
      },
    );
  });

  describe("tools", () => {
    it.each(PDF_CASES)(
      "%s → %s sends a preview request only",
      async (_kind, tool, path, fixture) => {
        const { client: sevdesk, fake } = realClient(pdfReply(fixture));
        const client = await connectInProcess({ config: READ_ONLY, client: sevdesk });
        clients.push(client);

        const result = await client.callTool({ name: tool, arguments: { id: 12 } });

        expect(result.isError).toBeFalsy();
        expectPreviewOnly(fake, path);
      },
    );
  });

  describe("resources", () => {
    it.each(PDF_CASES)(
      "%s resource read sends a preview request only",
      async (kind, _tool, path, fixture) => {
        const { client: sevdesk, fake } = realClient(pdfReply(fixture));
        const client = await connectInProcess({ config: READ_ONLY, client: sevdesk });
        clients.push(client);

        const result = await client.readResource({ uri: documentFileUri(kind, 12) });

        expect(result.contents).toHaveLength(1);
        expectPreviewOnly(fake, path);
      },
    );
  });

  it("the e-invoice XML path does not touch getPdf at all", async () => {
    const xml = (loadFixture("documents/invoice-xml.json").body as { objects: unknown }).objects;
    const { client: sevdesk, fake } = realClient(envelope(xml), envelope(xml));
    const client = await connectInProcess({ config: READ_ONLY, client: sevdesk });
    clients.push(client);

    await client.callTool({ name: "sevdesk_invoice_xml", arguments: { id: 12 } });
    await client.readResource({ uri: "sevdesk://invoices/12/xml" });

    expect(
      fake.requests.map(
        (request) => `${request.method} ${request.url.pathname}${request.url.search}`,
      ),
    ).toEqual(["GET /api/v1/Invoice/12/getXml", "GET /api/v1/Invoice/12/getXml"]);
  });
});
