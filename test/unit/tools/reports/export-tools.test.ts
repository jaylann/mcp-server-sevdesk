import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATEV_JOB_PATH, MAY_HAVE_STARTED } from "../../../../src/domain/exports/datev.js";
import { type Tier, TIERS } from "../../../../src/safety/tiers.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { swapPresignedFetch } from "../../../../src/sevdesk/export-download.js";
import { selectTools } from "../../../../src/tools/registry.js";
import {
  datevExportTool,
  exportCsvTool,
  REPORT_EXPORT_TOOLS,
} from "../../../../src/tools/reports/export-tools.js";
import { testConfig } from "../../../helpers/config.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { DATEV_ROUTES, DATEV_ZIP, zipFetch } from "../../../write-cases/reports.js";

const LINK_HOST = "sevexport-filestorage-workload-prod.s3.eu-central-1.amazonaws.com";
const SIGNATURE = "fake0000000000000000000000000000";
const PROGRESS_HASH = "22ae177d286f17aac5daac591c70164159b64c7f_0a0e1eff";
const JOB = "0a0e1eff-9590-1bea-1195-a3cfc04364cc";
const SEVDESK_NAME = "BITTE-ENTPACKEN_Buchungsstapel_1234567_12345_20260101_bis_20260331.zip";

let directory: string;
let restoreFetch: (() => void) | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sevdesk-export-test-"));
});

afterEach(async () => {
  restoreFetch?.();
  restoreFetch = undefined;
  await rm(directory, { recursive: true, force: true });
});

function useFetch(fetchImpl: typeof fetch): void {
  restoreFetch = swapPresignedFetch(fetchImpl);
}

/** Every text a model or human could see from a run, for leak checks. */
function visible(...parts: unknown[]): string {
  return parts
    .map((part) =>
      part instanceof Error
        ? `${part.message} ${JSON.stringify(part)} ${String((part as SevdeskError).upstreamMessage)}`
        : JSON.stringify(part),
    )
    .join("\n");
}

function names(overrides: Parameters<typeof testConfig>[0]): string[] {
  return selectTools(REPORT_EXPORT_TOOLS, testConfig(overrides)).map((tool) => tool.name);
}

describe("export tools: metadata and registration", () => {
  it("declare their tiers, local effects and honest annotations", () => {
    expect(datevExportTool).toMatchObject({
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
    expect(exportCsvTool).toMatchObject({
      tier: "read",
      toolset: "reports",
      localEffects: "writes-files",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
    for (const tool of REPORT_EXPORT_TOOLS) {
      expect(tool.description.length).toBeLessThanOrEqual(900);
      expect(tool.description).toContain("SEVDESK_OUTPUT_DIR");
    }
    expect(datevExportTool.description).toContain("never enshrines");
    expect(datevExportTool.description).toContain("link is never shown");
  });

  it("are registered only with SEVDESK_OUTPUT_DIR (and the DATEV export only with the write tier)", () => {
    const all = new Set<Tier>(TIERS);
    expect(names({ allowedTiers: all })).toEqual([]);
    expect(names({ outputDir: "/srv/out" })).toEqual(["sevdesk_export_csv"]);
    expect(names({ outputDir: "/srv/out", allowedTiers: all })).toEqual([
      "sevdesk_datev_export",
      "sevdesk_export_csv",
    ]);
  });
});

describe("sevdesk_datev_export: prepare", () => {
  it("previews period, scope, documents, target folder and what happens, deterministically", async () => {
    const client = new FakeSevdeskClient(DATEV_ROUTES);

    const first = await prepareWrite(
      datevExportTool,
      { year: 2026, quarter: 1, scope: ["transactions", "earnings"] },
      client,
      {
        outputDir: directory,
      },
    );
    const second = await prepareWrite(
      datevExportTool,
      { year: 2026, quarter: 1, scope: ["transactions", "earnings"] },
      client,
      {
        outputDir: directory,
      },
    );

    expect(first.preview).toEqual(second.preview);
    expect(first.preview.action).toBe(
      "Start a DATEV export (CSV ZIP) in sevDesk for 2026-Q1 and save the ZIP as a new file in SEVDESK_OUTPUT_DIR.",
    );
    const facts = Object.fromEntries(first.preview.facts.map((fact) => [fact.label, fact.value]));
    expect(facts).toMatchObject({
      Period: "2026-01-01 to 2026-03-31",
      Scope: "Einnahmen (earnings), Kontoumsätze (transactions)",
      Documents: "by document date",
      "Document images": "not included",
      "DATEV accountant / client number": "1234567 / 12345",
    });
    expect(facts["Target folder"]).toContain("sevdesk-export-test-");
    expect(first.preview.warnings.join(" ")).toContain("nothing is enshrined");
    expect(first.preview.irreversible).toBe(false);
    expect(client.writes()).toEqual([]);
    expect(client.calls.map((call) => call.path)).toEqual(["/SevClient", "/SevClient"]);
  });

  it("refuses with guidance when sevDesk's DATEV settings are missing", async () => {
    const client = new FakeSevdeskClient([
      { path: "/SevClient", response: { fixture: "exports/sev-client-no-datev.json" } },
    ]);

    const error = await prepareWrite(datevExportTool, { year: 2026 }, client, {
      outputDir: directory,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "validation" });
    expect((error as Error).message).toContain("Beraternummer");
    expect((error as Error).message).toContain("Einstellungen");
    expect(client.writes()).toEqual([]);
  });

  it("refuses a missing output folder before asking sevDesk", async () => {
    const client = new FakeSevdeskClient(DATEV_ROUTES);

    await expect(
      prepareWrite(datevExportTool, { year: 2026 }, client, {
        outputDir: join(directory, "missing"),
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(client.calls).toEqual([]);
  });

  it("previews paid-only exports with document images", async () => {
    const plan = await prepareWrite(
      datevExportTool,
      { from: "2026-02-01", to: "2026-02-28", exportByPaydate: true, includeDocumentImages: true },
      new FakeSevdeskClient(DATEV_ROUTES),
      { outputDir: directory },
    );
    const facts = Object.fromEntries(plan.preview.facts.map((fact) => [fact.label, fact.value]));
    expect(facts["Documents"]).toBe("only paid documents with a pay date in the period");
    expect(facts["Document images"]).toBe("included (larger file)");
    expect(plan.preview.warnings.join(" ")).toContain("can exceed the 100 MiB");
  });

  it("refuses a period that crosses the start of a fiscal year", async () => {
    const client = new FakeSevdeskClient(DATEV_ROUTES);

    const error = await prepareWrite(
      datevExportTool,
      { from: "2025-12-01", to: "2026-01-31" },
      client,
      { outputDir: directory },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "validation" });
    expect((error as Error).message).toBe(
      "The period 2025-12-01 to 2026-01-31 crosses the start of a fiscal year (2026-01-01, from " +
        "sevDesk's DATEV settings). A DATEV export covers one fiscal year: export 2025-12-01 to " +
        "2025-12-31 and 2026-01-01 to 2026-01-31 separately. Nothing was sent.",
    );
    expect(client.writes()).toEqual([]);
  });
});

describe("sevdesk_datev_export: execute", () => {
  it("starts the job with the write tier, downloads the ZIP and saves it under sevDesk's name", async () => {
    useFetch(zipFetch());
    const client = new FakeSevdeskClient(DATEV_ROUTES);

    const { plan, output } = await executeWrite(
      datevExportTool,
      { year: 2026, quarter: 1 },
      client,
      {
        outputDir: directory,
      },
    );

    expect(client.writes()).toEqual([
      expect.objectContaining({ method: "POST", path: DATEV_JOB_PATH, tier: "write" }),
    ]);
    expect(client.writes()[0]?.query).toMatchObject({
      scope: "EXTCD",
      includeDocumentImages: "false",
    });
    expect(Object.keys(client.writes()[0]?.query ?? {})).not.toContain("enshrineDocuments");
    expect(output.affected).toEqual([{ objectName: "ExportJob", id: JOB }]);
    expect(output.data).toMatchObject({
      bytes: DATEV_ZIP.byteLength,
      period: { from: "2026-01-01", to: "2026-03-31", label: "2026-Q1" },
      scope: ["earnings", "expenditure", "transactions", "cash_register", "assets"],
      exportByPaydate: false,
      includeDocumentImages: false,
      jobId: JOB,
    });
    const savedTo = (output.data as { savedTo: string }).savedTo;
    expect(savedTo.endsWith(SEVDESK_NAME)).toBe(true);
    expect(await readFile(savedTo)).toEqual(Buffer.from(DATEV_ZIP));
    expect((await stat(savedTo)).mode & 0o777).toBe(0o600);
    expect(output.summary).toBe(
      `DATEV export 2026-Q1: saved the ZIP (8 bytes) as a new file in SEVDESK_OUTPUT_DIR; sevDesk export job ${JOB}.`,
    );

    // The presigned link and the progress hash never reach anything a model or human sees.
    const seen = visible(plan.preview, output.data, output.summary, output.affected);
    for (const secret of [LINK_HOST, SIGNATURE, "X-Amz", PROGRESS_HASH]) {
      expect(seen).not.toContain(secret);
    }
  });

  it("never overwrites: a second export gets a suffix", async () => {
    useFetch(zipFetch());

    await executeWrite(
      datevExportTool,
      { year: 2026, quarter: 1 },
      new FakeSevdeskClient(DATEV_ROUTES),
      {
        outputDir: directory,
      },
    );
    await executeWrite(
      datevExportTool,
      { year: 2026, quarter: 1 },
      new FakeSevdeskClient(DATEV_ROUTES),
      {
        outputDir: directory,
      },
    );

    expect((await readdir(directory)).sort()).toEqual([
      SEVDESK_NAME.replace(".zip", "-1.zip"),
      SEVDESK_NAME,
    ]);
  });

  it.each([
    [
      "a download that is not a ZIP",
      () => Promise.resolve(new Response("<Error/>", { status: 200 })),
    ],
    ["an expired link", () => Promise.resolve(new Response("denied", { status: 403 }))],
    [
      "a redirect",
      () =>
        Promise.resolve(
          new Response(null, { status: 307, headers: { location: "https://evil.example" } }),
        ),
    ],
    [
      "a network failure",
      () => Promise.reject(new TypeError(`fetch failed ${LINK_HOST} ${SIGNATURE}`)),
    ],
  ] as const)("names the started job and leaks no link on %s", async (_label, fetchImpl) => {
    useFetch(fetchImpl);
    const client = new FakeSevdeskClient(DATEV_ROUTES);

    const error = await executeWrite(datevExportTool, { year: 2026 }, client, {
      outputDir: directory,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).completedWrites).toEqual([{ objectName: "ExportJob", id: JOB }]);
    const seen = visible(error);
    for (const secret of [LINK_HOST, SIGNATURE, "X-Amz", PROGRESS_HASH]) {
      expect(seen).not.toContain(secret);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses a download link to another host without fetching it", async () => {
    let fetched = 0;
    useFetch(() => {
      fetched += 1;
      return Promise.resolve(new Response(DATEV_ZIP));
    });
    const routes: FakeRoute[] = DATEV_ROUTES.map((route) =>
      route.path === "/ExportJob/jobDownloadInfo"
        ? {
            path: route.path,
            response: {
              body: {
                objects: { link: `https://evil.example.com/x?${SIGNATURE}`, filename: "x.zip" },
              },
            },
          }
        : route,
    );

    const error = await executeWrite(
      datevExportTool,
      { year: 2026 },
      new FakeSevdeskClient(routes),
      {
        outputDir: directory,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "unexpected_response" });
    expect(fetched).toBe(0);
    expect(visible(error)).not.toContain("evil.example.com");
  });

  const failingStart = (error: SevdeskError): FakeRoute[] =>
    DATEV_ROUTES.map((route) =>
      route.path === DATEV_JOB_PATH
        ? { method: "POST", path: DATEV_JOB_PATH, response: { error } }
        : route,
    );

  it("reports a job sevDesk refused without claiming one", async () => {
    const routes = failingStart(
      new SevdeskError({ kind: "validation", message: "sevDesk refused.", status: 422 }),
    );

    const error = await executeWrite(
      datevExportTool,
      { year: 2026 },
      new FakeSevdeskClient(routes),
      {
        outputDir: directory,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "validation", completedWrites: [] });
    expect((error as Error).message).not.toContain(MAY_HAVE_STARTED);
  });

  it.each(["timeout", "network", "server"] as const)(
    "says the job may have started when the start ends in %s",
    async (kind) => {
      const routes = failingStart(new SevdeskError({ kind, message: "No answer.", status: 500 }));

      const error = await executeWrite(
        datevExportTool,
        { year: 2026 },
        new FakeSevdeskClient(routes),
        { outputDir: directory },
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ kind, completedWrites: [], status: 500 });
      expect((error as Error).message).toBe(`No answer. ${MAY_HAVE_STARTED}`);
    },
  );

  it("wraps an unexpected failure after the job started and names the job", async () => {
    useFetch(zipFetch());
    const client = new FakeSevdeskClient(DATEV_ROUTES);
    const plan = await prepareWrite(datevExportTool, { year: 2026 }, client, {
      outputDir: directory,
    });
    const ctx = {
      ...testContext(client),
      progress: () => Promise.reject(new Error("transport closed")),
    };

    const error = await datevExportTool
      .execute(datevExportTool.input.parse({ year: 2026 }), plan, ctx)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({ completedWrites: [{ objectName: "ExportJob", id: JOB }] });
    expect((error as Error).message).toContain(`after sevDesk started export job ${JOB}`);
  });

  it("turns a file system failure into a trusted error that names the started job", async () => {
    useFetch(zipFetch());
    const client = new FakeSevdeskClient(DATEV_ROUTES);
    const plan = await prepareWrite(datevExportTool, { year: 2026 }, client, {
      outputDir: directory,
    });
    await rm(directory, { recursive: true, force: true });

    const error = await datevExportTool
      .execute(datevExportTool.input.parse({ year: 2026 }), plan, testContext(client))
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      kind: "validation",
      completedWrites: [{ objectName: "ExportJob", id: JOB }],
    });
    expect((error as Error).message).toMatch(
      /^The file could not be saved in SEVDESK_OUTPUT_DIR \(ENOENT\)\.$/,
    );
  });
});

describe("sevdesk_export_csv", () => {
  const csv = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    ...new TextEncoder().encode(
      `"Nummer";"Rechnungs-Datum";"Betrag"\n"RE-1";"05.01.2026";"119,00"\n"RE-2";"06.01.2026";"5,00"\n`,
    ),
  ]);

  it("saves sevDesk's CSV as it is and reports size and rows, never the content", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Export/invoiceCsv",
        response: { bytes: csv, contentType: "text/csv; charset=UTF-8" },
      },
    ]);
    const ctx = testContext(client, { SEVDESK_OUTPUT_DIR: directory });

    const args = exportCsvTool.input.parse({
      kind: "invoices",
      from: "2026-01-01",
      to: "2026-01-31",
      limit: 2,
    });
    const result = await exportCsvTool.handler(args, ctx);

    const data = exportCsvTool.output.parse(result.data);
    expect(data).toMatchObject({
      kind: "invoices",
      bytes: csv.byteLength,
      contentType: "text/csv; charset=UTF-8",
      bom: true,
      rows: 2,
      limit: 2,
      mayBeTruncated: true,
      from: "2026-01-01",
      to: "2026-01-31",
      periodCheck: {
        column: "Rechnungs-Datum",
        rowsOutsidePeriod: 0,
        rowsUnchecked: 0,
        verified: true,
      },
      warnings: ["The file has the maximum of 2 rows; more may exist."],
    });
    expect(data.savedTo.endsWith("invoices_2026-01-01_2026-01-31.csv")).toBe(true);
    expect(await readFile(data.savedTo)).toEqual(Buffer.from(csv));
    expect(JSON.stringify(result)).not.toContain("RE-1");
    expect(result.summary).toBe(
      `CSV export of invoices: 2 rows (${String(csv.byteLength)} bytes) saved as a new file in SEVDESK_OUTPUT_DIR; nothing changed in sevDesk.`,
    );
    expect(client.writes()).toEqual([]);
  });

  it("warns when the file's dates do not all lie in the period", async () => {
    const outside = new TextEncoder().encode(
      `"Nummer";"Rechnungs-Datum"\n"RE-1";"05.01.2026"\n"RE-2";"05.02.2026"\n`,
    );
    const noColumn = new TextEncoder().encode(`"Nummer";"Wann"\n"GU-1";"05.01.2026"\n`);
    const client = new FakeSevdeskClient([
      { path: "/Export/invoiceCsv", response: { bytes: outside } },
      { path: "/Export/creditNoteCsv", response: { bytes: noColumn } },
    ]);
    const ctx = testContext(client, { SEVDESK_OUTPUT_DIR: directory });

    const invoices = await exportCsvTool.handler(
      exportCsvTool.input.parse({ kind: "invoices", from: "2026-01-01", to: "2026-01-31" }),
      ctx,
    );
    expect(invoices.data.warnings).toEqual([
      "1 row(s) are dated outside from/to and 0 have no readable date: the file does not cover " +
        "only the requested period; filter it before use.",
    ]);
    expect(invoices.summary).toContain("Not every row could be confirmed");

    const creditNotes = await exportCsvTool.handler(
      exportCsvTool.input.parse({ kind: "credit_notes", from: "2026-01-01" }),
      ctx,
    );
    expect(creditNotes.data.warnings[0]).toContain("no date column this server knows");
    expect(creditNotes.data.periodCheck).toEqual({
      rowsOutsidePeriod: 0,
      rowsUnchecked: 1,
      verified: false,
    });
  });

  it("exports contacts without a date range and checks the folder first", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Export/contactListCsv", response: { bytes: csv } },
    ]);
    const ok = await exportCsvTool.handler(
      exportCsvTool.input.parse({ kind: "contacts" }),
      testContext(client, { SEVDESK_OUTPUT_DIR: directory }),
    );
    expect(ok.data).toMatchObject({ limit: 1000, mayBeTruncated: false });
    expect(ok.data).not.toHaveProperty("contentType");

    const before = client.calls.length;
    await expect(
      exportCsvTool.handler(
        exportCsvTool.input.parse({ kind: "contacts" }),
        testContext(client, { SEVDESK_OUTPUT_DIR: join(directory, "nope") }),
      ),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(client.calls.length).toBe(before);
  });
});
