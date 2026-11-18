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
 * `write-discount-foreign-currency`, `write-einvoice-discount`; D-116):
 * - on gross prices (100.00 net entered as 119.00) 10 % gives the same totals as on net prices,
 *   but a fixed 10.00 comes off the gross total (gross 109.00, net 91.60, tax 17.40), whatever
 *   `isNet` says;
 * - with 100.00 at 19 % and 100.00 at 7 %, sevDesk splits the discount over the rates by their
 *   share of the net total (10 %: tax 26.00 → 23.40; a fixed 10.00: tax → 24.70);
 * - a fixed 10.00 on a CHF document is 10.00 CHF;
 * - an e-invoice (CII, XRechnung 3.0) carries the discount as one document-level allowance.
 *
 * So a new discount is accepted on e-invoices, in other currencies than EUR and as a percentage on
 * gross prices, and refused with a trusted sentence only where this server does not compute the
 * totals: a fixed amount on gross prices, positions with several tax rates, and changing a draft
 * that has several discounts. A stored discount the call keeps is never refused; when the totals
 * cannot be computed with it, the preview says that sevDesk computes them.
 *
 * Totals (single rate r): the discount's net D is the percentage of the net total N (rounded to
 * cents) or the fixed amount, in the document's currency; its tax is D × r (rounded); net N − D,
 * tax T − D × r, gross their sum. For the recorded case: 100.00 − 10.00, 19.00 − 1.90, 107.10.
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
  multiply,
  round,
  subtract,
} from "../money.js";
import {
  type Amounts,
  type DraftPosition,
  expectedTotals,
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
        'Fixed Rabatt, net, in the document\'s currency, e.g. "50.00"; at most the net total. ' +
          "Net prices only.",
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
      "Positions with one tax rate only.",
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

/** A document discount as this server writes it: one deduction, net. */
export interface DraftDiscount {
  /** A percentage of the net total; otherwise a fixed net amount in the document's currency. */
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
  /** One net deduction: totals can include it. */
  | { readonly kind: "one"; readonly discount: DraftDiscount }
  /** Several rows, a surcharge or one stored as gross (`isNet` 0): sevDesk's totals only. */
  | { readonly kind: "other" };

/** What the stored rows mean for totals (see {@link DiscountState}). */
export function storedDiscountState(rows: readonly DiscountRow[]): DiscountState {
  const [row, ...rest] = rows;
  if (row === undefined) return { kind: "none" };
  if (rest.length > 0 || row.surcharge || row.isNet === false) return { kind: "other" };
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

/** Where a discount would apply: the document's price mode and tax rates. */
interface DiscountContext {
  readonly mode: PriceMode;
  /** Tax rates of the positions in the total (optional order positions left out). */
  readonly rates: readonly string[];
}

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

/** The tax rates of new positions that count toward the total. */
function positionRates(positions: readonly DraftPosition[]): string[] {
  return positions.filter((position) => position.optional !== true).map((p) => p.taxRate);
}

/**
 * Why this server does not compute the totals of a discount on this document (trusted text), or
 * `undefined` when it does. What sevDesk does in these cases is recorded (see the module comment);
 * the totals are not computed here yet. E-invoices and other currencies need no exception: the
 * e-invoice carries the discount, and a fixed amount is in the document's currency.
 */
function notComputed(discount: DraftDiscount, context: DiscountContext): string | undefined {
  if (context.mode === "gross" && !discount.percentage) {
    return (
      "On gross prices sevDesk takes a fixed discount off the gross total, which this tool does " +
      "not compute; give the discount in percent, or use net prices (priceMode net)."
    );
  }
  if (distinctRates(context.rates).length > 1) {
    return (
      "sevDesk splits a discount on the whole document over several tax rates, which this tool " +
      "does not compute; it sets one only on positions with one tax rate."
    );
  }
  return undefined;
}

/** Throws a `validation` error when this server does not compute a new discount's totals. */
function checkNewDiscount(discount: DraftDiscount, context: DiscountContext): void {
  const reason = notComputed(discount, context);
  if (reason !== undefined) throw refusal(reason);
}

function cents(net: Decimal, tax: Decimal): Amounts {
  return {
    net: format(net, CENT_PLACES),
    tax: format(tax, CENT_PLACES),
    gross: format(add(net, tax), CENT_PLACES),
  };
}

/** The net the discount deducts from the net total `net`: a percentage rounded to cents. */
function deductionOf(net: Decimal, discount: DraftDiscount): Decimal {
  return discount.percentage
    ? round(multiplyPercent(net, discount.value), CENT_PLACES)
    : decimal(discount.value);
}

/**
 * Why the discount cannot be taken off `base` (trusted text): a net total that is not positive, or
 * a deduction above it. `undefined` when it can.
 */
function totalProblem(base: Amounts, discount: DraftDiscount): string | undefined {
  const net = decimal(base.net);
  if (compare(net, 0) <= 0) {
    return `The net total is ${base.net}; a discount on the whole document needs a positive total.`;
  }
  const deduction = deductionOf(net, discount);
  if (compare(deduction, net) > 0) {
    return `The discount of ${format(deduction, CENT_PLACES)} is more than the net total of ${base.net}.`;
  }
  return undefined;
}

/**
 * `base` (the undiscounted totals of positions that all carry `rate`) less the discount. Throws a
 * `validation` error when the net total is not positive or a fixed amount exceeds it.
 */
export function discountedTotals(base: Amounts, rate: string, discount: DraftDiscount): Amounts {
  const problem = totalProblem(base, discount);
  if (problem !== undefined) throw refusal(problem);
  const net = decimal(base.net);
  const deduction = deductionOf(net, discount);
  const deductionTax = round(multiplyPercent(deduction, rate), CENT_PLACES);
  return cents(subtract(net, deduction), subtract(base.tax, deductionTax));
}

/** `value × percent / 100`, exactly. */
function multiplyPercent(value: Decimal, percent: string): Decimal {
  const product = multiply(value, percent);
  return decimal({ units: product.units, scale: product.scale + 2 });
}

/**
 * The totals of a new draft: its positions, less the discount when there is one. Throws for a
 * discount outside what is recorded (see {@link checkNewDiscount}).
 */
export function createTotals(
  positions: readonly DraftPosition[],
  mode: PriceMode,
  discount: DraftDiscount | undefined,
): Amounts {
  const base = expectedTotals(positions, mode);
  if (discount === undefined) return base;
  const rates = positionRates(positions);
  checkNewDiscount(discount, { mode, rates });
  return discountedTotals(base, distinctRates(rates)[0] ?? "0", discount);
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
 * The totals of an update with its discount. Unchanged when the call sets neither positions nor
 * the discount. A new discount must be one this server computes (throws otherwise); a kept one
 * that is not, or that is not one discount on the stored price mode, leaves the computing to
 * sevDesk with a warning.
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
  const rates =
    positions === undefined ? storedRates(input.storedPositions) : positionRates(positions);
  if (change.planned !== undefined && change.planned !== null) {
    checkNewDiscount(change.planned, { mode, rates });
  }
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
      // A new discount passed `checkNewDiscount` above and is refused by `discountedTotals` when
      // it does not fit the total. A kept one is never refused: the call does not touch it.
      if (change.planned === undefined) {
        const reason =
          notComputed(after.discount, { mode, rates }) ?? totalProblem(base, after.discount);
        if (reason !== undefined) {
          return uncomputed(`The draft keeps its discount on the whole document. ${reason}`);
        }
      }
      return {
        expected: discountedTotals(base, distinctRates(rates)[0] ?? "0", after.discount),
        changes: true,
        warning: undefined,
      };
    }
    case "other":
      return uncomputed(
        "The draft keeps its discounts on the whole document (several, a surcharge or one stored " +
          "as gross), which this server does not compute; with several, sevDesk's totals may " +
          "count only one of them.",
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
 * A new discount for a preview, written like a stored one (`discountRowText`), e.g.
 * `3 % of the net total ("Rabatt")`.
 */
export function discountText(discount: DraftDiscount, currency: string): string {
  const row = { surcharge: false, percentage: discount.percentage, value: discount.value };
  return `${discountRowText({ ...row, isNet: true }, currency, "en")} ("${discount.text}")`;
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
