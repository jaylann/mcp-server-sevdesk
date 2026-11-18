/**
 * Voucher (Beleg) drafts that start from sevDesk's own receipt recognition (Belegerkennung, #96):
 * `POST /Voucher/Factory/createVoucherFromFile`, which is not in the spec (spec/deviations.md
 * D-024, D-103).
 *
 * Recorded 2026-11-16 (probe `write-voucher-from-file`, trial account, Update 2.0): a multipart
 * body with the field `creditDebit` = `C` and the PDF in the part `voucher` answers 2xx with the
 * new voucher in `objects`. It is a draft (status 50) at once, with placeholders (the moment of
 * creation as `voucherDate`, no supplier name, no description, sums 0) and the receipt attached.
 * About five seconds after the upload the recognition had filled in the date, the description
 * (the receipt's number), the sums, a supplier text (not reliably the receipt's supplier, and no
 * contact) and one position with rate and sums, but no tax rule and no booking account
 * (`accountDatev` null). The draft exists even when recognition finds nothing.
 *
 * Recorded 2026-11-17 (one-off check, same account): `creditDebit` `D` makes a revenue draft that
 * is recognised the same way; a PNG in the part `voucher` makes a draft too (a 1x1 test image,
 * nothing recognised; JPEG and real photos unmeasured); the sums were there one second after the
 * upload; a receipt with 19 % and 7 % came back as ONE position at 7 % with the right gross total
 * and a wrong split; the same file sent twice made a second draft (sevDesk does not deduplicate).
 *
 * Before the upload, {@link prepareVoucherRecognition} looks for the same file among the receipts
 * already in sevDesk ({@link scanSameFile}, #127): the file's SHA-256 against the `contentHash`
 * of the receipts of vouchers dated about the last six months (`GET /Voucher?embed=document`,
 * D-100). A match is refused unless the caller passes `allowDuplicate`: a guard against filing
 * the same file twice, not a safety gate. Receipts made by this endpoint carry `contentHash` null
 * (D-100), so an earlier recognition of the same file is not found; the scan finds receipts filed
 * through `uploadTempFile` + `saveVoucher` (the draft, receipt-save and e-invoice import tools).
 *
 * So {@link executeVoucherRecognition} sends the POST once (never retried), then reads the draft
 * until its sums appear, waiting at most {@link RECOGNITION_WAIT_MS} in total, and reports which
 * fields sevDesk filled in (none of them checked; positions and rates can be wrong even when the
 * total is right), what is still missing and how to complete the draft with the normal update or
 * delete it. It takes the file kinds of a manual receipt (PDF, PNG, JPEG) and says that the
 * recognition of images is unmeasured. The longest recognition time (scans, many pages) is
 * unmeasured too.
 *
 * Every value on the new draft comes from sevDesk and is third-party text: it reaches the model
 * only as cleaned DTO values, never in a summary, note, preview action or error message.
 */
import { z } from "zod";

import { fenceInline } from "../../safety/fence.js";
import { berlinDateOf } from "../../sevdesk/dates.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { realSleep } from "../../sevdesk/pacing.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { parseUpstream, zId, zOptionalDecimal, zOptionalRef, zText } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { cleanText, statusDto } from "../common.js";
import { compare, format, isZero, type Money } from "../money.js";
import {
  bothPreviews,
  dateText,
  inLanguage,
  numberText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../preview-text.js";
import {
  type DocumentHeader,
  type HeaderList,
  listDocumentHeaders,
} from "../reports/positions-scan.js";
import { shiftDays } from "../reports/shared.js";
import {
  creditDebitForKind,
  listVoucherPositions,
  listVouchers,
  mapVoucherDetail,
  type VoucherDetailDto,
  type VoucherDetails,
  type VoucherKind,
} from "../vouchers.js";
import { draftPreview } from "./document.js";
import { type DraftPreview, fact } from "./preview.js";
import { readBack } from "./read-back.js";
import {
  assertUpdate2,
  kindText,
  readReceiptFile,
  receiptFacts,
  receiptSha256,
  type VoucherCallOptions,
} from "./voucher-checks.js";
import { receiptBlob, type ReceiptFile, VOUCHER_DRAFT_STATUS } from "./voucher-payload.js";

/** The endpoint (D-103). */
const CREATE_FROM_FILE_PATH = "/Voucher/Factory/createVoucherFromFile";

/**
 * The waits between the reads of the new draft: the first read follows the upload at once, then
 * up to seven more, 15 s of waiting in total. Recorded: the sums were there one second after the
 * upload (2026-11-17), at the latest about 5 s after it (2026-11-16, D-103); the short first
 * waits catch the usual case, the bound of three times the slowest recorded one leaves headroom
 * without holding the call for long.
 */
export const RECOGNITION_WAITS_MS: readonly number[] = [
  1_000, 1_000, 2_000, 2_000, 3_000, 3_000, 3_000,
];

/** The longest total wait for the recognition, ms. */
export const RECOGNITION_WAIT_MS = RECOGNITION_WAITS_MS.reduce((sum, wait) => sum + wait, 0);

/**
 * Rows the duplicate scan after the recognition reads: sevDesk's largest page, in one request.
 * Vouchers of one direction dated the same day rarely come near it (a card statement batch might);
 * past it the result says the check was partial instead of reading as "no duplicates".
 */
export const DUPLICATE_SCAN_LIMIT = 1_000;

/** An abort-aware wait; tests inject one that does not wait. */
export type RecognitionSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Fields of the draft that sevDesk's recognition fills in, in the order the result lists them. */
export const RECOGNISED_FIELDS = ["date", "number", "supplierName", "totals", "positions"] as const;
type RecognisedField = (typeof RECOGNISED_FIELDS)[number];

/** What a draft from the recognition may still lack before it can be finalized. */
export const MISSING_FIELDS = ["taxRule", "bookingAccount", "number", "supplierContact"] as const;
type MissingField = (typeof MISSING_FIELDS)[number];

// ---------------------------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------------------------

export interface RecognitionState {
  readonly file: ReceiptFile;
  readonly kind: VoucherKind;
  /** The checksum check before the upload; its matches were allowed (`allowDuplicate`). */
  readonly sameFile: SameFileScan;
}

export interface RecognitionPlan {
  readonly preview: DraftPreview;
  readonly previewDe: DraftPreview;
  readonly state: RecognitionState;
}

/**
 * The party of the voucher: the supplier of an expense, the customer of revenue. The German word
 * is the stem compounds take ("Lieferante" + "ntext", "Kunde" + "nkontakt").
 */
function partyWord(kind: VoucherKind): Phrase {
  return kind === "expense" ? phrase("supplier", "Lieferante") : phrase("customer", "Kunde");
}

/**
 * Reads the receipt (PDF, PNG or JPEG, through the call's file access with its size and type
 * checks, like the receipt of a manual draft; a link is downloaded, `options.signal` stops it),
 * refuses other bytes than `fileSha256` names, checks that the account is on Update 2.0 (a
 * recognised draft can only be completed there), looks for the same file among the receipts in
 * sevDesk ({@link scanSameFile}; a match is refused unless `allowDuplicate`, in a dry run too) and
 * builds the preview, which shows the file's full SHA-256 for the caller to pass back as
 * `fileSha256`: the real call reads the file again, and the draft it makes cannot be taken back.
 * Nothing is written.
 */
export async function prepareVoucherRecognition(
  client: SevdeskClient,
  args: {
    readonly file: string;
    readonly fileSha256?: string | undefined;
    readonly kind?: VoucherKind | undefined;
    readonly allowDuplicate?: boolean | undefined;
  },
  options: VoucherCallOptions,
): Promise<RecognitionPlan> {
  const kind = args.kind ?? "expense";
  const file = await readReceiptFile({ files: options.files, signal: options.signal }, args.file, {
    sha256: args.fileSha256,
  });
  await assertUpdate2(client, options.signal, options.cacheOwner);
  const sameFile = await scanSameFile(client, receiptSha256(file), options.signal);
  const matches = sameFileMatches(sameFile);
  if (matches.length > 0 && args.allowDuplicate !== true) throw sameFileRefusal(matches);
  const seconds = String(RECOGNITION_WAIT_MS / 1_000);
  const party = partyWord(kind);
  return {
    ...bothPreviews((lang) => {
      const text = (en: string, de: string): string => (lang === "de" ? de : en);
      return draftPreview(
        text(
          `Send the receipt file to sevDesk's receipt recognition: sevDesk creates a draft ${kind} ` +
            "voucher (Beleg) with the file attached at once and fills it in within seconds; wait " +
            `up to ${seconds} s for it.`,
          "Belegdatei an sevDesks Belegerkennung senden: sevDesk legt sofort einen " +
            `Belegentwurf (${kind === "expense" ? "Ausgabe" : "Einnahme"}) mit der Datei an und ` +
            `füllt ihn binnen Sekunden aus; bis zu ${seconds} s darauf warten.`,
        ),
        [
          fact(text("Kind", "Art"), kindText(kind, lang)),
          ...receiptFacts(file, lang),
          fact(
            text("Filled in by sevDesk", "Von sevDesk ausgefüllt"),
            text(
              `date, Belegnummer, sums, a ${party.en} text, positions (unchecked)`,
              `Belegdatum, Belegnummer, Summen, ein ${party.de}ntext, Positionen (ungeprüft)`,
            ),
          ),
          fact(
            text("Left empty", "Bleibt leer"),
            text(
              `tax rule (Steuerregel), booking accounts (Buchungskonten), ${party.en} contact`,
              `Steuerregel, Buchungskonten, ${party.de}nkontakt`,
            ),
          ),
          fact(
            text("Status after saving", "Status nach dem Speichern"),
            text(
              `draft (${String(VOUCHER_DRAFT_STATUS)}), not booked yet`,
              `Entwurf (${String(VOUCHER_DRAFT_STATUS)}), noch nicht gebucht`,
            ),
          ),
          fact(
            text("Same file in sevDesk", "Gleiche Datei in sevDesk"),
            sameFileFact(sameFile, lang),
          ),
        ],
        inLanguage(
          [
            ...PREVIEW_WARNINGS,
            ...sameFileWarnings(sameFile),
            ...(file.kind === "pdf" ? [] : [IMAGE_WARNING]),
          ],
          lang,
        ),
      );
    }),
    state: { file, kind, sameFile },
  };
}

/** For a PNG or JPEG (2026-11-17: a test PNG made a draft, nothing was recognised). */
const IMAGE_WARNING = phrase(
  "How well sevDesk's recognition reads an image is unmeasured (a test PNG made a draft with " +
    "nothing filled in; JPEG was not tried): expect to enter the details yourself.",
  "Wie gut sevDesks Erkennung ein Bild liest, ist nicht gemessen (ein Test-PNG ergab einen " +
    "Entwurf ohne ausgefüllte Angaben; JPEG wurde nicht probiert): Rechne damit, die Angaben " +
    "selbst einzutragen.",
);

const PREVIEW_WARNINGS: readonly Phrase[] = [
  phrase(
    "The draft is created as soon as the file is sent, also when the recognition finds " +
      "nothing, and stays until it is completed or deleted (sevdesk_voucher_delete_draft). " +
      "Every call creates another draft.",
    "Der Entwurf entsteht, sobald die Datei gesendet ist, auch wenn die Erkennung nichts " +
      "findet, und bleibt, bis er vervollständigt oder gelöscht wird " +
      "(sevdesk_voucher_delete_draft). Jeder Aufruf legt einen weiteren Entwurf an.",
  ),
  phrase(
    "sevdesk_voucher_finalize refuses the draft until sevdesk_voucher_update_draft has set a " +
      "tax rule and a booking account on every position.",
    "sevdesk_voucher_finalize lehnt den Entwurf ab, bis sevdesk_voucher_update_draft eine " +
      "Steuerregel und auf jeder Position ein Buchungskonto gesetzt hat.",
  ),
  phrase(
    "The recognised positions and tax rates can be wrong even when the total is right (a " +
      "receipt with 19 % and 7 % came back as one position at 7 %).",
    "Die erkannten Positionen und Steuersätze können falsch sein, auch wenn die Summe stimmt " +
      "(ein Beleg mit 19 % und 7 % kam als eine Position zu 7 % zurück).",
  ),
  phrase(
    "sevDesk does not refuse a file it has seen before. This server compares the file's SHA-256 " +
      "with the receipts of vouchers dated about the last six months before sending it (fact " +
      '"Same file in sevDesk"); after the recognition the result also names vouchers with the ' +
      "same date, gross total and Belegnummer.",
    "sevDesk lehnt eine schon gesendete Datei nicht ab. Dieser Server vergleicht vor dem Senden " +
      "die SHA-256 der Datei mit den Belegdateien der Belege etwa des letzten halben Jahres " +
      "(Angabe „Gleiche Datei in sevDesk“); nach der Erkennung nennt das Ergebnis außerdem Belege " +
      "mit demselben Datum, derselben Bruttosumme und Belegnummer.",
  ),
  // D-100: sevDesk stores no contentHash for a receipt its recognition attached.
  phrase(
    "sevDesk stores no checksum for the receipt of this draft, nor for any earlier one made by " +
      "this recognition: the checksum check of this tool and sevdesk_receipt_folder_check cannot " +
      "find them, and sevdesk_records_audit pairs duplicate drafts by number and amount instead.",
    "sevDesk speichert für die Belegdatei dieses Entwurfs keine Prüfsumme, auch nicht für " +
      "frühere aus dieser Belegerkennung: Die Prüfsummenprüfung dieses Werkzeugs und " +
      "sevdesk_receipt_folder_check finden sie nicht, und sevdesk_records_audit erkennt doppelte " +
      "Entwürfe stattdessen an Nummer und Betrag.",
  ),
];

// ---------------------------------------------------------------------------------------------
// Same file before the upload (#127)
// ---------------------------------------------------------------------------------------------

/**
 * Days before today (Europe/Berlin) whose vouchers the checksum check reads, by Belegdatum. A
 * receipt usually goes to the recognition soon after it arrives: monthly or quarterly VAT returns
 * (UStVA, a month later with Dauerfristverlängerung) book it within about four months, so half a
 * year covers that with room. A receipt filed before under an older date is not compared; the
 * result names the range read.
 */
export const SAME_FILE_DAYS_BACK = 183;

/** Days after today the check reads too: receipts dated ahead (an invoice issued in advance). */
export const SAME_FILE_DAYS_AHEAD = 31;

/**
 * Rows the check reads: one request of sevDesk's largest page, every row with its receipt
 * embedded (`embed=document`, D-100). Half a year of a small business's vouchers rarely comes near
 * it; past it the result says the check was partial instead of reading as "not found".
 */
export const SAME_FILE_SCAN_LIMIT = 1_000;

/**
 * Most vouchers named in the refusal (fewer when they would not fit its
 * {@link SAME_FILE_REFUSAL_MAX} cap); the rest are counted.
 */
const SAME_FILE_NAMED = 3;

/** Longest Belegnummer shown in the refusal (fenced: it is sevDesk text). */
const SAME_FILE_NUMBER_MAX = 24;

/** A voucher whose receipt has the file's SHA-256, as its list row gave it. */
interface SameFileVoucher {
  readonly id: number;
  /** Belegnummer: cleaned sevDesk text, never put into trusted text unfenced. */
  readonly number?: string | undefined;
  /** Belegdatum, YYYY-MM-DD. */
  readonly date?: string | undefined;
  readonly gross?: Money | undefined;
  readonly statusCode: number;
}

/** What the checksum check before the upload found. */
export type SameFileScan =
  | {
      /** `partial`: sevDesk has more vouchers in the range than {@link SAME_FILE_SCAN_LIMIT}. */
      readonly outcome: "complete" | "partial";
      /** The Belegdatum range read, YYYY-MM-DD. */
      readonly from: string;
      readonly to: string;
      /** Voucher rows read. */
      readonly read: number;
      /** Receipts of those vouchers without a checksum (D-100): never compared. */
      readonly withoutChecksum: number;
      /** By date, then id. */
      readonly matches: readonly SameFileVoucher[];
    }
  /** The vouchers could not be read; the upload goes ahead without the check. */
  | { readonly outcome: "failed"; readonly from: string; readonly to: string };

/**
 * Looks for vouchers whose receipt is the very same file: `sha256` (lower-case hex) against the
 * `contentHash` sevDesk lists with each receipt (`GET /Voucher?embed=document`, D-100; drafts
 * included, one request of at most {@link SAME_FILE_SCAN_LIMIT} rows, Belegdatum from
 * {@link SAME_FILE_DAYS_BACK} days before `today` to {@link SAME_FILE_DAYS_AHEAD} days after it).
 * Only equal checksums match; a receipt without one (rendered files, receipts made by
 * `createVoucherFromFile`) is counted, never matched. A failed read is the outcome `failed`, not
 * an error: the check is a guard against waste, and the caller's file is not at fault. A cancelled
 * call still throws.
 */
async function scanSameFile(
  client: SevdeskClient,
  sha256: string,
  signal: AbortSignal | undefined,
  today: string = berlinDateOf(Date.now()),
): Promise<SameFileScan> {
  const from = shiftDays(today, -SAME_FILE_DAYS_BACK);
  const to = shiftDays(today, SAME_FILE_DAYS_AHEAD);
  let listed: HeaderList;
  try {
    listed = await listDocumentHeaders(
      client,
      {
        from,
        to,
        kinds: ["voucher"],
        keepDrafts: true,
        voucherReceipts: true,
        maxRows: SAME_FILE_SCAN_LIMIT,
        today,
      },
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (error instanceof SevdeskError && error.kind !== "aborted") {
      return { outcome: "failed", from, to };
    }
    throw error;
  }
  const vouchers = [...listed.headers, ...listed.drafts];
  const matches = vouchers
    .filter((header) => header.receipt?.hash === sha256)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id - b.id)
    .map(sameFileVoucher);
  return {
    outcome: listed.truncated ? "partial" : "complete",
    from,
    to,
    read: listed.rowsRead,
    withoutChecksum: vouchers.filter(
      (header) => header.receipt !== undefined && header.receipt.hash === undefined,
    ).length,
    matches,
  };
}

function sameFileVoucher(header: DocumentHeader): SameFileVoucher {
  return {
    id: header.id,
    ...(header.number === undefined ? {} : { number: header.number }),
    ...(header.date === undefined ? {} : { date: header.date }),
    ...(header.gross === undefined
      ? {}
      : { gross: { amount: format(header.gross, 2), currency: header.currency } }),
    statusCode: header.statusCode,
  };
}

/** The vouchers that carry the file; none when the check failed. */
function sameFileMatches(scan: SameFileScan): readonly SameFileVoucher[] {
  return scan.outcome === "failed" ? [] : scan.matches;
}

/** "draft", "open", "partially paid", …, or "status 42" for a code no filter knows. */
function statusWords(code: number): string {
  return statusDto("voucher", code).key?.replace(/_/g, " ") ?? `status ${String(code)}`;
}

/**
 * A Belegnummer cut to {@link SAME_FILE_NUMBER_MAX} code points with a short "…" (the fence's own
 * cut adds a longer marker, which the refusal has no room for). Still fenced by the caller.
 */
function shortNumber(number: string): string {
  const points = Array.from(number);
  return points.length <= SAME_FILE_NUMBER_MAX
    ? number
    : `${points.slice(0, SAME_FILE_NUMBER_MAX - 1).join("")}…`;
}

/**
 * Code points of an error message the tool error shows: `describeSevdeskError` cuts the rest
 * (`sanitizeUntrusted(…, 500)`), which would take the refusal's closing instruction with it.
 */
const SAME_FILE_REFUSAL_MAX = 500;

/** "2101 (`ER-2026-0815`, 2026-11-02, 119.00 EUR, draft)": a matching voucher in the refusal. */
function sameFileDetails(voucher: SameFileVoucher): string {
  const parts = [
    voucher.number === undefined ? undefined : fenceInline(shortNumber(voucher.number)),
    voucher.date,
    voucher.gross === undefined ? undefined : `${voucher.gross.amount} ${voucher.gross.currency}`,
    statusWords(voucher.statusCode),
  ].filter((part): part is string => part !== undefined);
  return `${String(voucher.id)} (${parts.join(", ")})`;
}

/** The refusal text naming `named` (the first matches, described) and counting the rest. */
function sameFileRefusalText(
  matches: readonly SameFileVoucher[],
  named: readonly string[],
): string {
  const more = matches.length - named.length;
  const one = matches.length === 1;
  return (
    `This receipt file is already attached to ${one ? "voucher" : "vouchers"} ` +
    `${named.join("; ")}${more > 0 ? ` and ${String(more)} more` : ""} (same SHA-256). ` +
    "Recognising it again makes another draft of the same receipt. Check it with " +
    "sevdesk_voucher_get; to send the file anyway, call again with allowDuplicate: true."
  );
}

/**
 * The refusal of a file that is already attached to a voucher: names up to
 * {@link SAME_FILE_NAMED} of them with id, Belegnummer (fenced), date, gross total and status.
 * Nothing was sent; the caller can check the voucher or pass `allowDuplicate`.
 *
 * Fits {@link SAME_FILE_REFUSAL_MAX} by construction, so the instruction at its end is never cut:
 * it names fewer vouchers (three, then two, then one) until the text fits. One always fits, as
 * the row schemas bound its parts (the number is cut, the amount and currency are validated); the
 * ids-only text keeps the guarantee should that ever change.
 */
function sameFileRefusal(matches: readonly SameFileVoucher[]): SevdeskError {
  const most = Math.min(SAME_FILE_NAMED, matches.length);
  const fits = (text: string): boolean => Array.from(text).length <= SAME_FILE_REFUSAL_MAX;
  const described = Array.from({ length: most }, (_, fewer) =>
    sameFileRefusalText(matches, matches.slice(0, most - fewer).map(sameFileDetails)),
  );
  const message =
    described.find(fits) ??
    sameFileRefusalText(
      matches,
      matches.slice(0, most).map((voucher) => String(voucher.id)),
    );
  return new SevdeskError({ kind: "validation", message });
}

/** "voucher 2299" / "vouchers 2299, 2300". */
function voucherIds(matches: readonly SameFileVoucher[]): Phrase {
  const ids = matches.map((voucher) => String(voucher.id)).join(", ");
  const one = matches.length === 1;
  return phrase(`${one ? "voucher" : "vouchers"} ${ids}`, `${one ? "Beleg" : "Belege"} ${ids}`);
}

/** The value of the preview fact "Same file in sevDesk". */
function sameFileFact(scan: SameFileScan, lang: PreviewLanguage): string {
  const de = lang === "de";
  const range = de
    ? `vom ${dateText(scan.from, lang)} bis ${dateText(scan.to, lang)}`
    : `dated ${scan.from} to ${scan.to}`;
  if (scan.outcome === "failed") {
    return de
      ? "nicht geprüft: Die Belege ließen sich nicht lesen"
      : "not checked: the vouchers could not be read";
  }
  if (scan.matches.length > 0) {
    return de
      ? `an ${voucherIds(scan.matches).de}; trotzdem senden (allowDuplicate)`
      : `on ${voucherIds(scan.matches).en}; sent anyway (allowDuplicate)`;
  }
  const read = numberText(String(scan.read), lang);
  const vouchers = de
    ? `${read} ${scan.read === 1 ? "Beleg" : "Belegen"}`
    : `${read} ${scan.read === 1 ? "voucher" : "vouchers"}`;
  const among =
    scan.outcome === "partial"
      ? de
        ? `keine unter den ersten ${vouchers} ${range} (sevDesk hat mehr)`
        : `none among the first ${vouchers} ${range} (sevDesk has more)`
      : de
        ? `keine unter ${vouchers} ${range}`
        : `none among ${vouchers} ${range}`;
  if (scan.withoutChecksum === 0) return among;
  const count = String(scan.withoutChecksum);
  const one = scan.withoutChecksum === 1;
  return de
    ? `${among}; ${count} ${one ? "Belegdatei" : "Belegdateien"} ohne Prüfsumme nicht verglichen`
    : `${among}; ${count} ${one ? "receipt" : "receipts"} without a checksum not compared`;
}

/** The warnings of the check in the preview: an allowed match, a partial or a failed check. */
function sameFileWarnings(scan: SameFileScan): Phrase[] {
  if (scan.outcome === "failed") {
    return [
      phrase(
        "The checksum check could not read the vouchers in sevDesk, so it did not run; the file " +
          "is sent without it.",
        "Die Prüfsummenprüfung konnte die Belege in sevDesk nicht lesen und lief daher nicht; " +
          "die Datei wird ohne sie gesendet.",
      ),
    ];
  }
  const warnings: Phrase[] = [];
  if (scan.matches.length > 0) {
    const which = voucherIds(scan.matches);
    warnings.push(
      phrase(
        `This file is already attached to ${which.en} (same SHA-256). allowDuplicate is set, ` +
          "so it is sent anyway and sevDesk makes another draft of it.",
        `Diese Datei hängt schon an ${which.de} (gleiche SHA-256). allowDuplicate ist gesetzt, ` +
          "daher wird sie trotzdem gesendet, und sevDesk legt einen weiteren Entwurf daraus an.",
      ),
    );
  }
  if (scan.outcome === "partial") warnings.push(partialPhrase(scan));
  return warnings;
}

function partialPhrase(scan: { readonly from: string; readonly to: string }): Phrase {
  const rows = String(SAME_FILE_SCAN_LIMIT);
  return phrase(
    `The checksum check read the first ${rows} vouchers dated ${scan.from} to ${scan.to}, and ` +
      "sevDesk has more; the rest were not compared.",
    `Die Prüfsummenprüfung hat die ersten ${rows} Belege vom ${dateText(scan.from, "de")} bis ` +
      `${dateText(scan.to, "de")} gelesen, und sevDesk hat mehr; die übrigen wurden nicht ` +
      "verglichen.",
  );
}

/**
 * The notes of the check in the result: an allowed match (ids only; the details are in the
 * output), a partial or failed check, and receipts that could not be compared.
 */
function sameFileNotes(scan: SameFileScan, draftId: string): Phrase[] {
  if (scan.outcome === "failed") {
    return [
      phrase(
        "The checksum check before the upload could not read the vouchers in sevDesk, so the " +
          "file was sent unchecked; look for the receipt with sevdesk_vouchers_list before " +
          "finalizing.",
        "Die Prüfsummenprüfung vor dem Hochladen konnte die Belege in sevDesk nicht lesen, daher " +
          "wurde die Datei ungeprüft gesendet; suche den Beleg vor dem Fertigstellen mit " +
          "sevdesk_vouchers_list.",
      ),
    ];
  }
  const notes: Phrase[] = [];
  if (scan.matches.length > 0) {
    const which = voucherIds(scan.matches);
    notes.push(
      phrase(
        `This file was already attached to ${which.en} before the upload (same SHA-256, ` +
          "sameFileCheck.vouchers); it was sent anyway because allowDuplicate is set. If it is " +
          `the same receipt filed twice, delete draft ${draftId} with ` +
          "sevdesk_voucher_delete_draft.",
        `Diese Datei hing vor dem Hochladen schon an ${which.de} (gleiche SHA-256, ` +
          "sameFileCheck.vouchers); sie wurde trotzdem gesendet, weil allowDuplicate gesetzt ist. " +
          `Ist es derselbe Beleg zweimal, lösche Entwurf ${draftId} mit ` +
          "sevdesk_voucher_delete_draft.",
      ),
    );
  }
  if (scan.outcome === "partial") notes.push(partialPhrase(scan));
  if (scan.withoutChecksum > 0) {
    const count = String(scan.withoutChecksum);
    const one = scan.withoutChecksum === 1;
    notes.push(
      phrase(
        `${count} ${one ? "receipt" : "receipts"} on the vouchers compared ${one ? "has" : "have"} ` +
          "no checksum in sevDesk (receipts made by this recognition never have one) and could " +
          "not be compared: a file recognised before is not found by the checksum check.",
        `${count} ${one ? "Belegdatei" : "Belegdateien"} an den verglichenen Belegen ` +
          `${one ? "hat" : "haben"} in sevDesk keine Prüfsumme (Belegdateien aus dieser ` +
          "Belegerkennung haben nie eine) und " +
          `${one ? "konnte" : "konnten"} nicht verglichen werden: Eine schon erkannte Datei ` +
          "findet die Prüfsummenprüfung nicht.",
      ),
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------------------------

export interface RecognitionOptions {
  readonly signal?: AbortSignal | undefined;
  /** Defaults to a real timer. */
  readonly sleep?: RecognitionSleep | undefined;
  /** Called before each wait with the reads made so far and the most reads there will be. */
  readonly onWait?: ((reads: number, maxReads: number) => Promise<void>) | undefined;
  /**
   * Called once, right after sevDesk's answer to the upload shows the receipt attached to the new
   * draft, before anything is read back. The caller releases a remote upload there: the draft
   * exists from this moment on, so an upload kept after a failed read would let a retry with the
   * same upload id make a second draft.
   */
  readonly onAttached?: (() => void) | undefined;
}

/** What the duplicate scan after the recognition found. */
type DuplicateScan =
  | { readonly outcome: "done"; readonly ids: readonly number[] }
  /** sevDesk has more rows than {@link DUPLICATE_SCAN_LIMIT}: `ids` are the matches among those read. */
  | { readonly outcome: "partial"; readonly ids: readonly number[] }
  /** No recognised date and gross total: there was nothing to compare. */
  | { readonly outcome: "skipped" }
  | { readonly outcome: "failed" };

export interface RecognitionResult {
  readonly id: number;
  readonly details: VoucherDetails;
  /** Whether the sums appeared within the wait. */
  readonly recognised: boolean;
  readonly filledIn: readonly RecognisedField[];
  readonly missing: readonly MissingField[];
  /** Reads of the draft after the upload. */
  readonly reads: number;
  readonly waitedMs: number;
  readonly duplicates: DuplicateScan;
  /** The checksum check before the upload (its matches were allowed with `allowDuplicate`). */
  readonly sameFile: SameFileScan;
  /** The file sent: name, kind, size, SHA-256 and, for a link, the origin it came from. */
  readonly receipt: {
    readonly name: string;
    readonly kind: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly downloadedFrom?: string;
  };
  /** Trusted notes: what to check, what is missing, what to do next. */
  readonly notes: readonly string[];
  readonly notesDe: readonly string[];
}

/**
 * The fields of a voucher record this module compares; everything else is ignored. `document`
 * stays unparsed here, so an unexpected shape cannot fail the answer that names the new voucher;
 * {@link documentAttached} reads it.
 */
const watchedSchema = z.object({
  id: zId,
  objectName: zText,
  voucherDate: z.unknown().optional(),
  sumGross: zOptionalDecimal,
  document: z.unknown().optional(),
});

/** Whether a voucher record references its receipt (`document`, recorded as `{id, objectName}`). */
function documentAttached(record: z.output<typeof watchedSchema>): boolean {
  const parsed = zOptionalRef.safeParse(record.document);
  return parsed.success && parsed.data !== undefined;
}

/**
 * Sends the receipt to the recognition (one POST, never retried), waits for the sums, reads the
 * positions and scans for duplicates. Once sevDesk has answered with the new voucher, every
 * failure carries it as a completed write, so the caller is told not to send the receipt again.
 */
export async function executeVoucherRecognition(
  client: SevdeskClient,
  state: RecognitionState,
  options: RecognitionOptions = {},
): Promise<RecognitionResult> {
  const { signal } = options;
  const withSignal = signal === undefined ? {} : { signal };
  const answer = await client.request({
    method: "POST",
    path: CREATE_FROM_FILE_PATH,
    form: recognitionForm(state.file, state.kind),
    ...withSignal,
  });
  const created = readCreatedVoucher(answer);
  const id = created.id;
  const saved = { objectName: "Voucher", id: String(id) };
  // Recorded: the answer already carries the receipt (D-103), so the release does not wait for a
  // read that may fail.
  if (documentAttached(created)) options.onAttached?.();

  const waited = await readBack(saved, () => waitForRecognition(client, id, options));
  const voucher = waited.voucher;
  const positions = await readBack(saved, () =>
    listVoucherPositions(client, id, voucher.currency, signal),
  );
  const details: VoucherDetails = {
    voucher,
    positions: positions.positions,
    positionsComplete: positions.complete,
  };
  const recognised = waited.record.sumGross !== undefined && !isZero(waited.record.sumGross);
  // This call sent no field but the file, so every value the draft holds came from sevDesk; the
  // date is the one field with a placeholder (the moment of creation) that recognition replaces.
  const filled: Readonly<Record<RecognisedField, boolean>> = {
    date:
      waited.record.voucherDate !== undefined &&
      JSON.stringify(waited.record.voucherDate) !== JSON.stringify(created.voucherDate),
    number: voucher.number !== undefined,
    supplierName: voucher.supplier?.name !== undefined,
    totals: recognised,
    positions: details.positions.length > 0,
  };
  const lacking: Readonly<Record<MissingField, boolean>> = {
    taxRule: voucher.tax.rule === undefined,
    bookingAccount:
      details.positions.length === 0 ||
      details.positions.some((position) => position.accountDatev === undefined),
    number: voucher.number === undefined,
    supplierContact: voucher.supplier?.id === undefined,
  };
  const filledIn = RECOGNISED_FIELDS.filter((field) => filled[field]);
  const missing = MISSING_FIELDS.filter((field) => lacking[field]);
  const duplicates = recognised
    ? await scanDuplicates(client, voucher, state.kind, signal)
    : ({ outcome: "skipped" } as const);
  const facts: NoteFacts = {
    id,
    kind: state.kind,
    image: state.file.kind !== "pdf",
    voucher,
    recognised,
    filledIn,
    missing,
    reads: waited.reads,
    waitedMs: waited.waitedMs,
    duplicates,
    sameFile: state.sameFile,
    positionsComplete: details.positionsComplete,
  };
  return {
    id,
    details,
    recognised,
    filledIn,
    missing,
    reads: waited.reads,
    waitedMs: waited.waitedMs,
    duplicates,
    sameFile: state.sameFile,
    receipt: {
      name: cleanText(state.file.name, 200) ?? "file",
      kind: state.file.kind,
      bytes: state.file.bytes.length,
      sha256: receiptSha256(state.file),
      ...(state.file.host === undefined ? {} : { downloadedFrom: `https://${state.file.host}` }),
    },
    notes: inLanguage(recognitionNotes(facts), "en"),
    notesDe: inLanguage(recognitionNotes(facts), "de"),
  };
}

/**
 * The multipart body: `creditDebit` C (expense) or D (revenue) and the file in the part `voucher`
 * with its sniffed MIME type (D-103).
 */
function recognitionForm(file: ReceiptFile, kind: VoucherKind): FormData {
  const form = new FormData();
  form.append("creditDebit", creditDebitForKind(kind));
  form.append("voucher", receiptBlob(file), file.name);
  return form;
}

/**
 * The new voucher in the answer. sevDesk has created it when this runs, so an answer that does
 * not name it says that a draft probably exists and must be looked for, not created again.
 */
function readCreatedVoucher(answer: unknown): z.output<typeof watchedSchema> {
  let record: z.output<typeof watchedSchema> | undefined;
  let cause: SevdeskError | undefined;
  try {
    record = parseUpstream(
      watchedSchema,
      expectSingle(answer, "created voucher"),
      "the receipt recognition answer",
    );
  } catch (error) {
    if (!(error instanceof SevdeskError)) throw error;
    cause = error;
  }
  if (record === undefined || (record.objectName ?? "Voucher") !== "Voucher") {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        "sevDesk accepted the receipt, but its answer did not name the new voucher, so it could " +
        "not be read back. sevDesk normally creates a draft voucher at once: look for it with " +
        "sevdesk_vouchers_list (status draft) and complete or delete it. Do not send the receipt " +
        "again, or a second draft is created.",
      ...(cause === undefined ? {} : { cause }),
    });
  }
  return record;
}

interface WaitOutcome {
  readonly record: z.output<typeof watchedSchema>;
  readonly voucher: VoucherDetailDto;
  readonly reads: number;
  readonly waitedMs: number;
}

/** Reads the draft at once, then after each wait of {@link RECOGNITION_WAITS_MS} until its sums appear. */
async function waitForRecognition(
  client: SevdeskClient,
  id: number,
  options: RecognitionOptions,
): Promise<WaitOutcome> {
  const sleep = options.sleep ?? realSleep;
  let raw = await readVoucher(client, id, options.signal);
  let record = parseUpstream(watchedSchema, raw, "a voucher");
  let reads = 1;
  let waitedMs = 0;
  for (const wait of RECOGNITION_WAITS_MS) {
    if (record.sumGross !== undefined && !isZero(record.sumGross)) break;
    await options.onWait?.(reads, RECOGNITION_WAITS_MS.length + 1);
    try {
      await sleep(wait, options.signal);
    } catch (error) {
      throw new SevdeskError({
        kind: "aborted",
        message: "The request was cancelled.",
        cause: error,
      });
    }
    waitedMs += wait;
    raw = await readVoucher(client, id, options.signal);
    record = parseUpstream(watchedSchema, raw, "a voucher");
    reads += 1;
  }
  return { record, voucher: mapVoucherDetail(raw), reads, waitedMs };
}

async function readVoucher(
  client: SevdeskClient,
  id: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Voucher", id),
    ...(signal === undefined ? {} : { signal }),
  });
  return expectSingle(payload, `voucher ${String(id)}`);
}

/**
 * Other vouchers of the same direction with the recognised date and gross total (and
 * Belegnummer, when one was recognised). The supplier is not compared: the recognised supplier
 * text is not reliable (D-103). sevDesk itself makes a second draft from the same file
 * (2026-11-17), and the checksum check before the upload ({@link scanSameFile}) cannot see an
 * earlier recognition of it (D-100), so this is the only guard against that case. A failed scan
 * does not fail the call, since
 * the draft exists already; the notes say that it did not run, or that it read only the first
 * {@link DUPLICATE_SCAN_LIMIT} rows.
 */
async function scanDuplicates(
  client: SevdeskClient,
  voucher: VoucherDetailDto,
  kind: VoucherKind,
  signal: AbortSignal | undefined,
): Promise<DuplicateScan> {
  const date = voucher.date;
  const gross = voucher.totals.gross;
  if (date === undefined || gross === undefined) return { outcome: "skipped" };
  const same = (a: string | undefined, b: string | undefined): boolean =>
    (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  try {
    const result = await listVouchers(
      client,
      {
        kind,
        description: voucher.number,
        from: date,
        to: date,
        limit: DUPLICATE_SCAN_LIMIT,
        offset: 0,
      },
      signal,
    );
    const ids = result.items
      .filter(
        (row) =>
          row.id !== voucher.id &&
          row.currency === voucher.currency &&
          row.totals.gross !== undefined &&
          compare(row.totals.gross.amount, gross.amount) === 0 &&
          (voucher.number === undefined || same(row.number, voucher.number)),
      )
      .map((row) => row.id)
      .sort((a, b) => a - b);
    // sevDesk reports the count (`countAll`); a page without one counts as partial when it is full.
    const partial =
      result.window.total === undefined
        ? result.window.received >= DUPLICATE_SCAN_LIMIT
        : result.state.hasMore;
    return { outcome: partial ? "partial" : "done", ids };
  } catch (error) {
    if (error instanceof SevdeskError) return { outcome: "failed" };
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

interface NoteFacts {
  readonly id: number;
  readonly kind: VoucherKind;
  /** The receipt was a PNG or JPEG (recognition of images is unmeasured). */
  readonly image: boolean;
  readonly voucher: VoucherDetailDto;
  readonly recognised: boolean;
  readonly filledIn: readonly RecognisedField[];
  readonly missing: readonly MissingField[];
  readonly reads: number;
  readonly waitedMs: number;
  readonly duplicates: DuplicateScan;
  readonly sameFile: SameFileScan;
  readonly positionsComplete: boolean;
}

/** The words for the voucher's party in the notes (supplier of an expense, customer of revenue). */
interface PartyWords {
  readonly en: string;
  /** Nominative, accusative and the compound with "Text". */
  readonly de: string;
  readonly deAcc: string;
  readonly deText: string;
}

function partyWords(kind: VoucherKind): PartyWords {
  return kind === "expense"
    ? { en: "supplier", de: "Lieferant", deAcc: "Lieferanten", deText: "Lieferantentext" }
    : { en: "customer", de: "Kunde", deAcc: "Kunden", deText: "Kundentext" };
}

function fieldNames(party: PartyWords): Readonly<Record<RecognisedField, Phrase>> {
  return {
    date: phrase("the date", "das Belegdatum"),
    number: phrase("the Belegnummer", "die Belegnummer"),
    supplierName: phrase(`a ${party.en} text`, `einen ${party.deText}`),
    totals: phrase("the sums", "die Summen"),
    positions: phrase("the positions", "die Positionen"),
  };
}

/** "a, b and c" / "a, b und c". */
function listed(items: readonly Phrase[]): Phrase {
  const join = (lang: "en" | "de"): string => {
    const words = items.map((item) => item[lang]);
    const last = words.pop();
    if (last === undefined) return "";
    return words.length === 0
      ? last
      : `${words.join(", ")} ${lang === "de" ? "und" : "and"} ${last}`;
  };
  return phrase(join("en"), join("de"));
}

/**
 * The trusted notes of a recognition result. They name fields and ids only, never a value sevDesk
 * recognised (those are in the DTO).
 */
function recognitionNotes(facts: NoteFacts): Phrase[] {
  const notes: Phrase[] = [];
  const id = String(facts.id);
  const seconds = String(facts.waitedMs / 1_000);
  const party = partyWords(facts.kind);
  if (!facts.recognised) {
    notes.push(
      phrase(
        `sevDesk's receipt recognition filled in no sums within ${seconds} s (${String(facts.reads)} ` +
          "reads). What it did not fill in keeps sevDesk's placeholders: the upload time as " +
          `date, sums 0, no ${party.en} and no Belegnummer. The recognition may still finish ` +
          `later: read draft ${id} again with sevdesk_voucher_get, then complete it with ` +
          `sevdesk_voucher_update_draft (${party.en}, number, date, taxRuleId, positions) or ` +
          "delete it with sevdesk_voucher_delete_draft. Do not call this tool again for the same " +
          "receipt: every call creates another draft.",
        `sevDesks Belegerkennung hat binnen ${seconds} s (${String(facts.reads)} Abrufe) keine ` +
          "Summen ausgefüllt. Was sie nicht ausgefüllt hat, behält sevDesks Platzhalter: den " +
          `Zeitpunkt des Hochladens als Datum, Summen 0, keinen ${party.deAcc} und keine ` +
          `Belegnummer. Die Erkennung kann später noch fertig werden: Lies Entwurf ${id} mit ` +
          "sevdesk_voucher_get erneut, dann vervollständige ihn mit sevdesk_voucher_update_draft " +
          `(${party.de}, Belegnummer, Datum, taxRuleId, Positionen) oder lösche ihn mit ` +
          "sevdesk_voucher_delete_draft. Rufe dieses Werkzeug für denselben Beleg nicht erneut " +
          "auf: Jeder Aufruf legt einen weiteren Entwurf an.",
      ),
    );
  }
  if (facts.image) {
    notes.push(IMAGE_WARNING);
  }
  if (facts.filledIn.length > 0) {
    const names = fieldNames(party);
    const fields = listed(facts.filledIn.map((field) => names[field]));
    notes.push(
      phrase(
        `sevDesk's receipt recognition filled in ${fields.en} (recognition.filledIn); nobody has ` +
          "checked these values. Compare them with the receipt before finalizing.",
        `sevDesks Belegerkennung hat ${fields.de} ausgefüllt (recognition.filledIn); niemand hat ` +
          "diese Werte geprüft. Vergleiche sie vor dem Fertigstellen mit dem Beleg.",
      ),
    );
  }
  if (facts.filledIn.includes("positions") || facts.filledIn.includes("totals")) {
    // Recorded 2026-11-17: 100.00 net at 19 % and 50.00 net at 7 % came back as one position at
    // 7 % with the right gross total and a wrong split (D-103).
    notes.push(
      phrase(
        "The recognised positions and tax rates can be wrong even when the total is right: " +
          "sevDesk read a receipt with 19 % and 7 % as one position at 7 %. Check every " +
          "position and rate against the receipt; a receipt with several tax rates has to be " +
          "entered again as one position per rate (positions of sevdesk_voucher_update_draft).",
        "Die erkannten Positionen und Steuersätze können falsch sein, auch wenn die Summe stimmt: " +
          "sevDesk hat einen Beleg mit 19 % und 7 % als eine Position zu 7 % gelesen. Prüfe jede " +
          "Position und jeden Steuersatz am Beleg; ein Beleg mit mehreren Steuersätzen muss als " +
          "eine Position je Satz neu erfasst werden (positions von sevdesk_voucher_update_draft).",
      ),
    );
  }
  if (facts.missing.includes("supplierContact")) {
    notes.push(
      facts.filledIn.includes("supplierName")
        ? phrase(
            `The ${party.en} is only a text sevDesk read (voucher.supplier.name), not always the ` +
              `receipt's ${party.en}, and not a contact: set supplierId (from ` +
              "sevdesk_contacts_search) or supplierName with sevdesk_voucher_update_draft.",
            `Der ${party.de} ist nur ein von sevDesk gelesener Text (voucher.supplier.name), ` +
              `nicht immer der ${party.de} des Belegs, und kein Kontakt: Setze supplierId (aus ` +
              "sevdesk_contacts_search) oder supplierName mit sevdesk_voucher_update_draft.",
          )
        : phrase(
            `The draft has no ${party.en}: set supplierId (from sevdesk_contacts_search) or ` +
              "supplierName with sevdesk_voucher_update_draft.",
            `Der Entwurf hat keinen ${party.deAcc}: Setze supplierId (aus ` +
              "sevdesk_contacts_search) oder supplierName mit sevdesk_voucher_update_draft.",
          ),
    );
  }
  const noRule = facts.missing.includes("taxRule");
  const noAccount = facts.missing.includes("bookingAccount");
  if (noRule || noAccount) {
    const lacks = noRule
      ? noAccount
        ? phrase(
            "no tax rule (Steuerregel) and no booking account (Buchungskonto)",
            "keine Steuerregel und kein Buchungskonto",
          )
        : phrase("no tax rule (Steuerregel)", "keine Steuerregel")
      : phrase(
          "a position without a booking account (Buchungskonto)",
          "eine Position ohne Buchungskonto",
        );
    const fix = noAccount
      ? phrase(
          `${noRule ? "taxRuleId and " : ""}all positions with accountDatevId, amount and ` +
            "taxRate (they replace the recognised ones)",
          `${noRule ? "taxRuleId und " : ""}alle Positionen mit accountDatevId, Betrag und ` +
            "taxRate (sie ersetzen die erkannten)",
        )
      : phrase("taxRuleId", "taxRuleId");
    notes.push(
      phrase(
        `Draft ${id} has ${lacks.en}, so sevdesk_voucher_finalize refuses it. Complete it with ` +
          `sevdesk_voucher_update_draft: ${fix.en}. sevdesk_reference_lookup ` +
          "kind=receipt_guidance lists which booking accounts allow which tax rules and rates.",
        `Entwurf ${id} hat ${lacks.de}, daher lehnt sevdesk_voucher_finalize ihn ab. ` +
          `Vervollständige ihn mit sevdesk_voucher_update_draft: ${fix.de}. ` +
          "sevdesk_reference_lookup kind=receipt_guidance zeigt, welche Buchungskonten welche " +
          "Steuerregeln und Steuersätze erlauben.",
      ),
    );
  }
  if (facts.recognised && facts.missing.includes("number")) {
    notes.push(
      phrase(
        "No Belegnummer was recognised, and sevDesk books no voucher without one: set number " +
          "with sevdesk_voucher_update_draft.",
        "Es wurde keine Belegnummer erkannt, und ohne Belegnummer bucht sevDesk keinen Beleg: " +
          "Setze number mit sevdesk_voucher_update_draft.",
      ),
    );
  }
  notes.push(...duplicateNotes(facts.duplicates, id));
  notes.push(...sameFileNotes(facts.sameFile, id));
  const status = facts.voucher.status;
  if (status !== undefined && status.code !== VOUCHER_DRAFT_STATUS) {
    notes.push(
      phrase(
        `Voucher ${id} reads back with status ${String(status.code)}, not draft ` +
          `${String(VOUCHER_DRAFT_STATUS)}. Check it in sevDesk.`,
        `Beleg ${id} hat Status ${String(status.code)} statt Entwurf ` +
          `${String(VOUCHER_DRAFT_STATUS)}. Prüfe ihn in sevDesk.`,
      ),
    );
  }
  if (facts.voucher.hasDocument === false) {
    notes.push(
      phrase(
        `sevDesk reports no receipt file on draft ${id}; attach it with ` +
          "sevdesk_voucher_update_draft (file).",
        `sevDesk meldet keine Belegdatei an Entwurf ${id}; hänge sie mit ` +
          "sevdesk_voucher_update_draft (file) an.",
      ),
    );
  }
  if (!facts.positionsComplete) {
    notes.push(
      phrase(
        "sevDesk has more positions than could be read back; positions is partial.",
        "sevDesk hat mehr Positionen, als ausgelesen werden konnten; positions ist unvollständig.",
      ),
    );
  }
  return notes;
}

/**
 * The notes of the duplicate scan: the vouchers it found, and, whenever it did not look through
 * every voucher of that day (partial, skipped, failed), that it did not, so the result never reads
 * as "no duplicates" when nobody checked.
 */
function duplicateNotes(scan: DuplicateScan, draftId: string): Phrase[] {
  const notes: Phrase[] = [];
  const ids = scan.outcome === "done" || scan.outcome === "partial" ? scan.ids : [];
  if (ids.length > 0) {
    const which = ids.map(String).join(", ");
    const one = ids.length === 1;
    notes.push(
      phrase(
        `Possible duplicate: ${one ? "voucher" : "vouchers"} ${which} ${one ? "has" : "have"} ` +
          "the same date, gross total and Belegnummer. If this receipt was filed before, delete " +
          `draft ${draftId} with sevdesk_voucher_delete_draft.`,
        `Mögliche Dublette: ${one ? "Beleg" : "Belege"} ${which} ${one ? "hat" : "haben"} ` +
          "dasselbe Datum, dieselbe Bruttosumme und Belegnummer. Wurde dieser Beleg schon " +
          `erfasst, lösche Entwurf ${draftId} mit sevdesk_voucher_delete_draft.`,
      ),
    );
  }
  const rows = String(DUPLICATE_SCAN_LIMIT);
  switch (scan.outcome) {
    case "done":
      break;
    case "partial":
      notes.push(
        phrase(
          `The duplicate check after the recognition read the first ${rows} vouchers of that ` +
            "date and kind, and sevDesk has more; the rest were not compared. Look for the " +
            "receipt with sevdesk_vouchers_list before finalizing.",
          `Die Dublettenprüfung nach der Erkennung hat die ersten ${rows} Belege dieses Datums ` +
            "und dieser Art gelesen, und sevDesk hat mehr; die übrigen wurden nicht verglichen. " +
            "Suche den Beleg vor dem Fertigstellen mit sevdesk_vouchers_list.",
        ),
      );
      break;
    case "skipped":
      notes.push(
        phrase(
          "No duplicate check ran: the draft has no recognised date and gross total to compare. " +
            "Look for the receipt with sevdesk_vouchers_list before finalizing.",
          "Es lief keine Dublettenprüfung: Der Entwurf hat kein erkanntes Datum und keine " +
            "erkannte Bruttosumme zum Vergleichen. Suche den Beleg vor dem Fertigstellen mit " +
            "sevdesk_vouchers_list.",
        ),
      );
      break;
    case "failed":
      notes.push(
        phrase(
          "The duplicate check after the recognition could not run; look for the receipt with " +
            "sevdesk_vouchers_list before finalizing.",
          "Die Dublettenprüfung nach der Erkennung konnte nicht laufen; suche den Beleg vor dem " +
            "Fertigstellen mit sevdesk_vouchers_list.",
        ),
      );
      break;
    default: {
      const unknown: never = scan;
      return unknown;
    }
  }
  return notes;
}
