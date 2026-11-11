/**
 * The intermediate result of the CII and UBL readers: the invoice content in the shape of the
 * model contract (without container data and findings), plus facts the business-rule checks need
 * that the model does not carry, and the findings the reader recorded.
 */
import { add, compare, type Decimal, decimal, subtract, toDecimalString } from "../money.js";
import type { EInvoiceFinding, ParsedEInvoice } from "./model.js";

/** The invoice content as read from the XML. */
export type EInvoiceContent = Omit<ParsedEInvoice, "container" | "attachmentName" | "findings">;

/** The totals (BG-22) business terms the model requires. */
export type RequiredTotal = "BT-106" | "BT-109" | "BT-110" | "BT-112" | "BT-115";

/** Facts for the checks that the model does not carry. */
export interface EInvoiceFacts {
  /** BT-30: the seller's legal registration identifier is present. */
  readonly sellerLegalId: boolean;
  /** BT-47: the buyer's legal registration identifier is present. */
  readonly buyerLegalId: boolean;
  /**
   * Required totals that were missing or unreadable. Their value in the content is computed
   * from the other terms (for display only); the checks report them and skip the sums they feed.
   */
  readonly missingTotals: readonly RequiredTotal[];
  /** BG-16: at least one payment instruction (BT-81) is present. */
  readonly paymentInstructions: boolean;
  /** BT-6 differs from BT-5 and BT-111 was given (the VAT accounting currency total). */
  readonly taxCurrencyTotal: boolean;
  /**
   * Per line, in the order of the content's lines: what the line net amount (BT-131) is made of,
   * or `undefined` where that cannot be told (see {@link linePricing}). Without the list the
   * line check is skipped.
   */
  readonly linePricing?: readonly (LinePricing | undefined)[];
}

/**
 * The parts of one line's net amount as the file states them. The model's `netPrice` is already
 * divided by the base quantity and rounded, and the model carries no line allowances or charges,
 * so the check of BT-131 works on these.
 */
export interface LinePricing {
  /** BT-129 invoiced quantity. */
  readonly quantity: string;
  /** BT-146 item net price, per `baseQuantity` units. */
  readonly price: string;
  /** BT-149 price base quantity, above zero; `1` when the file gives none. */
  readonly baseQuantity: string;
  /** Sum of the line's charges (BT-141) minus the sum of its allowances (BT-136). */
  readonly adjustment: string;
}

/** A line-level allowance or charge as read; a part that could not be read is `undefined`. */
export interface LineAdjustment {
  readonly kind: "allowance" | "charge" | undefined;
  readonly amount: string | undefined;
}

/**
 * The pricing of a line when every part of it was readable: quantity and price given, a base
 * quantity above zero (or none), and every line allowance and charge with a readable indicator
 * and amount. Otherwise `undefined`: the line check then says nothing about the line instead of
 * guessing.
 */
export function linePricing(parts: {
  readonly quantity: string | undefined;
  readonly price: string | undefined;
  readonly baseQuantity: string | undefined;
  readonly adjustments: readonly LineAdjustment[];
}): LinePricing | undefined {
  const { quantity, price } = parts;
  const baseQuantity = parts.baseQuantity ?? "1";
  if (quantity === undefined || price === undefined || compare(baseQuantity, 0) <= 0) {
    return undefined;
  }
  let adjustment: Decimal = decimal(0);
  for (const entry of parts.adjustments) {
    if (entry.kind === undefined || entry.amount === undefined) return undefined;
    adjustment =
      entry.kind === "charge" ? add(adjustment, entry.amount) : subtract(adjustment, entry.amount);
  }
  return { quantity, price, baseQuantity, adjustment: toDecimalString(adjustment) };
}

/** What a syntax reader returns. */
export interface ExtractedEInvoice {
  readonly content: EInvoiceContent;
  readonly facts: EInvoiceFacts;
  readonly findings: readonly EInvoiceFinding[];
}

/** Read totals before defaults: every term may be missing. */
export interface RawTotals {
  readonly lineNet: string | undefined;
  readonly allowances: string | undefined;
  readonly charges: string | undefined;
  readonly net: string | undefined;
  readonly tax: string | undefined;
  readonly taxInAccountingCurrency: string | undefined;
  readonly gross: string | undefined;
  readonly prepaid: string | undefined;
  readonly rounding: string | undefined;
  readonly due: string | undefined;
}

/**
 * The totals for the content: the read values, and for each missing required term a value
 * computed from the lines, allowances/charges and the VAT breakdown (marked in
 * `missingTotals`, so it is reported and never trusted silently).
 */
export function completeTotals(
  raw: RawTotals,
  parts: {
    readonly lineAmounts: readonly string[];
    readonly breakdownTax: readonly string[];
  },
): { totals: EInvoiceContent["totals"]; missingTotals: RequiredTotal[] } {
  const missing: RequiredTotal[] = [];
  const sum = (values: readonly string[]): Decimal =>
    values.reduce<Decimal>((total, value) => add(total, value), decimal(0));
  const lineNet = raw.lineNet ?? mark("BT-106", toDecimalString(sum(parts.lineAmounts)));
  const net =
    raw.net ??
    mark(
      "BT-109",
      toDecimalString(add(subtract(lineNet, raw.allowances ?? "0"), raw.charges ?? "0")),
    );
  const tax = raw.tax ?? mark("BT-110", toDecimalString(sum(parts.breakdownTax)));
  const gross = raw.gross ?? mark("BT-112", toDecimalString(add(net, tax)));
  const due =
    raw.due ??
    mark("BT-115", toDecimalString(add(subtract(gross, raw.prepaid ?? "0"), raw.rounding ?? "0")));
  const totals = {
    lineNet,
    net,
    tax,
    gross,
    due,
    ...(raw.allowances === undefined ? {} : { allowances: raw.allowances }),
    ...(raw.charges === undefined ? {} : { charges: raw.charges }),
    ...(raw.taxInAccountingCurrency === undefined
      ? {}
      : { taxInAccountingCurrency: raw.taxInAccountingCurrency }),
    ...(raw.prepaid === undefined ? {} : { prepaid: raw.prepaid }),
    ...(raw.rounding === undefined ? {} : { rounding: raw.rounding }),
  };
  return { totals, missingTotals: missing };

  function mark(term: RequiredTotal, value: string): string {
    missing.push(term);
    return value;
  }
}
