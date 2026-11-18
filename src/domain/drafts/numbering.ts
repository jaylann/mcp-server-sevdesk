/**
 * Document numbers of order and credit note drafts, taken from sevDesk's number ranges
 * (Nummernkreise) through the undocumented next-number endpoints. Recorded on the trial account
 * on 2026-11-07 (lead's checks, spec/deviations.md B4/D-027):
 *
 * - `GET /Order/Factory/getNextOrderNumber?orderType=AN&useNextNumber=…` answers the number as a
 *   string ("AN-1000"); `GET /CreditNote/Factory/getNextCreditNoteNumber?useNextNumber=…` likewise
 *   ("GU-1002"; `creditNoteType=CN` gives the same, so it is not sent).
 * - `useNextNumber=false` only peeks; `useNextNumber=true` returns the current number AND advances
 *   the counter (true → AN-1000, then false → AN-1001). The verified spellings are the literals
 *   `true`/`false`, so they are sent as strings (the client would send booleans as 1/0). For
 *   `orderType=AB` and `LI` the reservation advances the counters by one as well (recorded
 *   2026-11-18, D-066); the order factories hand out the peeked number without it (D-107).
 * - Orders: `saveOrder` without `orderNumber` answers 400, and neither saving nor finalizing an
 *   order with a peeked number advances the counter (sevDesk handed out AN-1000 twice). So the
 *   number is reserved (`useNextNumber=true`) right before the save, as sevDesk's web app does.
 * - Credit notes: a draft without `creditNoteNumber` is accepted, but `sendBy` then answers 500
 *   (`fileName` null) and may still finalize it without a number. `createFromInvoice` gives its
 *   draft the counter's current value without advancing it, so the counter can lag behind the
 *   numbers in use; a reserved credit note number is therefore checked against the existing
 *   credit notes ({@link reserveFreeCreditNoteNumber}).
 *
 * Prepare peeks (a plain read, allowed by the read-only client); execute reserves (a side-effect
 * GET with the write tier). A reserved number that the save then does not use stays a gap in the
 * number range; errors say so.
 *
 * Warnings, notes and errors never quote a number (#152): the number range's format is set in the
 * sevDesk web app, so a number is text this server did not write, and these texts are sentences
 * the model reads. A preview shows the number as its "Number" fact; a result note points at the
 * output field that holds it ({@link NUMBER_FIELDS}); an error names no number.
 */
import { z } from "zod";

import { SevdeskError, type SevdeskErrorKind } from "../../sevdesk/errors.js";
import { parseUpstream, zId, zText } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";

/** The number range a draft takes its number from. */
export type NumberRange =
  | { readonly kind: "order"; readonly orderType: "AN" | "AB" | "LI" }
  | { readonly kind: "creditNote" };

const RANGES = {
  order: { path: "/Order/Factory/getNextOrderNumber", noun: "order" },
  creditNote: { path: "/CreditNote/Factory/getNextCreditNoteNumber", noun: "credit note" },
} as const;

/**
 * The output field of the draft tools that holds a saved draft's number, by range: result notes
 * point at it instead of quoting the number (#152).
 */
export const NUMBER_FIELDS = { order: "order.number", creditNote: "creditNote.number" } as const;

/** Longest number this server sends back to sevDesk. */
const NUMBER_MAX = 100;
/** C0/C1 control characters and line breaks: never part of a document number. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** Failure kinds after which sevDesk may still have reserved the number. */
const UNCERTAIN_KINDS: ReadonlySet<SevdeskErrorKind> = new Set([
  "network",
  "timeout",
  "server",
  "aborted",
  "unexpected_response",
]);

/** Reads the next number of `range` without reserving it (`useNextNumber=false`). */
export async function peekNextNumber(
  client: SevdeskClient,
  range: NumberRange,
  signal?: AbortSignal,
): Promise<string> {
  const payload = await client.request({
    method: "GET",
    path: RANGES[range.kind].path,
    query: rangeQuery(range, "false"),
    ...(signal === undefined ? {} : { signal }),
  });
  return parseNumber(payload, range);
}

/**
 * Reserves the next number of `range` (`useNextNumber=true`: sevDesk advances the counter). A
 * failure that may have reserved a number anyway says so in its message.
 */
export async function reserveNextNumber(
  client: SevdeskClient,
  range: NumberRange,
  signal?: AbortSignal,
): Promise<string> {
  let payload: unknown;
  try {
    payload = await client.request({
      method: "GET",
      path: RANGES[range.kind].path,
      query: rangeQuery(range, "true"),
      sideEffect: true,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof SevdeskError && UNCERTAIN_KINDS.has(error.kind)) {
      throw withSentence(
        error,
        `sevDesk may have reserved the next ${RANGES[range.kind].noun} number anyway; then ` +
          "that number stays unused (a gap in the number range, Nummernkreis).",
      );
    }
    throw error;
  }
  try {
    return parseNumber(payload, range);
  } catch (error) {
    throw withSentence(
      error as SevdeskError,
      `sevDesk has reserved that ${RANGES[range.kind].noun} number, so it stays unused (a gap ` +
        "in the number range, Nummernkreis). Nothing was saved.",
    );
  }
}

/**
 * The same failure with one more trusted sentence about the number reserved for the draft, which
 * the save did not use (named, not quoted: #152). `saveAttempted` says whether the save request
 * was sent: if not, nothing was saved for sure; if so, a failure that leaves the outcome open
 * (timeout, network, …) may still have saved the draft.
 */
export function reservedNumberError(
  error: SevdeskError,
  noun: string,
  saveAttempted = true,
): SevdeskError {
  const reserved = `The ${noun} number reserved for this draft`;
  const skipped = `${reserved} is now skipped in the number range (Nummernkreis)`;
  let sentence: string;
  if (!saveAttempted) {
    sentence = `${skipped}; nothing was saved, so repeating the call reserves the next one.`;
  } else if (UNCERTAIN_KINDS.has(error.kind)) {
    sentence =
      `${reserved} stays unused (a gap in the number range, Nummernkreis) unless sevDesk saved ` +
      "the draft anyway.";
  } else {
    sentence = `${skipped}; repeating the call reserves the next one.`;
  }
  return withSentence(error, sentence);
}

/**
 * Preview warning for a create call that will reserve a number (trusted). It points at the
 * preview's "Number" fact instead of quoting the number (#152). `noun` names the number range,
 * e.g. "offer".
 */
export function reservationWarning(noun: string): string {
  return (
    `Saving reserves the next number of sevDesk's ${noun} number range (Nummernkreis), shown ` +
    "as Number. If saving fails, that number is skipped (a gap in the range); if another " +
    "document takes it first, the draft gets the next number."
  );
}

/**
 * Result note when sevDesk reserved a different number than the preview showed (trusted), or
 * `undefined` when they are the same. `field` is the output field that holds the saved number
 * ({@link NUMBER_FIELDS}); neither number is quoted (#152).
 */
export function changedNumberNote(
  noun: string,
  field: string,
  peeked: string,
  reserved: string,
): string | undefined {
  if (normalize(peeked) === normalize(reserved)) return undefined;
  return (
    `sevDesk reserved a different ${noun} number than the preview showed (another document ` +
    `took that one in the meantime); the draft was saved with the reserved number (${field}).`
  );
}

/**
 * Result note when the read-back shows a different number than the draft was saved with
 * (trusted), or `undefined` when they agree or none was read back (the read-back notes report a
 * missing number). `stored` is the cleaned number of the read-back DTO; `field` is the output
 * field that shows it ({@link NUMBER_FIELDS}). Neither number is quoted (#152).
 */
export function storedNumberNote(
  noun: string,
  field: string,
  sent: string,
  stored: string | undefined,
): string | undefined {
  if (stored === undefined || normalize(stored) === normalize(sent)) return undefined;
  return (
    `sevDesk stored a different ${noun} number (${field}) than the draft was saved with; check ` +
    "the number range (Nummernkreis) and the draft before finalizing."
  );
}

/** Credit notes read when checking whether a reserved number is in use already. */
export const CREDIT_NOTE_SCAN_MAX = 5000;
const SCAN_PAGE_SIZE = 1000;
/** Reservations per call before giving up on a counter that lags behind. */
export const MAX_RESERVATIONS = 5;

/** A reserved credit note number that no existing credit note carries (as far as checked). */
export interface FreeNumber {
  readonly number: string;
  /** Reserved numbers that existing credit notes carried already (skipped, in order). */
  readonly skipped: readonly string[];
  /** True when not every credit note could be checked (more than the scan reads). */
  readonly truncated: boolean;
}

const numberRowSchema = z.object({ id: zId.optional(), creditNoteNumber: zText });

/**
 * Reserves the next credit note number and checks it against the numbers of existing credit
 * notes (`GET /CreditNote`, every row compared locally, trimmed and case-insensitive: sevDesk
 * ignores filters it does not know, so no number filter is relied on). A number in use is skipped
 * and the next one reserved, at most {@link MAX_RESERVATIONS} times in all; then the call fails
 * and says how many numbers were skipped. Execute only (it reserves).
 */
export async function reserveFreeCreditNoteNumber(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<FreeNumber> {
  const range: NumberRange = { kind: "creditNote" };
  const first = await reserveNextNumber(client, range, signal);
  let used: { numbers: ReadonlySet<string>; truncated: boolean };
  try {
    used = await creditNoteNumbersInUse(client, signal);
  } catch (error) {
    // The save was not sent yet: nothing was saved, whatever the failure.
    if (error instanceof SevdeskError) {
      throw reservedNumberError(error, "credit note", false);
    }
    throw error;
  }
  const skipped: string[] = [];
  let number = first;
  while (used.numbers.has(normalize(number))) {
    skipped.push(number);
    if (skipped.length >= MAX_RESERVATIONS) {
      throw new SevdeskError({
        kind: "validation",
        message:
          `sevDesk's credit note counter handed out ${MAX_RESERVATIONS} numbers in a row that ` +
          "existing credit notes carry already, so nothing was saved; those numbers are now " +
          "skipped. Move the credit note number range (Nummernkreis) in sevDesk's settings past " +
          "the highest credit note number, then repeat the call.",
      });
    }
    try {
      number = await reserveNextNumber(client, range, signal);
    } catch (error) {
      if (error instanceof SevdeskError) {
        throw withSentence(
          error,
          `${numberCount(skipped.length)} reserved before ${skipped.length === 1 ? "was" : "were"} ` +
            "skipped (in use already). Nothing was saved.",
        );
      }
      throw error;
    }
  }
  return { number, skipped, truncated: used.truncated };
}

/** "1 credit note number", "2 credit note numbers": skipped numbers are counted, not quoted. */
export function numberCount(count: number): string {
  return `${count} credit note number${count === 1 ? "" : "s"}`;
}

/**
 * The ids (ascending) of the credit notes that carry `number`, other than `exceptId`: the same
 * scan and comparison as {@link reserveFreeCreditNoteNumber}. For the check after
 * `createFromInvoice`, whose draft gets the counter's current number whether or not another
 * credit note has it already. Reads only.
 */
export async function findCreditNotesWithNumber(
  client: SevdeskClient,
  number: string,
  exceptId: number,
  signal?: AbortSignal,
): Promise<{ readonly ids: readonly number[]; readonly truncated: boolean }> {
  const scan = await scanCreditNoteNumbers(client, signal);
  const wanted = normalize(number);
  const ids = scan.rows.flatMap((row) =>
    row.id !== undefined && row.id !== exceptId && row.number === wanted ? [row.id] : [],
  );
  return { ids: [...new Set(ids)].sort((a, b) => a - b), truncated: scan.truncated };
}

async function creditNoteNumbersInUse(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
): Promise<{ numbers: ReadonlySet<string>; truncated: boolean }> {
  const scan = await scanCreditNoteNumbers(client, signal);
  return { numbers: new Set(scan.rows.map((row) => row.number)), truncated: scan.truncated };
}

/** Every credit note that has a number, with the number normalized (up to the scan's cap). */
async function scanCreditNoteNumbers(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
): Promise<{ rows: { id: number | undefined; number: string }[]; truncated: boolean }> {
  const list = await client.listAll("/CreditNote", undefined, {
    max: CREDIT_NOTE_SCAN_MAX,
    pageSize: SCAN_PAGE_SIZE,
    ...(signal === undefined ? {} : { signal }),
  });
  const rows: { id: number | undefined; number: string }[] = [];
  for (const raw of list.items) {
    const { id, creditNoteNumber } = parseUpstream(numberRowSchema, raw, "credit notes");
    if (creditNoteNumber !== undefined) rows.push({ id, number: normalize(creditNoteNumber) });
  }
  return { rows, truncated: list.truncated };
}

function normalize(number: string): string {
  return number.trim().toLowerCase();
}

function rangeQuery(range: NumberRange, useNextNumber: "true" | "false"): Record<string, string> {
  return range.kind === "order" ? { orderType: range.orderType, useNextNumber } : { useNextNumber };
}

/** The number sevDesk answered (a string, or a JSON number), trimmed and checked. */
function parseNumber(payload: unknown, range: NumberRange): string {
  const value = typeof payload === "number" ? String(payload) : payload;
  const number = typeof value === "string" ? value.trim() : "";
  if (number === "" || number.length > NUMBER_MAX || CONTROL.test(number)) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message: `sevDesk returned the next ${RANGES[range.kind].noun} number in an unexpected format.`,
    });
  }
  return number;
}

/** `error` with `sentence` appended to its trusted message; everything else is kept. */
function withSentence(error: SevdeskError, sentence: string): SevdeskError {
  return new SevdeskError({
    kind: error.kind,
    message: `${error.message} ${sentence}`,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.exceptionUuid === undefined ? {} : { exceptionUuid: error.exceptionUuid }),
    ...(error.upstreamMessage === undefined ? {} : { upstreamMessage: error.upstreamMessage }),
    ...(error.method === undefined ? {} : { method: error.method }),
    ...(error.path === undefined ? {} : { path: error.path }),
    // The message stays ours (the explanation plus the sentence), so it is still shown.
    ...(error.explained ? { explained: true } : {}),
    cause: error,
    completedWrites: error.completedWrites,
  });
}
