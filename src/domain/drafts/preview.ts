/**
 * Building blocks of draft previews (the `ConfirmationPreview` a dry run returns and the audit log
 * keeps). Structurally the same as the tools' `ConfirmationPreview`, declared here so the domain
 * does not depend on the tools layer. Every value that may contain sevDesk text (names, numbers)
 * goes through `cleanText`; labels are ours. Nothing here reads a clock, so previews are
 * deterministic for unchanged inputs and sevDesk state.
 */
import { cleanText } from "../common.js";
import { decimal, format } from "../money.js";
import { type Amounts, type DraftPosition, positionAmounts, type PriceMode } from "./positions.js";
import { addressPreview, type DocumentAddress } from "./recipient.js";

export interface PreviewFact {
  readonly label: string;
  readonly value: string;
}

export interface DraftPreview {
  readonly action: string;
  readonly facts: readonly PreviewFact[];
  readonly warnings: readonly string[];
  readonly irreversible: boolean;
}

/** Positions listed one by one in a preview; the rest are counted. */
const MAX_POSITION_FACTS = 20;
const VALUE_MAX = 200;

/** A fact whose value is (or may contain) untrusted text. */
export function fact(label: string, value: string): PreviewFact {
  return { label, value: cleanText(value, VALUE_MAX) ?? "" };
}

/** `"65.45 EUR"`. */
export function moneyText(amount: string, currency: string): string {
  return `${amount} ${currency}`;
}

/** `"net 55.00 EUR, tax 10.45 EUR, gross 65.45 EUR"`. */
export function totalsText(totals: Amounts, currency: string): string {
  return (
    `net ${moneyText(totals.net, currency)}, tax ${moneyText(totals.tax, currency)}, ` +
    `gross ${moneyText(totals.gross, currency)}`
  );
}

/** One fact per position (up to {@link MAX_POSITION_FACTS}, then a count of the rest). */
export function positionFacts(
  positions: readonly DraftPosition[],
  mode: PriceMode,
  currency: string,
): PreviewFact[] {
  const facts = positions.slice(0, MAX_POSITION_FACTS).map((position, index) => {
    const amounts = positionAmounts(position, mode);
    const price = format(position.unitPrice, Math.max(2, decimal(position.unitPrice).scale));
    const discount =
      position.discountPercent === undefined ? "" : `, ${position.discountPercent} % discount`;
    const optional = position.optional === true ? " (optional, not in the total)" : "";
    return fact(
      `Position ${index + 1}`,
      `${cleanText(position.name, VALUE_MAX) ?? ""}: ${position.quantity} × ` +
        `${moneyText(price, currency)} ${mode}, ${position.taxRate} % VAT${discount} → ` +
        `net ${moneyText(amounts.net, currency)}${optional}`,
    );
  });
  const rest = positions.length - MAX_POSITION_FACTS;
  if (rest > 0) {
    facts.push({ label: "More positions", value: `${rest} more, not listed here` });
  }
  return facts;
}

/** The address as one line with its country, e.g. "Musterfirma GmbH, …, 12345 Musterstadt, Deutschland". */
export function addressText(address: DocumentAddress): string {
  return addressPreview(address);
}

/** The customer, e.g. "Musterfirma GmbH (contact 1001)". */
export function customerText(name: string, contactId: number): string {
  return `${cleanText(name, VALUE_MAX) ?? "(unnamed)"} (contact ${contactId})`;
}
