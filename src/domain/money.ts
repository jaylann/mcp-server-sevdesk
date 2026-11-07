/**
 * Exact decimal arithmetic for money. Values are a bigint of units plus a decimal scale
 * (`units / 10^scale`), so `0.1 + 0.2` is exactly `0.3` and no float rounding ever creeps into a
 * total. Rounding happens only when asked for, half-up away from zero ("kaufmännisch gerundet").
 *
 * Numbers are parsed through their shortest round-trip `String()` form, so `2903.62000000001`
 * stays exactly that; JSON numbers from sevDesk therefore keep the digits sevDesk sent.
 */

/** An exact decimal: `units / 10^scale`. Immutable; normalized to the smallest scale. */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

/** Anything that can be turned into a {@link Decimal}. */
export type DecimalLike = Decimal | string | number | bigint;

/** Thrown for unparsable amounts, invalid currencies and mixed-currency sums. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Longest accepted input; guards against pathological values from untrusted data. */
const MAX_INPUT_LENGTH = 100;
/** Largest accepted decimal exponent / scale, for the same reason. */
const MAX_SCALE = 100;
const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/**
 * Parses a decimal from a string (`"-1.50"`, `"1e-3"`, `".5"`), a finite number (via its shortest
 * `String()` form) or a bigint. Throws {@link MoneyError} for anything else.
 */
export function decimal(value: DecimalLike): Decimal {
  if (typeof value === "bigint") return { units: value, scale: 0 };
  if (typeof value === "object") return normalize(value.units, value.scale);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MoneyError("An amount must be a finite number.");
    return parseDecimalString(String(value));
  }
  return parseDecimalString(value);
}

/** Whether `value` parses as a decimal. */
export function isDecimal(value: string): boolean {
  try {
    parseDecimalString(value);
    return true;
  } catch {
    return false;
  }
}

/** `a + b`, exactly. */
export function add(a: DecimalLike, b: DecimalLike): Decimal {
  const [x, y, scale] = align(decimal(a), decimal(b));
  return normalize(x + y, scale);
}

/** `a - b`, exactly. */
export function subtract(a: DecimalLike, b: DecimalLike): Decimal {
  const [x, y, scale] = align(decimal(a), decimal(b));
  return normalize(x - y, scale);
}

/** `a × b`, exactly (the scales add up; round explicitly afterwards). */
export function multiply(a: DecimalLike, b: DecimalLike): Decimal {
  const x = decimal(a);
  const y = decimal(b);
  return normalize(x.units * y.units, x.scale + y.scale);
}

/** `-a`. */
export function negate(a: DecimalLike): Decimal {
  const x = decimal(a);
  return normalize(-x.units, x.scale);
}

/** `-1`, `0` or `1` as `a` is less than, equal to or greater than `b`. */
export function compare(a: DecimalLike, b: DecimalLike): -1 | 0 | 1 {
  const [x, y] = align(decimal(a), decimal(b));
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

/** Whether `a` is exactly zero. */
export function isZero(a: DecimalLike): boolean {
  return decimal(a).units === 0n;
}

/**
 * Rounds to `places` decimals, half-up away from zero ("kaufmännisch"): `33.605 → 33.61`,
 * `-0.005 → -0.01`, `2.5 → 3` (at 0 places). Values with fewer decimals are unchanged.
 */
export function round(a: DecimalLike, places: number): Decimal {
  assertPlaces(places);
  const x = decimal(a);
  if (x.scale <= places) return x;
  const divisor = 10n ** BigInt(x.scale - places);
  let quotient = x.units / divisor;
  const remainder = x.units % divisor;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= divisor) quotient += x.units < 0n ? -1n : 1n;
  return normalize(quotient, places);
}

/**
 * Rounds to `places` decimals (see {@link round}) and renders exactly that many, e.g.
 * `format("33.605", 2) === "33.61"`, `format(5, 2) === "5.00"`. Never uses exponent notation.
 */
export function format(a: DecimalLike, places: number): string {
  const rounded = round(a, places);
  const units = rounded.units * 10n ** BigInt(places - rounded.scale);
  return render(units, places);
}

/** The exact value as a plain decimal string without exponent or trailing zeros, e.g. `"0.3"`. */
export function toDecimalString(a: DecimalLike): string {
  const x = decimal(a);
  return render(x.units, x.scale);
}

/**
 * An amount with its ISO 4217 currency. `amount` is an exact decimal string (never rounded) with
 * at least two decimals, e.g. `"119.00"`, `"33.605"`, `"-0.10"`.
 */
export interface Money {
  readonly amount: string;
  readonly currency: string;
}

export const DEFAULT_CURRENCY = "EUR";

let knownCurrencies: ReadonlySet<string> | undefined;

/** Whether `code` is an ISO 4217 currency code known to the runtime's ICU data (upper case). */
export function isCurrencyCode(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  knownCurrencies ??= new Set(Intl.supportedValuesOf("currency"));
  return knownCurrencies.has(code);
}

/**
 * Builds a {@link Money} value. The currency is upper-cased and validated against ISO 4217; the
 * amount is kept exact. Throws {@link MoneyError} on an invalid amount or currency.
 */
export function money(amount: DecimalLike, currency: string = DEFAULT_CURRENCY): Money {
  const code = currency.trim().toUpperCase();
  if (!isCurrencyCode(code)) {
    throw new MoneyError("A currency must be an ISO 4217 code such as EUR.");
  }
  const x = decimal(amount);
  const scale = Math.max(2, x.scale);
  return { amount: render(x.units * 10n ** BigInt(scale - x.scale), scale), currency: code };
}

/**
 * Sums amounts of one currency exactly. An empty list sums to zero in `currency` (default EUR).
 * Throws {@link MoneyError} when the list mixes currencies or does not match `currency` when given.
 */
export function sumMoney(list: readonly Money[], currency?: string): Money {
  const expected = (currency ?? list[0]?.currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  let total = decimal(0);
  for (const item of list) {
    if (item.currency.toUpperCase() !== expected) {
      throw new MoneyError("Cannot add amounts in different currencies.");
    }
    total = add(total, item.amount);
  }
  return money(total, expected);
}

function parseDecimalString(input: string): Decimal {
  const match = input.length <= MAX_INPUT_LENGTH ? DECIMAL_PATTERN.exec(input) : null;
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match ?? [];
  if (match === null || whole.length + fraction.length === 0) {
    throw new MoneyError("An amount must be a decimal number such as 12.34.");
  }
  const exp = Number(exponent);
  const scale = fraction.length - exp;
  if (Math.abs(exp) > MAX_SCALE || Math.abs(scale) > MAX_SCALE) {
    throw new MoneyError("An amount is out of the supported range.");
  }
  const digits = BigInt(`${whole}${fraction}` || "0");
  const units = sign === "-" ? -digits : digits;
  return scale >= 0 ? normalize(units, scale) : normalize(units * 10n ** BigInt(-scale), 0);
}

/** Strips trailing zeros so equal values have equal representations; `-0` becomes `0`. */
function normalize(units: bigint, scale: number): Decimal {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 2 * MAX_SCALE) {
    throw new MoneyError("An amount is out of the supported range.");
  }
  let u = units;
  let s = scale;
  while (s > 0 && u % 10n === 0n) {
    u /= 10n;
    s -= 1;
  }
  return { units: u, scale: s };
}

function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.units * 10n ** BigInt(scale - a.scale),
    b.units * 10n ** BigInt(scale - b.scale),
    scale,
  ];
}

function render(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  const body = scale > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

function assertPlaces(places: number): void {
  if (!Number.isSafeInteger(places) || places < 0 || places > MAX_SCALE) {
    throw new MoneyError(`Decimal places must be a whole number from 0 to ${MAX_SCALE}.`);
  }
}
