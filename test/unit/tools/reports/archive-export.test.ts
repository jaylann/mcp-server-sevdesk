import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listZipEntries } from "../../../../src/domain/exports/zip.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { archiveExportTool } from "../../../../src/tools/reports/archive-export.js";
import { FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { filesConfig, useTransfer } from "../../../helpers/transfer.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { buildZip, pdfBytes } from "../../../helpers/zip.js";
import { ARCHIVE_ROUTES, INVOICE_ARCHIVE } from "../../../write-cases/reports.js";

/** What sevDesk answers when nothing matches (recorded 2026-11-16, D-101). */
const README_ONLY = buildZip([
  {
    name: "readme.txt",
    content: "Es wurden keine Dateien hochgeladen, daher ist diese ZIP leer.",
  },
]);

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
    // The 5 minutes are the archive's own budget; a remote server's router ends at 120 s.
    expect(archiveExportTool.description).toContain(
      "stopped after 5 minutes (on a remote server after 120 s)",
    );
    expect(archiveExportTool.description.length).toBeLessThanOrEqual(900);
  });
});

describe("sevdesk_archive_export: on a remote server", () => {
  const transfer = useTransfer();

  it("names the 120-second request limit and the account's file space, not the 5 minutes", async () => {
    const fixture = await transfer();
    const config = filesConfig();
    const client = new FakeSevdeskClient(ARCHIVE_ROUTES);

    const plan = await prepareWrite(archiveExportTool, OCTOBER, client, config, fixture.access());

    expect(plan.preview.warnings).toContain(
      "sevDesk renders every PDF of the period before it answers (about a minute per 100 " +
        "invoices), and this remote server ends every request after 120 seconds; the download " +
        "link must also fit this account's share of the server's file space " +
        "(SEVDESK_HTTP_FILES_MAX_MB). The remedy for both is a shorter period, such as a week " +
        "or two of invoices.",
    );
    expect(plan.preview.warnings.join(" ")).not.toContain("stopped after 5");
    expect(client.calls).toEqual([]);
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
      // 500 by default: 1,000 invoices would outlast the 5 minutes and the 100 MiB.
      "At most": "500 documents",
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
    expect(plan.preview.warnings.join(" ")).toContain("Only vouchers with an uploaded receipt");
  });

  it("offers the amount filter on invoices too (recorded) and says the archive can be shorter", async () => {
    const plan = await prepareWrite(
      archiveExportTool,
      { subject: "invoices", year: 2026, month: 10, maxAmount: "500" },
      new FakeSevdeskClient([]),
      { outputDir: directory },
    );
    const facts = Object.fromEntries(plan.preview.facts.map((fact) => [fact.label, fact.value]));
    expect(facts["Amounts"]).toBe("any to 500 EUR");
    const warnings = plan.preview.warnings.join(" ");
    expect(warnings).toContain("fewer invoices than sevdesk_invoices_list shows");
    expect(warnings).toContain("stopped after 5");
  });

  it.each([
    [{ subject: "vouchers", year: 2026, contactId: 1 }, "contactId filters invoices only"],
    [{ subject: "invoices", from: "2026-02-01", to: "2026-01-01" }, "from is after to"],
    [{ subject: "invoices" }, "give either year"],
    [
      { subject: "vouchers", year: 2026, minAmount: "500", maxAmount: 100 },
      "minAmount is above maxAmount",
    ],
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
      "sevQuery[limit]": 500,
    });
    expect(output.data).toMatchObject({
      subject: "invoices",
      bytes: INVOICE_ARCHIVE.byteLength,
      period: { from: "2026-10-01", to: "2026-10-31", label: "2026-10" },
      entries: 3,
      pdfEntries: 3,
      draftEntries: 1,
      limit: 500,
      mayBeTruncated: false,
    });
    const data = output.data as { savedTo: string; warnings: string[] };
    expect(data.warnings).toEqual([
      expect.stringContaining("1 entry is named like drafts"),
      expect.stringContaining("fewer invoices than sevdesk_invoices_list shows"),
    ]);
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
    expect((output.data as { warnings: string[] }).warnings).toContain(
      "The ZIP holds 2 files, close to the limit of 2 documents: sevDesk may have stopped " +
        "there, so more may exist. Export a shorter period or raise limit (up to 1000).",
    );
  });

  it("flags an archive a file short of the limit: the limit counts documents, the ZIP files", async () => {
    // sevDesk left one invoice of the list out of both recorded archives (D-101): an archive
    // cut at 50 invoices can hold 49 files.
    const files = buildZip(
      Array.from({ length: 49 }, (_, index) => ({
        name: `2026-10-01_Rechnung_RE-${String(2000 + index)}_${String(index)}.pdf`,
        content: pdfBytes(String(index)),
      })),
    );
    const client = new FakeSevdeskClient([
      { path: "/Export/invoiceZip", response: { bytes: files, contentType: "application/zip" } },
    ]);

    const { output } = await executeWrite(archiveExportTool, { ...OCTOBER, limit: 50 }, client, {
      outputDir: directory,
    });

    expect(output.data).toMatchObject({ entries: 49, limit: 50, mayBeTruncated: true });
    expect((output.data as { warnings: string[] }).warnings).toContain(
      "The ZIP holds 49 files, close to the limit of 50 documents: sevDesk may have stopped " +
        "there, so more may exist. Export a shorter period or raise limit (up to 1000).",
    );
  });

  it("asks only for a shorter period when the limit is already the maximum", async () => {
    const files = buildZip(
      Array.from({ length: 980 }, (_, index) => ({
        name: `2026-10-01_Beleg_${String(index)}.pdf`,
        content: "%PDF",
      })),
    );
    const client = new FakeSevdeskClient([
      { path: "/Export/voucherZip", response: { bytes: files, contentType: "application/zip" } },
    ]);

    const { output } = await executeWrite(
      archiveExportTool,
      { subject: "vouchers", year: 2026, limit: 1000 },
      client,
      { outputDir: directory },
    );

    expect(output.data).toMatchObject({ entries: 980, mayBeTruncated: true });
    expect((output.data as { warnings: string[] }).warnings).toContain(
      "The ZIP holds 980 files, close to the limit of 1000 documents: sevDesk may have stopped " +
        "there, so more may exist. Export a shorter period.",
    );
  });

  it.each([
    ["sevDesk's readme-only ZIP (what it answers when nothing matches)", README_ONLY],
    ["a ZIP without entries", buildZip([])],
  ])("saves nothing for %s and says no document matched", async (_label, bytes) => {
    const client = new FakeSevdeskClient([
      {
        path: "/Export/voucherZip",
        response: { bytes, contentType: "application/zip; charset=UTF-8'" },
      },
    ]);

    const { output } = await executeWrite(
      archiveExportTool,
      { subject: "vouchers", year: 2026, month: 10 },
      client,
      { outputDir: directory },
    );

    expect(output.data).toMatchObject({ entries: 0, pdfEntries: 0, bytes: 0, warnings: [] });
    expect(output.data).not.toHaveProperty("savedTo");
    expect(output.summary).toBe(
      "No vouchers with a receipt file matched 2026-10 and the filters; nothing was saved and " +
        "nothing changed in sevDesk.",
    );
    // Our own words only: sevDesk's readme text never reaches the model.
    expect(JSON.stringify(output)).not.toContain("hochgeladen");
    expect(await readdir(directory)).toEqual([]);
  });

  it("treats fewer entries than documents as normal, not as an error", async () => {
    const one = buildZip([{ name: "2026-10-01_Beleg_A_01.pdf", content: pdfBytes("a") }]);
    const client = new FakeSevdeskClient([
      { path: "/Export/voucherZip", response: { bytes: one, contentType: "application/zip" } },
    ]);

    const { output } = await executeWrite(
      archiveExportTool,
      { subject: "vouchers", year: 2026, month: 10 },
      client,
      { outputDir: directory },
    );

    expect(output.data).toMatchObject({ entries: 1, mayBeTruncated: false });
    expect((output.data as { warnings: string[] }).warnings).toEqual([
      expect.stringContaining("vouchers without a file are left out"),
    ]);
    expect(output.summary).toContain("1 files");
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("tells the client up front that rendering can take minutes", async () => {
    const client = new FakeSevdeskClient(ARCHIVE_ROUTES);
    const plan = await prepareWrite(archiveExportTool, OCTOBER, client, { outputDir: directory });
    const messages: string[] = [];
    const ctx = {
      ...testContext(client, { SEVDESK_OUTPUT_DIR: directory }),
      progress: (_done: number, _total: number | undefined, message?: string) => {
        messages.push(message ?? "");
        return Promise.resolve();
      },
    };

    await archiveExportTool.execute(archiveExportTool.input.parse(OCTOBER), plan, ctx);

    expect(messages).toEqual([
      "sevDesk is rendering the invoices of 2026-10 into one ZIP; this can take minutes.",
    ]);
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
