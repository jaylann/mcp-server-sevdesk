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
 * - The DATEV export-job endpoints (`Export/createDatevCsvZipExportJob`,
 *   `Export/createDatevXmlZipExportJob`) start a job in sevDesk, and the job may mark the exported
 *   documents as exported (the XML job's `includeExportedDocuments` filter implies such a mark).
 *   They are never retried (a retry would start a second job) and need the `write` tier.
 * - The next-number endpoints (`…/getNextOrderNumber`, `…/getNextCreditNoteNumber`,
 *   `…/getNextInvoiceNumber`, any `getNext…Number`) reserve the number unless `useNextNumber` is
 *   clearly off: sevDesk returns it and advances the counter (recorded on the trial account,
 *   2026-11-07: true → AN-1000, then false → AN-1001). Only `useNextNumber=false` was recorded to
 *   peek; what sevDesk does without the flag is unrecorded, so an absent flag counts as
 *   reserving. Exception: the documented `getNextCustomerNumber`, which takes no such flag and
 *   reserves nothing (spec).
 *
 * Endpoint names and flag names are matched case-insensitively. `declaredSideEffect` (the
 * request's `sideEffect` flag) always wins and leaves the query untouched.
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
  if (EXPORT_JOB_ENDPOINTS.has(endpoint)) return { sideEffect: true, effect: STARTS_EXPORT, query };
  if (reservesNumber(endpoint, query)) return { sideEffect: true, effect: RESERVES_NUMBER, query };

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
 *
 * Besides the table, a change to one bank transaction itself (`PUT`/`DELETE
 * /CheckAccountTransaction/{id}`: marking it private, setting its status back) and a
 * `Voucher/Factory/saveVoucher` whose body is not a draft (status ≠ 50: the voucher's finalize)
 * need `commit` (see {@link minimumWriteTier}): they change what is booked.
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
 * flag, otherwise `write` (this includes a next-number GET that reserves the number: a draft tool
 * reserves the number it saves the draft with). The client refuses a request whose declared tier
 * does not cover it (`tierCovers`), so a `write` tool can never finalize, book, cancel or send.
 */
export function minimumWriteTier(
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
  body?: unknown,
): WriteTier {
  const endpoint = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const listed = ENDPOINT_TIERS[endpoint];
  if (listed !== undefined) return listed;
  if (endpoint === "getpdf" || enshrineFlagSet(query)) return "commit";
  if (TRANSACTION_RECORD.test(path)) return "commit";
  if (endpoint === "savevoucher" && savesOpenVoucher(body)) return "commit";
  return "write";
}

/**
 * Whether a `saveVoucher` body moves the voucher out of draft: `voucher.status` other than the
 * draft status 50 (100 = open, booked into the books; sevDesk's spec says higher statuses are set
 * through `saveVoucher`). That is the voucher's "finalize", so it needs `commit` like `sendBy`;
 * a missing or unreadable status counts as not a draft, erring towards the stricter tier.
 */
function savesOpenVoucher(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return true;
  const voucher = (body as { voucher?: unknown }).voucher;
  if (typeof voucher !== "object" || voucher === null) return true;
  const status = (voucher as { status?: unknown }).status;
  return !(status === VOUCHER_DRAFT_STATUS || status === String(VOUCHER_DRAFT_STATUS));
}

/** sevDesk's voucher draft status (spec: saveVoucher accepts 50 and 100). */
const VOUCHER_DRAFT_STATUS = 50;

/** `/CheckAccountTransaction/{id}` exactly (case-insensitive), not its sub-resources. */
const TRANSACTION_RECORD = /^\/checkaccounttransaction\/[^/]+$/i;

function enshrineFlagSet(query: Readonly<Record<string, QueryValue>> | undefined): boolean {
  return Object.entries(query ?? {}).some(
    ([key, value]) => ENSHRINE_KEYS.has(key.toLowerCase()) && !isFalseFlag(value),
  );
}

/**
 * Whether a GET to a next-number endpoint reserves the number: unless its `useNextNumber` flag
 * (any key spelling) is clearly off. An absent flag and odd values err towards the write gate;
 * `getNextCustomerNumber` (documented, no flag) never reserves.
 */
function reservesNumber(
  endpoint: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): boolean {
  if (!NEXT_NUMBER_ENDPOINT.test(endpoint) || endpoint === NEXT_CUSTOMER_NUMBER) return false;
  const flags = Object.entries(query ?? {}).filter(
    ([key, value]) => key.toLowerCase() === "usenextnumber" && value !== undefined,
  );
  return flags.length === 0 || flags.some(([, value]) => !isFalseFlag(value));
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
const RESERVES_NUMBER = "it reserves the next document number";
const STARTS_EXPORT = "it starts an export job in sevDesk";
/** DATEV export-job endpoints, lower case. */
const EXPORT_JOB_ENDPOINTS: ReadonlySet<string> = new Set([
  "createdatevcsvzipexportjob",
  "createdatevxmlzipexportjob",
]);
/** `getNextOrderNumber`, `getNextCreditNoteNumber`, `getNextInvoiceNumber`, … (lower case). */
const NEXT_NUMBER_ENDPOINT = /^getnext[a-z]+number$/;
/** `Contact/Factory/getNextCustomerNumber`: documented, reads the next customer number only. */
const NEXT_CUSTOMER_NUMBER = "getnextcustomernumber";

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
