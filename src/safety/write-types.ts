/**
 * The types every layer shares about a write: the record it changes and the preview a human
 * confirms. They live here, not in `src/tools/types.ts` (which re-exports them for tool
 * authors), so that `src/domain/` and `src/safety/` build previews, hash them and write the
 * audit log without importing the tool layer (review 2026-11, round 3).
 */

/** A sevDesk record a write created or changed, for the audit log and read-back. */
export interface SevdeskObjectRef {
  /** sevDesk's `objectName`, e.g. `Invoice`, `CreditNote`, `Contact`. */
  readonly objectName: string;
  readonly id: string;
}

/** One labelled fact in a confirmation, e.g. `{ label: "Total (gross)", value: "1,190.00 EUR" }`. */
export interface ConfirmationFact {
  /** Trusted text written by us. */
  readonly label: string;
  /**
   * May contain sevDesk text (a customer name, a document number). The framework sanitizes it
   * (invisible and bidi characters stripped, length capped) before a human sees it, but build it
   * with `cleanText` anyway.
   */
  readonly value: string;
}

/**
 * What a human approves before a `commit`/`external` action, and what a dry run returns. Shown
 * in the elicitation form, on the local approval page and in dry-run results, so it must say
 * exactly what will happen, in plain words, with the amounts and recipients involved.
 *
 * Determinism rule: for an unchanged sevDesk state and the same arguments, `prepare` must return
 * an identical preview (no clock times, no random ids, stable order). The framework prepares
 * again after the approval and asks again when the preview changed, so the human always approves
 * what actually runs.
 */
export interface ConfirmationPreview {
  /**
   * One trusted sentence in the imperative, e.g. "Finalize invoice RE-1042 (draft → open) and
   * mark it as sent by post." Identifiers from sevDesk only through `cleanText`.
   */
  readonly action: string;
  /** Key facts, most important first: record, customer, amounts, dates, recipients. */
  readonly facts: readonly ConfirmationFact[];
  /**
   * Consequences the human must read, trusted text, e.g. "The invoice number is assigned and
   * the invoice becomes legally binding." Empty when there are none.
   */
  readonly warnings: readonly string[];
  /** True when the action cannot be undone at all (enshrine, an email that was sent). */
  readonly irreversible: boolean;
}
