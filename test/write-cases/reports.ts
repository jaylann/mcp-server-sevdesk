import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DATEV_JOB_PATH, DATEV_XML_JOB_PATH } from "../../src/domain/exports/datev.js";
import { swapPresignedFetch } from "../../src/sevdesk/export-download.js";
import { archiveExportTool } from "../../src/tools/reports/archive-export.js";
import { datevSettingsUpdateTool } from "../../src/tools/reports/datev-settings.js";
import { datevExportTool } from "../../src/tools/reports/export-tools.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import { buildZip, pdfBytes } from "../helpers/zip.js";

type WriteCaseEnvironment = Awaited<ReturnType<NonNullable<WriteToolCase["setup"]>>>;

/** The bytes of a tiny ZIP (local file header magic first). */
export const DATEV_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

/** The routes of a DATEV export that is already done at the first progress poll. */
export const DATEV_ROUTES: readonly FakeRoute[] = [
  { path: "/SevClient", response: { fixture: "exports/sev-client-datev.json" } },
  { method: "POST", path: DATEV_JOB_PATH, response: { fixture: "exports/datev-job-start.json" } },
  {
    method: "POST",
    path: DATEV_XML_JOB_PATH,
    response: { fixture: "exports/datev-job-start.json" },
  },
  {
    path: "/Progress/generateDownloadHash",
    response: { fixture: "exports/datev-progress-hash.json" },
  },
  { path: "/Progress/getProgress", response: { fixture: "exports/datev-progress-done.json" } },
  {
    path: "/ExportJob/jobDownloadInfo",
    response: { fixture: "exports/datev-download-info.json" },
  },
];

/** A presigned-download fetch that answers every request with `bytes` (default {@link DATEV_ZIP}). */
export function zipFetch(bytes: Uint8Array = DATEV_ZIP): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(bytes, { status: 200, headers: { "content-type": "binary/octet-stream" } }),
    );
}

/**
 * An invoice archive as sevDesk names its entries (D-101; fake numbers and hashes): two issued
 * invoices and one draft.
 */
export const INVOICE_ARCHIVE = buildZip([
  {
    name: "2026-10-05_Rechnung_RE-1000_0123456789abcdef0123456789abcdef.pdf",
    content: pdfBytes("1"),
  },
  {
    name: "2026-10-07_Rechnung_RE-1001_fedcba9876543210fedcba9876543210.pdf",
    content: pdfBytes("2"),
  },
  {
    name: "2026-10-09_Rechnung(Entwurf)__00112233445566778899aabbccddeeff.pdf",
    content: pdfBytes("3"),
  },
]);

/** The recorded answer of `GET /Export/invoiceZip?download=true` (media type as sevDesk sends it). */
export const ARCHIVE_ROUTES: readonly FakeRoute[] = [
  {
    path: "/Export/invoiceZip",
    response: { bytes: INVOICE_ARCHIVE, contentType: "application/zip; charset=UTF-8'" },
  },
];

/** A temporary SEVDESK_OUTPUT_DIR, with the presigned download answered by `fetchImpl`. */
async function outputFolder(fetchImpl?: typeof fetch): Promise<WriteCaseEnvironment> {
  const directory = await mkdtemp(join(tmpdir(), "sevdesk-export-case-"));
  const restore = fetchImpl === undefined ? undefined : swapPresignedFetch(fetchImpl);
  return {
    config: { outputDir: directory },
    undo: async () => {
      restore?.();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Known-good cases of the reports write tools. */
export const REPORTS_CASES: readonly WriteToolCase[] = [
  {
    label: "export a quarter to DATEV",
    tool: datevExportTool,
    args: { year: 2026, quarter: 1 },
    routes: DATEV_ROUTES,
    writes: [{ method: "POST", path: DATEV_JOB_PATH }],
    setup: () => outputFolder(zipFetch()),
  },
  {
    label: "export a quarter to DATEV XML with receipt images",
    tool: datevExportTool,
    args: { year: 2026, quarter: 1, format: "xml" },
    routes: DATEV_ROUTES,
    writes: [{ method: "POST", path: DATEV_XML_JOB_PATH }],
    setup: () =>
      outputFolder(zipFetch(buildZip([{ name: "DATEV_inner.zip", content: buildZip([]) }]))),
  },
  {
    label: "save the invoice PDFs of a month as a ZIP",
    tool: archiveExportTool,
    args: { subject: "invoices", year: 2026, month: 10 },
    routes: ARCHIVE_ROUTES,
    writes: [{ method: "GET", path: "/Export/invoiceZip" }],
    setup: () => outputFolder(),
  },
  {
    label: "set the DATEV client number",
    tool: datevSettingsUpdateTool,
    args: { accountantClientNumber: 54321 },
    routes: [
      { path: "/SevClient", response: { fixture: "exports/sev-client-datev.json" } },
      {
        method: "PUT",
        path: "/SevClient/9001/updateExportConfig",
        response: { body: { objects: null } },
      },
    ],
    writes: [{ method: "PUT", path: "/SevClient/9001/updateExportConfig" }],
  },
];
