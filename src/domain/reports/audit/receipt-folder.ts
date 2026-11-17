/**
 * `sevdesk_receipt_folder_check` (the `receipt_folder` check of issue #92, a tool of its own
 * because it exists only where the server can read local folders): compares the receipt files of
 * a folder inside `SEVDESK_FILE_DIRS` with the receipt files attached to the vouchers (Belege) in
 * sevDesk, by SHA-256 checksum.
 *
 * What it reads: the folder (`FileAccess.scanFolder`: paths, sizes, modification times and
 * checksums, never file content; its confinement is in `src/safety/local-folder.ts`) and the
 * vouchers dated from {@link RECEIPT_MARGIN_DAYS} days before the period to as many days after
 * it, drafts included, each with its receipt's `contentHash` (`GET /Voucher?embed=document`, one
 * request per 1,000 vouchers; spec/deviations.md D-100 (PR #104), recorded 2026-11-17). A
 * voucher's receipt checksum is the SHA-256 of the bytes uploaded to sevDesk, so a local file
 * matches only the very same bytes. Nothing is read by id, nothing is sent to sevDesk.
 *
 * Not every receipt has a checksum: one that sevDesk's recognition created from an uploaded file
 * (`Voucher/Factory/createVoucherFromFile`) has `contentHash` null (recorded 2026-11-17, trial
 * account, Update 2.0; PDF and PNG alike). Such receipts cannot be compared. The result counts
 * them (`coverage.vouchers.withoutChecksum`, `withoutChecksum` with a note in English and German),
 * and while there are any, `receipt_file_not_booked` says "no receipt with this checksum" instead
 * of presenting the file as unbooked. Rows that name the receipt without embedding its document
 * (should sevDesk ignore `embed`) count among them and separately (`coverage.vouchers.notEmbedded`,
 * with a note), so a listing without checksums is not mistaken for receipts without one.
 *
 * The findings, one per checksum (one for all files nothing matched):
 * - `receipt_file_not_booked`: no voucher read carries the file;
 * - `receipt_file_before_period`: the same, but the file was last changed before the vouchers
 *   read begin, so it most likely holds an older receipt (see the weak hints);
 * - `receipt_file_only_on_draft`: only draft vouchers carry it (not booked yet);
 * - `receipt_file_draft_repeats`: a booked voucher and a draft carry it;
 * - `receipt_file_booked_twice`: two or more booked vouchers carry it.
 * Every file that matches is also listed in `matched` with its vouchers and their status.
 *
 * Every result states, in English and German, that its findings are hints and not tax advice (the
 * audit's caveat, `AUDIT_CAVEAT`) and what a match does and does not prove ({@link MATCHING},
 * {@link MATCHING_DE}). Amount, date and supplier are not compared: without reading the file's
 * content (no PDF parsing, no OCR) the check does not know them. Two weak hints, labelled as such:
 * - the day of the file's last modification (`modified`): when it was saved or copied, not the
 *   receipt date. It only decides `receipt_file_before_period`: a file saved before the range of
 *   vouchers read cannot hold a receipt from inside it, unless its date was set back by hand. A
 *   file saved after the range may still hold a receipt from inside it, so such unmatched files
 *   stay `receipt_file_not_booked` and are only counted in a note (they may belong to a later
 *   period);
 * - `possibleVouchers`: vouchers whose document number (at least {@link MIN_HINT_NUMBER_LENGTH}
 *   characters with a digit, compared like the duplicates check) appears in the file's name; the
 *   receipt may be booked from another file (a scan, a photo);
 * - `sameSizeVouchers`: vouchers whose receipt has no checksum but the same size in bytes and the
 *   same extension as the file (`filesize`, `extension` of the embedded document). Never a match.
 *
 * Local file paths are untrusted text: they appear only as values of their own fields, never in
 * titles, reasons, notes or the summary.
 */
import { basename, extname } from "node:path";

import { z } from "zod";

import type { FolderFile, FolderScan } from "../../../safety/local-folder.js";
import { berlinDateOf } from "../../../sevdesk/dates.js";
import type { SevdeskClient } from "../../../sevdesk/types.js";
import { compact, statusDto, statusDtoSchema } from "../../common.js";
import { contactLink, voucherLink } from "../../links.js";
import { type DocumentHeader, listDocumentHeaders } from "../positions-scan.js";
import { plural, type ReportRunOptions, shiftDays } from "../shared.js";
import type { ReportPeriod } from "../vat.js";
import { numberKey } from "./duplicates-check.js";
import {
  AUDIT_CAVEAT,
  AUDIT_CAVEAT_DE,
  auditFindingSchema,
  byDateThenId,
  type FindingText,
  MAX_FINDINGS,
  recordOf,
} from "./findings.js";
import { contactOf, supplierKey } from "./supplier-bills.js";

/** Vouchers are read this many days before and after the period. */
export const RECEIPT_MARGIN_DAYS = 62;
/** Files listed per finding; the rest are counted. */
const MAX_FINDING_FILES = 100;
/** Files listed in `matched`; the rest are counted. */
const MAX_MATCHED = 200;
/** Shortest normalized document number used as a file-name hint. */
const MIN_HINT_NUMBER_LENGTH = 6;
/** Vouchers named per file as a file-name hint. */
const MAX_HINTS = 3;
/** sevDesk's voucher draft status. */
const VOUCHER_DRAFT = 50;

const CHECK = "receipt_folder" as const;

/** Stated in every result (English). */
export const MATCHING =
  "A file counts as found when a voucher in sevDesk carries a receipt file with exactly the same " +
  "bytes (SHA-256 checksum). A match proves that this file is attached to that voucher, not that " +
  "the voucher is booked correctly. No match does not prove that the receipt is missing: the " +
  "same receipt as another file (a scan or photo of the paper, a copy converted or compressed by " +
  "sevDesk or another program, a receipt that reached sevDesk by e-mail or through its mobile " +
  "app) has another checksum, a receipt sevDesk stores without a checksum (for example one its " +
  "recognition created from an uploaded file) cannot be compared at all, and vouchers dated " +
  "outside the range read are not compared. Amounts, dates and suppliers are not compared: that " +
  "would need the file's content, which this check does not read.";

/** Stated in every result (German). */
export const MATCHING_DE =
  "Eine Datei gilt als gefunden, wenn ein Beleg in sevDesk eine Belegdatei mit genau denselben " +
  "Bytes hat (SHA-256-Prüfsumme). Ein Treffer beweist, dass diese Datei an diesem Beleg hängt, " +
  "nicht, dass der Beleg richtig gebucht ist. Kein Treffer beweist nicht, dass der Beleg fehlt: " +
  "Derselbe Beleg als andere Datei (ein Scan oder Foto des Papiers, eine von sevDesk oder einem " +
  "anderen Programm umgewandelte oder verkleinerte Kopie, ein Beleg, der per E-Mail oder über " +
  "die sevDesk-App kam) hat eine andere Prüfsumme, eine Belegdatei, die sevDesk ohne Prüfsumme " +
  "speichert (etwa eine, die seine Belegerkennung aus einer hochgeladenen Datei angelegt hat), " +
  "lässt sich gar nicht vergleichen, und Belege mit einem Datum außerhalb des gelesenen " +
  "Zeitraums werden nicht verglichen. Beträge, Daten und Lieferanten werden nicht verglichen: " +
  "Dafür müsste der Inhalt der Datei gelesen werden, und das tut diese Prüfung nicht.";

export const RECEIPT_FOLDER_FINDING_CODES = [
  "receipt_file_booked_twice",
  "receipt_file_not_booked",
  "receipt_file_before_period",
  "receipt_file_only_on_draft",
  "receipt_file_draft_repeats",
] as const;

type ReceiptFolderCode = (typeof RECEIPT_FOLDER_FINDING_CODES)[number];

const TEXTS: Readonly<Record<ReceiptFolderCode, FindingText>> = {
  receipt_file_booked_twice: {
    severity: "warning",
    title: "Same receipt file booked more than once",
    titleDe: "Gleiche Belegdatei mehrfach gebucht",
    reason:
      "Two or more booked vouchers carry a receipt file with the same SHA-256 checksum as this " +
      "file: the same receipt was probably booked twice, so its amount and VAT count twice.",
    action:
      "Open the vouchers and keep one; undo the other in sevDesk (ask your tax adviser how to " +
      "correct a voucher that is already enshrined, festgeschrieben).",
  },
  receipt_file_not_booked: {
    severity: "check",
    title: "Receipt file not found in sevDesk",
    titleDe: "Belegdatei nicht in sevDesk gefunden",
    reason:
      "No voucher in the range read carries a receipt file with the same SHA-256 checksum, so " +
      "this file was probably not booked; if it is a receipt of the business, its amount and " +
      "VAT are missing from the books. Not proof: the receipt may be booked from another file " +
      "(see matching).",
    action:
      "Look for the receipt in sevDesk (sevdesk_vouchers_list by supplier, date or number; " +
      "possibleVouchers names vouchers whose number appears in the file name). If it is not " +
      "booked, book it, for example as a draft with sevdesk_voucher_create_draft and this file " +
      "as file.",
  },
  receipt_file_before_period: {
    severity: "check",
    title: "Receipt file older than the vouchers read",
    titleDe: "Belegdatei älter als die gelesenen Belege",
    reason:
      "No voucher in the range read carries this file, and the file was last changed before " +
      "that range begins. The modification date is a weak hint, not the receipt date, but a file " +
      "saved before the range most likely holds an older receipt, whose voucher was not read.",
    action:
      "Run the check for the period the receipt belongs to, or keep older receipts in another " +
      "folder.",
  },
  receipt_file_only_on_draft: {
    severity: "check",
    title: "Receipt file only on a draft voucher",
    titleDe: "Belegdatei nur an einem Belegentwurf",
    reason:
      "Only vouchers that are still drafts carry this file. Drafts are not booked: the amount " +
      "and its VAT are missing from the books, the reports and the UStVA until the voucher is " +
      "booked.",
    action:
      "Complete and book the draft, or delete it if the receipt is booked under another voucher.",
  },
  receipt_file_draft_repeats: {
    severity: "check",
    title: "Booked receipt file attached to a draft again",
    titleDe: "Gebuchte Belegdatei erneut an einem Entwurf",
    reason:
      "A booked voucher and a draft both carry this file. Usually the same receipt reached " +
      "sevDesk twice (upload, e-mail inbox); booking the draft would count it twice.",
    action:
      "Compare the draft with the booked voucher; if it is the same receipt, delete the draft " +
      "instead of booking it.",
  },
};

/**
 * The words of `receipt_file_not_booked` while `withoutChecksum` receipts in the range read carry
 * no checksum: the file is then one without a receipt of the same checksum, not an unbooked one,
 * since it may be one of those receipts.
 */
function notBookedText(withoutChecksum: number): FindingText {
  const base = TEXTS.receipt_file_not_booked;
  if (withoutChecksum === 0) return base;
  return {
    ...base,
    title: "No receipt in sevDesk with this checksum",
    titleDe: "Kein Beleg in sevDesk mit dieser Prüfsumme",
    reason:
      "No voucher in the range read carries a receipt file with the same SHA-256 checksum. " +
      `${plural(withoutChecksum, "receipt")} attached to vouchers in that range ` +
      `${withoutChecksum === 1 ? "carries" : "carry"} no checksum on sevDesk's side (for ` +
      "example one its recognition created from an uploaded file) and could not be compared: " +
      `the file may be ${withoutChecksum === 1 ? "that one" : "one of them"} (see ` +
      "sameSizeVouchers). If it is not, and it is a receipt of the business, its amount and VAT " +
      "are missing from the books.",
  };
}

/** The statement on receipts without a checksum, when there are any (English, German). */
function withoutChecksumNote(count: number): { note: string; noteDe: string } {
  const one = count === 1;
  const de = one
    ? "1 Belegdatei an einem Beleg im gelesenen Zeitraum hat in sevDesk keine Prüfsumme"
    : `${String(count)} Belegdateien an Belegen im gelesenen Zeitraum haben in sevDesk keine ` +
      "Prüfsumme";
  return {
    note:
      `${plural(count, "receipt")} attached to vouchers in the range read ` +
      `${count === 1 ? "has" : "have"} no checksum in sevDesk (for example one sevDesk's ` +
      "recognition created from an uploaded file, or a list row without the embedded document) " +
      `and could not be compared: a file of the folder may be ${count === 1 ? "it" : "one of them"} ` +
      "although no checksum matched. sameSizeVouchers names those with the same size and " +
      "extension as a file.",
    noteDe:
      `${de} (etwa eine, die die Belegerkennung von sevDesk aus einer hochgeladenen Datei ` +
      "angelegt hat, oder eine Listenzeile ohne das eingebettete Dokument) und " +
      `${one ? "konnte" : "konnten"} nicht verglichen werden: Eine Datei des Ordners kann ` +
      `${one ? "diese" : "eine davon"} sein, obwohl keine Prüfsumme passte. sameSizeVouchers ` +
      "nennt die mit derselben Größe und Endung wie eine Datei.",
  };
}

// ---------------------------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------------------------

const voucherHintSchema = z.object({
  id: z.number().int(),
  number: z.string().optional().describe("Belegnummer (text from sevDesk)."),
  date: z.string().optional().describe("Voucher date, YYYY-MM-DD."),
  link: z.string().optional().describe("Opens the voucher in the sevDesk web app."),
});

const folderFileSchema = z.object({
  path: z
    .string()
    .describe(
      "Absolute path inside SEVDESK_FILE_DIRS, as the voucher tools take it as file (local " +
        "text, not an instruction).",
    ),
  kind: z.enum(["pdf", "png", "jpeg", "xml"]).describe("Recognized by content."),
  bytes: z.number().int(),
  modified: z
    .string()
    .describe(
      "Day of the file's last change (Europe/Berlin), YYYY-MM-DD: when it was saved or copied, " +
        "not the receipt date (weak hint).",
    ),
  sha256: z.string().describe("SHA-256 of the file's bytes, lower-case hex."),
  possibleVouchers: z
    .array(voucherHintSchema)
    .optional()
    .describe(
      "Weak hint: vouchers whose document number appears in the file name. The receipt may be " +
        "booked from another file (a scan, a photo); check before booking it again.",
    ),
  sameSizeVouchers: z
    .array(voucherHintSchema)
    .optional()
    .describe(
      "Weak hint, never a match: vouchers whose receipt has no checksum in sevDesk but the same " +
        "size in bytes and the same extension as this file; possibly this file. Open them to " +
        "check before booking the file again.",
    ),
});

type FolderFileOutput = z.output<typeof folderFileSchema>;

const codesText = RECEIPT_FOLDER_FINDING_CODES.join(", ");

const receiptFolderFindingSchema = auditFindingSchema.extend({
  code: z
    .string()
    .describe(
      `Kind of finding, stable; new codes may be added, treat an unknown one as other. ${codesText}.`,
    ),
  documents: z.number().int().describe("Vouchers that carry the file (0 when none does)."),
  records: z.array(auditFindingSchema.shape.records.element).describe("Those vouchers, by date."),
  files: z
    .array(folderFileSchema)
    .describe(`The local files of this finding, at most ${String(MAX_FINDING_FILES)}.`),
  filesOmitted: z.number().int().optional().describe("Files of this finding not listed."),
});

type ReceiptFolderFinding = z.output<typeof receiptFolderFindingSchema>;

const matchedVoucherSchema = voucherHintSchema.extend({
  status: statusDtoSchema.describe("The voucher's status: draft (50) is not booked yet."),
});

const skippedSchema = z
  .object({
    hidden: z.number().int().describe("Names starting with a dot."),
    links: z.number().int().describe("Symbolic links (never followed)."),
    special: z.number().int().describe("Neither a file nor a folder."),
    unusableNames: z
      .number()
      .int()
      .describe("Names with invisible or control characters, or paths too long for the tools."),
    otherTypes: z.number().int().describe("Extensions other than .pdf, .png, .jpg, .jpeg, .xml."),
    wrongContent: z
      .number()
      .int()
      .describe("A receipt extension, but the content is no PDF, PNG, JPEG or XML."),
    tooLarge: z.number().int().describe("Larger than the per-file limit."),
    unreadable: z.number().int().describe("Files or folders that could not be read."),
    changed: z.number().int().describe("Files or folders that changed while being read."),
  })
  .describe("Entries not checked, by reason.");

const filesByFindingSchema = z
  .object({
    receipt_file_booked_twice: z.number().int(),
    receipt_file_not_booked: z.number().int(),
    receipt_file_before_period: z.number().int(),
    receipt_file_only_on_draft: z.number().int(),
    receipt_file_draft_repeats: z.number().int(),
  })
  .describe(
    "Files per kind of finding, counted over all findings, also those beyond the findings listed.",
  ) satisfies z.ZodType<Record<ReceiptFolderCode, number>>;

type FilesByFinding = z.output<typeof filesByFindingSchema>;

const coverageSchema = z.object({
  folders: z
    .array(z.string())
    .describe("The folders scanned: absolute paths inside SEVDESK_FILE_DIRS (local text)."),
  subfolders: z.boolean().describe("Whether subfolders were read."),
  foldersRead: z.number().int(),
  subfoldersNotRead: z
    .number()
    .int()
    .describe("Subfolders found but not read (subfolders off, or deeper than the limit)."),
  filesChecked: z.number().int().describe("Receipt files whose checksum was computed."),
  filesMatched: z.number().int().describe("Files a voucher read carries."),
  filesNotMatched: z.number().int(),
  filesByFinding: filesByFindingSchema,
  skipped: skippedSchema,
  notChecked: z
    .array(
      z.object({
        path: z.string().describe("Local text."),
        reason: z.enum(["wrong_content", "too_large", "unreadable", "changed"]),
      }),
    )
    .describe("Files with a receipt extension that could not be checked (the first 50)."),
  folderCut: z
    .array(z.enum(["files", "bytes", "entries", "folders", "depth", "time"]))
    .describe("Why the folder scan stopped early (see the notes); empty when it read everything."),
  vouchers: z
    .object({
      from: z.string().describe("First voucher date read, YYYY-MM-DD."),
      to: z.string().describe("Last voucher date read, YYYY-MM-DD."),
      read: z.number().int().describe("Voucher rows listed (drafts included)."),
      withReceipt: z.number().int().describe("Vouchers with a receipt file."),
      withoutChecksum: z
        .number()
        .int()
        .describe(
          "Of those, receipts without a usable checksum (receipts sevDesk's recognition created " +
            "from an uploaded file, files sevDesk rendered itself, or a list row without the " +
            "embedded document): no local file can match them.",
        ),
      notEmbedded: z
        .number()
        .int()
        .describe(
          "Of those, list rows that named the receipt without embedding its document although " +
            "the listing asked for it (embed=document): their checksum was not read at all, " +
            "which says nothing about the receipt itself.",
        ),
      truncated: z.boolean().describe("True when the voucher listing stopped at its cap."),
    })
    .describe("The vouchers compared."),
});

export const receiptFolderResultSchema = z.object({
  check: z.literal(CHECK),
  period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  source: z.string(),
  caveat: z.string().describe("Findings are hints, not tax advice."),
  caveatDe: z.string().describe("The same in German."),
  matching: z.string().describe("What a match and a missing match prove."),
  matchingDe: z.string().describe("The same in German."),
  withoutChecksum: z
    .object({
      receipts: z.number().int().describe("Receipts on vouchers in the range read without one."),
      note: z.string(),
      noteDe: z.string().describe("The same in German."),
    })
    .optional()
    .describe(
      "Present when receipts in sevDesk carry no checksum and could not be compared: a file " +
        "without a match may be one of them.",
    ),
  findings: z
    .array(receiptFolderFindingSchema)
    .describe(`Warnings first; at most ${String(MAX_FINDINGS)}.`),
  findingsOmitted: z.number().int().optional().describe("Findings not listed."),
  matched: z
    .array(
      z.object({
        path: z.string().describe("Local text."),
        vouchers: z.array(matchedVoucherSchema).describe("The vouchers that carry the file."),
      }),
    )
    .describe(`Files a voucher read carries, at most ${String(MAX_MATCHED)}.`),
  matchedOmitted: z.number().int().optional().describe("Matched files not listed."),
  coverage: coverageSchema,
  notes: z.array(z.string()),
});

export type ReceiptFolderResult = z.output<typeof receiptFolderResultSchema>;

/** Stated in every result. */
const SOURCE =
  "Checked by this server: the receipt files of a local folder (checksums only, no content) " +
  "against the receipt files of the vouchers in sevDesk. Nothing was changed or uploaded.";

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

export interface ReceiptFolderParams {
  readonly period: ReportPeriod;
  readonly folder: FolderScan;
  /** Whether subfolders were read (as the caller asked). */
  readonly subfolders: boolean;
  /** Row cap of the voucher listing; tests lower it. */
  readonly maxRows?: number | undefined;
  /** Berlin `YYYY-MM-DD` for the voucher mapper; tests pin it. */
  readonly today?: string | undefined;
}

/** The vouchers of the range read and their receipts, by checksum. */
interface VoucherReceipts {
  readonly byHash: ReadonlyMap<string, readonly DocumentHeader[]>;
  readonly all: readonly DocumentHeader[];
  readonly rowsRead: number;
  readonly withReceipt: number;
  readonly withoutChecksum: number;
  /**
   * Of those, rows that carried only the receipt's reference, not the embedded document: sevDesk
   * did not embed it, so the checksum is unknown rather than absent.
   */
  readonly notEmbedded: number;
  /** The vouchers whose receipt has no checksum (no file can match them), by date. */
  readonly unhashed: readonly DocumentHeader[];
  readonly truncated: boolean;
}

async function readVoucherReceipts(
  client: SevdeskClient,
  range: { readonly from: string; readonly to: string },
  params: ReceiptFolderParams,
  options: ReportRunOptions,
): Promise<VoucherReceipts> {
  const listed = await listDocumentHeaders(
    client,
    {
      from: range.from,
      to: range.to,
      kinds: ["voucher"],
      keepDrafts: true,
      voucherReceipts: true,
      maxRows: params.maxRows,
      today: params.today,
    },
    options,
  );
  const all = [...listed.headers, ...listed.drafts].sort(byDateThenId);
  const byHash = new Map<string, DocumentHeader[]>();
  const unhashed: DocumentHeader[] = [];
  let withReceipt = 0;
  for (const header of all) {
    if (header.receipt === undefined) continue;
    withReceipt += 1;
    const { hash } = header.receipt;
    if (hash === undefined) {
      unhashed.push(header);
      continue;
    }
    byHash.set(hash, [...(byHash.get(hash) ?? []), header]);
  }
  return {
    byHash,
    all,
    rowsRead: listed.rowsRead,
    withReceipt,
    withoutChecksum: unhashed.length,
    notEmbedded: unhashed.filter((header) => header.receipt?.embedded === false).length,
    unhashed,
    truncated: listed.truncated,
  };
}

const NO_VOUCHERS: VoucherReceipts = {
  byHash: new Map(),
  all: [],
  rowsRead: 0,
  withReceipt: 0,
  withoutChecksum: 0,
  notEmbedded: 0,
  unhashed: [],
  truncated: false,
};

/** A file's extension as sevDesk's `extension` would read it: lower case, `jpeg` as `jpg`. */
function extensionKey(extension: string): string {
  const ext = extension.replace(/^\./, "").toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/**
 * Vouchers whose receipt has no checksum but the size and extension of `file` (weak hint, never a
 * match): sevDesk's `filesize` is the bytes it received, recorded 2026-11-17.
 */
function sizeHints(file: FolderFile, unhashed: readonly DocumentHeader[]): DocumentHeader[] {
  const extension = extensionKey(extname(file.path));
  return unhashed
    .filter((header) => {
      const receipt = header.receipt;
      return (
        receipt?.size === file.size &&
        receipt.extension !== undefined &&
        extensionKey(receipt.extension) === extension
      );
    })
    .slice(0, MAX_HINTS);
}

const isDraft = (header: DocumentHeader): boolean => header.statusCode === VOUCHER_DRAFT;

/** A file name as compared with document numbers: upper case without spaces and `-_/.#`. */
function nameKey(path: string): string {
  const name = basename(path, extname(path));
  return name.toUpperCase().replace(/[\s\-_/.#]/g, "");
}

/** Vouchers whose number appears in the file's name (weak hint), by date, at most a few. */
function numberHints(path: string, vouchers: readonly DocumentHeader[]): DocumentHeader[] {
  const name = nameKey(path);
  return vouchers
    .filter((header) => {
      const key = numberKey(header.number);
      return key !== undefined && key.length >= MIN_HINT_NUMBER_LENGTH && name.includes(key);
    })
    .slice(0, MAX_HINTS);
}

function voucherRef(header: DocumentHeader): z.output<typeof voucherHintSchema> {
  return compact({
    id: header.id,
    number: header.number,
    date: header.date,
    link: voucherLink(header.id),
  });
}

function fileOutput(file: FolderFile, entry: Partial<FileWithHints> = {}): FolderFileOutput {
  const byName = entry.hints ?? [];
  const bySize = entry.sameSize ?? [];
  return compact({
    path: file.path,
    kind: file.kind,
    bytes: file.size,
    modified: berlinDateOf(file.modifiedMs),
    sha256: file.sha256,
    possibleVouchers: byName.length === 0 ? undefined : byName.map(voucherRef),
    sameSizeVouchers: bySize.length === 0 ? undefined : bySize.map(voucherRef),
  });
}

/** The code for the vouchers that carry one checksum; `undefined` for a plain match. */
function matchCode(vouchers: readonly DocumentHeader[]): ReceiptFolderCode | undefined {
  const booked = vouchers.filter((header) => !isDraft(header)).length;
  if (booked >= 2) return "receipt_file_booked_twice";
  if (booked === 1) return vouchers.length > 1 ? "receipt_file_draft_repeats" : undefined;
  return "receipt_file_only_on_draft";
}

function finding(
  code: ReceiptFolderCode,
  files: readonly FileWithHints[],
  vouchers: readonly DocumentHeader[],
  text: FindingText = TEXTS[code],
): ReceiptFolderFinding {
  const [first] = vouchers;
  // The finding names a contact only when every voucher has the same one; else each record does.
  const suppliers = new Set(vouchers.map((header) => supplierKey(header) ?? "none"));
  const shared = suppliers.size === 1;
  const contact = first === undefined || !shared ? undefined : contactOf(first);
  const omitted = files.length - MAX_FINDING_FILES;
  return compact({
    check: CHECK,
    code,
    severity: text.severity,
    title: text.title,
    titleDe: text.titleDe,
    reason: text.reason,
    action: text.action,
    contact:
      contact === undefined
        ? undefined
        : compact({
            id: contact.id,
            name: contact.name,
            link: contact.id === undefined ? undefined : contactLink(contact.id),
          }),
    documents: vouchers.length,
    records: vouchers.map((header) => recordOf(header, { withContact: !shared })),
    files: files.slice(0, MAX_FINDING_FILES).map((entry) => fileOutput(entry.file, entry)),
    filesOmitted: omitted > 0 ? omitted : undefined,
  });
}

interface FileWithHints {
  readonly file: FolderFile;
  /** Vouchers whose number appears in the file name. */
  readonly hints?: readonly DocumentHeader[] | undefined;
  /** Vouchers whose receipt has no checksum but the file's size and extension. */
  readonly sameSize?: readonly DocumentHeader[] | undefined;
}

const SEVERITY_ORDER = { warning: 0, check: 1 } as const;

/**
 * Compares the scanned folder with the vouchers of the period (plus the margin) and shapes the
 * result. Reads only the voucher list, and nothing at all when the folder holds no receipt file.
 */
export async function runReceiptFolderCheck(
  client: SevdeskClient,
  params: ReceiptFolderParams,
  options: ReportRunOptions = {},
): Promise<ReceiptFolderResult> {
  const { period, folder } = params;
  const range = {
    from: shiftDays(period.from, -RECEIPT_MARGIN_DAYS),
    to: shiftDays(period.to, RECEIPT_MARGIN_DAYS),
  };
  const vouchers =
    folder.files.length === 0
      ? NO_VOUCHERS
      : await readVoucherReceipts(client, range, params, options);

  // Files by checksum, in scan order (the same bytes saved twice form one group).
  const groups = new Map<string, FolderFile[]>();
  for (const file of folder.files) {
    groups.set(file.sha256, [...(groups.get(file.sha256) ?? []), file]);
  }

  const findings: { readonly code: ReceiptFolderCode; readonly finding: ReceiptFolderFinding }[] =
    [];
  const add = (
    code: ReceiptFolderCode,
    files: readonly FileWithHints[],
    carriers: readonly DocumentHeader[],
    text?: FindingText,
  ): void => {
    findings.push({ code, finding: finding(code, files, carriers, text) });
  };
  const notBooked: FileWithHints[] = [];
  const beforePeriod: FileWithHints[] = [];
  const matched: ReceiptFolderResult["matched"] = [];
  let filesMatched = 0;
  // Unmatched files changed after the range read: only counted in a note. Unlike a file saved
  // before the range, a late save says nothing (a receipt of the period downloaded today), so
  // they keep their code.
  let changedAfterRange = 0;
  for (const [hash, files] of groups) {
    const carriers = vouchers.byHash.get(hash) ?? [];
    if (carriers.length === 0) {
      for (const file of files) {
        // Hints only: a file of the same size as a receipt without a checksum is never matched.
        const entry = {
          file,
          hints: numberHints(file.path, vouchers.all),
          sameSize: sizeHints(file, vouchers.unhashed),
        };
        const modified = berlinDateOf(file.modifiedMs);
        if (modified < range.from) {
          beforePeriod.push(entry);
          continue;
        }
        notBooked.push(entry);
        if (modified > range.to) changedAfterRange += 1;
      }
      continue;
    }
    filesMatched += files.length;
    const vouchersOut = carriers.map((header) => ({
      ...voucherRef(header),
      status: statusDto("voucher", header.statusCode),
    }));
    for (const file of files) matched.push({ path: file.path, vouchers: vouchersOut });
    const code = matchCode(carriers);
    if (code !== undefined) {
      add(
        code,
        files.map((file) => ({ file })),
        carriers,
      );
    }
  }
  if (notBooked.length > 0) {
    add("receipt_file_not_booked", notBooked, [], notBookedText(vouchers.withoutChecksum));
  }
  if (beforePeriod.length > 0) add("receipt_file_before_period", beforePeriod, []);
  // Warnings first, then by kind; within a kind in scan order (stable sort).
  const order = (code: ReceiptFolderCode): number =>
    SEVERITY_ORDER[TEXTS[code].severity] * RECEIPT_FOLDER_FINDING_CODES.length +
    RECEIPT_FOLDER_FINDING_CODES.indexOf(code);
  const sorted = findings.sort((a, b) => order(a.code) - order(b.code)).map((x) => x.finding);
  const findingsOmitted = sorted.length - MAX_FINDINGS;
  const matchedOmitted = matched.length - MAX_MATCHED;
  const notMatched = folder.files.length - filesMatched;

  return compact({
    check: CHECK,
    period: { from: period.from, to: period.to, label: period.label },
    source: SOURCE,
    caveat: AUDIT_CAVEAT,
    caveatDe: AUDIT_CAVEAT_DE,
    matching: MATCHING,
    matchingDe: MATCHING_DE,
    withoutChecksum:
      vouchers.withoutChecksum === 0
        ? undefined
        : { receipts: vouchers.withoutChecksum, ...withoutChecksumNote(vouchers.withoutChecksum) },
    findings: sorted.slice(0, MAX_FINDINGS),
    findingsOmitted: findingsOmitted > 0 ? findingsOmitted : undefined,
    matched: matched.slice(0, MAX_MATCHED),
    matchedOmitted: matchedOmitted > 0 ? matchedOmitted : undefined,
    coverage: {
      folders: [...folder.folders],
      subfolders: params.subfolders,
      foldersRead: folder.foldersRead,
      subfoldersNotRead: folder.subfoldersNotRead,
      filesChecked: folder.files.length,
      filesMatched,
      filesNotMatched: notMatched,
      // Over all findings: the list below stops at MAX_FINDINGS, the counts must not.
      filesByFinding: filesPerFinding(sorted),
      skipped: {
        hidden: folder.skipped.hidden,
        links: folder.skipped.link,
        special: folder.skipped.special,
        unusableNames: folder.skipped.unusable_name,
        otherTypes: folder.skipped.other_type,
        wrongContent: folder.skipped.wrong_content,
        tooLarge: folder.skipped.too_large,
        unreadable: folder.skipped.unreadable,
        changed: folder.skipped.changed,
      },
      notChecked: folder.notChecked.map((entry) => ({ path: entry.path, reason: entry.reason })),
      folderCut: [...folder.cut],
      vouchers: {
        from: range.from,
        to: range.to,
        read: vouchers.rowsRead,
        withReceipt: vouchers.withReceipt,
        withoutChecksum: vouchers.withoutChecksum,
        notEmbedded: vouchers.notEmbedded,
        truncated: vouchers.truncated,
      },
    },
    notes: notesOf(params, range, vouchers, { findingsOmitted, changedAfterRange }),
  });
}

/** The files of each kind of finding (listed and omitted ones), over `findings`. */
function filesPerFinding(findings: readonly ReceiptFolderFinding[]): FilesByFinding {
  const count = (code: ReceiptFolderCode): number =>
    findings
      .filter((entry) => entry.code === code)
      .reduce((sum, entry) => sum + entry.files.length + (entry.filesOmitted ?? 0), 0);
  return {
    receipt_file_booked_twice: count("receipt_file_booked_twice"),
    receipt_file_not_booked: count("receipt_file_not_booked"),
    receipt_file_before_period: count("receipt_file_before_period"),
    receipt_file_only_on_draft: count("receipt_file_only_on_draft"),
    receipt_file_draft_repeats: count("receipt_file_draft_repeats"),
  };
}

/** Trusted notes: the range read, what the scan left out and why. Names no file. */
function notesOf(
  params: ReceiptFolderParams,
  range: { readonly from: string; readonly to: string },
  vouchers: VoucherReceipts,
  counts: {
    readonly findingsOmitted: number;
    /** Files not found that were last changed after the range read. */
    readonly changedAfterRange: number;
  },
): string[] {
  const { folder } = params;
  const { findingsOmitted, changedAfterRange } = counts;
  const notes: string[] = [];
  if (folder.files.length === 0) {
    notes.push(
      "The folder holds no receipt file this check can read (PDF, PNG, JPEG or XML), so nothing " +
        "was read from sevDesk." +
        (folder.subfoldersNotRead > 0 && !params.subfolders
          ? " It has subfolders: pass subfolders: true to read them."
          : ""),
    );
  } else {
    notes.push(
      `Vouchers dated ${range.from} to ${range.to} were compared (the period and ` +
        `${String(RECEIPT_MARGIN_DAYS)} days before and after it, drafts included). A receipt ` +
        "booked under a voucher dated outside that range counts as not found.",
    );
  }
  if (changedAfterRange > 0) {
    notes.push(
      `${plural(changedAfterRange, "file")} not found ${changedAfterRange === 1 ? "was" : "were"} ` +
        `last changed after ${range.to}, the last voucher date read: ` +
        `${changedAfterRange === 1 ? "it" : "they"} may hold receipts of a later period, whose ` +
        "vouchers were not read (the change date is a weak hint, not the receipt date). Check " +
        "such files with the period they belong to, or keep each period's receipts in a folder " +
        "of their own.",
    );
  }
  const cut = new Set(folder.cut);
  const cuts: string[] = [];
  if (cut.has("files")) cuts.push("the cap on files per call was reached");
  if (cut.has("bytes")) cuts.push("the cap on bytes read per call was reached");
  if (cut.has("entries")) cuts.push("the cap on folder entries per call was reached");
  if (cut.has("folders")) cuts.push("the cap on folders per call was reached");
  if (cut.has("depth")) cuts.push("subfolders deeper than the limit were not read");
  if (cut.has("time")) cuts.push("this server's time budget for one request ran out");
  if (cuts.length > 0) {
    notes.push(
      `The folder was cut: ${cuts.join("; ")}. Files not read are not in the result; check a ` +
        "smaller folder (one month, or a subfolder).",
    );
  }
  if (folder.subfoldersNotRead > 0 && !params.subfolders && folder.files.length > 0) {
    notes.push(
      `${plural(folder.subfoldersNotRead, "subfolder")} not read: pass subfolders: true to ` +
        "include them.",
    );
  }
  const { skipped } = folder;
  const unreadable = skipped.wrong_content + skipped.too_large + skipped.unreadable;
  if (unreadable + skipped.changed > 0) {
    notes.push(
      `${plural(unreadable + skipped.changed, "file or folder", "files or folders")} could not ` +
        "be checked (see coverage.notChecked): wrong content, too large, unreadable or changed " +
        "while being read.",
    );
  }
  if (skipped.link + skipped.unusable_name > 0) {
    notes.push(
      `${plural(skipped.link + skipped.unusable_name, "entry", "entries")} skipped: symbolic ` +
        "links are not followed, and names with invisible or control characters are not read.",
    );
  }
  if (vouchers.withoutChecksum > 0) {
    // The same statement as `withoutChecksum.note`, which also carries the German one.
    notes.push(withoutChecksumNote(vouchers.withoutChecksum).note);
  }
  const { notEmbedded } = vouchers;
  if (notEmbedded > 0) {
    const one = notEmbedded === 1;
    notes.push(
      `${plural(notEmbedded, "voucher row")} named ${one ? "its" : "their"} receipt without ` +
        "embedding the document, although the listing asked for it (embed=document): " +
        `${one ? "its" : "their"} checksum was not read, and ${one ? "it counts" : "they count"} ` +
        "among the receipts without a checksum. When this concerns most receipts, sevDesk did " +
        "not embed the documents and this check cannot match files.",
    );
  }
  if (vouchers.truncated) {
    notes.push(
      "The voucher listing stopped at its cap: files may count as not found although they are " +
        "booked. Use a shorter period.",
    );
  }
  if (findingsOmitted > 0) {
    notes.push(`${plural(findingsOmitted, "further finding")} not listed: check a smaller folder.`);
  }
  return notes;
}

/** Trusted one-line summary: counts only, no file name. */
export function receiptFolderSentence(result: ReceiptFolderResult): string {
  const { coverage } = result;
  const count = (code: ReceiptFolderCode): number => coverage.filesByFinding[code];
  const unhashed = coverage.vouchers.withoutChecksum;
  let text =
    `Receipt folder ${result.period.label}: ${plural(coverage.filesChecked, "file")} checked, ` +
    `${String(coverage.filesMatched)} found on a voucher, ` +
    `${String(count("receipt_file_not_booked"))} not found${unhashed > 0 ? " by checksum" : ""}`;
  const older = count("receipt_file_before_period");
  if (older > 0) text += ` (and ${String(older)} older than the vouchers read)`;
  const drafts = count("receipt_file_only_on_draft");
  if (drafts > 0) text += `, ${String(drafts)} only on a draft`;
  const twice = count("receipt_file_booked_twice");
  if (twice > 0) text += `, ${String(twice)} booked more than once`;
  text += ".";
  if (unhashed > 0) {
    text +=
      ` ${plural(unhashed, "receipt")} in sevDesk ${unhashed === 1 ? "has" : "have"} no ` +
      "checksum and could not be compared.";
  }
  if (coverage.folderCut.length > 0) text += " The folder was cut (see the notes).";
  if (coverage.vouchers.truncated) text += " The voucher listing was cut (see the notes).";
  return text;
}
