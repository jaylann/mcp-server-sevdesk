/**
 * Export tools (M4), both handing their file out only through `ToolContext.files`: a new file in
 * `SEVDESK_OUTPUT_DIR` (never overwriting), or over HTTP with file transfer a download link. Both
 * are registered only when files can be delivered (`canDeliverFiles`), and both check the
 * delivery (`checkDelivery`) before their first sevDesk request:
 *
 * - `sevdesk_datev_export` (write tier): starts sevDesk's DATEV export job, waits for it, downloads
 *   the ZIP from the presigned link (never shown to the model) and saves it. A write because the
 *   job is a request that changes state in sevDesk (it may mark the exported documents as
 *   exported); it never enshrines.
 * - `sevdesk_csv_export` (read tier, `writes-files`): one of sevDesk's CSV exports, saved as is.
 */
import { z } from "zod";

import { dateRangeInputShape } from "../../domain/common.js";
import {
  CSV_EXPORT_KINDS,
  CSV_EXPORTS,
  csvFilename,
  exportCsv,
  MAX_CSV_ROWS,
} from "../../domain/exports/csv.js";
import {
  DATEV_SCOPE_KEYS,
  datevFilename,
  type DatevJobParams,
  exportFilename,
  fiscalYearStartWithin,
  looksLikeZip,
  MAY_HAVE_STARTED,
  readDatevExportConfig,
  SCOPE_LABELS,
  startDatevExportJob,
  waitForDatevExport,
} from "../../domain/exports/datev.js";
import { shiftDays } from "../../domain/reports/shared.js";
import { resolvePeriod } from "../../domain/reports/vat.js";
import { canDeliverFiles } from "../../safety/file-access.js";
import { SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import { downloadPresignedExport } from "../../sevdesk/export-download.js";
import { defineTool, defineWriteTool } from "../define-tool.js";
import { deliveryData, deliveryOutputShape, downloadText } from "../documents/delivery.js";
import { refused } from "../documents/save-file.js";
import type { AnyToolDefinition, ExecuteContext, SevdeskObjectRef } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { periodInputShape } from "./period-input.js";

// ---------------------------------------------------------------------------------------------
// DATEV
// ---------------------------------------------------------------------------------------------

const datevOutput = z.object({
  ...deliveryOutputShape,
  bytes: z.number().int(),
  period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  scope: z.array(z.enum(DATEV_SCOPE_KEYS)),
  exportByPaydate: z.boolean(),
  includeDocumentImages: z.boolean(),
  jobId: z.string().describe("sevDesk's export job id (ExportJob)."),
});

interface DatevPlanState {
  readonly params: DatevJobParams;
  readonly label: string;
}

/** Saved files' content is never parsed or returned; only their size and where they went. */
export const datevExportTool = defineWriteTool({
  name: "sevdesk_datev_export",
  title: "DATEV export to a ZIP file",
  description:
    "DATEV-Export: let sevDesk build the DATEV booking data (Buchungsstapel, CSV in a ZIP) for a " +
    "month, quarter, year or date range and save the ZIP as a new file in SEVDESK_OUTPUT_DIR " +
    "(on a remote server: a download link for the user), e.g. for the tax adviser " +
    "(Steuerberater). scope picks earnings, expenditure, transactions, " +
    "cash register and assets (default all); exportByPaydate keeps only documents paid in the " +
    "period; includeDocumentImages adds the receipts (larger). Write tier: it starts an export " +
    "job in sevDesk, which may mark the documents as exported; it never enshrines " +
    "(festschreiben). Needs the DATEV settings in sevDesk (Beraternummer, Mandantennummer, " +
    "Wirtschaftsjahresbeginn); refused with guidance when they are missing. dryRun previews. " +
    "The download link is never shown. Takes up to a few minutes.",
  toolset: "reports",
  tier: "write",
  localEffects: "writes-files",
  available: canDeliverFiles,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    ...periodInputShape,
    scope: z
      .array(z.enum(DATEV_SCOPE_KEYS))
      .min(1)
      .default([...DATEV_SCOPE_KEYS])
      .describe(
        "What to include: earnings (Einnahmen), expenditure (Ausgaben), transactions " +
          "(Kontoumsätze), cash_register (Kasse), assets (Anlagen). Default all.",
      ),
    exportByPaydate: z
      .boolean()
      .optional()
      .describe("Only paid documents whose pay date lies in the period (Zahlungsdatum)."),
    includeDocumentImages: z
      .boolean()
      .default(false)
      .describe("Add the document images (Belegbilder) to the ZIP; makes it much larger."),
    ...dryRunInputShape,
  }),
  output: datevOutput,
  prepare: async (args, ctx) => {
    const period = resolvePeriod(args);
    // Local checks first: a misconfiguration costs no sevDesk request.
    await ctx.files.checkDelivery();
    const delivery = ctx.files.describeDelivery();
    const config = await readDatevExportConfig(ctx.client, ctx.signal);
    if (config.missing.length > 0) {
      throw refused(
        `The DATEV export needs sevDesk's DATEV settings, which are missing: ` +
          `${config.missing.join(", ")}. The user sets them once in sevDesk (Einstellungen → ` +
          "DATEV-Export), then calls this tool again. Nothing was sent",
      );
    }
    const yearStart =
      config.accountingYearBegin === undefined
        ? undefined
        : fiscalYearStartWithin(period.from, period.to, config.accountingYearBegin);
    if (yearStart !== undefined) {
      throw refused(
        `The period ${period.from} to ${period.to} crosses the start of a fiscal year ` +
          `(${yearStart}, from sevDesk's DATEV settings). A DATEV export covers one fiscal year: ` +
          `export ${period.from} to ${shiftDays(yearStart, -1)} and ${yearStart} to ${period.to} ` +
          "separately. Nothing was sent",
      );
    }
    const params: DatevJobParams = {
      from: period.from,
      to: period.to,
      scope: args.scope,
      exportByPaydate: args.exportByPaydate,
      includeDocumentImages: args.includeDocumentImages,
    };
    const scope = DATEV_SCOPE_KEYS.filter((key) => args.scope.includes(key));
    return {
      preview: {
        action:
          `Start a DATEV export (CSV ZIP) in sevDesk for ${period.label} and provide the ZIP as ` +
          `${delivery}.`,
        facts: [
          { label: "Period", value: `${period.from} to ${period.to}` },
          { label: "Scope", value: scope.map((key) => SCOPE_LABELS[key]).join(", ") },
          {
            label: "Documents",
            value:
              args.exportByPaydate === true
                ? "only paid documents with a pay date in the period"
                : "by document date",
          },
          {
            label: "Document images",
            value: args.includeDocumentImages ? "included (larger file)" : "not included",
          },
          {
            label: "DATEV accountant / client number",
            value: `${config.accountantNumber ?? ""} / ${config.accountantClientNumber ?? ""}`,
          },
          { label: "Delivered as", value: delivery },
          {
            label: "File name",
            value:
              "as sevDesk names the export (BITTE-ENTPACKEN_Buchungsstapel_…zip), a suffix is " +
              "added if taken",
          },
        ],
        warnings: [
          "sevDesk starts an export job and may note the export internally; the documents are " +
            "not locked (nothing is enshrined, festgeschrieben).",
          "sevDesk keeps the ZIP behind a download link for 7 days; this server downloads it " +
            "once and never shows the link.",
          ...(args.includeDocumentImages
            ? [
                "With document images the ZIP can exceed the 100 MiB this server downloads; then " +
                  "nothing is saved and the export has to be downloaded in sevDesk.",
              ]
            : []),
        ],
        irreversible: false,
      },
      state: { params, label: period.label } satisfies DatevPlanState,
    };
  },
  execute: async (_args, plan, ctx) => {
    const { params, label } = plan.state;
    const jobId = await startJob(ctx, params);
    const job: SevdeskObjectRef = { objectName: "ExportJob", id: jobId };
    try {
      const info = await waitForDatevExport(ctx.client, jobId, {
        signal: ctx.signal,
        onProgress: (done, total, message) => ctx.progress(done, total, message),
      });
      const download = await downloadPresignedExport(info.link, { signal: ctx.signal });
      if (!looksLikeZip(download.bytes)) {
        throw new SevdeskError({
          kind: "unexpected_response",
          message: "The DATEV export download is not a ZIP file; nothing was saved.",
        });
      }
      const delivery = await ctx.files.deliver({
        filename: exportFilename(info.filename, datevFilename(params)),
        kind: "zip",
        bytes: download.bytes,
      });
      const size = String(download.bytes.byteLength);
      return {
        data: {
          ...deliveryData(delivery),
          bytes: download.bytes.byteLength,
          period: { from: params.from, to: params.to, label },
          scope: DATEV_SCOPE_KEYS.filter((key) => params.scope.includes(key)),
          exportByPaydate: params.exportByPaydate === true,
          includeDocumentImages: params.includeDocumentImages === true,
          jobId,
        },
        summary:
          "download" in delivery
            ? `DATEV export ${label}: the ZIP (${size} bytes) is ready as ` +
              `${downloadText(delivery.download)}; sevDesk export job ${jobId}.`
            : `DATEV export ${label}: saved the ZIP (${size} bytes) as a new file in ` +
              `SEVDESK_OUTPUT_DIR; sevDesk export job ${jobId}.`,
        affected: [job],
      };
    } catch (error) {
      // The job was started in sevDesk: say so, so it is fetched there instead of started again.
      if (error instanceof SevdeskError) throw withCompletedWrites(error, [job]);
      throw new SevdeskError({
        kind: "unexpected_response",
        message:
          `The DATEV export failed after sevDesk started export job ${jobId}; download it in ` +
          "sevDesk (Export → DATEV) instead of starting another one.",
        completedWrites: [job],
      });
    }
  },
});

/** Failures of the job start after which the job may still have been created in sevDesk. */
const UNCERTAIN_START: ReadonlySet<SevdeskError["kind"]> = new Set([
  "timeout",
  "network",
  "aborted",
  "server",
]);

/**
 * Starts the export job. When the request may have reached sevDesk without an answer (timeout,
 * network, cancellation, server error), the error says that a job may exist.
 */
async function startJob(ctx: ExecuteContext, params: DatevJobParams): Promise<string> {
  try {
    return await startDatevExportJob(ctx.client, params, ctx.signal);
  } catch (error) {
    if (!(error instanceof SevdeskError) || !UNCERTAIN_START.has(error.kind)) throw error;
    throw new SevdeskError({
      kind: error.kind,
      message: `${error.message} ${MAY_HAVE_STARTED}`,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.upstreamMessage === undefined ? {} : { upstreamMessage: error.upstreamMessage }),
      ...(error.exceptionUuid === undefined ? {} : { exceptionUuid: error.exceptionUuid }),
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

const csvOutput = z.object({
  subject: z.enum(CSV_EXPORT_KINDS),
  ...deliveryOutputShape,
  bytes: z.number().int(),
  mimeType: z.string().optional().describe("As sevDesk sent it, e.g. text/csv; charset=UTF-8."),
  bom: z.boolean().describe("The file starts with a UTF-8 byte order mark (as sevDesk sends it)."),
  rows: z.number().int().describe("Data rows after the header."),
  limit: z.number().int(),
  mayBeTruncated: z
    .boolean()
    .describe("True when rows reached limit: more records may exist; narrow from/to."),
  from: z.string().optional(),
  to: z.string().optional(),
  periodCheck: z
    .object({
      column: z.string().optional().describe("Date column checked; absent when none was found."),
      rowsOutsidePeriod: z.number().int().describe("Rows dated outside from/to."),
      rowsUnchecked: z.number().int().describe("Rows without a readable date."),
      verified: z
        .boolean()
        .describe("True only when every row was checked and lies inside from/to."),
    })
    .optional()
    .describe(
      "With from/to: the file's date column checked here as a safety net after sevDesk's own " +
        "date filter. When verified is false, the warnings say what did not match.",
    ),
  warnings: z.array(z.string()).describe("Trusted caveats about the file."),
});

/** `sevdesk_csv_export`: one of sevDesk's CSV exports, as a new file or a download link. */
export const csvExportTool = defineTool({
  name: "sevdesk_csv_export",
  title: "CSV export to a file",
  description:
    "CSV-Export from sevDesk: invoices (Rechnungen), credit_notes (Gutschriften), vouchers " +
    "(Belege), transactions (Kontoumsätze) or contacts (Kontakte), saved as a new file in " +
    "SEVDESK_OUTPUT_DIR (on a remote server: a download link for the user) exactly as sevDesk " +
    "sends it (UTF-8 with BOM, ';' separated, German " +
    `headers), e.g. for Excel or the tax adviser. from/to filter by date in sevDesk (not for ` +
    "contacts); the file's date column is checked as well (periodCheck); " +
    `at most ${String(MAX_CSV_ROWS)} rows per file (mayBeTruncated says when more may exist). ` +
    "Returns the path or link, size and row count, never the content; nothing changes in " +
    "sevDesk. Every call creates another file. For totals use sevdesk_records_summarize instead.",
  toolset: "reports",
  tier: "read",
  localEffects: "writes-files",
  available: canDeliverFiles,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    subject: z
      .enum(CSV_EXPORT_KINDS)
      .describe("invoices, credit_notes, vouchers, transactions or contacts."),
    ...dateRangeInputShape,
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_CSV_ROWS)
      .default(MAX_CSV_ROWS)
      .describe(`Most rows, 1–${String(MAX_CSV_ROWS)}.`),
  }),
  output: csvOutput,
  handler: async (args, ctx) => {
    // The delivery is checked first, so a misconfiguration costs no sevDesk request.
    await ctx.files.checkDelivery();
    const params = { kind: args.subject, from: args.from, to: args.to, limit: args.limit };
    const file = await exportCsv(ctx.client, params, ctx.signal);
    const delivery = await ctx.files.deliver({
      filename: csvFilename(params),
      kind: "csv",
      bytes: file.bytes,
    });
    const noun = CSV_EXPORTS[args.subject].noun;
    const check = file.periodCheck;
    const warnings: string[] = [];
    if (check !== undefined && !check.verified) {
      warnings.push(
        check.column === undefined
          ? "The file has no date column this server knows, so whether it covers only from/to " +
              "was not checked."
          : `${String(check.rowsOutsidePeriod)} row(s) are dated outside from/to and ` +
              `${String(check.rowsUnchecked)} have no readable date: the file does not cover ` +
              "only the requested period; filter it before use.",
      );
    }
    if (file.rows >= args.limit) {
      warnings.push(`The file has the maximum of ${String(args.limit)} rows; more may exist.`);
    }
    return {
      data: {
        subject: args.subject,
        ...deliveryData(delivery),
        bytes: file.bytes.byteLength,
        ...(file.contentType === undefined ? {} : { mimeType: file.contentType }),
        bom: file.bom,
        rows: file.rows,
        limit: args.limit,
        mayBeTruncated: file.rows >= args.limit,
        ...(args.from === undefined ? {} : { from: args.from }),
        ...(args.to === undefined ? {} : { to: args.to }),
        ...(check === undefined ? {} : { periodCheck: check }),
        warnings,
      },
      summary:
        `CSV export of ${noun}: ${String(file.rows)} rows (${String(file.bytes.byteLength)} ` +
        `bytes) ${
          "download" in delivery
            ? `ready as ${downloadText(delivery.download)}`
            : "saved as a new file in SEVDESK_OUTPUT_DIR"
        }; nothing changed in sevDesk.` +
        (check !== undefined && !check.verified
          ? " Not every row could be confirmed to lie in the requested period (see warnings)."
          : ""),
    };
  },
});

/** Export tools, M4: the DATEV export job and CSV exports, as files or download links. */
export const REPORT_EXPORT_TOOLS: readonly AnyToolDefinition[] = [datevExportTool, csvExportTool];
