/**
 * Regression (D-101, D-102, D-023): the document archives and the DATEV XML export never send an
 * enshrine flag (festschreiben is irreversible) nor `includeExportedDocuments` (it had no effect,
 * so it is never offered), and a body that is not a ZIP is refused before anything is saved.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATEV_XML_JOB_PATH } from "../../src/domain/exports/datev.js";
import { swapPresignedFetch } from "../../src/sevdesk/export-download.js";
import { archiveExportTool } from "../../src/tools/reports/archive-export.js";
import { datevExportTool } from "../../src/tools/reports/export-tools.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { executeWrite } from "../helpers/write-tools.js";
import { buildZip, pdfBytes } from "../helpers/zip.js";
import { DATEV_ROUTES, zipFetch } from "../write-cases/reports.js";

const FORBIDDEN_KEYS = /enshrine|exported/i;

let directory: string;
let restore: (() => void) | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sevdesk-no-enshrine-"));
});

afterEach(async () => {
  restore?.();
  restore = undefined;
  await rm(directory, { recursive: true, force: true });
});

const ZIP = buildZip([{ name: "2026-10-01_Beleg_A_01.pdf", content: pdfBytes("a") }]);

describe("document archives", () => {
  it.each([
    { subject: "invoices", year: 2026 },
    { subject: "invoices", year: 2026, month: 3, contactId: 7, limit: 5 },
    { subject: "vouchers", from: "2026-01-01", to: "2026-01-31", minAmount: "1", maxAmount: 2 },
  ])("sends no enshrine or exported flag for %j", async (args) => {
    const client = new FakeSevdeskClient([
      { path: "/Export/invoiceZip", response: { bytes: ZIP, contentType: "application/zip" } },
      { path: "/Export/voucherZip", response: { bytes: ZIP, contentType: "application/zip" } },
    ]);

    await executeWrite(archiveExportTool, args, client, { outputDir: directory });

    expect(client.calls).toHaveLength(1);
    for (const call of client.calls) {
      expect(Object.keys(call.query).filter((key) => FORBIDDEN_KEYS.test(key))).toEqual([]);
      expect(call.tier).toBe("write");
    }
  });

  it.each([
    ["HTML", "<html>Wartung</html>", "text/html"],
    ["the JSON form without the file", '{"objects":{"content":null}}', "application/json"],
    ["bytes under a ZIP type", "PK but not really", "application/zip; charset=UTF-8'"],
  ])("refuses %s and saves nothing", async (_label, body, contentType) => {
    const client = new FakeSevdeskClient([
      {
        path: "/Export/invoiceZip",
        response: { bytes: new TextEncoder().encode(body), contentType },
      },
    ]);

    await expect(
      executeWrite(archiveExportTool, { subject: "invoices", year: 2026 }, client, {
        outputDir: directory,
      }),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("DATEV XML export", () => {
  it("starts the job without enshrine or exported flags, whatever the arguments", async () => {
    restore = swapPresignedFetch(zipFetch(ZIP));
    const client = new FakeSevdeskClient(DATEV_ROUTES);

    await executeWrite(
      datevExportTool,
      { year: 2026, quarter: 2, format: "xml", exportByPaydate: true, includeDocumentImages: true },
      client,
      { outputDir: directory },
    );

    expect(client.writes().map((call) => call.path)).toEqual([DATEV_XML_JOB_PATH]);
    for (const call of client.calls) {
      expect(Object.keys(call.query).filter((key) => FORBIDDEN_KEYS.test(key))).toEqual([]);
    }
  });

  it("refuses a download that is not a ZIP and saves nothing", async () => {
    restore = swapPresignedFetch(() =>
      Promise.resolve(new Response("<Error>AccessDenied</Error>", { status: 200 })),
    );

    await expect(
      executeWrite(
        datevExportTool,
        { year: 2026, quarter: 2, format: "xml" },
        new FakeSevdeskClient(DATEV_ROUTES),
        { outputDir: directory },
      ),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
    expect(await readdir(directory)).toEqual([]);
  });
});
