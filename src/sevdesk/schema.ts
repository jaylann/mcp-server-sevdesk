/**
 * Lenient zod building blocks for parsing sevDesk responses. sevDesk returns most scalars as
 * strings (ids, sums, status codes, booleans as "0"/"1") and sometimes as real numbers, so every
 * incoming field goes through one of these. Outgoing payloads use strict schemas instead.
 *
 * zod 4: a field schema that ends in `.transform()` makes its object key required unless
 * `.optional()` (or `.nullish()`) comes before the transform. Every optional helper below is built
 * that way, so a record without the key still parses.
 */
import { z } from "zod";

import { toBerlinDate } from "./dates.js";
import { SevdeskError } from "./errors.js";

/** Positive integer id, sent by sevDesk as "123" or 123. */
export const zId = z
  .union([z.string().regex(/^\d+$/), z.number().int()])
  .transform(Number)
  .pipe(z.number().int().positive());

/** Integer such as a status code ("100", 100). */
export const zIntish = z
  .union([z.string().regex(/^-?\d+$/), z.number().int()])
  .transform(Number)
  .pipe(z.number().int());

/** Plain decimal notation; `Number()` alone would also accept " ", "0x1A" and "Infinity". */
const DECIMAL_TEXT = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Decimal number as string or number; `null`/"" become `undefined`. Not for money arithmetic. */
export const zNumberish = z.union([z.string(), z.number(), z.null()]).transform((value, ctx) => {
  if (value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : DECIMAL_TEXT.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    // The offending value is untrusted sevDesk data, so it stays out of the message.
    ctx.issues.push({ code: "custom", message: "expected a decimal number", input: value });
    return z.NEVER;
  }
  return parsed;
});

/**
 * Decimal kept as a string exactly as sevDesk sent it (for the money module, which parses it
 * without float rounding). `null`/"" become `undefined`.
 */
export const zDecimalString = z
  .union([z.string().regex(DECIMAL_TEXT), z.number(), z.null(), z.literal("")])
  .transform((value) => (value === null || value === "" ? undefined : String(value)));

/** {@link zDecimalString} for a key sevDesk may also leave out. */
export const zOptionalDecimal = zDecimalString.optional();

/** Boolean sent as "0"/"1", 0/1, true/false; `null` becomes `undefined`. */
export const zBool01 = z
  .union([z.enum(["0", "1", "true", "false"]), z.literal(0), z.literal(1), z.boolean(), z.null()])
  .transform((value) => {
    if (value === null) return undefined;
    return value === true || value === 1 || value === "1" || value === "true";
  });

/** Optional text: `null` and "" become `undefined`. */
export const zOptionalString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => (value === null || value === "" ? undefined : value));

/**
 * Optional free text that sevDesk may send as string, number or `null`: numbers become strings,
 * `null` and "" become `undefined`. Not trimmed or sanitized; DTO mappers do that.
 */
export const zText = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) =>
    value === null || value === undefined || value === "" ? undefined : String(value),
  );

/** Optional integer (see {@link zIntish}): missing, `null` and "" become `undefined`. */
export const zOptionalInt = z
  .union([zIntish, z.null(), z.literal("")])
  .optional()
  .transform((value) => (value === null || value === "" ? undefined : value));

/**
 * Optional integer (see {@link zIntish}) where only missing and `null` mean unset: unlike
 * {@link zOptionalInt}, "" fails the record. Used where the original schemas never accepted ""
 * (vouchers, bank accounts and transactions, parts).
 */
export const zNullableInt = zIntish.nullish().transform((value) => value ?? undefined);

/**
 * A sevDesk date (ISO date-time, Unix seconds, `dd.mm.yyyy`) as its Europe/Berlin calendar day
 * `YYYY-MM-DD` (see `toBerlinDate`). Missing, `null` and "" become `undefined`; an unreadable
 * value fails the record, so {@link parseUpstream} reports it as `unexpected_response`.
 */
export const zBerlinDate = z
  .unknown()
  .optional()
  .transform((value, ctx) => {
    try {
      return toBerlinDate(value);
    } catch {
      ctx.issues.push({ code: "custom", message: "expected a date", input: value });
      return z.NEVER;
    }
  });

/** A sevDesk object reference `{ id, objectName }`. */
export function zRef<N extends string>(objectName?: N) {
  return z.object({
    id: zId,
    objectName: objectName === undefined ? z.string() : z.literal(objectName),
  });
}

/** Optional `{ id, objectName }` reference; sevDesk sends `null` or leaves unset references out. */
export const zOptionalRef = zRef()
  .nullish()
  .transform((value) => value ?? undefined);

/**
 * Parses one upstream record with a lenient schema. A record that does not fit means the API
 * changed or the payload is broken, which must surface, never be skipped silently: throws an
 * `unexpected_response` error. `what` is trusted text naming the record ("a contact"); the
 * offending data stays out of the message because it is untrusted.
 */
export function parseUpstream<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  throw new SevdeskError({
    kind: "unexpected_response",
    message: `sevDesk returned ${what} in an unexpected format.`,
  });
}
