/**
 * Decimal helpers the money module does not need elsewhere: division (for unit prices given per
 * base quantity, BT-149) and the tolerance comparison of the VAT amount rule BR-CO-17.
 */
import { compare, decimal, type DecimalLike, subtract, toDecimalString } from "../money.js";

/**
 * `a / b`, rounded half-up away from zero to `places` decimals (default 6), as an exact decimal
 * string. Division by zero returns `a` unchanged (callers only divide by quantities they checked).
 */
export function divideDecimal(a: DecimalLike, b: DecimalLike, places = 6): string {
  const x = decimal(a);
  const y = decimal(b);
  if (y.units === 0n) return toDecimalString(x);
  // a / b = (x.units / 10^x.scale) / (y.units / 10^y.scale); scaled by 10^places.
  let numerator = x.units * 10n ** BigInt(y.scale + places);
  let denominator = y.units * 10n ** BigInt(x.scale);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= denominator) quotient += numerator < 0n ? -1n : 1n;
  return toDecimalString({ units: quotient, scale: places });
}

/** `|a - b| <= tolerance`, exactly. */
export function withinTolerance(a: DecimalLike, b: DecimalLike, tolerance: DecimalLike): boolean {
  const difference = decimal(subtract(a, b));
  const absolute =
    difference.units < 0n ? { units: -difference.units, scale: difference.scale } : difference;
  return compare(absolute, tolerance) <= 0;
}

/** BT-146 divided by BT-149 when a base quantity other than 1 is given (model contract). */
export function pricePerUnit(
  price: string | undefined,
  baseQuantity: string | undefined,
): string | undefined {
  if (price === undefined) return undefined;
  if (
    baseQuantity === undefined ||
    compare(baseQuantity, 1) === 0 ||
    compare(baseQuantity, 0) === 0
  ) {
    return price;
  }
  return divideDecimal(price, baseQuantity);
}
