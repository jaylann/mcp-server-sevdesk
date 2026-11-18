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
 * - a percentage takes that share of the net total, on net and on gross prices alike;
 * - a fixed amount is net on net prices and gross on gross prices, whatever `isNet` says; on gross
 *   prices it comes off the gross total exactly (119.00 less 10.00: gross 109.00, net 91.60);
 * - over several tax rates sevDesk splits the deduction by the rates' shares of the net total;
 * - a fixed 10.00 on a CHF document is 10.00 CHF;
 * - an e-invoice (CII, XRechnung 3.0) carries the discount as one document-level allowance;
 * - a surcharge (`discount` "0") adds instead of deducting (one rate, net prices).
 *
 * Totals (net or percentage, any number of tax rates). The net deduction D is the fixed amount, or
 * the percentage of the net total N rounded half-up to cents. Each tax rate i (net N_i, rate r_i)
 * gives up d_i = D × N_i / N rounded half-up to cents; the cent this can leave over (D − Σ d_i)
 * goes to the rate with the largest net. Its tax is (N_i − d_i) × r_i rounded to cents. The
 * document then has net N − D, tax Σ of the rates' taxes, gross their sum. Of the 48 roundings
 * the probe set apart (share rounded or exact; tax rounded on the total, on the deduction or per
 * rate; the leftover cent on the largest, first, last, highest-rate or lowest-rate position; a
 * percentage off the total or off each rate), only this one gives all 15 recorded splits (two and
 * three rates, 0 % included). On one rate it is N − D and (N − D) × r. No recorded share or tax
 * lands on a half cent, so half-up at a tie (as for positions) is assumed: 49.50 × 19 % = 9.405
 * gives 9.41 here.
 *
 * Not computed here, with a trusted preview warning instead of a refusal:
 * - how sevDesk splits a fixed amount on gross prices into net and tax: three rules fit the three
 *   recorded cases and disagree in about a fifth of others. The gross total is exact (the total
 *   less the amount), so the preview shows it and the read-back compares it;
 * - a new or kept discount on stored positions with several rates, whose net per rate the stored
 *   sums do not show;
 * - surcharges, recorded on one rate only (the tools never send one; a kept one stays sevDesk's).
 * Changing a draft that has several discounts is refused (`planDiscountChange`).
 *
 * The recorded cases have one position per tax rate. Several positions at one rate are summed into
 * that rate first (assumed, not recorded; the read-back compares the gross total).
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
      .describe("Rabatt in percent of the net total, more than 0 and at most 100, e.g. 3."),
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
      "sevDesk splits it over the tax rates by their net shares.",
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
   * A percentage of the net total; otherwise a fixed amount in the document's currency, net on
   * net prices and gross on gross prices.
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

/** The distinct rates, compared as decimals ("19" and "19.00" are one rate). */
function distinctRates(rates: readonly string[]): string[] {
  const distinct: string[] = [];
  for (const rate of rates) {
    if (!distinct.some((known) => compare(known, rate) === 0)) distinct.push(rate);
  }
  return distinct;
}

/** What the discount checks read of a stored position (`PositionRecord` has these fields). */
export interface StoredPositionRate {
  readonly taxRate?: string | undefined;
  readonly optional?: boolean | undefined;
}

/** The tax rates of stored positions that count toward the total. */
function storedRates(positions: readonly StoredPositionRate[]): string[] {
  return positions
    .filter((row) => row.optional !== true)
    .map((row) => row.taxRate)
    .filter((rate): rate is string => rate !== undefined);
}

/** One tax rate of a total: the rate and the undiscounted net and gross of its positions. */
export interface RateTotal {
  /** Percent, e.g. "19". */
  readonly rate: string;
  readonly net: Decimal;
  readonly gross: Decimal;
}

/**
 * The rate totals of new positions (optional order positions left out), one per distinct rate in
 * the order the rates first appear; each position's amounts as `positionAmounts` computes them.
 */
export function rateTotals(positions: readonly DraftPosition[], mode: PriceMode): RateTotal[] {
  const totals: RateTotal[] = [];
  for (const position of positions) {
    if (position.optional === true) continue;
    const amounts = positionAmounts(position, mode);
    const index = totals.findIndex((item) => compare(item.rate, position.taxRate) === 0);
    const known = totals[index];
    totals[index === -1 ? totals.length : index] =
      known === undefined
        ? { rate: position.taxRate, net: decimal(amounts.net), gross: decimal(amounts.gross) }
        : {
            rate: known.rate,
            net: add(known.net, amounts.net),
            gross: add(known.gross, amounts.gross),
          };
  }
  return totals;
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

/** A fixed amount on gross prices: a gross amount, split into net and tax by sevDesk. */
function isGrossAmount(discount: DraftDiscount, mode: PriceMode): boolean {
  return mode === "gross" && !discount.percentage;
}

/** The net the discount deducts from the net total `net`: a percentage rounded to cents. */
function deductionOf(net: Decimal, discount: DraftDiscount): Decimal {
  return discount.percentage
    ? round(multiplyPercent(net, discount.value), CENT_PLACES)
    : decimal(discount.value);
}

/**
 * Why the discount cannot be taken off a total of `net` and `gross` (trusted text): a total that
 * is not positive, or a deduction above it; the gross total for a fixed amount on gross prices,
 * the net total otherwise. `undefined` when it can.
 */
function totalProblem(
  total: { readonly net: Decimal; readonly gross: Decimal },
  mode: PriceMode,
  discount: DraftDiscount,
): string | undefined {
  const gross = isGrossAmount(discount, mode);
  const label = gross ? "gross" : "net";
  const basis = gross ? total.gross : total.net;
  const shown = format(basis, CENT_PLACES);
  if (compare(basis, 0) <= 0) {
    return `The ${label} total is ${shown}; a discount on the whole document needs a positive total.`;
  }
  const deduction = gross ? decimal(discount.value) : deductionOf(basis, discount);
  if (compare(deduction, basis) > 0) {
    return `The discount of ${format(deduction, CENT_PLACES)} is more than the ${label} total of ${shown}.`;
  }
  return undefined;
}

/** The net and gross of all rates together. */
function totalOf(rates: readonly RateTotal[]): { readonly net: Decimal; readonly gross: Decimal } {
  return {
    net: sumOf(rates.map((item) => item.net)),
    gross: sumOf(rates.map((item) => item.gross)),
  };
}

/**
 * What each rate gives up of the net `deduction` (recorded 2026-11-18, see the module comment): its
 * share by net, rounded half-up to cents, and the cent left over on the rate with the largest net
 * (the first of equal ones).
 */
function splitDeduction(
  rates: readonly RateTotal[],
  deduction: Decimal,
): { readonly item: RateTotal; readonly share: Decimal }[] {
  const net = totalOf(rates).net;
  const split = rates.map((item) => ({
    item,
    share: divideRounded(multiply(deduction, item.net), net, CENT_PLACES),
  }));
  const rest = subtract(deduction, sumOf(split.map((part) => part.share)));
  if (isZero(rest)) return split;
  const largest = split.reduce(
    (best, part, index) => (compare(part.item.net, split[best]?.item.net ?? 0) > 0 ? index : best),
    0,
  );
  return split.map((part, index) =>
    index === largest ? { item: part.item, share: add(part.share, rest) } : part,
  );
}

/** A total less the discount: all three amounts, or only the gross for a fixed gross amount. */
export type DiscountedTotals =
  | { readonly kind: "computed"; readonly amounts: Amounts }
  /** A fixed amount on gross prices: the gross total is exact, net and tax are sevDesk's. */
  | { readonly kind: "grossOnly"; readonly gross: string };

/**
 * `rates` (the undiscounted totals per tax rate) less the discount, by the recorded rule (see the
 * module comment). Throws a `validation` error when the total is not positive or a fixed amount
 * exceeds it.
 */
export function discountedTotals(
  rates: readonly RateTotal[],
  mode: PriceMode,
  discount: DraftDiscount,
): DiscountedTotals {
  const total = totalOf(rates);
  const problem = totalProblem(total, mode, discount);
  if (problem !== undefined) throw refusal(problem);
  if (isGrossAmount(discount, mode)) {
    return { kind: "grossOnly", gross: format(subtract(total.gross, discount.value), CENT_PLACES) };
  }
  const deduction = deductionOf(total.net, discount);
  const tax = sumOf(
    splitDeduction(rates, deduction).map(({ item, share }) =>
      round(multiplyPercent(subtract(item.net, share), item.rate), CENT_PLACES),
    ),
  );
  return { kind: "computed", amounts: cents(subtract(total.net, deduction), tax) };
}

/** Why net and tax of a fixed amount on gross prices are left to sevDesk (trusted text). */
function grossSplitText(gross: string): string {
  return (
    `On gross prices a fixed discount comes off the gross total (expected gross ${gross}); ` +
    "sevDesk splits it into net and tax in a way this server does not compute."
  );
}

/** The totals a create preview shows. */
export interface CreateTotals {
  /** Net, tax and gross, when this server computes all three. */
  readonly expected: Amounts | undefined;
  /** The gross total: always known (a fixed amount on gross prices comes off it exactly). */
  readonly gross: string;
  /** Trusted preview warning when net and tax are left to sevDesk. */
  readonly warning: string | undefined;
}

/** What a draft's read-back compares: the gross total, with net and tax when computed here. */
export type ExpectedTotals = Amounts | { readonly gross: string };

/** The expectation a create keeps for its read-back. */
export function expectedOfCreate(totals: CreateTotals): ExpectedTotals {
  return totals.expected ?? { gross: totals.gross };
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
  if (discount === undefined) {
    const base = expectedTotals(positions, mode);
    return { expected: base, gross: base.gross, warning: undefined };
  }
  const result = discountedTotals(rateTotals(positions, mode), mode, discount);
  if (result.kind === "computed") {
    return { expected: result.amounts, gross: result.amounts.gross, warning: undefined };
  }
  return {
    expected: undefined,
    gross: result.gross,
    warning: `${grossSplitText(result.gross)} Check net and tax in the result before finalizing.`,
  };
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
 * The rate totals an update's discount is split over: those of the new positions, or for stored
 * positions with one rate the undiscounted stored sums (`base`). Otherwise why they are not known
 * (trusted text): the stored sums do not show the net per rate, and without a rate the tax of the
 * rest is unknown (taking 0 % would show a total without tax).
 */
function updateRates(
  positions: readonly DraftPosition[] | undefined,
  storedPositions: readonly StoredPositionRate[],
  base: Amounts,
  mode: PriceMode,
): RateTotal[] | string {
  if (positions !== undefined) return rateTotals(positions, mode);
  const [rate, ...others] = distinctRates(storedRates(storedPositions));
  if (rate === undefined) {
    return "sevDesk sent no tax rate for the stored positions, which the tax of the new total needs.";
  }
  if (others.length > 0) {
    return (
      "The stored positions have several tax rates, and the stored sums do not show the net of " +
      "each, which the split of the discount needs."
    );
  }
  return [{ rate, net: decimal(base.net), gross: decimal(base.gross) }];
}

/**
 * The totals of an update with its discount. Unchanged when the call sets neither positions nor
 * the discount. A new discount the total cannot take is refused (`validation`); a kept one is
 * never refused. Where this server does not compute the total (a fixed amount on gross prices,
 * stored positions with several rates, discounts it does not know), sevDesk computes it and the
 * preview says so.
 */
export function updateTotals(input: {
  readonly change: DiscountChange;
  /** New positions, or `undefined` when the stored ones stay. */
  readonly positions: readonly DraftPosition[] | undefined;
  readonly storedPositions: readonly StoredPositionRate[];
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
      const rates = updateRates(positions, input.storedPositions, base, mode);
      if (typeof rates === "string") return uncomputed(`${prefix}${rates}`);
      const result = discountedTotals(rates, mode, after.discount);
      if (result.kind === "grossOnly")
        return uncomputed(`${prefix}${grossSplitText(result.gross)}`);
      return { expected: result.amounts, changes: true, warning: undefined };
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
