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
 * So {@link executeVoucherRecognition} sends the POST once (never retried), then reads the draft
 * until its sums appear, waiting at most {@link RECOGNITION_WAIT_MS} in total, and reports which
 * fields sevDesk filled in (none of them checked), what is still missing and how to complete the
 * draft with the normal update or delete it. Only what was recorded is offered: expense receipts
 * as PDF. Revenue vouchers (`D`), image files, the longest recognition time and receipts with
 * several tax rates were not recorded.
 *
 * Every value on the new draft comes from sevDesk and is third-party text: it reaches the model
 * only as cleaned DTO values, never in a summary, note, preview action or error message.
 */
import { z } from "zod";

import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { realSleep } from "../../sevdesk/pacing.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { parseUpstream, zId, zOptionalDecimal, zText } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { cleanText } from "../common.js";
import { compare, isZero } from "../money.js";
import { bothPreviews, inLanguage, type Phrase, phrase } from "../preview-text.js";
import {
  listVoucherPositions,
  listVouchers,
  mapVoucherDetail,
  type VoucherDetailDto,
  type VoucherDetails,
} from "../vouchers.js";
import { draftPreview } from "./document.js";
import { type DraftPreview, fact } from "./preview.js";
import { readBack } from "./read-back.js";
import {
  assertUpdate2,
  kindText,
  readReceiptFile,
  receiptText,
  type VoucherCallOptions,
} from "./voucher-checks.js";
import { receiptBlob, type ReceiptFile, VOUCHER_DRAFT_STATUS } from "./voucher-payload.js";

/** The endpoint (D-103). */
const CREATE_FROM_FILE_PATH = "/Voucher/Factory/createVoucherFromFile";

/** File kinds sent to the recognition: only a PDF was recorded (D-103). */
const RECOGNITION_FILE_KINDS = ["pdf"] as const;

/**
 * The waits between the reads of the new draft: the first read follows the upload at once, then
 * up to six more, 15 s of waiting in total. Recorded: the sums were there about 5 s after the
 * upload (D-103); three times that leaves headroom without holding the call for long.
 */
export const RECOGNITION_WAITS_MS: readonly number[] = [2_000, 2_000, 2_000, 3_000, 3_000, 3_000];

/** The longest total wait for the recognition, ms. */
export const RECOGNITION_WAIT_MS = RECOGNITION_WAITS_MS.reduce((sum, wait) => sum + wait, 0);

/** Rows checked for possible duplicates after the recognition. */
const DUPLICATE_SCAN_LIMIT = 25;

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
}

export interface RecognitionPlan {
  readonly preview: DraftPreview;
  readonly previewDe: DraftPreview;
  readonly state: RecognitionState;
}

/**
 * Reads the receipt (a PDF, through the call's file access with its size and type checks),
 * checks that the account is on Update 2.0 (a recognised draft can only be completed there) and
 * builds the preview. Nothing is written.
 */
export async function prepareVoucherRecognition(
  client: SevdeskClient,
  fileRef: string,
  options: VoucherCallOptions,
): Promise<RecognitionPlan> {
  const file = await readReceiptFile(options.files, fileRef, RECOGNITION_FILE_KINDS);
  await assertUpdate2(client, options.signal, options.cacheOwner);
  const seconds = String(RECOGNITION_WAIT_MS / 1_000);
  return {
    ...bothPreviews((lang) => {
      const text = (en: string, de: string): string => (lang === "de" ? de : en);
      return draftPreview(
        text(
          "Send the receipt file to sevDesk's receipt recognition: sevDesk creates a draft " +
            "expense voucher (Beleg) with the file attached at once and fills it in within " +
            `seconds; wait up to ${seconds} s for it.`,
          "Belegdatei an sevDesks Belegerkennung senden: sevDesk legt sofort einen " +
            "Belegentwurf (Ausgabe) mit der Datei an und füllt ihn binnen Sekunden aus; bis zu " +
            `${seconds} s darauf warten.`,
        ),
        [
          fact(text("Kind", "Art"), kindText("expense", lang)),
          fact(text("Receipt file (Belegbild)", "Belegdatei"), receiptText(file, lang)),
          fact(
            text("Filled in by sevDesk", "Von sevDesk ausgefüllt"),
            text(
              "date, Belegnummer, sums, a supplier text, positions (unchecked)",
              "Belegdatum, Belegnummer, Summen, ein Lieferantentext, Positionen (ungeprüft)",
            ),
          ),
          fact(
            text("Left empty", "Bleibt leer"),
            text(
              "tax rule (Steuerregel), booking accounts (Buchungskonten), supplier contact",
              "Steuerregel, Buchungskonten, Lieferantenkontakt",
            ),
          ),
          fact(
            text("Status after saving", "Status nach dem Speichern"),
            text(
              `draft (${String(VOUCHER_DRAFT_STATUS)}), not booked yet`,
              `Entwurf (${String(VOUCHER_DRAFT_STATUS)}), noch nicht gebucht`,
            ),
          ),
        ],
        inLanguage(PREVIEW_WARNINGS, lang),
      );
    }),
    state: { file },
  };
}

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
    "Duplicates can only be looked for after the recognition: the result names vouchers with " +
      "the same date, gross total and Belegnummer.",
    "Dubletten lassen sich erst nach der Erkennung suchen: Das Ergebnis nennt Belege mit " +
      "demselben Datum, derselben Bruttosumme und Belegnummer.",
  ),
];

// ---------------------------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------------------------

export interface RecognitionOptions {
  readonly signal?: AbortSignal | undefined;
  /** Defaults to a real timer. */
  readonly sleep?: RecognitionSleep | undefined;
  /** Called before each wait with the reads made so far and the most reads there will be. */
  readonly onWait?: ((reads: number, maxReads: number) => Promise<void>) | undefined;
}

/** What the duplicate scan after the recognition found. */
type DuplicateScan =
  | { readonly outcome: "done"; readonly ids: readonly number[] }
  /** Not recognised: there was nothing to compare. */
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
  readonly receipt: { readonly name: string; readonly kind: string; readonly bytes: number };
  /** Trusted notes: what to check, what is missing, what to do next. */
  readonly notes: readonly string[];
  readonly notesDe: readonly string[];
}

/** The fields of a voucher record this module compares; everything else is ignored. */
const watchedSchema = z.object({
  id: zId,
  objectName: zText,
  voucherDate: z.unknown().optional(),
  sumGross: zOptionalDecimal,
});

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
    form: recognitionForm(state.file),
    ...withSignal,
  });
  const created = readCreatedVoucher(answer);
  const id = created.id;
  const saved = { objectName: "Voucher", id: String(id) };

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
    ? await scanDuplicates(client, voucher, signal)
    : ({ outcome: "skipped" } as const);
  const facts: NoteFacts = {
    id,
    voucher,
    recognised,
    filledIn,
    missing,
    reads: waited.reads,
    waitedMs: waited.waitedMs,
    duplicates,
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
    receipt: {
      name: cleanText(state.file.name, 200) ?? "file",
      kind: state.file.kind,
      bytes: state.file.bytes.length,
    },
    notes: inLanguage(recognitionNotes(facts), "en"),
    notesDe: inLanguage(recognitionNotes(facts), "de"),
  };
}

/** The multipart body: `creditDebit` C (an expense) and the file in the part `voucher` (D-103). */
function recognitionForm(file: ReceiptFile): FormData {
  const form = new FormData();
  form.append("creditDebit", "C");
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
 * Other expense vouchers with the recognised date and gross total (and Belegnummer, when one was
 * recognised). The supplier is not compared: the recognised supplier text is not reliable
 * (D-103). A failed scan does not fail the call, since the draft exists already; the notes say
 * that it did not run.
 */
async function scanDuplicates(
  client: SevdeskClient,
  voucher: VoucherDetailDto,
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
        kind: "expense",
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
    return { outcome: "done", ids };
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
  readonly voucher: VoucherDetailDto;
  readonly recognised: boolean;
  readonly filledIn: readonly RecognisedField[];
  readonly missing: readonly MissingField[];
  readonly reads: number;
  readonly waitedMs: number;
  readonly duplicates: DuplicateScan;
  readonly positionsComplete: boolean;
}

const FIELD_NAMES: Readonly<Record<RecognisedField, Phrase>> = {
  date: phrase("the date", "das Belegdatum"),
  number: phrase("the Belegnummer", "die Belegnummer"),
  supplierName: phrase("a supplier text", "einen Lieferantentext"),
  totals: phrase("the sums", "die Summen"),
  positions: phrase("the positions", "die Positionen"),
};

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
  if (!facts.recognised) {
    notes.push(
      phrase(
        `sevDesk's receipt recognition filled in no sums within ${seconds} s (${String(facts.reads)} ` +
          "reads). What it did not fill in keeps sevDesk's placeholders: the upload time as " +
          "date, sums 0, no supplier and no Belegnummer. The recognition may still finish " +
          `later: read draft ${id} again with sevdesk_voucher_get, then complete it with ` +
          "sevdesk_voucher_update_draft (supplier, number, date, taxRuleId, positions) or delete " +
          "it with sevdesk_voucher_delete_draft. Do not call this tool again for the same " +
          "receipt: every call creates another draft.",
        `sevDesks Belegerkennung hat binnen ${seconds} s (${String(facts.reads)} Abrufe) keine ` +
          "Summen ausgefüllt. Was sie nicht ausgefüllt hat, behält sevDesks Platzhalter: den " +
          "Zeitpunkt des Hochladens als Datum, Summen 0, keinen Lieferanten und keine " +
          `Belegnummer. Die Erkennung kann später noch fertig werden: Lies Entwurf ${id} mit ` +
          "sevdesk_voucher_get erneut, dann vervollständige ihn mit sevdesk_voucher_update_draft " +
          "(Lieferant, Belegnummer, Datum, taxRuleId, Positionen) oder lösche ihn mit " +
          "sevdesk_voucher_delete_draft. Rufe dieses Werkzeug für denselben Beleg nicht erneut " +
          "auf: Jeder Aufruf legt einen weiteren Entwurf an.",
      ),
    );
  }
  if (facts.filledIn.length > 0) {
    const fields = listed(facts.filledIn.map((field) => FIELD_NAMES[field]));
    notes.push(
      phrase(
        `sevDesk's receipt recognition filled in ${fields.en} (recognition.filledIn); nobody has ` +
          "checked these values. Compare them with the receipt before finalizing.",
        `sevDesks Belegerkennung hat ${fields.de} ausgefüllt (recognition.filledIn); niemand hat ` +
          "diese Werte geprüft. Vergleiche sie vor dem Fertigstellen mit dem Beleg.",
      ),
    );
  }
  if (facts.missing.includes("supplierContact")) {
    notes.push(
      facts.filledIn.includes("supplierName")
        ? phrase(
            "The supplier is only a text sevDesk read (voucher.supplier.name), not always the " +
              "receipt's supplier, and not a contact: set supplierId (from " +
              "sevdesk_contacts_search) or supplierName with sevdesk_voucher_update_draft.",
            "Der Lieferant ist nur ein von sevDesk gelesener Text (voucher.supplier.name), nicht " +
              "immer der Lieferant des Belegs, und kein Kontakt: Setze supplierId (aus " +
              "sevdesk_contacts_search) oder supplierName mit sevdesk_voucher_update_draft.",
          )
        : phrase(
            "The draft has no supplier: set supplierId (from sevdesk_contacts_search) or " +
              "supplierName with sevdesk_voucher_update_draft.",
            "Der Entwurf hat keinen Lieferanten: Setze supplierId (aus sevdesk_contacts_search) " +
              "oder supplierName mit sevdesk_voucher_update_draft.",
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
  const scan = facts.duplicates;
  if (scan.outcome === "done" && scan.ids.length > 0) {
    const which = scan.ids.map(String).join(", ");
    const one = scan.ids.length === 1;
    notes.push(
      phrase(
        `Possible duplicate: ${one ? "voucher" : "vouchers"} ${which} ${one ? "has" : "have"} ` +
          "the same date, gross total and Belegnummer. If this receipt was filed before, delete " +
          `draft ${id} with sevdesk_voucher_delete_draft.`,
        `Mögliche Dublette: ${one ? "Beleg" : "Belege"} ${which} ${one ? "hat" : "haben"} ` +
          "dasselbe Datum, dieselbe Bruttosumme und Belegnummer. Wurde dieser Beleg schon " +
          `erfasst, lösche Entwurf ${id} mit sevdesk_voucher_delete_draft.`,
      ),
    );
  } else if (scan.outcome === "failed") {
    notes.push(
      phrase(
        "The duplicate check after the recognition could not run; look for the receipt with " +
          "sevdesk_vouchers_list before finalizing.",
        "Die Dublettenprüfung nach der Erkennung konnte nicht laufen; suche den Beleg vor dem " +
          "Fertigstellen mit sevdesk_vouchers_list.",
      ),
    );
  }
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
