import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DATEV_JOB_PATH } from "../../src/domain/exports/datev.js";
import { swapPresignedFetch } from "../../src/sevdesk/export-download.js";
import { datevExportTool } from "../../src/tools/reports/export-tools.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import type { WriteToolCase } from "../helpers/write-cases.js";

/** The bytes of a tiny ZIP (local file header magic first). */
export const DATEV_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

/** The routes of a DATEV export that is already done at the first progress poll. */
export const DATEV_ROUTES: readonly FakeRoute[] = [
  { path: "/SevClient", response: { fixture: "exports/sev-client-datev.json" } },
  { method: "POST", path: DATEV_JOB_PATH, response: { fixture: "exports/datev-job-start.json" } },
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

/** A presigned-download fetch that answers every request with {@link DATEV_ZIP}. */
export function zipFetch(): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(DATEV_ZIP, { status: 200, headers: { "content-type": "binary/octet-stream" } }),
    );
}

/** Known-good cases of the M4 reports write tools. */
export const REPORTS_CASES: readonly WriteToolCase[] = [
  {
    label: "export a quarter to DATEV",
    tool: datevExportTool,
    args: { year: 2026, quarter: 1 },
    routes: DATEV_ROUTES,
    writes: [{ method: "POST", path: DATEV_JOB_PATH }],
    setup: async () => {
      const directory = await mkdtemp(join(tmpdir(), "sevdesk-datev-case-"));
      const restore = swapPresignedFetch(zipFetch());
      return {
        config: { outputDir: directory },
        undo: async () => {
          restore();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  },
];
