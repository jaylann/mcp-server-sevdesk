/**
 * Path safety for sevDesk requests. Every request path is checked before anything is sent, so a
 * malformed id (negative, fractional, `NaN`, `"12abc"`, beyond 2^53) or a traversal attempt
 * (`..`, `//`, `?`, `#`) can never reach a different endpoint than the one a tool meant to call.
 * {@link resolveGetSafety} recognizes the GET endpoints that change state.
 */
import type { WriteTier } from "../safety/tiers.js";
import { SevdeskError } from "./errors.js";
import type { QueryValue } from "./types.js";

/** One path segment of a sevDesk endpoint name, e.g. `Invoice`, `Factory`, `getPdf`. */
const NAME_SEGMENT = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Canonical positive integer: no sign, no leading zero, no exponent. */
const ID_SEGMENT = /^[1-9]\d*$/;
/** What a stringified non-value looks like when it slips into a template literal. */
const POISON_SEGMENTS: ReadonlySet<string> = new Set([
  "NaN",
  "Infinity",
  "undefined",
  "null",
  "true",
  "false",
]);

/** Whether `value` is a valid sevDesk object id: a positive safe integer. */
export function isSevdeskId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validates and normalizes a sevDesk object id given as a number or a digit string.
 * Throws a local `validation` {@link SevdeskError} for anything else.
 */
export function toSevdeskId(value: number | string): number {
  if (typeof value === "number") {
    if (isSevdeskId(value)) return value;
  } else if (ID_SEGMENT.test(value)) {
    const parsed = Number(value);
    if (isSevdeskId(parsed)) return parsed;
  }
  throw invalidPath("An id must be a positive whole number (sevDesk object ids are 1 or higher).");
}

/**
 * Builds a request path from segments: strings are endpoint names (`Invoice`, `getPdf`) and
 * numbers are object ids. A string made of digits is accepted as an id after validation.
 *
 * @example sevdeskPath("Invoice", 123, "getPdf") // "/Invoice/123/getPdf"
 */
export function sevdeskPath(...segments: readonly (string | number)[]): string {
  if (segments.length === 0) throw invalidPath("A sevDesk path needs at least one segment.");
  const parts = segments.map((segment) => {
    if (typeof segment === "number" || /^\d/.test(segment)) return String(toSevdeskId(segment));
    if (!NAME_SEGMENT.test(segment) || POISON_SEGMENTS.has(segment)) {
      throw invalidPath(
        "A sevDesk path segment must be an endpoint name (letters, digits, underscore).",
      );
    }
    return segment;
  });
  return `/${parts.join("/")}`;
}

/**
 * Asserts that a request path is safe to append to the base URL: starts with `/`, consists of
 * `[A-Za-z0-9_]` segments only (no `..`, `//`, `?`, `#`, whitespace or non-ASCII), and every
 * segment that starts with a digit is a valid id. Query parameters belong in `query`.
 */
export function assertSafePath(path: string): void {
  if (!path.startsWith("/")) throw invalidPath("A sevDesk path must start with '/'.");
  const segments = path.slice(1).split("/");
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_]+$/.test(segment)) {
      throw invalidPath(
        "A sevDesk path may only contain '/'-separated segments of letters, digits and " +
          "underscores; pass query parameters separately.",
      );
    }
    if (/^\d/.test(segment)) {
      toSevdeskId(segment);
    } else if (POISON_SEGMENTS.has(segment)) {
      throw invalidPath("A sevDesk path contains a placeholder value instead of an id.");
    }
  }
}

/** How the client must treat a GET: as a read, or as a request that changes data. */
export type GetSafety =
  | {
      readonly sideEffect: false;
      /** The query to send; for `getPdf` it carries `preventSendBy=true`. */
      readonly query: Readonly<Record<string, QueryValue>> | undefined;
    }
  | {
      readonly sideEffect: true;
      /** Trusted text naming the side effect, for the `blocked` message. */
      readonly effect: string;
      readonly query: Readonly<Record<string, QueryValue>> | undefined;
    };

/**
 * Recognizes sevDesk's state-changing GET endpoints (see spec/deviations.md D-023), so that a
 * missing `sideEffect` flag cannot turn a "read" into a write:
 * - `…/getPdf` (Invoice, Order, CreditNote) marks the document as sent unless `preventSendBy` is
 *   set. Without a declared side effect the client sends the literal `preventSendBy=true` (also
 *   when the caller passed true, 1, "1" or "true"); any other `preventSendBy` value (false, 0, …)
 *   makes the request a side effect.
 * - `…/sendByWithRender` always marks the document as sent.
 * - An `enshrine` or `enshrineDocuments` query flag (DATEV exports) enshrines every exported
 *   document, which is irreversible.
 *
 * Endpoint names are matched case-insensitively. `declaredSideEffect` (the request's
 * `sideEffect` flag) always wins and leaves the query untouched.
 */
export function resolveGetSafety(
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
  declaredSideEffect: boolean,
): GetSafety {
  const endpoint = path.slice(path.lastIndexOf("/") + 1).toLowerCase();

  if (endpoint === "getpdf") {
    if (declaredSideEffect) return { sideEffect: true, effect: MARKS_SENT, query };
    const preventSendBy = query?.["preventSendBy"];
    // Missing or "on" in any spelling: a read that always goes out as the verified literal.
    if (preventSendBy === undefined || isTrueFlag(preventSendBy)) {
      return { sideEffect: false, query: { ...query, preventSendBy: PREVENT_SEND_BY } };
    }
    return { sideEffect: true, effect: MARKS_SENT, query };
  }
  if (endpoint === "sendbywithrender") return { sideEffect: true, effect: MARKS_SENT, query };

  if (enshrineFlagSet(query)) return { sideEffect: true, effect: ENSHRINES, query };

  return declaredSideEffect
    ? { sideEffect: true, effect: "it is marked as changing data in sevDesk", query }
    : { sideEffect: false, query };
}

/**
 * The minimum tier per endpoint name (the last path segment, matched case-insensitively) for
 * requests that change data. Everything not listed needs `write`.
 *
 * - `commit`: steps that make a document legally binding or are hard to undo: `sendBy` (mark as
 *   sent, finalizes a draft), `bookAmount` (book a payment), `enshrine` (festschreiben, GoBD,
 *   irreversible), `cancelInvoice` (Storno), `resetToDraft` / `resetToOpen`, `changeParameter`
 *   (changes a finalized document's parameters);
 * - `external`: steps that reach third parties: `sendViaEmail`, `sendByWithRender` (renders and
 *   marks as sent, used for letters).
 */
const ENDPOINT_TIERS: Readonly<Record<string, WriteTier>> = {
  sendby: "commit",
  bookamount: "commit",
  enshrine: "commit",
  cancelinvoice: "commit",
  resettodraft: "commit",
  resettoopen: "commit",
  changeparameter: "commit",
  sendviaemail: "external",
  sendbywithrender: "external",
};

/**
 * The lowest tier that may make a request that changes data (the caller decides that it does,
 * see `resolveGetSafety`): the endpoint's entry in the tier table, `commit` for a `getPdf` that
 * marks the document as sent (same effect as `sendBy`) and for DATEV exports with an `enshrine`
 * flag, otherwise `write`. The client refuses a request whose declared tier does not cover it
 * (`tierCovers`), so a `write` tool can never finalize, book, cancel or send.
 */
export function minimumWriteTier(
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): WriteTier {
  const endpoint = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const listed = ENDPOINT_TIERS[endpoint];
  if (listed !== undefined) return listed;
  if (endpoint === "getpdf" || enshrineFlagSet(query)) return "commit";
  return "write";
}

function enshrineFlagSet(query: Readonly<Record<string, QueryValue>> | undefined): boolean {
  return Object.entries(query ?? {}).some(
    ([key, value]) => ENSHRINE_KEYS.has(key.toLowerCase()) && !isFalseFlag(value),
  );
}

/**
 * The `preventSendBy` value every getPdf read is sent with: the literal string `true`, the form
 * both community measurements verified (jernoxit/sevdesk-rs, firsttris/haben; spec/deviations.md
 * D-023). Whether sevDesk honors `1` is unconfirmed, and if it did not, a preview would finalize
 * (and could enshrine) a draft, so the client never sends booleans as `1` here.
 */
const PREVENT_SEND_BY = "true";

const MARKS_SENT = "it marks the document as sent";
const ENSHRINES = "it enshrines (irreversibly locks) the exported documents";
const ENSHRINE_KEYS: ReadonlySet<string> = new Set(["enshrine", "enshrinedocuments"]);

function isTrueFlag(value: QueryValue): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Anything not clearly "off" counts as on, so an odd value errs towards the write gate. */
function isFalseFlag(value: QueryValue): boolean {
  return (
    value === undefined || value === false || value === 0 || value === "0" || value === "false"
  );
}

function invalidPath(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message: `Invalid request: ${message}` });
}
