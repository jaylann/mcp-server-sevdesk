/**
 * The file tools over HTTP with remote file transfer (`deployment.files`): registration, receipt
 * and e-invoice uploads (`upload:<id>` as `file`), and deliveries as download links. The local
 * folder behaviour is tested next to each tool; the transfer store and the file accesses in
 * `test/unit/safety/`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VoucherSuggestion } from "../../../src/domain/drafts/voucher-import.js";
import type { ParsedEInvoice } from "../../../src/domain/einvoice/model.js";
import { money } from "../../../src/domain/money.js";
import { openBlobStore } from "../../../src/safety/blob-store.js";
import { remoteFileAccess } from "../../../src/safety/file-sources.js";
import { createTransferStore } from "../../../src/safety/transfer-store.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { swapPresignedFetch } from "../../../src/sevdesk/export-download.js";
import { DOCUMENT_FILE_TOOLS } from "../../../src/tools/documents/index.js";
import { ALL_TOOLS } from "../../../src/tools/index.js";
import { selectTools } from "../../../src/tools/registry.js";
import { csvExportTool, datevExportTool } from "../../../src/tools/reports/export-tools.js";
import { voucherCreateDraftTool } from "../../../src/tools/vouchers/draft-create.js";
import { einvoiceParseTool } from "../../../src/tools/vouchers/einvoice-parse.js";
import { voucherImportEInvoiceTool } from "../../../src/tools/vouchers/import-einvoice.js";
import { allEnabledConfig, TEST_TOKEN } from "../../helpers/config.js";
import { connectInProcess } from "../../helpers/connect.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../helpers/fake-client.js";
import {
  FILES_ORIGIN,
  filesConfig,
  filesOffDeployment,
  OWNER,
  useTransfer,
} from "../../helpers/transfer.js";
import { grantAuthInfo, resultData, resultSummary, resultText } from "../../helpers/write-flow.js";
import { executeWrite, prepareWrite } from "../../helpers/write-tools.js";
import { DATEV_ROUTES, DATEV_ZIP, zipFetch } from "../../write-cases/reports.js";
import {
  CREATE_READ_ROUTES,
  PDF_BYTES,
  readBackRoutes,
  saveRoute,
  uploadRoute,
} from "./vouchers/routes.js";

const openTransfer = useTransfer();
const clients: Client[] = [];
let restoreFetch: (() => void) | undefined;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  restoreFetch?.();
  restoreFetch = undefined;
  vi.restoreAllMocks();
});

const FILE_TOOLS = [
  "sevdesk_csv_export",
  "sevdesk_datev_export",
  "sevdesk_document_save",
  "sevdesk_einvoice_parse",
  "sevdesk_upload_request",
  "sevdesk_voucher_import_einvoice",
];
const DRAFT_ARGS = {
  supplierId: 1001,
  number: "ER-2026-0815",
  date: "2026-11-02",
  positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
};
const XRECHNUNG = fileURLToPath(
  new URL("../../fixtures/einvoice/kosit/01.01a-INVOICE_uncefact.xml", import.meta.url),
);
const CII = fileURLToPath(
  new URL("../../fixtures/einvoice/generated/cii-en16931-invoice.xml", import.meta.url),
);

function names(config: Parameters<typeof selectTools>[1]): string[] {
  return selectTools(ALL_TOOLS, config).map((tool) => tool.name);
}

function voucherClient(): FakeSevdeskClient {
  return new FakeSevdeskClient([
    ...CREATE_READ_ROUTES,
    uploadRoute,
    saveRoute(),
    ...readBackRoutes(),
  ]);
}

/** The id at the end of a download link. */
function linkId(url: unknown): string {
  return String(url).split("/").pop() ?? "";
}

describe("file tools with remote file transfer: registration", () => {
  it("offers the file tools and the upload request in OAuth mode without any folder", () => {
    const offered = names(filesConfig());
    for (const name of FILE_TOOLS) expect(offered, name).toContain(name);

    const off = names(allEnabledConfig({ deployment: filesOffDeployment() }));
    for (const name of FILE_TOOLS) expect(off, name).not.toContain(name);
    expect(names(allEnabledConfig())).not.toContain("sevdesk_upload_request");
  });
});

describe("receipts and e-invoices from uploads", () => {
  it("attaches an uploaded receipt: sevDesk gets its bytes under the cleaned name", async () => {
    const transfer = await openTransfer();
    const ref = await transfer.upload(PDF_BYTES, { name: "Rechnung-0815.pdf" });
    const fake = voucherClient();

    const { plan, output } = await executeWrite(
      voucherCreateDraftTool,
      { ...DRAFT_ARGS, file: ref },
      fake,
      filesConfig(),
      transfer.access(),
    );

    expect(fake.writes().map((call) => call.path)).toEqual([
      "/Voucher/Factory/uploadTempFile",
      "/Voucher/Factory/saveVoucher",
    ]);
    const part = fake.writes()[0]?.form?.get("file") as File;
    expect(part.name).toBe("Rechnung-0815.pdf");
    expect(part.type).toBe("application/pdf");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PDF_BYTES);
    const fact = plan.preview.facts.find((f) => f.label === "Receipt file (Belegbild)")?.value;
    expect(fact).toMatch(/^Rechnung-0815\.pdf \(PDF, \d+ bytes, SHA-256 [0-9a-f]{16}…\)$/);
    expect(output.data.receipt).toMatchObject({ name: "Rechnung-0815.pdf", kind: "pdf" });
    expect(JSON.stringify([plan.preview, output])).not.toContain(ref.slice("upload:".length));
  });

  it("refuses another grant's upload and a wrong kind before any request", async () => {
    const transfer = await openTransfer();
    const ref = await transfer.upload(PDF_BYTES);
    const xml = await transfer.upload(new TextEncoder().encode("<Invoice/>"), {
      name: "RE.xml",
      kind: "xml",
      purpose: "einvoice",
    });
    const other = { grantKey: "grant-2", accountScope: OWNER.accountScope };

    for (const [file, access, expected] of [
      [ref, transfer.access(filesConfig(), other), "no uploaded file"],
      [xml, transfer.access(), "is a XML file; accepted here: PDF, PNG, JPEG"],
    ] as const) {
      const fake = voucherClient();
      const error = await prepareWrite(
        voucherCreateDraftTool,
        { ...DRAFT_ARGS, file },
        fake,
        filesConfig(),
        access,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SevdeskError);
      expect((error as Error).message).toContain(expected);
      expect(fake.calls).toEqual([]);
    }
  });

  it("imports an uploaded XRechnung as a draft with the XML attached", async () => {
    const transfer = await openTransfer();
    const ref = await transfer.upload(await readFile(XRECHNUNG), {
      name: "xrechnung.xml",
      kind: "xml",
      purpose: "einvoice",
    });
    const planner = (parsed: ParsedEInvoice): Promise<VoucherSuggestion> =>
      Promise.resolve({
        kind: "expense",
        counterparty: { name: parsed.seller.name },
        supplierCandidates: [],
        taxRuleId: 9,
        taxRuleReason: "VAT category S: input VAT deductible (rule 9).",
        positions: parsed.vatBreakdown.map((row) => ({
          vatCategory: row.category,
          taxRate: row.rate ?? "0",
          net: money(row.taxableAmount),
          tax: money(row.taxAmount),
          gross: money(parsed.totals.gross),
        })),
        voucherDate: parsed.issueDate,
        number: parsed.number,
        currency: parsed.currency,
        totals: {
          net: money(parsed.totals.net),
          tax: money(parsed.totals.tax),
          gross: money(parsed.totals.gross),
          due: money(parsed.totals.due),
        },
        blocking: [],
        warnings: [],
      });
    const fake = voucherClient();

    const { output } = await executeWrite(
      voucherImportEInvoiceTool(planner),
      { file: ref, accountDatevId: 4266 },
      fake,
      filesConfig(),
      transfer.access(),
    );

    const part = fake.writes()[0]?.form?.get("file") as File;
    expect(part.type).toBe("application/xml");
    expect(part.name).toBe("xrechnung.xml");
    expect(output.data.receipt).toMatchObject({ name: "xrechnung.xml", kind: "xml" });
  });

  it("parses an uploaded e-invoice", async () => {
    const transfer = await openTransfer();
    const ref = await transfer.upload(await readFile(CII), {
      name: "RE-2026-0001.xml",
      kind: "xml",
      purpose: "einvoice",
    });
    const routes: FakeRoute[] = [
      {
        path: "/SevClient",
        response: { body: { objects: [{ smallSettlement: "0", name: "Musterfirma GmbH" }] } },
      },
      { path: "/Contact", response: { fixture: "contacts/contacts-list.json" } },
    ];
    const client = new FakeSevdeskClient(routes);

    const result = await einvoiceParseTool.handler(einvoiceParseTool.input.parse({ file: ref }), {
      ...testContext(client),
      config: filesConfig(),
      files: transfer.access(),
    });

    expect(result.data.file).toEqual({ name: "RE-2026-0001.xml", kind: "xml" });
    expect(result.data.invoice.number).toBe("RE-2026-0001");
    expect(client.writes()).toEqual([]);
  });

  it("keeps upload ids out of error results and the server log", async () => {
    const transfer = await openTransfer();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fake = voucherClient();
    const client = await connectInProcess(
      {
        config: filesConfig(),
        client: fake,
        tools: [voucherCreateDraftTool],
        transfer: transfer.store,
      },
      { authInfo: grantAuthInfo({ accountId: "4711", token: TEST_TOKEN, grantId: "grant-1" }) },
    );
    clients.push(client);
    const id = "Q".repeat(43);

    const result = await client.callTool({
      name: "sevdesk_voucher_create_draft",
      arguments: { ...DRAFT_ARGS, file: `upload:${id}` },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("no uploaded file for this uploadId");
    expect(JSON.stringify(result)).not.toContain(id);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain(id);
    expect(fake.calls).toEqual([]);
  });
});

describe("deliveries as download links", () => {
  it("sevdesk_document_save returns a link the account's browser session can download", async () => {
    const transfer = await openTransfer();
    const fake = new FakeSevdeskClient([
      {
        path: "/Invoice/12/getPdf",
        query: { preventSendBy: true },
        response: { fixture: "documents/invoice-pdf.json" },
      },
    ]);
    const client = await connectInProcess(
      { config: filesConfig(), client: fake, tools: DOCUMENT_FILE_TOOLS, transfer: transfer.store },
      { authInfo: grantAuthInfo({ accountId: "4711", token: TEST_TOKEN, grantId: "grant-1" }) },
    );
    clients.push(client);

    const result = await client.callTool({
      name: "sevdesk_document_save",
      arguments: { document: "invoice_pdf", id: 12 },
    });

    expect(result.isError).toBeFalsy();
    const data = resultData(result);
    expect(data).not.toHaveProperty("savedTo");
    const download = data["download"] as { url: string; reference: string; expiresAt: string };
    expect(download.url.startsWith(`${FILES_ORIGIN}/files/`)).toBe(true);
    expect(download.expiresAt).toBe("2026-11-09T12:30:00.000Z");
    expect(resultSummary(result)).toBe(
      `Invoice 12: the PDF file (${String(data["bytes"])} bytes) is ready as a download link ` +
        `(reference ${download.reference}, valid until ${download.expiresAt}): give the user the ` +
        "link in download.url; they open it in the browser, signed in to this sevDesk account; " +
        "nothing changed in sevDesk.",
    );
    expect(resultSummary(result)).not.toContain(linkId(download.url));
    expect(result.content[1]).toMatchObject({ type: "resource_link" });
    expect(fake.calls.map((call) => [call.path, call.query])).toEqual([
      ["/Invoice/12/getPdf", { preventSendBy: true }],
    ]);
    const served = await transfer.store.takeDownload(linkId(download.url), "4711");
    expect(served).toMatchObject({
      status: "served",
      file: { filename: "RE-1001.pdf", kind: "pdf", reference: download.reference },
    });
  });

  it("sevdesk_csv_export returns a link instead of a path", async () => {
    const transfer = await openTransfer();
    const csv = new TextEncoder().encode(`"Nummer";"Name"\n"K-1";"Muster"\n`);
    const client = new FakeSevdeskClient([
      { path: "/Export/contactListCsv", response: { bytes: csv } },
    ]);

    const result = await csvExportTool.handler(csvExportTool.input.parse({ subject: "contacts" }), {
      ...testContext(client),
      config: filesConfig(),
      files: transfer.access(),
    });

    const data = csvExportTool.output.parse(result.data);
    expect(data.savedTo).toBeUndefined();
    expect(data.download?.url.startsWith(`${FILES_ORIGIN}/files/`)).toBe(true);
    expect(result.summary).toMatch(
      /^CSV export of contacts: 1 rows \(\d+ bytes\) ready as a download link \(reference [A-Z2-9]{6}, valid until 2026-11-09T12:30:00\.000Z\): give the user the link in download\.url; .*; nothing changed in sevDesk\.$/,
    );
    const served = await transfer.store.takeDownload(linkId(data.download?.url), "4711");
    expect(served).toMatchObject({
      status: "served",
      file: { kind: "csv", bytes: Buffer.from(csv) },
    });
  });

  it("sevdesk_datev_export previews and delivers the ZIP as a link", async () => {
    restoreFetch = swapPresignedFetch(zipFetch());
    const transfer = await openTransfer();

    const { plan, output } = await executeWrite(
      datevExportTool,
      { year: 2026, quarter: 1 },
      new FakeSevdeskClient(DATEV_ROUTES),
      filesConfig(),
      transfer.access(),
    );

    const delivered = transfer.access().describeDelivery();
    expect(plan.preview.action).toBe(
      `Start a DATEV export (CSV ZIP) in sevDesk for 2026-Q1 and provide the ZIP as ${delivered}.`,
    );
    expect(plan.preview.facts).toContainEqual({ label: "Delivered as", value: delivered });
    expect(output.data).not.toHaveProperty("savedTo");
    expect(output.data.download?.url.startsWith(`${FILES_ORIGIN}/files/`)).toBe(true);
    expect(output.summary).toContain("DATEV export 2026-Q1: the ZIP (8 bytes) is ready as");
    const served = await transfer.store.takeDownload(linkId(output.data.download?.url), "4711");
    expect(served).toMatchObject({
      status: "served",
      file: { kind: "zip", bytes: Buffer.from(DATEV_ZIP) },
    });
  });

  it("names the started DATEV job when the link cannot be stored", async () => {
    restoreFetch = swapPresignedFetch(zipFetch());
    const store = createTransferStore({
      blobs: await openBlobStore(),
      maxBytes: 4,
      fileTtlMs: 60_000,
      pruneIntervalMs: 0,
    });
    try {
      const error = await executeWrite(
        datevExportTool,
        { year: 2026, quarter: 1 },
        new FakeSevdeskClient(DATEV_ROUTES),
        filesConfig(),
        remoteFileAccess(filesConfig(), store, OWNER),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SevdeskError);
      expect(error).toMatchObject({
        kind: "validation",
        completedWrites: [{ objectName: "ExportJob" }],
      });
      expect((error as Error).message).toContain("Download it in sevDesk instead");
    } finally {
      await store.close();
    }
  });
});
