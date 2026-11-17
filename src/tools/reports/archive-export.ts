/**
 * `sevdesk_archive_export`: every invoice PDF or every voucher receipt of a period as one ZIP from
 * sevDesk (`GET /Export/invoiceZip`, `/Export/voucherZip`; `src/domain/exports/archive.ts`),
 * handed out like the DATEV ZIP through `ToolContext.files`.
 *
 * Tier `write`, like the DATEV export: it changes no document (recorded, D-101), but sevDesk
 * renders every PDF of the period on request, a heavy job that is never retried; the client
 * treats both endpoints as side effects. Drafts are included by sevDesk; the result counts the
 * entries named like drafts and says so, since a tax adviser expects only issued documents.
 */
import { z } from "zod";

import { amountInput } from "../../domain/common.js";
import {
  ARCHIVE_EXPORTS,
  ARCHIVE_SUBJECTS,
  archiveFilename,
  type ArchiveParams,
  checkArchiveParams,
  DEFAULT_ARCHIVE_DOCUMENTS,
  exportArchive,
  MAX_ARCHIVE_DOCUMENTS,
  mayBeTruncated,
} from "../../domain/exports/archive.js";
import { resolvePeriod } from "../../domain/reports/vat.js";
import { canDeliverFiles } from "../../safety/file-access.js";
import { defineWriteTool } from "../define-tool.js";
import { deliveryData, deliveryOutputShape, downloadText } from "../documents/delivery.js";
import { dryRunInputShape } from "../write-input.js";
import { periodInputShape } from "./period-input.js";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const archiveOutput = z.object({
  subject: z.enum(ARCHIVE_SUBJECTS),
  ...deliveryOutputShape,
  bytes: z
    .number()
    .int()
    .describe("Size of the ZIP; 0 when nothing matched and nothing was saved."),
  period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  entries: z
    .number()
    .int()
    .describe(
      "Documents in the ZIP, one file each. Can be lower than the documents listed: vouchers " +
        "without a receipt file are not included. 0 when nothing matched.",
    ),
  pdfEntries: z.number().int().describe("Entries that are PDF files."),
  draftEntries: z
    .number()
    .int()
    .describe(
      'Entries named like drafts: sevDesk includes drafts and names them with "(Entwurf)" ' +
        "after the document kind.",
    ),
  limit: z.number().int(),
  mayBeTruncated: z
    .boolean()
    .describe(
      "True when entries came within 2 % of limit: sevDesk may have stopped there and more " +
        "documents may exist; narrow the period. False is no proof that every document is in " +
        "the ZIP: documents without a file (vouchers without a receipt) may count against limit.",
    ),
  warnings: z.array(z.string()).describe("Trusted caveats about the archive."),
});

interface ArchivePlanState {
  readonly params: ArchiveParams;
  readonly label: string;
}

/**
 * Only entries labelled `(Entwurf)` count as drafts (`isDraftEntry`): the advice to take them out
 * must never hit a document with another label, such as a cancellation the tax audit needs.
 */
const DRAFTS_INCLUDED =
  'sevDesk includes drafts in the archive, named with "(Entwurf)" and without a number; ' +
  "remove them before handing the archive to the tax adviser.";

/**
 * Why an archive can hold fewer files than the document lists show (recorded, D-101): not an
 * error, but worth saying so nobody takes the archive as complete.
 */
const COVERAGE: Readonly<Record<ArchiveParams["subject"], string>> = {
  invoices:
    "The archive can hold fewer invoices than sevdesk_invoices_list shows (one fewer when " +
    "recorded); compare the count there when completeness matters.",
  vouchers:
    "Only vouchers with an uploaded receipt file are in the archive; vouchers without a file " +
    "are left out, so it can hold fewer files than vouchers. Compare the count with " +
    "sevdesk_vouchers_list when completeness matters.",
};

export const archiveExportTool = defineWriteTool({
  name: "sevdesk_archive_export",
  title: "Invoice or voucher PDFs as a ZIP file",
  description:
    "Belegarchiv: let sevDesk put every invoice PDF (Rechnungen) or every voucher receipt " +
    "(Belege) of a month, quarter, year or date range into one ZIP and save it as a new file in " +
    "SEVDESK_OUTPUT_DIR (on a remote server: a download link for the user), e.g. for the tax " +
    "adviser or a tax audit (Betriebsprüfung). contactId narrows invoices to one customer, " +
    "minAmount/maxAmount narrow by amount. sevDesk includes drafts (draftEntries counts them); " +
    "vouchers without a receipt file are not in it. Nothing changes on any document; write " +
    "tier because sevDesk renders every PDF first: about a minute per 100 invoices, stopped " +
    "after 5 minutes; the remedy is a shorter period. limit: documents asked for (default " +
    `${String(DEFAULT_ARCHIVE_DOCUMENTS)}, up to ${String(MAX_ARCHIVE_DOCUMENTS)}; ` +
    "mayBeTruncated hints at a cut); at most 100 MiB per ZIP. Returns the path or link and " +
    "counts, never the content. dryRun previews.",
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
    subject: z
      .enum(ARCHIVE_SUBJECTS)
      .describe("invoices (Rechnungen, the rendered PDFs) or vouchers (Belege, the receipts)."),
    ...periodInputShape,
    contactId: positiveId
      .optional()
      .describe("Invoices only: only this customer's invoices (contact id)."),
    minAmount: amountInput()
      .optional()
      .describe("Smallest amount in EUR (inclusive), e.g. 100.00; for vouchers the gross amount."),
    maxAmount: amountInput()
      .optional()
      .describe("Largest amount in EUR (inclusive); for vouchers the gross amount."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_DOCUMENTS)
      .default(DEFAULT_ARCHIVE_DOCUMENTS)
      .describe(
        `Most documents to ask sevDesk for, 1–${String(MAX_ARCHIVE_DOCUMENTS)}. The default ` +
          "fits the time and size limits (about 0.5 s and 140–190 KB per invoice).",
      ),
    ...dryRunInputShape,
  }),
  output: archiveOutput,
  prepare: async (args, ctx) => {
    const period = resolvePeriod(args);
    const params: ArchiveParams = {
      subject: args.subject,
      from: period.from,
      to: period.to,
      limit: args.limit,
      contactId: args.contactId,
      minAmount: args.minAmount,
      maxAmount: args.maxAmount,
    };
    checkArchiveParams(params);
    // Local checks only: the preview costs no sevDesk request.
    await ctx.files.checkDelivery();
    const delivery = ctx.files.describeDelivery();
    const noun = ARCHIVE_EXPORTS[args.subject].noun;
    const amounts =
      args.minAmount === undefined && args.maxAmount === undefined
        ? undefined
        : `${args.minAmount ?? "any"} to ${args.maxAmount ?? "any"} EUR` +
          (args.subject === "vouchers" ? " gross" : "");
    return {
      preview: {
        action:
          `Let sevDesk put the ${noun} of ${period.label} into one ZIP and provide it as ` +
          `${delivery}.`,
        facts: [
          {
            label: "Documents",
            value:
              args.subject === "invoices"
                ? "invoices (rendered PDFs)"
                : "vouchers (uploaded receipts)",
          },
          { label: "Period", value: `${period.from} to ${period.to}` },
          ...(args.contactId === undefined
            ? []
            : [{ label: "Contact", value: `contact ${String(args.contactId)}` }]),
          ...(amounts === undefined ? [] : [{ label: "Amounts", value: amounts }]),
          { label: "At most", value: `${String(args.limit)} documents` },
          { label: "Delivered as", value: delivery },
          { label: "File name", value: archiveFilename(params) },
        ],
        warnings: [
          "Nothing changes on any document: no status, no send date, nothing enshrined " +
            "(festgeschrieben).",
          DRAFTS_INCLUDED,
          COVERAGE[args.subject],
          "sevDesk renders every PDF of the period before it answers: a large archive takes " +
            "minutes and is stopped after 5; a ZIP above 100 MiB is not saved. The remedy for " +
            "both is a shorter period.",
        ],
        irreversible: false,
      },
      state: { params, label: period.label } satisfies ArchivePlanState,
    };
  },
  execute: async (_args, plan, ctx) => {
    const { params, label } = plan.state;
    const noun = ARCHIVE_EXPORTS[params.subject].noun;
    // sevDesk answers only once the whole ZIP is rendered (up to minutes): tell the client.
    await ctx.progress(
      0,
      undefined,
      `sevDesk is rendering the ${noun} of ${label} into one ZIP; this can take minutes.`,
    );
    const archive = await exportArchive(ctx.client, params, ctx.signal);
    const period = { from: params.from, to: params.to, label };
    const truncated = mayBeTruncated(archive.entries, params.limit);
    // No sevDesk record changed; the audit log names the export request itself.
    const affected = [
      {
        objectName: "DocumentArchive",
        id: archiveFilename(params).replace(/\.zip$/, ""),
      },
    ];
    const warnings = [
      ...(archive.draftEntries > 0
        ? [
            `${String(archive.draftEntries)} entr${archive.draftEntries === 1 ? "y is" : "ies are"} named like drafts. ${DRAFTS_INCLUDED}`,
          ]
        : []),
      ...(truncated
        ? [
            `The ZIP holds ${String(archive.entries)} files, close to the limit of ` +
              `${String(params.limit)} documents: sevDesk may have stopped there, so more may ` +
              "exist. Export a shorter period" +
              (params.limit < MAX_ARCHIVE_DOCUMENTS
                ? ` or raise limit (up to ${String(MAX_ARCHIVE_DOCUMENTS)}).`
                : "."),
          ]
        : []),
      ...(archive.entries > 0 ? [COVERAGE[params.subject]] : []),
    ];
    const counts = {
      entries: archive.entries,
      pdfEntries: archive.pdfEntries,
      draftEntries: archive.draftEntries,
      limit: params.limit,
      mayBeTruncated: truncated,
    };
    if (archive.entries === 0) {
      return {
        data: { subject: params.subject, bytes: 0, period, ...counts, warnings },
        summary:
          `No ${noun} ${params.subject === "vouchers" ? "with a receipt file " : ""}matched ` +
          `${label} and the filters; nothing was saved and nothing changed in sevDesk.`,
        affected,
      };
    }
    const delivery = await ctx.files.deliver({
      filename: archiveFilename(params),
      kind: "zip",
      bytes: archive.bytes,
    });
    const size = String(archive.bytes.byteLength);
    return {
      data: {
        subject: params.subject,
        ...deliveryData(delivery),
        bytes: archive.bytes.byteLength,
        period,
        ...counts,
        warnings,
      },
      summary:
        `Archive of ${noun} ${label}: ${String(archive.entries)} files (${size} bytes) ` +
        ("download" in delivery
          ? `ready as ${downloadText(delivery.download)}`
          : "saved as a new file in SEVDESK_OUTPUT_DIR") +
        `; nothing changed in sevDesk.` +
        (archive.draftEntries > 0
          ? ` ${String(archive.draftEntries)} of them ` +
            `${archive.draftEntries === 1 ? "is a draft" : "are drafts"} (see warnings).`
          : ""),
      affected,
    };
  },
});
