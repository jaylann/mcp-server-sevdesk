import { z } from "zod";

import { compact, moneySchema, statusDto, statusDtoSchema } from "../../domain/common.js";
import { voucherRecognitionInputShape } from "../../domain/drafts/voucher-inputs.js";
import {
  executeVoucherRecognition,
  MISSING_FIELDS,
  prepareVoucherRecognition,
  RECOGNISED_FIELDS,
  RECOGNITION_WAIT_MS,
  type RecognitionResult,
  type RecognitionSleep,
  SAME_FILE_SCAN_LIMIT,
  type SameFileScan,
} from "../../domain/drafts/voucher-recognition.js";
import { voucherLink } from "../../domain/links.js";
import { canReadFiles } from "../../safety/file-access.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_VOUCHER_DRAFTS, type ToolOutput } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { voucherDraftOutput } from "./draft-output.js";

const WAIT_SECONDS = String(RECOGNITION_WAIT_MS / 1_000);

/** The voucher as read back, plus what the recognition filled in and what is missing. */
const recognitionOutput = voucherDraftOutput.extend({
  recognition: z
    .object({
      recognised: z
        .boolean()
        .describe(`Whether sevDesk filled in the sums within ${WAIT_SECONDS} s.`),
      filledIn: z
        .array(z.enum(RECOGNISED_FIELDS))
        .describe(
          "Fields sevDesk's recognition filled in, none of them checked: date, number " +
            "(Belegnummer), supplierName (a text, not reliably the receipt's supplier), totals, " +
            "positions (positions and rates can be wrong even when the total is right).",
        ),
      missing: z
        .array(z.enum(MISSING_FIELDS))
        .describe(
          "What the draft still lacks: taxRule and bookingAccount block the finalize; set them " +
            "with sevdesk_voucher_update_draft.",
        ),
      reads: z.number().int().describe("Reads of the draft after the upload."),
      waitedSeconds: z.number().describe("Seconds waited for the recognition."),
    })
    .describe("sevDesk's receipt recognition (Belegerkennung) on this draft."),
  possibleDuplicates: z
    .array(z.number().int())
    .optional()
    .describe(
      "Other vouchers of the same kind with the same date, gross total and Belegnummer. The " +
        "notes say when the check could not look at every voucher of that day.",
    ),
  sameFileCheck: z
    .object({
      checked: z
        .enum(["complete", "partial", "failed"])
        .describe(
          `complete: every voucher of the range was read; partial: only the first ` +
            `${String(SAME_FILE_SCAN_LIMIT)} (sevDesk has more); failed: the vouchers could not ` +
            "be read and the file was sent unchecked.",
        ),
      from: z.string().describe("First Belegdatum read, YYYY-MM-DD."),
      to: z.string().describe("Last Belegdatum read, YYYY-MM-DD."),
      vouchersRead: z.number().int().optional().describe("Voucher rows read (drafts included)."),
      withoutChecksum: z
        .number()
        .int()
        .optional()
        .describe(
          "Receipts of those vouchers without a checksum in sevDesk (receipts made by this " +
            "recognition never have one): not compared.",
        ),
      vouchers: z
        .array(
          z.object({
            id: z.number().int(),
            number: z.string().optional().describe("Belegnummer (text from sevDesk)."),
            date: z.string().optional().describe("Belegdatum, YYYY-MM-DD."),
            gross: moneySchema.optional(),
            status: statusDtoSchema,
            link: z.string().optional().describe("Opens the voucher in the sevDesk web app."),
          }),
        )
        .optional()
        .describe(
          "Vouchers that already carried this file before the upload (same SHA-256); only with " +
            "allowDuplicate, which sent it anyway.",
        ),
    })
    .describe(
      "The check before the upload: the file's SHA-256 against the receipts of the vouchers " +
        "dated from..to. Receipts made by this recognition have no checksum, so a file " +
        "recognised before is not found.",
    ),
});

type RecognitionOutput = z.output<typeof recognitionOutput>;

/**
 * `sevdesk_voucher_recognize_receipt`: a draft voucher (expense by default, or revenue) made by
 * sevDesk's own receipt recognition from a receipt file
 * (`POST /Voucher/Factory/createVoucherFromFile`, D-103; mechanism
 * in `src/domain/drafts/voucher-recognition.ts`). Tier `write`: it only creates a draft, which
 * cannot be finalized before a tax rule and booking accounts are set through the normal update.
 * Before the upload it refuses a file already attached to a voucher (same SHA-256, #127) unless
 * `allowDuplicate`, which only saves a wasted draft and guards nothing else.
 * `sleep` is injected by tests; the registered tool waits with a real timer.
 */
export function voucherRecognizeReceiptTool(
  options: { readonly sleep?: RecognitionSleep | undefined } = {},
) {
  return defineWriteTool({
    name: "sevdesk_voucher_recognize_receipt",
    title: "Draft a voucher with sevDesk's receipt recognition",
    description:
      "Create a draft voucher (Beleg; expense or revenue) from a receipt file with " +
      "sevDesk's own receipt recognition (Belegerkennung): sevDesk attaches the file and fills " +
      "in date, Belegnummer, sums, a supplier text and positions within seconds; the tool waits " +
      `up to ${WAIT_SECONDS} s. The result lists what sevDesk filled in (unchecked; positions ` +
      "and tax rates can be wrong even when the total is right) and what is missing (always tax " +
      "rule and booking accounts): complete it with sevdesk_voucher_update_draft before " +
      "sevdesk_voucher_finalize. PDF (PNG/JPEG: recognition unmeasured) from SEVDESK_FILE_DIRS, " +
      "an upload or an allowed https link (fileSha256 pins its bytes). Refuses a file already " +
      "attached to a voucher of about the last six months (same SHA-256; allowDuplicate " +
      "overrides: a waste guard, not a safety gate). Earlier recognitions have no checksum and " +
      "are not found: every call makes a new draft. Known fields: " +
      "sevdesk_voucher_create_draft. Update 2.0 only. Tier write; dryRun previews.",
    toolset: "vouchers",
    tier: "write",
    // Open world: `file` may be an https link the server downloads (SEVDESK_FILE_URL_HOSTS).
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    localEffects: "reads-files",
    available: canReadFiles,
    input: z.strictObject({ ...voucherRecognitionInputShape, ...dryRunInputShape }),
    output: recognitionOutput,
    // A new voucher draft, like sevdesk_voucher_create_draft: one at a time per account, so the
    // duplicate scan after the recognition sees a draft another call made just before.
    locks: () => [ACCOUNT_VOUCHER_DRAFTS],
    prepare: (args, ctx) =>
      prepareVoucherRecognition(ctx.client, args, {
        signal: ctx.signal,
        cacheOwner: ctx.config,
        files: ctx.files,
      }),
    execute: async (args, plan, ctx) => {
      // An upload is released as soon as sevDesk's answer shows it attached, also when a read
      // after that fails: the draft exists, and a retry with the same upload would make another.
      // An answer without the receipt leaves the decision to the read-back (a release is a no-op
      // the second time, and for a local file or a link).
      const result = await executeVoucherRecognition(ctx.client, plan.state, {
        signal: ctx.signal,
        sleep: options.sleep,
        onWait: (reads, maxReads) =>
          ctx.progress(reads, maxReads, "Waiting for sevDesk's receipt recognition"),
        onAttached: () => {
          ctx.files.release(args.file);
        },
      });
      if (result.details.voucher.hasDocument === true) ctx.files.release(args.file);
      return recognitionToolOutput(result);
    },
  });
}

/** The checksum check before the upload, as the output shows it. */
function sameFileOutput(scan: SameFileScan): RecognitionOutput["sameFileCheck"] {
  if (scan.outcome === "failed") return { checked: "failed", from: scan.from, to: scan.to };
  return {
    checked: scan.outcome,
    from: scan.from,
    to: scan.to,
    vouchersRead: scan.read,
    withoutChecksum: scan.withoutChecksum,
    ...(scan.matches.length === 0
      ? {}
      : {
          vouchers: scan.matches.map((voucher) =>
            compact({
              id: voucher.id,
              number: voucher.number,
              date: voucher.date,
              gross: voucher.gross,
              status: statusDto("voucher", voucher.statusCode),
              link: voucherLink(voucher.id),
            }),
          ),
        }),
  };
}

/** The tool output: the draft as read back, the recognition facts and the trusted notes. */
function recognitionToolOutput(result: RecognitionResult): ToolOutput<RecognitionOutput> {
  const { voucher, positions, positionsComplete } = result.details;
  const id = String(result.id);
  const gross = voucher.totals.gross;
  const count = `${String(positions.length)} position${positions.length === 1 ? "" : "s"}`;
  const scan = result.duplicates;
  const duplicates = scan.outcome === "done" || scan.outcome === "partial" ? scan.ids : [];
  return {
    data: {
      voucher,
      positions: [...positions],
      positionsComplete,
      receipt: result.receipt,
      recognition: {
        recognised: result.recognised,
        filledIn: [...result.filledIn],
        missing: [...result.missing],
        reads: result.reads,
        waitedSeconds: result.waitedMs / 1_000,
      },
      ...(duplicates.length === 0 ? {} : { possibleDuplicates: [...duplicates] }),
      sameFileCheck: sameFileOutput(result.sameFile),
      ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
      ...(result.notesDe.length === 0 ? {} : { notesDe: [...result.notesDe] }),
    },
    summary: result.recognised
      ? `Created draft voucher ${id} with sevDesk's receipt recognition (${count}` +
        `${gross === undefined ? "" : `, gross ${gross.amount} ${gross.currency}`}); the ` +
        "recognised values are unchecked and the draft is not complete yet. See notes."
      : `Created draft voucher ${id}, but sevDesk's receipt recognition filled in no sums ` +
        `within ${String(result.waitedMs / 1_000)} s. See notes.`,
    affected: [{ objectName: "Voucher", id }],
  };
}
