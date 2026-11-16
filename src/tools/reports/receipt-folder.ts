/**
 * `sevdesk_receipt_folder_check`: which receipt files of a local folder are booked in sevDesk.
 * A read tool: it reads files inside `SEVDESK_FILE_DIRS` through `ctx.files` (checksums only, no
 * content leaves the server) and the voucher list, and changes nothing. Offered only where the
 * server can read local folders (`canReadFolders`): an upload over HTTP is a single file. The
 * matching lives in `src/domain/reports/audit/receipt-folder.ts`, the folder scan and its
 * confinement in `src/safety/local-folder.ts`.
 */
import { z } from "zod";

import {
  RECEIPT_MARGIN_DAYS,
  receiptFolderResultSchema,
  receiptFolderSentence,
  runReceiptFolderCheck,
} from "../../domain/reports/audit/receipt-folder.js";
import { deadlineReached } from "../../domain/reports/shared.js";
import { resolvePeriod } from "../../domain/reports/vat.js";
import { canReadFolders } from "../../safety/file-access.js";
import { FOLDER_SCAN_LIMITS } from "../../safety/local-folder.js";
import { defineTool } from "../define-tool.js";
import { periodInputShape } from "./period-input.js";
import { taxReportRunOptions } from "./tax-tools.js";

const MIB = 1024 * 1024;

/** `sevdesk_receipt_folder_check`: local receipt files against the vouchers' receipt files. */
export const receiptFolderCheckTool = defineTool({
  name: "sevdesk_receipt_folder_check",
  title: "Check a receipt folder against sevDesk",
  description:
    "Compare a local folder of receipts (Belege: PDF, PNG, JPEG, XML) inside SEVDESK_FILE_DIRS " +
    "with the receipt files attached to the vouchers in sevDesk, by SHA-256 checksum: finds " +
    "receipts probably never booked (Beleg nicht gebucht), files only on a draft, and files " +
    "booked twice. Give the period the receipts belong to (year with month or quarter, or " +
    `from/to): vouchers dated ${String(RECEIPT_MARGIN_DAYS)} days before to ` +
    `${String(RECEIPT_MARGIN_DAYS)} days after it are compared, drafts included. Reads at most ` +
    `${String(FOLDER_SCAN_LIMITS.maxFiles)} files of up to ` +
    `${String(FOLDER_SCAN_LIMITS.maxFileBytes / MIB)} MB and never sends or returns their ` +
    "content: only paths, sizes, dates and checksums. No match is a hint, not proof: the same " +
    "receipt as another file (a scan, a photo from the sevDesk app, a converted copy) has " +
    "another checksum; amounts, dates and suppliers are not compared. Changes nothing. To book " +
    "a file: sevdesk_voucher_create_draft with it as file.",
  toolset: "reports",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  localEffects: "reads-files",
  available: canReadFolders,
  input: z.strictObject({
    folder: z
      .string()
      .min(1)
      .max(1_024)
      .optional()
      .describe(
        "The folder: an absolute path inside one of the SEVDESK_FILE_DIRS folders, or a path " +
          "relative to one of them, e.g. 2026/03. Default: every SEVDESK_FILE_DIRS folder.",
      ),
    subfolders: z
      .boolean()
      .optional()
      .describe(
        `Also read subfolders, up to ${String(FOLDER_SCAN_LIMITS.maxDepth)} levels deep. ` +
          "Default false.",
      ),
    ...periodInputShape,
  }),
  output: receiptFolderResultSchema,
  handler: async (args, ctx) => {
    // The period first: a wrong one is refused before the folder is touched.
    const period = resolvePeriod(args);
    const options = taxReportRunOptions(ctx);
    const subfolders = args.subfolders === true;
    const folder = await ctx.files.scanFolder(args.folder, {
      subfolders,
      signal: ctx.signal,
      stop: () => deadlineReached(options.deadline),
    });
    const result = await runReceiptFolderCheck(ctx.client, { period, folder, subfolders }, options);
    return { data: result, summary: receiptFolderSentence(result) };
  },
});
