/**
 * Positions (Positionen) of draft invoices, credit notes and orders: the tool input, the
 * normalized form, the totals we expect sevDesk to compute, and the position objects of the save
 * payloads.
 *
 * Price fields (B8). A position carries one price, `price`, which sevDesk reads as net when the
 * document's `showNet` is true and as gross when it is false (spec tags `Invoice`/`CreditNote`/
 * `Order` → "showNet"; jernoxit/sevdesk-rs on an Update 2.0 account: its response recorded on
 * 2026-10-01 for a `showNet: true` request with prices 3 × 10 + 25 has `sumNet` 55, and its live test asserts
 * `sumGross` 21.90 for `showNet: false` with 11.90 + 2 × 5.00, an assertion, not a stored
 * fixture; the request shapes come from its source). `priceNet` is read-only in all three
 * position models, and no known request sends `priceGross` or `priceTax` on create, so payloads
 * send `price` only, with the document's
 * price mode deciding how sevDesk reads it. Derived values (sums, `priceNet`/`priceGross`/
 * `priceTax`) are never sent; the totals computed here only feed previews, the duplicate check and
 * the read-back comparison.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import { amountInput, compact } from "../common.js";
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

/** How position prices are entered: `net` → `showNet: true`, `gross` → `showNet: false`. */
export const PRICE_MODES = ["net", "gross"] as const;
export type PriceMode = (typeof PRICE_MODES)[number];

/** Positions per document a tool accepts in one call. */
export const MAX_POSITIONS = 100;

/**
 * `Unity` id 1, "Stk" (Stück, translation code `UNITY_PIECE`, UN/ECE `C62`): sevDesk's system unit
 * for pieces (recorded `GET /Unity` and the units embedded in a recorded `saveInvoice` response).
 */
const DEFAULT_UNIT_ID = 1;

const MAX_NAME_LENGTH = 250;
const MAX_TEXT_LENGTH = 5_000;

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const positionShape = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .describe("Article or service name (Bezeichnung) as printed."),
  quantity: amountInput({ places: 4, allowZero: false }).describe(
    'Menge, greater than 0, up to 4 decimals, e.g. 2 or "1.5".',
  ),
  unitPrice: amountInput({ places: 4, allowNegative: true }).describe(
    "Einzelpreis per unit in the document currency, net or gross as the document's priceMode " +
      'says; up to 4 decimals, e.g. "49.90"; negative for a deduction line.',
  ),
  taxRate: amountInput({ places: 2 })
    .optional()
    .describe(
      "Umsatzsteuersatz in percent, e.g. 19, 7 or 0; must be allowed by the tax rule. May be " +
        "left out only when the rule allows a single rate (e.g. 0 for rule 11).",
    ),
  unitId: positiveId
    .optional()
    .describe("Einheit (Unity id, see sevdesk_reference_lookup kind=units); default 1 = Stk."),
  partId: positiveId
    .optional()
    .describe(
      "Inventory part (Artikel, see sevdesk_parts_list) to link. Name and price still come " +
        "from this position; sevDesk does not fill them in.",
    ),
  text: z
    .string()
    .max(MAX_TEXT_LENGTH)
    .optional()
    .describe("Description printed below the name (Positionstext); line breaks allowed."),
  discountPercent: amountInput({ places: 2, allowZero: false })
    .optional()
    .describe("Rabatt on this position in percent, more than 0 and at most 100."),
};

/** One position of an invoice or credit note draft. */
export const draftPositionInput = z.strictObject(positionShape);

/** One position of an order draft: may also be optional (offers). */
export const orderPositionInput = z.strictObject({
  ...positionShape,
  optional: z
    .boolean()
    .optional()
    .describe("Optional position (Optionale Position, offers): printed, not part of the total."),
});

/** A position as the tools receive it (the order variant is a superset). */
export type PositionInput = z.output<typeof orderPositionInput>;

/** A validated position with its tax rate resolved. Amounts are exact decimal strings. */
export interface DraftPosition {
  readonly name: string;
  readonly quantity: string;
  readonly unitPrice: string;
  /** Percent, e.g. "19". */
  readonly taxRate: string;
  readonly unitId: number;
  readonly partId?: number | undefined;
  readonly text?: string | undefined;
  readonly discountPercent?: string | undefined;
  readonly optional?: boolean | undefined;
}

/**
 * Validated positions with the tax rates resolved by the tax module (one per input, same order).
 * Throws a `validation` error for a discount above 100 %.
 */
export function toDraftPositions(
  inputs: readonly PositionInput[],
  taxRates: readonly string[],
): DraftPosition[] {
  return inputs.map((input, index) => {
    if (input.discountPercent !== undefined && compare(input.discountPercent, 100) > 0) {
      throw new SevdeskError({
        kind: "validation",
        message: `Position ${index + 1} has a discount above 100 %; give discountPercent from 0.01 to 100.`,
      });
    }
    const taxRate = taxRates[index];
    if (taxRate === undefined) {
      throw new Error(`toDraftPositions: no tax rate for position ${index + 1}`);
    }
    return compact({
      name: input.name,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      taxRate,
      unitId: input.unitId ?? DEFAULT_UNIT_ID,
      partId: input.partId,
      text: input.text === undefined || input.text.trim() === "" ? undefined : input.text,
      discountPercent: input.discountPercent,
      optional: input.optional === true ? true : undefined,
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Expected totals (never sent)
// ---------------------------------------------------------------------------------------------

/** Net, tax and gross with exactly two decimals, e.g. `{ net: "30.00", tax: "5.70", … }`. */
export interface Amounts {
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

const CENT_PLACES = 2;

/** `value / 100`, exactly (a shift of the decimal point). */
function percentOf(value: Decimal): Decimal {
  return decimal({ units: value.units, scale: value.scale + 2 });
}

/**
 * `a / b` rounded half-up away from zero to `places` decimals, with bigint arithmetic only (no
 * floats). `b` must not be zero.
 */
export function divideRounded(a: Decimal, b: Decimal, places: number): Decimal {
  if (b.units === 0n) throw new Error("divideRounded: division by zero");
  // a / b = (a.units / 10^a.scale) / (b.units / 10^b.scale)
  //       = (a.units * 10^(b.scale + places)) / (b.units * 10^a.scale) / 10^places
  let numerator = a.units * 10n ** BigInt(b.scale + places);
  let denominator = b.units * 10n ** BigInt(a.scale);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= denominator) quotient += numerator < 0n ? -1n : 1n;
  return decimal({ units: quotient, scale: places });
}

/**
 * The amounts of one position as we expect sevDesk to compute them: quantity × unit price, less
 * the discount, rounded to cents ("kaufmännisch"). Net prices: tax = net × rate. Gross prices:
 * net = gross / (1 + rate), tax = gross − net.
 */
export function positionAmounts(position: DraftPosition, mode: PriceMode): Amounts {
  let line = multiply(position.quantity, position.unitPrice);
  if (position.discountPercent !== undefined) {
    line = percentOf(multiply(line, subtract(100, position.discountPercent)));
  }
  const rate = decimal(position.taxRate);
  if (mode === "net") {
    const net = round(line, CENT_PLACES);
    const tax = round(percentOf(multiply(net, rate)), CENT_PLACES);
    return cents(net, tax, add(net, tax));
  }
  const gross = round(line, CENT_PLACES);
  const net = divideRounded(multiply(gross, 100), add(100, rate), CENT_PLACES);
  return cents(net, subtract(gross, net), gross);
}

/** The document totals we expect: the sum of all non-optional positions. */
export function expectedTotals(positions: readonly DraftPosition[], mode: PriceMode): Amounts {
  let net = decimal(0);
  let tax = decimal(0);
  let gross = decimal(0);
  for (const position of positions) {
    if (position.optional === true) continue;
    const amounts = positionAmounts(position, mode);
    net = add(net, amounts.net);
    tax = add(tax, amounts.tax);
    gross = add(gross, amounts.gross);
  }
  return cents(net, tax, gross);
}

function cents(net: Decimal, tax: Decimal, gross: Decimal): Amounts {
  return {
    net: format(net, CENT_PLACES),
    tax: format(tax, CENT_PLACES),
    gross: format(gross, CENT_PLACES),
  };
}

// ---------------------------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------------------------

/** `objectName` of the position collections. */
export type PositionObjectName = "InvoicePos" | "CreditNotePos" | "OrderPos";

/** A position object for `invoicePosSave` / `creditNotePosSave` / `orderPosSave` (new rows). */
export interface PositionPayload {
  readonly objectName: PositionObjectName;
  readonly mapAll: true;
  readonly quantity: number;
  /** Net or gross per the document's `showNet` (B8); exact decimal string, as sevdesk-rs sends. */
  readonly price: string;
  readonly name: string;
  readonly unity: { readonly id: number; readonly objectName: "Unity" };
  readonly taxRate: number;
  readonly positionNumber: number;
  readonly text?: string | undefined;
  readonly part?: { readonly id: number; readonly objectName: "Part" } | undefined;
  /** Percent (the recorded response shows `isPercentage: true` when none was sent). */
  readonly discount?: number | undefined;
  readonly optional?: boolean | undefined;
}

/**
 * The payload of a new position. Field types follow sevdesk-rs's request (shape from its
 * source; the response recorded on 2026-10-01 shows it accepted): `quantity`
 * and `taxRate` as JSON numbers, `price` as a decimal string ("10.00"). `positionNumber` counts
 * from 0 (spec tag `InvoicePos`: "Needs to start with zero and is incremented for every new
 * position"). `optional` is sent for order positions only (the other position models lack it).
 */
export function positionPayload(
  position: DraftPosition,
  index: number,
  objectName: PositionObjectName,
): PositionPayload {
  const price = decimal(position.unitPrice);
  return compact({
    objectName,
    mapAll: true as const,
    quantity: wireNumber(position.quantity, `the quantity of position ${index + 1}`),
    price: format(price, Math.max(CENT_PLACES, price.scale)),
    name: position.name,
    unity: { id: position.unitId, objectName: "Unity" as const },
    taxRate: wireNumber(position.taxRate, `the tax rate of position ${index + 1}`),
    positionNumber: index,
    text: position.text,
    part:
      position.partId === undefined
        ? undefined
        : { id: position.partId, objectName: "Part" as const },
    discount:
      position.discountPercent === undefined
        ? undefined
        : wireNumber(position.discountPercent, `the discount of position ${index + 1}`),
    optional: objectName === "OrderPos" && position.optional === true ? true : undefined,
  });
}

/**
 * An exact decimal string as a JSON number for the wire. Only serialization happens here (no
 * arithmetic): the number must print back as exactly the same decimal, else the value is refused
 * rather than sent rounded. `what` is trusted text for the error.
 */
export function wireNumber(value: string, what: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || compare(String(number), value) !== 0) {
    throw new SevdeskError({
      kind: "validation",
      message: `${what} has too many digits to send exactly; use a smaller value.`,
    });
  }
  return number;
}
