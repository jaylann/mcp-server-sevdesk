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
  readonly kind: VoucherKind;
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
 * recognised draft can only be completed there) and builds the preview, which shows the file's
 * full SHA-256 for the caller to pass back as `fileSha256`: the real call reads the file again,
 * and the draft it makes cannot be taken back. Nothing is written.
 */
export async function prepareVoucherRecognition(
  client: SevdeskClient,
  args: {
    readonly file: string;
    readonly fileSha256?: string | undefined;
    readonly kind?: VoucherKind | undefined;
  },
  options: VoucherCallOptions,
): Promise<RecognitionPlan> {
  const kind = args.kind ?? "expense";
  const file = await readReceiptFile({ files: options.files, signal: options.signal }, args.file, {
    sha256: args.fileSha256,
  });
  await assertUpdate2(client, options.signal, options.cacheOwner);
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
        ],
        inLanguage([...PREVIEW_WARNINGS, ...(file.kind === "pdf" ? [] : [IMAGE_WARNING])], lang),
      );
    }),
    state: { file, kind },
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
    "sevDesk does not refuse a file it has seen before, and duplicates can only be looked for " +
      "after the recognition: the result names vouchers with the same date, gross total and " +
      "Belegnummer.",
    "sevDesk lehnt eine schon gesendete Datei nicht ab, und Dubletten lassen sich erst nach der " +
      "Erkennung suchen: Das Ergebnis nennt Belege mit demselben Datum, derselben Bruttosumme " +
      "und Belegnummer.",
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
    form: recognitionForm(state.file, state.kind),
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
 * (2026-11-17), so this is the only duplicate guard. A failed scan does not fail the call, since
 * the draft exists already; the notes say that it did not run.
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
