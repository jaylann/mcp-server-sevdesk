import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  DOCUMENT_FILE_KINDS,
  documentFileUri,
  documentFileUriTemplate,
  fetchDocumentFile,
  MAX_DOCUMENT_FILE_BYTES,
  MAX_FILENAME_LENGTH,
  safeFilename,
} from "../../../src/domain/document-files.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../helpers/fake-client.js";

const INVOICE_PDF = loadFixture("documents/invoice-pdf.json");
const PDF_BASE64 = (INVOICE_PDF.body as { objects: { content: string } }).objects.content;
const PDF_BYTES = Buffer.from(PDF_BASE64, "base64");

function pdfBody(record: Record<string, unknown>): { objects: unknown } {
  return {
    objects: {
      filename: "RE-1001.pdf",
      mimeType: "application/pdf",
      base64encoded: true,
      content: PDF_BASE64,
      ...record,
    },
  };
}

function client(...routes: FakeRoute[]): FakeSevdeskClient {
  return new FakeSevdeskClient(routes);
}

function invoicePdfRoute(body: unknown): FakeRoute {
  return { path: "/Invoice/12/getPdf", response: { body } };
}

function xmlRoute(response: FakeRoute["response"]): FakeRoute {
  return { path: "/Invoice/12/getXml", response };
}

async function failure(promise: Promise<unknown>): Promise<SevdeskError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  return error as SevdeskError;
}

describe("documentFileUri / documentFileUriTemplate", () => {
  it("builds sevdesk:// URIs and templates per kind", () => {
    expect(DOCUMENT_FILE_KINDS.map((kind) => documentFileUri(kind, 12))).toEqual([
      "sevdesk://invoices/12/pdf",
      "sevdesk://credit-notes/12/pdf",
      "sevdesk://orders/12/pdf",
      "sevdesk://invoices/12/xml",
    ]);
    expect(DOCUMENT_FILE_KINDS.map(documentFileUriTemplate)).toEqual([
      "sevdesk://invoices/{id}/pdf",
      "sevdesk://credit-notes/{id}/pdf",
      "sevdesk://orders/{id}/pdf",
      "sevdesk://invoices/{id}/xml",
    ]);
  });
});

describe("fetchDocumentFile: PDFs", () => {
  it.each([
    ["invoice_pdf", "/Invoice/12/getPdf", "documents/invoice-pdf.json", "RE-1001.pdf"],
    ["credit_note_pdf", "/CreditNote/12/getPdf", "documents/credit-note-pdf.json", "GU-1001.pdf"],
    ["order_pdf", "/Order/12/getPdf", "documents/order-pdf.json", "AN-1001.pdf"],
  ] as const)(
    "%s: GET %s with preventSendBy, decoded and named",
    async (kind, path, fixture, name) => {
      const fake = client({ path, query: { preventSendBy: true }, response: { fixture } });

      const file = await fetchDocumentFile(fake, kind, 12);

      expect(fake.calls).toEqual([
        {
          operation: "request",
          method: "GET",
          path,
          query: { preventSendBy: true },
          sideEffect: false,
        },
      ]);
      const content = (loadFixture(fixture).body as { objects: { content: string } }).objects
        .content;
      expect(file).toMatchObject({
        kind,
        id: 12,
        uri: documentFileUri(kind, 12),
        filename: name,
        mimeType: "application/pdf",
      });
      expect(Buffer.from(file.bytes).toString("base64")).toBe(content);
      expect(Buffer.from(file.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    },
  );

  it("never sends download (the JSON envelope is what is parsed)", async () => {
    const fake = client(invoicePdfRoute(pdfBody({})));
    await fetchDocumentFile(fake, "invoice_pdf", 12);
    expect(fake.calls[0]?.query).not.toHaveProperty("download");
  });

  it("passes the abort signal on", async () => {
    const fake = client(invoicePdfRoute(pdfBody({})));
    const controller = new AbortController();
    controller.abort();
    const error = await failure(fetchDocumentFile(fake, "invoice_pdf", 12, controller.signal));
    expect(error.kind).toBe("aborted");
  });

  it("accepts objects as an array of one, line-wrapped base64, base64encoded '1' and no mimeType", async () => {
    const wrapped = PDF_BASE64.replace(/(.{76})/g, "$1\r\n");
    const fake = client(
      invoicePdfRoute({
        objects: [{ filename: null, mimeType: null, base64encoded: "1", content: wrapped }],
      }),
    );

    const file = await fetchDocumentFile(fake, "invoice_pdf", 12);

    expect(Buffer.from(file.bytes).equals(PDF_BYTES)).toBe(true);
    expect(file.filename).toBe("invoice-12.pdf");
  });

  it("accepts a media type with parameters and in upper case", async () => {
    const fake = client(invoicePdfRoute(pdfBody({ mimeType: "Application/PDF; charset=binary" })));
    await expect(fetchDocumentFile(fake, "invoice_pdf", 12)).resolves.toMatchObject({
      mimeType: "application/pdf",
    });
  });

  it("maps an empty objects array to not_found", async () => {
    const error = await failure(
      fetchDocumentFile(client(invoicePdfRoute({ objects: [] })), "invoice_pdf", 12),
    );
    expect(error.kind).toBe("not_found");
    expect(error.message).toBe("sevDesk found no PDF for invoice 12.");
  });

  it("passes sevDesk errors through", async () => {
    const notFound = new SevdeskError({ kind: "not_found", message: "gone", status: 404 });
    const fake = client({ path: "/Order/12/getPdf", response: { error: notFound } });
    await expect(fetchDocumentFile(fake, "order_pdf", 12)).rejects.toBe(notFound);
  });

  it.each([
    ["the render shape (D-025: pdf instead of content)", { objects: { pdf: PDF_BASE64 } }],
    ["a scalar payload", { objects: "JVBERi0=" }],
    ["base64encoded false", pdfBody({ base64encoded: false })],
    ["a media type other than PDF", pdfBody({ mimeType: "text/html" })],
    ["characters outside base64", pdfBody({ content: "JVBERi0x!!" })],
    ["an impossible base64 length", pdfBody({ content: "JVBER" })],
    ["padding in the middle", pdfBody({ content: "JV=BERi0" })],
    ["empty content", pdfBody({ content: "" })],
    ["content that is not a PDF", pdfBody({ content: Buffer.from("<html>").toString("base64") })],
    ["content shorter than the magic bytes", pdfBody({ content: "JVBE" })],
  ])("rejects %s as unexpected_response", async (_label, body) => {
    const error = await failure(
      fetchDocumentFile(client(invoicePdfRoute(body)), "invoice_pdf", 12),
    );
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).not.toContain(PDF_BASE64.slice(0, 20));
  });

  it("accepts a PDF of exactly the size limit", async () => {
    const bytes = Buffer.alloc(MAX_DOCUMENT_FILE_BYTES, 0x20);
    bytes.write("%PDF-", 0, "latin1");
    const fake = client(invoicePdfRoute(pdfBody({ content: bytes.toString("base64") })));

    const file = await fetchDocumentFile(fake, "invoice_pdf", 12);

    expect(file.bytes.byteLength).toBe(MAX_DOCUMENT_FILE_BYTES);
  });

  it("rejects a PDF one byte over the limit without decoding it", async () => {
    const bytes = Buffer.alloc(MAX_DOCUMENT_FILE_BYTES + 1, 0x20);
    bytes.write("%PDF-", 0, "latin1");
    const fake = client(invoicePdfRoute(pdfBody({ content: bytes.toString("base64") })));

    const error = await failure(fetchDocumentFile(fake, "invoice_pdf", 12));

    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toContain("more than 20 MB");
  });

  it("rejects absurdly long content before scanning it", async () => {
    const huge = "A".repeat(Math.ceil((MAX_DOCUMENT_FILE_BYTES * 4) / 3) * 2 + 4);
    const error = await failure(
      fetchDocumentFile(client(invoicePdfRoute(pdfBody({ content: huge }))), "invoice_pdf", 12),
    );
    expect(error.message).toContain("more than 20 MB");
  });

  it("validates the id before sending anything", async () => {
    const fake = client();
    const error = await failure(fetchDocumentFile(fake, "invoice_pdf", 0));
    expect(error.kind).toBe("validation");
    expect(fake.calls).toEqual([]);
  });
});

describe("fetchDocumentFile: e-invoice XML", () => {
  const XML_FIXTURE = loadFixture("documents/invoice-xml.json");
  const XML = (XML_FIXTURE.body as { objects: string }).objects;

  it("GETs getXml without query and returns the XML as UTF-8 bytes", async () => {
    const fake = client(xmlRoute({ fixture: "documents/invoice-xml.json" }));

    const file = await fetchDocumentFile(fake, "invoice_xml", 12);

    expect(fake.calls).toEqual([
      {
        operation: "request",
        method: "GET",
        path: "/Invoice/12/getXml",
        query: {},
        sideEffect: false,
      },
    ]);
    expect(file).toMatchObject({
      kind: "invoice_xml",
      uri: "sevdesk://invoices/12/xml",
      filename: "invoice-12.xml",
      mimeType: "application/xml",
    });
    expect(new TextDecoder().decode(file.bytes)).toBe(XML);
  });

  it("strips a byte order mark and tolerates leading whitespace", async () => {
    const bom = String.fromCodePoint(0xfeff);
    const fake = client(xmlRoute({ body: { objects: `${bom}\n  <Invoice/>` } }));

    const file = await fetchDocumentFile(fake, "invoice_xml", 12);

    expect(new TextDecoder().decode(file.bytes)).toBe("\n  <Invoice/>");
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "  \n"],
    ["an empty array", []],
    ["false", false],
  ])("reports %s as an invoice without e-invoice XML", async (_label, objects) => {
    const error = await failure(
      fetchDocumentFile(client(xmlRoute({ body: { objects } })), "invoice_xml", 12),
    );
    expect(error.kind).toBe("not_found");
    expect(error.status).toBeUndefined();
    expect(error.message).toContain("no e-invoice XML for invoice 12");
    expect(error.message).toContain("E-Rechnung");
  });

  it("turns sevDesk's refusal of getXml into a clear not_found, keeping the upstream details", async () => {
    const refusal = new SevdeskError({
      kind: "validation",
      message: "sevDesk rejected the request: validation error (HTTP 400).",
      status: 400,
      upstreamMessage: "Invoice is not an e-invoice",
      exceptionUuid: "4f1c2d3e-0000-4000-8000-000000000001",
      method: "GET",
      path: "/Invoice/12/getXml",
    });

    const error = await failure(
      fetchDocumentFile(client(xmlRoute({ error: refusal })), "invoice_xml", 12),
    );

    expect(error).toMatchObject({
      kind: "not_found",
      status: 400,
      upstreamMessage: "Invoice is not an e-invoice",
      exceptionUuid: "4f1c2d3e-0000-4000-8000-000000000001",
      method: "GET",
      path: "/Invoice/12/getXml",
    });
    expect(error.message).toContain("(sevDesk answered HTTP 400)");
    expect(error.message).not.toContain("Invoice is not an e-invoice");
    expect(error.cause).toBe(refusal);
  });

  it("keeps a refusal without upstream details minimal", async () => {
    const refusal = new SevdeskError({ kind: "validation", message: "x", status: 422 });
    const error = await failure(
      fetchDocumentFile(client(xmlRoute({ error: refusal })), "invoice_xml", 12),
    );
    expect(error).toMatchObject({ kind: "not_found", status: 422 });
    expect(error.upstreamMessage).toBeUndefined();
    expect(error.exceptionUuid).toBeUndefined();
    expect(error.method).toBeUndefined();
  });

  it.each([
    new SevdeskError({ kind: "server", message: "down", status: 503 }),
    new SevdeskError({ kind: "validation", message: "local" }),
    new SevdeskError({ kind: "not_found", message: "no invoice", status: 404 }),
  ])("passes other errors through (%s)", async (upstream) => {
    await expect(
      fetchDocumentFile(client(xmlRoute({ error: upstream })), "invoice_xml", 12),
    ).rejects.toBe(upstream);
  });

  it.each([
    ["an object", { xml: "<a/>" }],
    ["text that is not XML", "RE-1001"],
    ["an HTML page", "<!DOCTYPE html><html></html>"],
    ["an html element", "<HTML><body/></HTML>"],
  ])("rejects %s as unexpected_response", async (_label, objects) => {
    const error = await failure(
      fetchDocumentFile(client(xmlRoute({ body: { objects } })), "invoice_xml", 12),
    );
    expect(error.kind).toBe("unexpected_response");
  });

  it("rejects XML over the size limit", async () => {
    const tooLong = `<a>${"x".repeat(MAX_DOCUMENT_FILE_BYTES)}</a>`;
    const error = await failure(
      fetchDocumentFile(client(xmlRoute({ body: { objects: tooLong } })), "invoice_xml", 12),
    );
    expect(error.message).toContain("more than 20 MB");
  });

  it("measures the limit in UTF-8 bytes, not characters", async () => {
    // 3 bytes per character in UTF-8: under the limit in UTF-16 code units, over it in bytes.
    const wide = `<a>${"€".repeat(Math.ceil(MAX_DOCUMENT_FILE_BYTES / 3))}</a>`;
    const error = await failure(
      fetchDocumentFile(client(xmlRoute({ body: { objects: wide } })), "invoice_xml", 12),
    );
    expect(error.message).toContain("more than 20 MB");
  });
});

describe("safeFilename", () => {
  it.each([
    ["RE-1001.pdf", "RE-1001.pdf"],
    ["RE-1001.PDF", "RE-1001.pdf"],
    ["RE-1001", "RE-1001.pdf"],
    ["Rechnung RE 1001.pdf", "Rechnung_RE_1001.pdf"],
    ["Rechnung_Müller_Größe.pdf", "Rechnung_Mueller_Groesse.pdf"],
    ["Café Ñandú.pdf", "Cafe_Nandu.pdf"],
    ["../../etc/passwd", "passwd.pdf"],
    ["..\\..\\Windows\\win.ini", "win.ini.pdf"],
    ["/absolute/RE-1.pdf", "RE-1.pdf"],
    [".hidden.pdf", "hidden.pdf"],
    ["-rf.pdf", "rf.pdf"],
    ["RE..1001...pdf", "RE.1001.pdf"],
    ["rechnung.pdf.exe", "rechnung.pdf.exe.pdf"],
    ["a$(rm -rf ~)`b`;c|d>e.pdf", "a_rm_-rf_b_c_d_e.pdf"],
    ["name.pdf.", "name.pdf"],
  ])("%j → %j", (raw, expected) => {
    expect(safeFilename(raw, "invoice-12", "pdf")).toBe(expected);
  });

  it("removes invisible and bidi characters", () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    expect(safeFilename(`RE${zwsp}-1001${rlo}fdp.exe`, "invoice-12", "pdf")).toBe(
      "RE-1001fdp.exe.pdf",
    );
  });

  it.each([undefined, "", "   ", "...", "///", ".pdf", "CON", "con.pdf", "LPT1.txt", "nul"])(
    "falls back for %j",
    (raw) => {
      expect(safeFilename(raw, "invoice-12", "pdf")).toBe("invoice-12.pdf");
    },
  );

  it("caps the length and keeps the extension", () => {
    const name = safeFilename(`${"a".repeat(300)}.xml`, "invoice-12", "xml");
    expect(name).toHaveLength(MAX_FILENAME_LENGTH);
    expect(name.endsWith(".xml")).toBe(true);
  });

  it("does not end the stem with punctuation after truncation", () => {
    const name = safeFilename(`${"a".repeat(MAX_FILENAME_LENGTH - 5)}----b.pdf`, "x", "pdf");
    expect(name).toMatch(/^a+\.pdf$/);
  });

  it("only ever yields safe characters", () => {
    for (const raw of ["\u0000\u0001x.pdf", "x\ny.pdf", 'quote"s.pdf', "tab\tbed.pdf"]) {
      expect(safeFilename(raw, "f", "pdf")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/);
    }
  });
});
