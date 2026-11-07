/**
 * sevDesk wraps every JSON response in `{"objects": …}`, including POST/PUT results and PDF
 * renders (contrary to its OpenAPI spec), and returns GET-by-id results as an array of one. These
 * helpers turn that envelope into plain payloads and fail with a typed error when the shape is off.
 */
import { SevdeskError } from "./errors.js";

/** A parsed sevDesk JSON envelope. `total` is only present with `countAll=true`. */
export interface Envelope {
  readonly objects: unknown;
  readonly total: unknown;
}

/** Narrows a parsed JSON body to the envelope, or returns `undefined` if `objects` is missing. */
export function readEnvelope(body: unknown): Envelope | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (!Object.hasOwn(body, "objects")) return undefined;
  const record = body as Record<string, unknown>;
  return { objects: record["objects"], total: record["total"] };
}

/**
 * Parses sevDesk's `total`: a JSON number in every recorded response (2026-11-07, e.g. `39`;
 * spec/deviations.md D-002 expected a string), and a digit string such as `"123"` in older
 * community recordings, so both are accepted. Returns `undefined` when it is absent or not a
 * non-negative integer.
 */
export function parseTotal(total: unknown): number | undefined {
  let value: number | undefined;
  if (typeof total === "number") value = total;
  else if (typeof total === "string" && /^\d+$/.test(total)) value = Number(total);
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Returns `payload` as an array (a list response). Anything else is an `unexpected_response`
 * error; `what` names the collection in the trusted error message, e.g. `"invoices"`.
 */
export function expectArray(payload: unknown, what = "objects"): unknown[] {
  if (Array.isArray(payload)) return payload as unknown[];
  throw new SevdeskError({
    kind: "unexpected_response",
    message: `sevDesk returned an unexpected format: expected a list of ${what}.`,
  });
}

/**
 * Returns the single object of a GET-by-id or write response. An array of one yields its element,
 * an empty array (or `null`) is a `not_found` error, and a plain object passes through. Arrays
 * with more than one element and scalars are `unexpected_response` errors. `what` is trusted text
 * naming the object, e.g. `"invoice 123"`.
 */
export function expectSingle(payload: unknown, what: string): unknown {
  if (Array.isArray(payload)) {
    const items = payload as unknown[];
    if (items.length === 1) return items[0];
    if (items.length === 0) {
      throw new SevdeskError({ kind: "not_found", message: `sevDesk found no ${what}.` });
    }
    throw new SevdeskError({
      kind: "unexpected_response",
      message: `sevDesk returned ${items.length} objects where one ${what} was expected.`,
    });
  }
  if (payload === null || payload === undefined) {
    throw new SevdeskError({ kind: "not_found", message: `sevDesk found no ${what}.` });
  }
  if (typeof payload === "object") return payload;
  throw new SevdeskError({
    kind: "unexpected_response",
    message: `sevDesk returned an unexpected format: expected one ${what}.`,
  });
}
