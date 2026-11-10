/**
 * Path safety for sevDesk requests. Every request path is checked before anything is sent, so a
 * malformed id (negative, fractional, `NaN`, `"12abc"`, beyond 2^53) or a traversal attempt
 * (`..`, `//`, `?`, `#`) can never reach a different endpoint than the one a tool meant to call.
 * {@link resolveGetSafety} recognizes the GET endpoints that change state, and
 * {@link genericGetRefusal} is the stricter list for GETs whose path the model chooses
 * (`sevdesk_api_get`).
 */
import { tierCovers, type WriteTier } from "../safety/tiers.js";
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
 * request's `sideEffect` flag) always wins and leaves the query untouched. One of these endpoint
 * names before the last segment (`/Invoice/1/getPdf/2`) counts as that endpoint's side effect:
 * no tool builds such a path, and how sevDesk routes trailing segments is unknown, so a path the
 * model chose (`sevdesk_api_get`) cannot reach the endpoint by appending one.
 */
export function resolveGetSafety(
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
  declaredSideEffect: boolean,
): GetSafety {
  const endpoint = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const inner = innerSideEffect(path);
  if (inner !== undefined) return { sideEffect: true, effect: inner, query };

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

/** Lower-case name segments of `path` before its last one (ids included, they match nothing). */
function innerSegments(path: string): string[] {
  return path.slice(1).toLowerCase().split("/").slice(0, -1);
}

/**
 * The effect of a state-changing GET endpoint named before the last path segment, or
 * `undefined` (see {@link resolveGetSafety}).
 */
function innerSideEffect(path: string): string | undefined {
  for (const name of innerSegments(path)) {
    if (name === "getpdf" || name === "sendbywithrender") return MARKS_SENT;
    if (EXPORT_JOB_ENDPOINTS.has(name)) return STARTS_EXPORT;
    if (NEXT_NUMBER_ENDPOINT.test(name) && name !== NEXT_CUSTOMER_NUMBER) return RESERVES_NUMBER;
  }
  return undefined;
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
 * The {@link ENDPOINT_TIERS} entry of a lower-case endpoint name. Own keys only, so `constructor`
 * or `__proto__` (valid path segments) never read `Object.prototype`.
 */
function listedTier(name: string): WriteTier | undefined {
  return Object.hasOwn(ENDPOINT_TIERS, name) ? ENDPOINT_TIERS[name] : undefined;
}

/**
 * The lowest tier that may make a request that changes data (the caller decides that it does,
 * see `resolveGetSafety`): the endpoint's entry in the tier table, `commit` for a `getPdf` that
 * marks the document as sent (same effect as `sendBy`) and for DATEV exports with an `enshrine`
 * flag, otherwise `write` (this includes a next-number GET that reserves the number: a draft tool
 * reserves the number it saves the draft with). The client refuses a request whose declared tier
 * does not cover it (`tierCovers`), so a `write` tool can never finalize, book, cancel or send.
 * A listed endpoint or `getPdf` before the last path segment (`/Invoice/1/sendBy/2`, see
 * {@link resolveGetSafety}) raises the minimum to its tier as well.
 */
export function minimumWriteTier(
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
  body?: unknown,
): WriteTier {
  const own = endpointTier(path, query, body);
  return innerSegments(path).reduce<WriteTier>((highest, name) => {
    const inner = name === "getpdf" ? "commit" : listedTier(name);
    return inner !== undefined && !tierCovers(highest, inner) ? inner : highest;
  }, own);
}

/** {@link minimumWriteTier} by the last path segment, the query and the body. */
function endpointTier(
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
  body: unknown,
): WriteTier {
  const endpoint = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const listed = listedTier(endpoint);
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

/**
 * Why a GET whose path and query the model chose (`sevdesk_api_get`) is refused, as one trusted
 * sentence that names the tool to use instead, or `undefined` when it may be sent. Stricter than
 * {@link resolveGetSafety}, which still guards the request afterwards (`readOnlyClient`): it
 * refuses everything that changes data, hands out files or download state, or needs a curated
 * tool's care, in any spelling (names and keys compared case-insensitively):
 *
 * - endpoints under `Export`, `ExportJob`, `Progress` (`generateDownloadHash` creates download
 *   state), `Report` (PDF files as base64), `DocServer` (base64 thumbnails) and `SevSequence`
 *   (number sequences);
 * - a segment `getPdf`, `getXml`, `render`, `sendByWithRender`, an action of the tier table
 *   (`sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`, `resetToDraft`, `resetToOpen`,
 *   `changeParameter`, `sendViaEmail`), a DATEV export job, or a next-number endpoint
 *   (`getNext…Number`, also when it would only peek), anywhere in the path;
 * - a segment after the first that starts with a verb that changes data (`save…`, `create…`,
 *   `book…`, `send…`, `delete…`, …; `bookkeepingSystemVersion` is not one: the verb must end at
 *   a word boundary of the camelCase name);
 * - anything {@link resolveGetSafety} classifies as a side effect;
 * - query keys for credentials (`token`, `api_key`, `authorization`, …: sevDesk accepts a token
 *   in the query, which would put it into URLs and could switch the account), paging (`limit`,
 *   `offset`, `countAll`: separate arguments), `download`, `preventSendBy`, `enshrine…`,
 *   `useNextNumber`, and HTTP method overrides. Keys are compared the way PHP reads them: lower
 *   case, `.` and space as `_`, and the name before a `[` (so `Api.Key` and `token[0]` count as
 *   well);
 * - query keys whose brackets do not pair up (`api[key`): PHP turns an unclosed `[` into `_`
 *   (`api_key`), so such a key could reach a name the list above refuses.
 */
export function genericGetRefusal(
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string | undefined {
  const names = path.slice(1).toLowerCase().split("/");
  const root = names[0] ?? "";
  if (Object.hasOwn(REFUSED_ROOTS, root)) return REFUSED_ROOTS[root];

  const segments = path.slice(1).split("/");
  for (const [index, name] of names.entries()) {
    const refusal = segmentRefusal(name);
    if (refusal !== undefined) return refusal;
    if (index > 0 && startsWithMutatingVerb(segments[index] ?? "")) return MUTATING_NAME;
  }

  const safety = resolveGetSafety(path, query, false);
  if (safety.sideEffect) {
    return `This GET changes data in sevDesk (${safety.effect}); sevdesk_api_get only reads.`;
  }

  for (const key of Object.keys(query ?? {})) {
    if (!PAIRED_BRACKETS.test(key)) return UNPAIRED_BRACKETS;
    const refusal = queryKeyRefusal(phpQueryName(key));
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/** Endpoint families refused by their first path segment (lower case), with the alternative. */
const REFUSED_ROOTS: Readonly<Record<string, string>> = {
  export:
    "Export endpoints return files or start export jobs, not JSON records: use " +
    "sevdesk_csv_export for CSV exports or sevdesk_datev_export for the DATEV export.",
  exportjob:
    "Export jobs and their download links belong to sevdesk_datev_export; sevdesk_api_get " +
    "does not read them.",
  progress:
    "Progress endpoints track export jobs and create download state " +
    "(Progress/generateDownloadHash): use sevdesk_datev_export.",
  report:
    "Report endpoints render PDF files (as base64), not records: use the list tools (for " +
    "example sevdesk_invoices_list) or sevdesk_csv_export.",
  docserver:
    "DocServer endpoints return base64 template and letterhead images, which sevdesk_api_get " +
    "does not return.",
  sevsequence:
    "Number sequences (SevSequence) are not read through sevdesk_api_get: like the " +
    "next-number endpoints, reading them may reserve a number. sevDesk assigns document " +
    "numbers when a document is finalized.",
};

const FILE_ENDPOINTS: ReadonlySet<string> = new Set([
  "getpdf",
  "getxml",
  "render",
  "sendbywithrender",
]);
/** `getNextOrderNumber`, `getNextNumber`, `nextInvoiceNumber`, … (lower case, anywhere). */
const NEXT_NUMBER_LIKE = /next\w*number/;

const FILE_ENDPOINT_REFUSAL =
  "Document files are read with sevdesk_invoice_pdf, sevdesk_credit_note_pdf, " +
  "sevdesk_order_pdf or sevdesk_invoice_xml, which keep sevDesk from marking the document as " +
  "sent (getPdf without preventSendBy finalizes a draft; sendByWithRender always marks it as " +
  "sent).";
const ACTION_REFUSAL =
  "This endpoint is an action that changes data in sevDesk (marking as sent, booking a " +
  "payment, enshrining, cancelling, resetting or e-mailing), not a read: use the matching " +
  "tool, which asks for confirmation where needed.";
const NEXT_NUMBER_REFUSAL =
  "Next-number endpoints can reserve the number they return, so sevdesk_api_get never calls " +
  "them: use sevdesk_contacts_next_customer_number for the next customer number; sevDesk " +
  "assigns document numbers when a document is finalized.";
const MUTATING_NAME =
  "The endpoint name starts with a verb that changes data (save, create, update, delete, book, " +
  "send, …); sevdesk_api_get only reads.";

function segmentRefusal(name: string): string | undefined {
  if (FILE_ENDPOINTS.has(name)) return FILE_ENDPOINT_REFUSAL;
  if (listedTier(name) !== undefined) return ACTION_REFUSAL;
  if (EXPORT_JOB_ENDPOINTS.has(name)) return REFUSED_ROOTS["export"];
  if (NEXT_NUMBER_LIKE.test(name)) return NEXT_NUMBER_REFUSAL;
  return undefined;
}

/**
 * Verbs whose endpoints change data. A segment matches when it starts with one (any case) and
 * the verb ends the name or is followed by an upper-case letter, digit or `_` (`setStatus`,
 * `book_2`), so nouns that merely start with the letters (`settings`, `addresses`,
 * `bookkeepingSystemVersion`) pass.
 */
const MUTATING_VERBS: readonly string[] = [
  "activate",
  "add",
  "apply",
  "approve",
  "archive",
  "assign",
  "book",
  "cancel",
  "change",
  "clear",
  "close",
  "convert",
  "copy",
  "create",
  "deactivate",
  "delete",
  "duplicate",
  "enshrine",
  "execute",
  "generate",
  "import",
  "link",
  "lock",
  "mark",
  "merge",
  "move",
  "post",
  "put",
  "remove",
  "render",
  "reopen",
  "reserve",
  "reset",
  "restore",
  "run",
  "save",
  "send",
  "set",
  "start",
  "transfer",
  "trigger",
  "unlink",
  "unlock",
  "update",
  "upload",
  "write",
];

function startsWithMutatingVerb(segment: string): boolean {
  const lower = segment.toLowerCase();
  return MUTATING_VERBS.some(
    (verb) => lower.startsWith(verb) && !/^[a-z]/.test(segment.slice(verb.length)),
  );
}

/**
 * How PHP (sevDesk's backend) names a query key with paired brackets: lower-cased here for
 * comparison, `.` and space read as `_`, and an array key `name[…]` as `name`.
 */
function phpQueryName(key: string): string {
  const bracket = key.indexOf("[");
  return (bracket < 0 ? key : key.slice(0, bracket)).toLowerCase().replace(/[. ]/g, "_");
}

/** A name, then any number of `[…]` groups without brackets inside: `contact[id]`, `a[0][b]`. */
const PAIRED_BRACKETS = /^[^[\]]+(?:\[[^[\]]*\])*$/;
const UNPAIRED_BRACKETS =
  "A query key's brackets must pair up, as in contact[id] or orderBy[0][field]; sevDesk would " +
  "read a key like api[key as another name.";

const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "token",
  "api_key",
  "apikey",
  "api_token",
  "apitoken",
  "access_token",
  "accesstoken",
  "auth",
  "auth_token",
  "authtoken",
  "authorization",
]);
const PAGING_KEYS: ReadonlySet<string> = new Set(["limit", "offset", "countall"]);
const METHOD_KEYS: ReadonlySet<string> = new Set([
  "method",
  "_method",
  "httpmethod",
  "http_method",
  "x_http_method",
  "x_http_method_override",
]);

function queryKeyRefusal(name: string): string | undefined {
  if (CREDENTIAL_KEYS.has(name)) {
    return (
      "Credentials never go into the query: sevDesk would accept a token there (and switch " +
      "accounts with it). The server sends its configured token in the Authorization header."
    );
  }
  if (PAGING_KEYS.has(name)) {
    return (
      "Paging uses the limit and offset arguments (countAll is always sent), not query " +
      "parameters."
    );
  }
  if (name === "download") {
    return (
      "download switches sevDesk to a raw file answer; sevdesk_api_get reads JSON only. Use the " +
      "file tools (sevdesk_invoice_pdf, sevdesk_invoice_xml, …) for files."
    );
  }
  if (name === "preventsendby") {
    return "preventSendBy belongs to getPdf, which sevdesk_api_get does not call: use the PDF tools.";
  }
  if (name.startsWith("enshrine")) {
    return "enshrine flags lock documents irreversibly (festschreiben); sevdesk_api_get only reads.";
  }
  if (name === "usenextnumber") {
    return "useNextNumber belongs to the next-number endpoints, which sevdesk_api_get does not call.";
  }
  if (METHOD_KEYS.has(name)) {
    return "Parameters that could override the HTTP method are refused; sevdesk_api_get only sends GET.";
  }
  return undefined;
}

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
