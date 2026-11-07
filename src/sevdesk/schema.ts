/**
 * Lenient zod building blocks for parsing sevDesk responses. sevDesk returns most scalars as
 * strings (ids, sums, status codes, booleans as "0"/"1") and sometimes as real numbers, so every
 * incoming field goes through one of these. Outgoing payloads use strict schemas instead.
 */
import { z } from "zod";

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

/** A sevDesk object reference `{ id, objectName }`. */
export function zRef<N extends string>(objectName?: N) {
  return z.object({
    id: zId,
    objectName: objectName === undefined ? z.string() : z.literal(objectName),
  });
}

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
