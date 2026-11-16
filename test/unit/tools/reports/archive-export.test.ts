import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listZipEntries } from "../../../../src/domain/exports/zip.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { archiveExportTool } from "../../../../src/tools/reports/archive-export.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { buildZip, pdfBytes } from "../../../helpers/zip.js";
import { ARCHIVE_ROUTES, INVOICE_ARCHIVE } from "../../../write-cases/reports.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sevdesk-archive-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const OCTOBER = { subject: "invoices", year: 2026, month: 10 } as const;

describe("sevdesk_archive_export: metadata", () => {
  it("is a write-tier file writer with honest annotations", () => {
    expect(archiveExportTool).toMatchObject({
      tier: "write",
      toolset: "reports",
      localEffects: "writes-files",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
    expect(archiveExportTool.description).toContain("includes drafts");
    expect(archiveExportTool.description).toContain("100 MiB");
    expect(archiveExportTool.description.length).toBeLessThanOrEqual(900);
  });
});

describe("sevdesk_archive_export: prepare", () => {
  it("previews period, filters, target and the draft caveat without asking sevDesk", async () => {
    const client = new FakeSevdeskClient(ARCHIVE_ROUTES);

    const plan = await prepareWrite(archiveExportTool, { ...OCTOBER, contactId: 42 }, client, {
      outputDir: directory,
    });
    const again = await prepareWrite(archiveExportTool, { ...OCTOBER, contactId: 42 }, client, {
      outputDir: directory,
    });

    expect(plan.preview).toEqual(again.preview);
    expect(plan.preview.action).toBe(
      "Let sevDesk put the invoices of 2026-10 into one ZIP and provide it as a new file in " +
        `SEVDESK_OUTPUT_DIR (${directory}).`,
    );
    const facts = Object.fromEntries(plan.preview.facts.map((fact) => [fact.label, fact.value]));
    expect(facts).toMatchObject({
      Documents: "invoices (rendered PDFs)",
      Period: "2026-10-01 to 2026-10-31",
      Contact: "contact 42",
      "At most": "1000 documents",
      "File name": "invoices_2026-10-01_2026-10-31.zip",
    });
    const warnings = plan.preview.warnings.join(" ");
    expect(warnings).toContain("Nothing changes on any document");
    expect(warnings).toContain("includes drafts");
    expect(warnings).toContain("100 MiB");
    expect(plan.preview.irreversible).toBe(false);
    expect(client.calls).toEqual([]);
  });

  it("shows the voucher amount range", async () => {
    const plan = await prepareWrite(
      archiveExportTool,
      {
        subject: "vouchers",
        from: "2026-11-16",
        to: "2026-11-16",
        minAmount: 123,
        maxAmount: "124",
      },
      new FakeSevdeskClient([]),
      { outputDir: directory },
    );
    const facts = Object.fromEntries(plan.preview.facts.map((fact) => [fact.label, fact.value]));
    expect(facts["Amounts"]).toBe("123 to 124 EUR gross");
  });

  it.each([
    [{ subject: "vouchers", year: 2026, contactId: 1 }, "contactId filters invoices only"],
    [{ subject: "invoices", year: 2026, maxAmount: "5" }, "vouchers only"],
    [{ subject: "invoices", from: "2026-02-01", to: "2026-01-01" }, "from is after to"],
    [{ subject: "invoices" }, "give either year"],
  ])("refuses %j before anything is sent", async (args, text) => {
    const client = new FakeSevdeskClient(ARCHIVE_ROUTES);
    const error = await prepareWrite(archiveExportTool, args, client, {
      outputDir: directory,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "validation" });
    expect((error as Error).message).toContain(text);
    expect(client.calls).toEqual([]);
  });

  it("refuses a missing output folder", async () => {
    await expect(
      prepareWrite(archiveExportTool, OCTOBER, new FakeSevdeskClient(ARCHIVE_ROUTES), {
        outputDir: join(directory, "missing"),
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("sevdesk_archive_export: execute", () => {
  it("asks once with the write tier, saves the ZIP unchanged and counts entries and drafts", async () => {
    const client = new FakeSevdeskClient(ARCHIVE_ROUTES);

    const { output } = await executeWrite(archiveExportTool, OCTOBER, client, {
      outputDir: directory,
    });

    expect(client.writes()).toEqual([
      expect.objectContaining({
        operation: "download",
        method: "GET",
        path: "/Export/invoiceZip",
        sideEffect: true,
        tier: "write",
      }),
    ]);
    expect(client.writes()[0]?.query).toMatchObject({
      download: "true",
      "sevQuery[modelName]": "Invoice",
      "sevQuery[limit]": 1000,
    });
    expect(output.data).toMatchObject({
      subject: "invoices",
      bytes: INVOICE_ARCHIVE.byteLength,
      period: { from: "2026-10-01", to: "2026-10-31", label: "2026-10" },
      entries: 3,
      pdfEntries: 3,
      draftEntries: 1,
      limit: 1000,
      mayBeTruncated: false,
    });
    const data = output.data as { savedTo: string; warnings: string[] };
    expect(data.warnings).toEqual([expect.stringContaining("1 entry is named like drafts")]);
    expect(data.savedTo.endsWith("invoices_2026-10-01_2026-10-31.zip")).toBe(true);
    const saved = await readFile(data.savedTo);
    expect(Buffer.from(saved)).toEqual(Buffer.from(INVOICE_ARCHIVE));
    // The ZIP's own contents, read back from the saved file: names and count.
    expect(listZipEntries(saved)?.map((entry) => entry.name)).toEqual([
      "2026-10-05_Rechnung_RE-1000_0123456789abcdef0123456789abcdef.pdf",
      "2026-10-07_Rechnung_RE-1001_fedcba9876543210fedcba9876543210.pdf",
      "2026-10-09_Rechnung(Entwurf)__00112233445566778899aabbccddeeff.pdf",
    ]);
    // Entry names (invoice numbers, voucher descriptions) never reach the model.
    expect(JSON.stringify(output)).not.toContain("RE-1000");
    expect(output.summary).toBe(
      `Archive of invoices 2026-10: 3 files (${String(INVOICE_ARCHIVE.byteLength)} bytes) saved ` +
        "as a new file in SEVDESK_OUTPUT_DIR; nothing changed in sevDesk. 1 of them is a draft " +
        "(see warnings).",
    );
    expect(output.affected).toEqual([
      { objectName: "DocumentArchive", id: "invoices_2026-10-01_2026-10-31" },
    ]);
  });

  it("says when the limit may have cut the archive", async () => {
    const two = buildZip([
      { name: "2026-10-01_Beleg_A_01.pdf", content: pdfBytes("a") },
      { name: "2026-10-02_Beleg_B_02.pdf", content: pdfBytes("b") },
    ]);
    const client = new FakeSevdeskClient([
      { path: "/Export/voucherZip", response: { bytes: two, contentType: "application/zip" } },
    ]);

    const { output } = await executeWrite(
      archiveExportTool,
      { subject: "vouchers", year: 2026, month: 10, limit: 2, minAmount: "10.5" },
      client,
      { outputDir: directory },
    );

    expect(output.data).toMatchObject({ entries: 2, draftEntries: 0, mayBeTruncated: true });
    expect(client.writes()[0]?.query).toMatchObject({
      "sevQuery[modelName]": "Voucher",
      "sevQuery[limit]": 2,
      "sevQuery[filter][startAmount]": "10.5",
    });
  });

  it("saves nothing when the archive is empty", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Export/invoiceZip", response: { bytes: buildZip([]) } },
    ]);

    const { output } = await executeWrite(archiveExportTool, OCTOBER, client, {
      outputDir: directory,
    });

    expect(output.data).toMatchObject({ entries: 0, bytes: 0 });
    expect(output.data).not.toHaveProperty("savedTo");
    expect(output.summary).toContain("nothing was saved");
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses an answer that is not a ZIP and saves nothing", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Export/invoiceZip",
        response: {
          bytes: new TextEncoder().encode(
            JSON.stringify({ objects: { filename: "Rechnungen.zip", content: null } }),
          ),
          contentType: "application/json",
        },
      },
    ]);

    const error = await executeWrite(archiveExportTool, OCTOBER, client, {
      outputDir: directory,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({ kind: "unexpected_response" });
    expect(await readdir(directory)).toEqual([]);
  });
});
