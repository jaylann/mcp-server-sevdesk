/**
 * Helpers the three document modules (invoice, credit note, order) share for previews, payload
 * fragments and update bookkeeping. Kept apart from `shared.ts`, which resolves inputs.
 */
import { SevdeskError } from "../../sevdesk/errors.js";
import { cleanText, currencyCode, splitTotals, type SumFields } from "../common.js";
import type { PreviewLanguage } from "../preview-text.js";
import type { TaxRule } from "../reference-data.js";
import { type DraftPreview, fact, type PreviewFact } from "./preview.js";
import type { DocumentAddress } from "./recipient.js";
import { taxRuleLabel } from "./tax.js";

/** `{id, objectName}` for a payload. */
export function ref<N extends string>(id: number, objectName: N): { id: number; objectName: N } {
  return { id, objectName };
}

/** The optional stored reference as a payload reference with its stored `objectName`. */
export function storedRef<N extends string>(
  value: { readonly id: number } | undefined,
  objectName: N,
): { id: number; objectName: N } | undefined {
  return value === undefined ? undefined : { id: value.id, objectName };
}

/**
 * The structured address fields of invoices and credit notes (sent by sevdesk-rs, echoed in its
 * recorded responses). Every
 * part is sent, `null` when empty, so a changed address never keeps a stale part.
 */
export function structuredAddress(address: DocumentAddress): {
  addressName: string;
  addressStreet: string | null;
  addressZip: string | null;
  addressCity: string | null;
  addressCountry: { id: number; objectName: "StaticCountry" };
} {
  return {
    addressName: address.name,
    addressStreet: address.street ?? null,
    addressZip: address.zip ?? null,
    addressCity: address.city ?? null,
    addressCountry: ref(address.countryId, "StaticCountry"),
  };
}

/**
 * The stored gross total for a preview, in the document's own currency (foreign-currency
 * documents keep it in `sum…ForeignCurrency`, spec/deviations.md D-043), plus the EUR amount
 * sevDesk books when the two differ.
 */
export function storedTotalText(
  doc: SumFields & { readonly currency?: string | undefined },
): string {
  const { totals, eur } = splitTotals(doc, currencyCode(doc.currency));
  if (totals.gross === undefined) return "as stored";
  const booked = eur?.gross === undefined ? "" : ` (${eur.gross.amount} EUR booked)`;
  return `gross ${totals.gross.amount} ${totals.gross.currency}${booked}`;
}

/** The preview text of the tax setting, e.g. "tax rule 1 Umsatzsteuerpflichtige Umsätze". */
export function taxText(
  rule: TaxRule | undefined,
  fields: { readonly taxRule?: unknown; readonly taxType?: string | undefined },
): string {
  if (fields.taxType !== undefined) {
    const from = rule === undefined ? "" : ` (from tax rule ${taxRuleLabel(rule)})`;
    return `tax type ${fields.taxType}${from}, bookkeeping 1.0`;
  }
  return rule === undefined ? "stored tax rule" : `tax rule ${taxRuleLabel(rule)}`;
}

/** Throws a `validation` error when an update call changes nothing. */
export function assertChanges(args: object, noun: string): void {
  const given = Object.entries(args).filter(
    ([key, value]) => key !== "id" && key !== "dryRun" && value !== undefined,
  );
  if (given.length === 0) {
    throw new SevdeskError({
      kind: "validation",
      message: `Nothing to change: give at least one field of the ${noun} besides id.`,
    });
  }
}

/** Records what an update changes, for the preview's action and facts. */
export class ChangeLog {
  private readonly names: string[] = [];
  readonly facts: PreviewFact[] = [];

  constructor(private readonly missing = "(none)") {}

  /** Adds a change when `before` and `after` differ (both compared as given). */
  value(name: string, label: string, before: string | undefined, after: string | undefined): void {
    if (before === after) return;
    this.names.push(name);
    this.facts.push(fact(label, `${before ?? this.missing} → ${after ?? this.missing}`));
  }

  /** Adds a change whose details are given as one text (e.g. "changed"). */
  note(name: string, label: string, value: string): void {
    this.names.push(name);
    this.facts.push(fact(label, value));
  }

  get changed(): readonly string[] {
    return this.names;
  }
}

/** A preview with trusted `action`, ordered facts and warnings; drafts are never irreversible. */
export function draftPreview(
  action: string,
  facts: readonly PreviewFact[],
  warnings: readonly (string | undefined)[],
): DraftPreview {
  return {
    action,
    facts,
    warnings: warnings.filter((warning): warning is string => warning !== undefined),
    irreversible: false,
  };
}

/** "1 position" / "3 positions". */
export function positionCount(count: number, lang: PreviewLanguage = "en"): string {
  if (lang === "de") return `${count} Position${count === 1 ? "" : "en"}`;
  return `${count} position${count === 1 ? "" : "s"}`;
}

/** A stored document number for an update body: kept exactly as stored, never invented (B4). */
export function storedNumber(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** A stored number for a preview (cleaned upstream text). */
export function numberLabel(value: string | undefined): string {
  const cleaned = cleanText(value, 100);
  return cleaned === undefined ? "no number yet" : `number ${cleaned}`;
}
