/**
 * After a save: read the document back (GET by id, positions included) and compare it with what
 * the preview promised. The comparison turns silent surprises into notes in the result: a gross
 * total that differs from the expected one (e.g. prices read as gross instead of net, B8), and a
 * missing or unexpanded document number (B4; spec/deviations.md D-027).
 *
 * The save has already happened when the read-back runs, so a failing read-back is rethrown with
 * the saved record attached (`withCompletedWrites`): the caller must not repeat the call.
 */
import { type CompletedWrite, SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import { compare } from "../money.js";
import type { Amounts } from "./positions.js";

/** Runs the read-back of a saved record; a `SevdeskError` carries the record as completed write. */
export async function readBack<T>(saved: CompletedWrite, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, [saved]);
    throw error;
  }
}

export interface ReadBackFacts {
  /** The document number as read back (cleaned), if any. */
  readonly number?: string | undefined;
  /** The gross total as read back, if sevDesk sent one. */
  readonly gross?: string | undefined;
  readonly currency: string;
  /** False when sevDesk had more position rows than could be read back. */
  readonly positionsComplete: boolean;
}

export interface ReadBackExpectation {
  /** Trusted noun, e.g. "invoice". */
  readonly noun: string;
  /** Tool that finalizes the document, e.g. "sevdesk_invoice_finalize". */
  readonly finalizeTool: string;
  /** Expected totals when this call set the positions; `undefined` when they were kept. */
  readonly expected?: Amounts | undefined;
}

/** Placeholders sevDesk number ranges use, e.g. `%YYYY%`. */
const PLACEHOLDER = /%[A-Za-z]+%/;

/** Trusted notes about what the read-back shows (empty when everything matches). */
export function readBackNotes(actual: ReadBackFacts, expectation: ReadBackExpectation): string[] {
  const notes: string[] = [];
  const { noun } = expectation;
  if (actual.number === undefined) {
    notes.push(
      `The ${noun} has no number yet: sevDesk assigns it from its number range ` +
        `(Nummernkreis), at the latest when the ${noun} is finalized with ` +
        `${expectation.finalizeTool}.`,
    );
  } else if (PLACEHOLDER.test(actual.number)) {
    notes.push(
      `The ${noun} number still contains placeholders (%…%). Check the number range ` +
        "(Nummernkreis) in sevDesk's settings before finalizing.",
    );
  }
  const expected = expectation.expected;
  if (
    expected !== undefined &&
    actual.gross !== undefined &&
    compare(actual.gross, expected.gross) !== 0
  ) {
    notes.push(
      `sevDesk computed a gross total of ${actual.gross} ${actual.currency}; the preview ` +
        `expected ${expected.gross} ${actual.currency}. Check the positions and the price mode ` +
        "(net/gross) before finalizing.",
    );
  }
  if (!actual.positionsComplete) {
    notes.push("sevDesk has more positions than could be read back; positions is partial.");
  }
  return notes;
}
