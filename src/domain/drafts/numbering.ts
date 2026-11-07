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
 *   `true`/`false`, so they are sent as strings (the client would send booleans as 1/0).
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
 * number range; errors say which number that is.
 */
import { z } from "zod";

import { SevdeskError, type SevdeskErrorKind } from "../../sevdesk/errors.js";
import { parseUpstream, zText } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";

/** The number range a draft takes its number from. */
export type NumberRange =
  | { readonly kind: "order"; readonly orderType: "AN" | "AB" | "LI" }
  | { readonly kind: "creditNote" };

const RANGES = {
  order: { path: "/Order/Factory/getNextOrderNumber", noun: "order" },
  creditNote: { path: "/CreditNote/Factory/getNextCreditNoteNumber", noun: "credit note" },
} as const;

/** Longest number this server sends back to sevDesk. */
const NUMBER_MAX = 100;
/** C0/C1 control characters and line breaks: never part of a document number. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/**
 * A number that may be quoted in trusted text (messages, notes): one short token of letters,
 * digits and `. _ / # % + -`, no spaces, so it cannot carry sentences or markup.
 */
const QUOTABLE = /^[\p{L}\p{N}][\p{L}\p{N}._/#%+-]{0,39}$/u;

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
 * The same failure with one more trusted sentence about a reserved number that the save did not
 * use; `number` is quoted only when {@link quotableNumber} allows it. `saveAttempted` says
 * whether the save request was sent: if not, nothing was saved for sure; if so, a failure that
 * leaves the outcome open (timeout, network, …) may still have saved the draft.
 */
export function reservedNumberError(
  error: SevdeskError,
  noun: string,
  number: string,
  saveAttempted = true,
): SevdeskError {
  const label = quotableNumber(number) ?? "the reserved number";
  const skipped = `The ${noun} number ${label} was reserved for this draft and is now skipped in the number range (Nummernkreis)`;
  let sentence: string;
  if (!saveAttempted) {
    sentence = `${skipped}; nothing was saved, so repeating the call reserves the next one.`;
  } else if (UNCERTAIN_KINDS.has(error.kind)) {
    sentence =
      `The ${noun} number ${label} was reserved for this draft; unless sevDesk saved the draft ` +
      "anyway, that number stays unused (a gap in the number range, Nummernkreis).";
  } else {
    sentence = `${skipped}; repeating the call reserves the next one.`;
  }
  return withSentence(error, sentence);
}

/** `number` when it is safe to quote in trusted text (see {@link QUOTABLE}), else `undefined`. */
export function quotableNumber(number: string): string | undefined {
  return QUOTABLE.test(number) ? number : undefined;
}

/**
 * Preview warning for a create call that will reserve a number (trusted; the number is quoted only
 * when {@link quotableNumber} allows it). `noun` names the number range, e.g. "offer".
 */
export function reservationWarning(noun: string, peeked: string): string {
  const number = quotableNumber(peeked);
  const which = number === undefined ? "the next number" : `the number ${number}`;
  return (
    `Saving reserves ${which} from sevDesk's ${noun} number range (Nummernkreis). If saving ` +
    "fails, that number is skipped (a gap in the range); if another document takes it first, " +
    "the draft gets the next number."
  );
}

/**
 * Result note when sevDesk reserved a different number than the preview showed (trusted), or
 * `undefined` when they are the same.
 */
export function changedNumberNote(
  noun: string,
  peeked: string,
  reserved: string,
): string | undefined {
  if (normalize(peeked) === normalize(reserved)) return undefined;
  const before = quotableNumber(peeked);
  const after = quotableNumber(reserved);
  return before === undefined || after === undefined
    ? `sevDesk reserved a different ${noun} number than the preview showed (another document ` +
        "took that one in the meantime); the draft was saved with the reserved number."
    : `sevDesk reserved ${after} instead of the previewed ${before} (another document took ` +
        `${before} in the meantime); the draft was saved with ${after}.`;
}

/**
 * Result note when the read-back shows a different number than the draft was saved with
 * (trusted), or `undefined` when they agree or none was read back (the read-back notes report a
 * missing number). `stored` is the cleaned number of the read-back DTO.
 */
export function storedNumberNote(
  noun: string,
  sent: string,
  stored: string | undefined,
): string | undefined {
  if (stored === undefined || normalize(stored) === normalize(sent)) return undefined;
  const before = quotableNumber(sent);
  const after = quotableNumber(stored);
  const what =
    before === undefined || after === undefined
      ? `sevDesk stored a different ${noun} number than the draft was saved with`
      : `sevDesk stored the ${noun} number ${after} although the draft was saved with ${before}`;
  return `${what}; check the number range (Nummernkreis) and the draft before finalizing.`;
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

const numberRowSchema = z.object({ creditNoteNumber: zText });

/**
 * Reserves the next credit note number and checks it against the numbers of existing credit
 * notes (`GET /CreditNote`, every row compared locally, trimmed and case-insensitive: sevDesk
 * ignores filters it does not know, so no number filter is relied on). A number in use is skipped
 * and the next one reserved, at most {@link MAX_RESERVATIONS} times in all; then the call fails
 * with the skipped numbers named. Execute only (it reserves).
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
      throw reservedNumberError(error, "credit note", first, false);
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
          `existing credit notes carry already (${numberList(skipped)}), so nothing was saved; ` +
          "those numbers are now skipped. Move the credit note number range (Nummernkreis) in " +
          "sevDesk's settings past the highest credit note number, then repeat the call.",
      });
    }
    try {
      number = await reserveNextNumber(client, range, signal);
    } catch (error) {
      if (error instanceof SevdeskError) {
        throw withSentence(
          error,
          `Skipped before (in use already): ${numberList(skipped)}. Nothing was saved.`,
        );
      }
      throw error;
    }
  }
  return { number, skipped, truncated: used.truncated };
}

/** "GU-1000, GU-1001" (unquotable numbers are counted instead of shown). */
export function numberList(numbers: readonly string[]): string {
  const shown = numbers.map(quotableNumber).filter((value): value is string => value !== undefined);
  const hidden = numbers.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`${hidden} more`] : [])].join(", ");
}

async function creditNoteNumbersInUse(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
): Promise<{ numbers: ReadonlySet<string>; truncated: boolean }> {
  const list = await client.listAll("/CreditNote", undefined, {
    max: CREDIT_NOTE_SCAN_MAX,
    pageSize: SCAN_PAGE_SIZE,
    ...(signal === undefined ? {} : { signal }),
  });
  const numbers = new Set<string>();
  for (const raw of list.items) {
    const { creditNoteNumber } = parseUpstream(numberRowSchema, raw, "credit notes");
    if (creditNoteNumber !== undefined) numbers.add(normalize(creditNoteNumber));
  }
  return { numbers, truncated: list.truncated };
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
    cause: error,
    completedWrites: error.completedWrites,
  });
}
