/**
 * The document discount (Rabatt auf den Gesamtbetrag) of invoice, credit note and order drafts
 * (spec/deviations.md D-116): the tool argument, the body keys, the totals a preview expects, and
 * the checks that keep the draft tools inside what is recorded.
 *
 * Recorded on 2026-11-16 (probe `write-document-discount`, one position of 100.00 net at 19 %):
 * `discountSave` as a list of one `{objectName: "Discounts", mapAll: true, discount: true, text,
 * percentage, value}` after the position keys, followed by `discountDelete: null`, was accepted
 * by all three factories, for 10 % and for a fixed 10.00. sevDesk stored one row (`isNet` "1") and
 * computed net 90.00, tax 17.10, gross 107.10. An update with the document's id,
 * `discountSave: null` and `discountDelete` as a list of `{id, objectName: "Discounts"}` removed
 * it again.
 *
 * Checked on 2026-11-17 (trial account, Update 2.0, by the orchestrator) on an invoice draft of
 * 100.00 net at 19 %: the update body this module builds, `invoicePosSave: null`,
 * `invoicePosDelete: null`, `discountSave: [a fixed 5]` and `discountDelete: [the stored 10 %
 * row]`, replaced the discount in one request (one row afterwards; 95.00, 18.05, 113.05), and
 * adding one with `invoicePosSave: null` worked too (10 %: 90.00, 17.10, 107.10). A second
 * `discountSave` without a delete stored a second row, but sevDesk's sums then counted only the
 * newer one; that is why a draft with several discounts is never changed here.
 *
 * Recorded on 2026-11-18 (probes `write-discount-net-gross`, `write-discount-mixed-tax`,
 * `write-discount-mixed-tax-uneven`, `write-discount-foreign-currency`, `write-einvoice-discount`;
 * D-116):
 * - a fixed amount is net on net prices and gross on gross prices, whatever `isNet` says; on gross
 *   prices it comes off the gross total exactly (119.00 less 10.00: gross 109.00, net 91.60);
 * - a fixed 10.00 on a CHF document is 10.00 CHF;
 * - an e-invoice (CII, XRechnung 3.0) carries the discount as one document-level allowance;
 * - a surcharge (`discount` "0") adds instead of deducting (one rate, net prices).
 *
 * How sevDesk splits the deduction and rounds it was settled by the 40 cases recorded on
 * 2026-11-18 (probes `write-discount-mixed-tax-uneven` and `write-discount-rounding-edges`, D-116):
 * every one fits the rule below. Each competing split or tax rounding misses at least five;
 * variants of the rule itself (the leftover cent elsewhere, unrounded shares) miss one to four.
 * Rounding is half-up to cents throughout, ties included (49.50 × 19 % = 9.405 gave 9.41; 10 % of
 * 146.45 = 14.645 gave 14.65).
 *
 * - Net prices: the deduction D is the fixed amount, or the percentage of the net total N. Each
 *   position (not each rate: 10.01 × 3 at 19 % with 10 % gave tax 5.13, the rate's sum 5.14)
 *   gives up d_i = D × n_i / N; the cent this can leave over (D − Σ d_i) goes to the position with
 *   the largest net (the first of equal ones). Its tax is (n_i − d_i) × r_i. The document has net
 *   N − D, tax Σ of the positions' taxes, gross their sum.
 * - Gross prices, percentage and fixed amount alike: the deduction D is the fixed amount, or the
 *   percentage of the gross total G (3 % of 99.99 gave 3.00 off the gross, net 81.50, not the
 *   81.51 that 3 % of the net would give). Each position gives up d_i = D × g_i / G, the leftover
 *   cent to the largest gross; its net is (g_i − d_i) / (1 + r_i). The document has gross G − D,
 *   net Σ of the positions' nets, tax the difference.
 *
 * The recorded gross cases have one position per tax rate, so a split per position and one per
 * rate give the same sums there; per position is taken, as recorded for net prices. None of them
 * leaves a cent over after the split or rounds a tie, so the leftover cent's place on gross prices
 * (the largest gross) and half-up at a tie are carried over from net prices, not recorded.
 *
 * Not computed here, with a trusted preview warning instead of a refusal:
 * - a new or kept discount on stored positions whose sums sevDesk did not send, or whose sums do
 *   not add up to the stored totals (the split needs each position's amounts);
 * - surcharges, recorded on one rate only (the tools never send one; a kept one stays sevDesk's).
 * Changing a draft that has several discounts is refused (`planDiscountChange`).
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import { amountInput, currencyCode, splitTotals, type SumFields } from "../common.js";
import {
  appliedDiscount,
  type DiscountRow,
  discountRowText,
  type DiscountSums,
  discountTotals,
  type DocumentDiscount,
  type StoredDiscounts,
} from "../document-discounts.js";
import {
  add,
  compare,
  type Decimal,
  decimal,
  format,
  isZero,
  multiply,
  round,
  subtract,
} from "../money.js";
import {
  type Amounts,
  divideRounded,
  type DraftPosition,
  expectedTotals,
  positionAmounts,
  type PriceMode,
  wireNumber,
} from "./positions.js";

/** Text sent with a discount the call gives none for: sevDesk's own term. */
const DEFAULT_TEXT = "Rabatt";
const CENT_PLACES = 2;

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** The `discount` argument of the create draft tools. */
export const discountInput = z
  .strictObject({
    percent: amountInput({ places: 2, allowZero: false })
      .optional()
      .describe(
        "Rabatt in percent of the total (net on net prices, gross on gross prices), more than 0 " +
          "and at most 100, e.g. 3.",
      ),
    amount: amountInput({ places: 2, allowZero: false })
      .optional()
      .describe(
        'Fixed Rabatt in the document\'s currency, e.g. "50.00": net on net prices, gross on ' +
          "gross prices (priceMode gross); at most that total.",
      ),
    text: z
      .string()
      .trim()
      .min(1)
      .max(250)
      .optional()
      .describe('Text printed with the discount; default "Rabatt".'),
  })
  .describe(
    "Discount on the whole document (Rabatt auf den Gesamtbetrag): give percent or amount. " +
      "sevDesk splits it over the positions by their shares of the total.",
  );

export type DiscountInput = z.output<typeof discountInput>;

/** The `discount` argument of the update draft tools: `null` removes the stored discount. */
export const discountUpdateInput = discountInput
  .nullable()
  .optional()
  .describe(
    "Discount on the whole document (Rabatt auf den Gesamtbetrag), percent or amount: replaces " +
      "the stored one; null removes it; leave out to keep it.",
  );

/** A document discount as this server writes it: one deduction. */
export interface DraftDiscount {
  /**
   * A percentage of the total (net on net prices, gross on gross prices); otherwise a fixed
   * amount in the document's currency, net on net prices and gross on gross prices.
   */
  readonly percentage: boolean;
  /** Exact decimal, e.g. "3" or "50". */
  readonly value: string;
  readonly text: string;
}

function refusal(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message });
}

/** Validates the argument. Throws `validation` errors (trusted text). */
export function resolveDiscount(input: DiscountInput): DraftDiscount {
  const { percent, amount } = input;
  const text = input.text ?? DEFAULT_TEXT;
  if (percent !== undefined && amount === undefined) {
    if (compare(percent, 100) > 0) {
      throw refusal("discount.percent must be at most 100.");
    }
    return { percentage: true, value: percent, text };
  }
  if (amount !== undefined && percent === undefined) {
    return { percentage: false, value: amount, text };
  }
  throw refusal("discount: give either percent or amount, not both and not neither.");
}

// ---------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------

/** One object of `discountSave` (recorded shape and key order). */
interface DiscountSavePayload {
  readonly objectName: "Discounts";
  readonly mapAll: true;
  readonly discount: true;
  readonly text: string;
  readonly percentage: boolean;
  readonly value: number;
}

/** The discount keys of a save body; none when the stored discount is kept. */
export interface DiscountBody {
  readonly discountSave?: readonly DiscountSavePayload[] | null;
  readonly discountDelete?:
    readonly { readonly id: number; readonly objectName: "Discounts" }[] | null;
}

function savePayload(discount: DraftDiscount): DiscountSavePayload {
  return {
    objectName: "Discounts",
    mapAll: true,
    discount: true,
    text: discount.text,
    percentage: discount.percentage,
    value: wireNumber(discount.value, "The discount"),
  };
}

/** The body keys of a create: the discount as a list of one, nothing to delete (recorded). */
export function createDiscountBody(discount: DraftDiscount | undefined): DiscountBody {
  return discount === undefined
    ? {}
    : { discountSave: [savePayload(discount)], discountDelete: null };
}

// ---------------------------------------------------------------------------------------------
// Stored discounts and the change an update makes
// ---------------------------------------------------------------------------------------------

/** The stored discount as far as this server computes with it. */
export type DiscountState =
  | { readonly kind: "none" }
  /** One deduction: totals can include it. */
  | { readonly kind: "one"; readonly discount: DraftDiscount }
  /**
   * Several rows, a surcharge, or a percentage stored with `isNet` 0 (not recorded): sevDesk's
   * totals only. A fixed amount's `isNet` does not matter (recorded 2026-11-18, D-116).
   */
  | { readonly kind: "other" };

/** What the stored rows mean for totals (see {@link DiscountState}). */
export function storedDiscountState(rows: readonly DiscountRow[]): DiscountState {
  const [row, ...rest] = rows;
  if (row === undefined) return { kind: "none" };
  if (rest.length > 0 || row.surcharge || (row.percentage && row.isNet === false)) {
    return { kind: "other" };
  }
  return {
    kind: "one",
    discount: { percentage: row.percentage, value: row.value, text: row.text ?? "" },
  };
}

/** What an update does with the discount. */
export interface DiscountChange {
  /** Keys for the save body (none when the discount is kept). */
  readonly body: DiscountBody;
  /** Whether the call replaces or removes the stored discount. */
  readonly changed: boolean;
  /** The new discount, `null` when removed, `undefined` when kept. */
  readonly planned: DraftDiscount | null | undefined;
  /** The discount the draft has after the save. */
  readonly after: DiscountState;
}

/**
 * The change an update makes: keep (argument left out), replace (every stored row in
 * `discountDelete`, the new one in `discountSave`) or remove (`discountSave: null` and the stored
 * rows in `discountDelete`, the recorded removal). `label` names the draft, e.g. "Invoice 2102".
 * Throws `validation` for a draft with several discounts and for removing none.
 */
export function planDiscountChange(
  argument: DiscountInput | null | undefined,
  stored: StoredDiscounts,
  label: string,
): DiscountChange {
  if (argument === undefined) {
    return {
      body: {},
      changed: false,
      planned: undefined,
      after: storedDiscountState(stored.rows),
    };
  }
  if (stored.rows.length > 1) {
    throw refusal(
      `${label} has ${stored.rows.length} discounts on the whole document, and sevDesk's totals ` +
        "do not count all of them (in a check, only the newest). This tool changes a single " +
        "discount: correct them in sevDesk.",
    );
  }
  const deleted =
    stored.rows.length === 0
      ? null
      : stored.rows.map((row) => ({ id: row.id, objectName: "Discounts" as const }));
  if (argument === null) {
    if (deleted === null) {
      throw refusal(`${label} has no discount on the whole document to remove.`);
    }
    return {
      body: { discountSave: null, discountDelete: deleted },
      changed: true,
      planned: null,
      after: { kind: "none" },
    };
  }
  const discount = resolveDiscount(argument);
  return {
    body: { discountSave: [savePayload(discount)], discountDelete: deleted },
    changed: true,
    planned: discount,
    after: { kind: "one", discount },
  };
}

// ---------------------------------------------------------------------------------------------
// What is computed here, and totals
// ---------------------------------------------------------------------------------------------

/**
 * What the discount checks read of a stored position (`PositionRecord` has these fields): its
 * rate, whether it counts, and its sums as sevDesk stored them.
 */
export interface StoredPosition extends SumFields {
  readonly taxRate?: string | undefined;
  readonly optional?: boolean | undefined;
}

/** One position of a total: its rate and its undiscounted net and gross. */
export interface PartTotal {
  /** Percent, e.g. "19". */
  readonly rate: string;
  readonly net: Decimal;
  readonly gross: Decimal;
}

/**
 * The totals of new positions (optional order positions left out), one per position in the order
 * sent, each as `positionAmounts` computes it: the parts the discount is split over.
 */
export function positionParts(positions: readonly DraftPosition[], mode: PriceMode): PartTotal[] {
  return positions
    .filter((position) => position.optional !== true)
    .map((position) => {
      const amounts = positionAmounts(position, mode);
      return { rate: position.taxRate, net: decimal(amounts.net), gross: decimal(amounts.gross) };
    });
}

function sumOf(values: readonly Decimal[]): Decimal {
  return values.reduce<Decimal>((sum, value) => add(sum, value), decimal(0));
}

function cents(net: Decimal, tax: Decimal): Amounts {
  return {
    net: format(net, CENT_PLACES),
    tax: format(tax, CENT_PLACES),
    gross: format(add(net, tax), CENT_PLACES),
  };
}

/** `value × percent / 100`, exactly. */
function multiplyPercent(value: Decimal, percent: string): Decimal {
  const product = multiply(value, percent);
  return decimal({ units: product.units, scale: product.scale + 2 });
}

/**
 * The amount the discount takes off `basis`, the total of the document's price mode (net on net
 * prices, gross on gross prices): the fixed amount, or the percentage rounded half-up to cents.
 */
function deductionOf(basis: Decimal, discount: DraftDiscount): Decimal {
  return discount.percentage
    ? round(multiplyPercent(basis, discount.value), CENT_PLACES)
    : decimal(discount.value);
}

/**
 * Why the discount cannot be taken off a total of `net` and `gross` (trusted text): a total that
 * is not positive, or a deduction above it; the gross total on gross prices, the net total on net
 * prices. `undefined` when it can.
 */
function totalProblem(
  total: { readonly net: Decimal; readonly gross: Decimal },
  mode: PriceMode,
  discount: DraftDiscount,
): string | undefined {
  const label = mode === "gross" ? "gross" : "net";
  const basis = mode === "gross" ? total.gross : total.net;
  const shown = format(basis, CENT_PLACES);
  if (compare(basis, 0) <= 0) {
    return `The ${label} total is ${shown}; a discount on the whole document needs a positive total.`;
  }
  const deduction = deductionOf(basis, discount);
  if (compare(deduction, basis) > 0) {
    return `The discount of ${format(deduction, CENT_PLACES)} is more than the ${label} total of ${shown}.`;
  }
  return undefined;
}

/** The net and gross of all parts together. */
function totalOf(parts: readonly PartTotal[]): { readonly net: Decimal; readonly gross: Decimal } {
  return {
    net: sumOf(parts.map((item) => item.net)),
    gross: sumOf(parts.map((item) => item.gross)),
  };
}

/**
 * What each part gives up of `deduction` (recorded 2026-11-18, see the module comment): its share
 * by `weight` (net on net prices, gross on gross prices), rounded half-up to cents, and the cent
 * left over on the part with the largest weight (the first of equal ones). In the order of `parts`.
 */
function splitDeduction(
  parts: readonly PartTotal[],
  deduction: Decimal,
  weight: (part: PartTotal) => Decimal,
): Decimal[] {
  const total = sumOf(parts.map(weight));
  const shares = parts.map((part) =>
    divideRounded(multiply(deduction, weight(part)), total, CENT_PLACES),
  );
  const rest = subtract(deduction, sumOf(shares));
  if (isZero(rest)) return shares;
  const largest = parts.reduce((best, part, index) => {
    const leader = parts[best];
    return leader !== undefined && compare(weight(part), weight(leader)) > 0 ? index : best;
  }, 0);
  return shares.map((share, index) => (index === largest ? add(share, rest) : share));
}

/**
 * `parts` (the undiscounted totals of each counted position) less the discount, by the recorded
 * rule (see the module comment). Throws a `validation` error when the total is not positive or the
 * deduction exceeds it.
 */
export function discountedTotals(
  parts: readonly PartTotal[],
  mode: PriceMode,
  discount: DraftDiscount,
): Amounts {
  const total = totalOf(parts);
  const problem = totalProblem(total, mode, discount);
  if (problem !== undefined) throw refusal(problem);
  if (mode === "net") {
    const deduction = deductionOf(total.net, discount);
    const shares = splitDeduction(parts, deduction, (part) => part.net);
    const tax = sumOf(
      parts.map((part, index) =>
        round(
          multiplyPercent(subtract(part.net, shares[index] ?? decimal(0)), part.rate),
          CENT_PLACES,
        ),
      ),
    );
    return cents(subtract(total.net, deduction), tax);
  }
  const deduction = deductionOf(total.gross, discount);
  const shares = splitDeduction(parts, deduction, (part) => part.gross);
  const net = sumOf(
    parts.map((part, index) =>
      divideRounded(
        multiply(subtract(part.gross, shares[index] ?? decimal(0)), 100),
        add(100, part.rate),
        CENT_PLACES,
      ),
    ),
  );
  return cents(net, subtract(subtract(total.gross, deduction), net));
}

/** The totals a create preview shows. */
export interface CreateTotals {
  /** Net, tax and gross, less the discount when there is one. */
  readonly expected: Amounts;
  readonly gross: string;
}

/** What a draft's read-back compares: net, tax and gross. */
export type ExpectedTotals = Amounts;

/** The expectation a create keeps for its read-back. */
export function expectedOfCreate(totals: CreateTotals): ExpectedTotals {
  return totals.expected;
}

/**
 * The totals of a new draft: its positions, less the discount when there is one. Throws a
 * `validation` error for a discount the total cannot take (see {@link discountedTotals}).
 */
export function createTotals(
  positions: readonly DraftPosition[],
  mode: PriceMode,
  discount: DraftDiscount | undefined,
): CreateTotals {
  const expected =
    discount === undefined
      ? expectedTotals(positions, mode)
      : discountedTotals(positionParts(positions, mode), mode, discount);
  return { expected, gross: expected.gross };
}

/** The stored document a draft update starts from (sums as sevDesk sent them). */
export type StoredSums = SumFields & DiscountSums & { readonly currency?: string | undefined };

/**
 * The stored totals without the stored discounts: the document's sums less what sevDesk says the
 * discounts deducted (`sumDiscountNet`/`sumDiscountGross`, negative). `undefined` when sevDesk sent
 * no net or tax sum.
 */
function undiscountedStored(stored: StoredSums): Amounts | undefined {
  const currency = currencyCode(stored.currency);
  const { totals } = splitTotals(stored, currency);
  if (totals.net === undefined || totals.tax === undefined) return undefined;
  const deducted = discountTotals(stored, currency);
  const deductedNet = deducted.net?.amount ?? "0";
  const deductedTax =
    deducted.gross === undefined ? "0" : subtract(deducted.gross.amount, deductedNet);
  return cents(subtract(totals.net.amount, deductedNet), subtract(totals.tax.amount, deductedTax));
}

/** The totals an update preview shows, and why when they are not computed here. */
export interface UpdateTotals {
  /** The expected totals, when this call changes them and they can be computed. */
  readonly expected: Amounts | undefined;
  /** Whether the call changes the totals (so the preview must not call them unchanged). */
  readonly changes: boolean;
  /** Trusted preview warning when the totals change but are not computed here. */
  readonly warning: string | undefined;
}

/**
 * The parts an update's discount is split over: the new positions, or the stored ones by their
 * stored sums (in the document's `currency`). A single stored position without sums stands for
 * the undiscounted stored totals (`base`). Otherwise why they are not known (trusted text): a
 * position without a rate (taking 0 % would show a total without tax), several without sums, or
 * sums that do not add up to `base`.
 */
function updateParts(
  positions: readonly DraftPosition[] | undefined,
  storedPositions: readonly StoredPosition[],
  currency: string,
  base: Amounts,
  mode: PriceMode,
): PartTotal[] | string {
  if (positions !== undefined) return positionParts(positions, mode);
  const counted = storedPositions.filter((row) => row.optional !== true);
  const rates = counted.map((row) => row.taxRate);
  if (counted.length === 0 || rates.some((rate) => rate === undefined)) {
    return "sevDesk sent no tax rate for the stored positions, which the tax of the new total needs.";
  }
  const parts: PartTotal[] = [];
  for (const row of counted) {
    const { totals } = splitTotals(row, currency);
    if (row.taxRate === undefined || totals.net === undefined || totals.gross === undefined) break;
    parts.push({
      rate: row.taxRate,
      net: decimal(totals.net.amount),
      gross: decimal(totals.gross.amount),
    });
  }
  if (parts.length < counted.length) {
    const [only] = counted;
    if (counted.length === 1 && only?.taxRate !== undefined) {
      return [{ rate: only.taxRate, net: decimal(base.net), gross: decimal(base.gross) }];
    }
    return "sevDesk sent no sums for the stored positions, which the split of the discount over them needs.";
  }
  const total = totalOf(parts);
  if (compare(total.net, base.net) !== 0 || compare(total.gross, base.gross) !== 0) {
    return (
      "The sums of the stored positions do not add up to the stored totals, which the split of " +
      "the discount over them needs."
    );
  }
  return parts;
}

/**
 * The totals of an update with its discount. Unchanged when the call sets neither positions nor
 * the discount. A new discount the total cannot take is refused (`validation`); a kept one is
 * never refused. Where this server does not compute the total (stored positions whose sums it
 * does not have, discounts it does not know), sevDesk computes it and the preview says so.
 */
export function updateTotals(input: {
  readonly change: DiscountChange;
  /** New positions, or `undefined` when the stored ones stay. */
  readonly positions: readonly DraftPosition[] | undefined;
  readonly storedPositions: readonly StoredPosition[];
  readonly mode: PriceMode;
  readonly currencyChanged: boolean;
  readonly stored: StoredSums;
}): UpdateTotals {
  const { change, positions, mode } = input;
  if (positions === undefined && !change.changed) {
    return { expected: undefined, changes: false, warning: undefined };
  }
  const base =
    positions !== undefined
      ? expectedTotals(positions, mode)
      : input.currencyChanged
        ? undefined
        : undiscountedStored(input.stored);
  const uncomputed = (reason: string): UpdateTotals => ({
    expected: undefined,
    changes: true,
    warning: `${reason} sevDesk computes the new total; check it in the result before finalizing.`,
  });
  if (base === undefined) {
    return uncomputed("The stored totals cannot be read in the new currency.");
  }
  const after = change.after;
  switch (after.kind) {
    case "none":
      return { expected: base, changes: true, warning: undefined };
    case "one": {
      const kept = change.planned === undefined;
      const prefix = kept ? "The draft keeps its discount on the whole document. " : "";
      // A new discount that does not fit the total is refused; a kept one is not: the call does
      // not touch it.
      const problem = totalProblem(
        { net: decimal(base.net), gross: decimal(base.gross) },
        mode,
        after.discount,
      );
      if (problem !== undefined) {
        if (!kept) throw refusal(problem);
        return uncomputed(`${prefix}${problem}`);
      }
      const parts = updateParts(
        positions,
        input.storedPositions,
        currencyCode(input.stored.currency),
        base,
        mode,
      );
      if (typeof parts === "string") return uncomputed(`${prefix}${parts}`);
      return {
        expected: discountedTotals(parts, mode, after.discount),
        changes: true,
        warning: undefined,
      };
    }
    case "other":
      return uncomputed(
        "The draft keeps its discounts on the whole document (several, a surcharge or a " +
          "percentage stored as gross), which this server does not compute; with several, " +
          "sevDesk's totals may count only one of them.",
      );
    default: {
      const unknown: never = after;
      return unknown;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Preview and read-back
// ---------------------------------------------------------------------------------------------

/**
 * A new discount for a preview, written like a stored one (`discountRowText`) with the basis
 * sevDesk applies on `mode` (`appliedDiscount`: a fixed amount is gross on gross prices), e.g.
 * `3 % of the net total ("Rabatt")` or `50.00 EUR gross ("Rabatt")`.
 */
export function discountText(discount: DraftDiscount, currency: string, mode: PriceMode): string {
  const row = { surcharge: false, percentage: discount.percentage, value: discount.value };
  const applied = appliedDiscount({ ...row, isNet: true }, mode);
  return `${discountRowText(applied, currency, "en")} ("${discount.text}")`;
}

/**
 * The stored discounts for a preview (`discountRowText` with the basis sevDesk applies on `mode`,
 * `appliedDiscount`; raw text in quotes, cleaned by `fact`), or `undefined` for none.
 */
export function storedDiscountText(
  rows: readonly DiscountRow[],
  currency: string,
  mode: PriceMode,
): string | undefined {
  if (rows.length === 0) return undefined;
  return rows
    .map((row) => {
      const text = row.text === undefined ? "" : ` ("${row.text}")`;
      return `${discountRowText(appliedDiscount(row, mode), currency, "en")}${text}`;
    })
    .join("; ");
}

/**
 * A trusted read-back note when the discounts sevDesk stored differ from what the call sent, else
 * `undefined`. The replacement in one request is checked (see the module comment); the note stays
 * so that whatever sevDesk did with a save is seen before finalizing.
 */
export function discountReadBackNote(
  planned: DraftDiscount | null | undefined,
  actual: DocumentDiscount | undefined,
  noun: string,
): string | undefined {
  if (planned === undefined) return undefined;
  const items = actual?.items ?? [];
  if (planned === null) {
    return items.length === 0
      ? undefined
      : `sevDesk still lists ${items.length} discount(s) on the whole ${noun}; check them in ` +
          "sevDesk before finalizing.";
  }
  const [item] = items;
  const matches =
    items.length === 1 &&
    item !== undefined &&
    item.surcharge !== true &&
    item.kind === (planned.percentage ? "percent" : "amount") &&
    compare(item.value, planned.value) === 0;
  return matches
    ? undefined
    : `sevDesk lists ${items.length} discount(s) on the whole ${noun}, not the one this call ` +
        "sent; check them in sevDesk before finalizing.";
}
