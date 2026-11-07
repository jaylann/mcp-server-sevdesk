/**
 * What `pnpm fixtures:record` records: one read endpoint per fixture we have (`mirrors`) or need
 * for the write tools, in dependency order (lists first; they supply the ids of the by-id reads).
 *
 * Every committed fixture of a read (its provenance `ref` names a GET) has its endpoint recorded
 * here, is mirrored explicitly, or is listed in {@link NOT_RECORDED} with a reason;
 * `test/unit/scripts/record-fixtures.test.ts` enforces that, so a fixture of a new endpoint cannot
 * be forgotten. Responses of writes (POST/PUT) cannot be recorded read-only: `pnpm probe
 * --allow-writes` captures their shapes as scrubbed evidence.
 *
 * Only GETs, and no endpoint with side effects: PDFs are fetched with `preventSendBy=true` (the
 * client forces it anyway) and only for documents that are no longer drafts, until the probe has
 * confirmed that a preview leaves a 2.0 draft untouched.
 */
import type { QueryValue } from "../../src/sevdesk/types.js";
import type { ScrubMode } from "./scrub.js";

/** Ids learned from list responses and used by later by-id reads. */
export type IdSlot =
  | "contact"
  | "personContact"
  | "invoice"
  | "invoiceFinal"
  | "creditNote"
  | "creditNoteFinal"
  | "order"
  | "orderFinal"
  | "voucher"
  | "checkAccount"
  | "part";

export type Ids = Partial<Record<IdSlot, number>>;

export interface RecordEntry {
  /** Output path below the session folder, e.g. `invoices/invoice-by-id.json`. */
  readonly file: string;
  /** Committed fixtures (below `test/fixtures/`) this recording replaces or cross-checks. */
  readonly mirrors: readonly string[];
  /** Path template; `{invoice}` etc. are replaced with ids from earlier entries. */
  readonly path: string;
  /** Query; string values may contain the same placeholders. */
  readonly query?: Readonly<Record<string, Exclude<QueryValue, undefined>>>;
  /** A collection: `limit`, `offset=0` and `countAll=true` are added (a recorded single page). */
  readonly list?: boolean;
  /** Rows of this list instead of `--limit` (system lists are recorded whole). */
  readonly limit?: number;
  /** `reference` for system lists that may stay verbatim. Default `full`. */
  readonly mode?: ScrubMode;
  /** Ids this entry needs; it is skipped (with the reason) when one is missing. */
  readonly requires?: readonly IdSlot[];
  /** Ids this entry's response provides. */
  readonly collect?: (objects: unknown) => Ids;
  /** Short, trusted remark stored in `_provenance.note`. */
  readonly note?: string;
}

/** Committed fixtures that are deliberately not recorded, with the reason. */
export const NOT_RECORDED: Readonly<Record<string, string>> = {
  "contacts/contact-empty.json":
    "Synthetic: an empty GET-by-id answer. The probe records what sevDesk really returns for an unknown id.",
  "contacts/contacts-page.json":
    "Covered by contacts/contacts-list.json, which is recorded as a single page with total.",
  "meta/bookkeeping-system-version-1.json":
    "Needs an Update 1.0 account; a new trial account is on 2.0.",
};

type Row = Readonly<Record<string, unknown>>;

/** The rows of a list response's `objects` (an array, or a single object as an array of one). */
export function rowsOf(objects: unknown): Row[] {
  const items = Array.isArray(objects) ? objects : [objects];
  return items.filter((item): item is Row => typeof item === "object" && item !== null);
}

/** The id of the first row matching `predicate`, as a number; `undefined` when none matches. */
export function firstId(
  objects: unknown,
  predicate: (row: Row) => boolean = () => true,
): number | undefined {
  for (const row of rowsOf(objects)) {
    if (!predicate(row)) continue;
    const id = Number(row["id"]);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return undefined;
}

const isDraft = (row: Row): boolean => String(row["status"]) === "100";
const isPerson = (row: Row): boolean =>
  (typeof row["surename"] === "string" && row["surename"] !== "") ||
  (typeof row["familyname"] === "string" && row["familyname"] !== "");

function ids(entries: Partial<Record<IdSlot, number | undefined>>): Ids {
  return Object.fromEntries(Object.entries(entries).filter(([, id]) => id !== undefined));
}

/**
 * An endpoint without ids, for comparing fixtures with the plan: `/api/v1` and the query are
 * dropped, id segments and placeholders become `{}`, and a trailing id is dropped, so a by-id
 * read counts as its collection (`/Invoice/{invoice}` → `/Invoice`, `/Invoice/{id}/getPdf` →
 * `/Invoice/{}/getPdf`).
 */
export function endpointKey(path: string): string {
  return (path.replace(/^\/api\/v1(?=\/)/, "").split("?")[0] ?? "")
    .split("/")
    .map((segment) => (/^\{.*\}$|^\d+$/.test(segment) ? "{}" : segment))
    .join("/")
    .replace(/\/\{\}$/, "");
}

/** Placeholders in a path or query value, e.g. `{invoice}`. */
const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

/** The entry's path and query with ids filled in, or the first missing slot. */
export function resolveEntry(
  entry: RecordEntry,
  known: Ids,
):
  | {
      readonly ok: true;
      readonly path: string;
      readonly query: Readonly<Record<string, Exclude<QueryValue, undefined>>>;
    }
  | { readonly ok: false; readonly missing: IdSlot } {
  for (const slot of entry.requires ?? []) {
    if (known[slot] === undefined) return { ok: false, missing: slot };
  }
  const fill = (text: string): string =>
    text.replace(PLACEHOLDER, (_match, slot: string) => String(known[slot as IdSlot] ?? ""));
  const query: Record<string, Exclude<QueryValue, undefined>> = {};
  for (const [key, value] of Object.entries(entry.query ?? {})) {
    query[key] = typeof value === "string" ? fill(value) : value;
  }
  return { ok: true, path: fill(entry.path), query };
}

/** Human-readable request line for logs and provenance, e.g. `GET /Invoice/{invoice}?embed=contact`. */
export function describeEntry(entry: RecordEntry): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(entry.query ?? {})) {
    query.append(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  if (entry.list === true) query.append("limit", "<n>");
  const search = query
    .toString()
    .replace(/%5B/g, "[")
    .replace(/%5D/g, "]")
    .replace(/%7B/g, "{")
    .replace(/%7D/g, "}")
    .replace(/%3C|%3E/g, "");
  return `GET ${entry.path}${search === "" ? "" : `?${search}`}`;
}

/** The recording plan, in dependency order. `today` (YYYY-MM-DD) is used for balance reads. */
export function recordPlan(today: string): readonly RecordEntry[] {
  return [
    // --- meta (system reference data stays verbatim) ---------------------------------------
    {
      file: "meta/bookkeeping-system-version.json",
      mirrors: ["meta/bookkeeping-system-version.json"],
      path: "/Tools/bookkeepingSystemVersion",
      mode: "reference",
    },
    {
      file: "meta/tax-rules.json",
      mirrors: ["meta/tax-rules.json"],
      path: "/TaxRule",
      list: true,
      limit: 1000,
      mode: "reference",
    },
    {
      file: "meta/units.json",
      mirrors: ["meta/units.json"],
      path: "/Unity",
      list: true,
      limit: 1000,
      mode: "reference",
    },
    {
      file: "meta/categories.json",
      mirrors: ["meta/categories.json"],
      path: "/Category",
      list: true,
      limit: 1000,
      mode: "reference",
    },
    {
      file: "meta/communication-way-keys.json",
      mirrors: ["meta/communication-way-keys.json"],
      path: "/CommunicationWayKey",
      list: true,
      limit: 1000,
      mode: "reference",
    },
    {
      file: "meta/static-countries.json",
      mirrors: ["meta/static-countries.json"],
      path: "/StaticCountry",
      list: true,
      limit: 1000,
      mode: "reference",
    },
    {
      file: "meta/payment-methods.json",
      mirrors: ["meta/payment-methods.json"],
      path: "/PaymentMethod",
      list: true,
      limit: 1000,
      mode: "reference",
    },
    {
      file: "meta/sev-users.json",
      mirrors: ["meta/sev-users.json"],
      path: "/SevUser",
      list: true,
    },
    {
      file: "meta/account-datev.json",
      mirrors: [],
      path: "/AccountDatev",
      list: true,
      limit: 100,
      mode: "reference",
      note: "Needed for booking accounts (Update 2.0); undocumented endpoint (D-024).",
    },
    {
      file: "meta/receipt-guidance-all.json",
      mirrors: [],
      path: "/ReceiptGuidance/forAllAccounts",
      mode: "reference",
      note: "Needed for ReceiptGuidance validation of tax rule x account x rate.",
    },

    // --- contacts -------------------------------------------------------------------------
    {
      file: "contacts/contacts-list.json",
      mirrors: ["contacts/contacts-list.json", "contacts/contacts-page.json"],
      path: "/Contact",
      query: { depth: 1 },
      list: true,
      collect: (objects) =>
        ids({
          contact: firstId(objects, (row) => !isPerson(row)),
          personContact: firstId(objects, isPerson),
        }),
    },
    {
      file: "contacts/contact-by-id.json",
      mirrors: ["contacts/contact-1001.json"],
      path: "/Contact/{contact}",
      requires: ["contact"],
      note: "An organisation.",
    },
    {
      file: "contacts/person-by-id.json",
      mirrors: ["contacts/contact-1002.json"],
      path: "/Contact/{personContact}",
      requires: ["personContact"],
      note: "A person.",
    },
    {
      file: "contacts/contact-addresses.json",
      mirrors: ["contacts/contact-addresses-1001.json"],
      path: "/ContactAddress",
      query: { "contact[id]": "{contact}", "contact[objectName]": "Contact" },
      list: true,
      requires: ["contact"],
    },
    {
      file: "contacts/contact-addresses-unfiltered.json",
      mirrors: ["contacts/contact-addresses-unfiltered.json"],
      path: "/ContactAddress",
      list: true,
      note: "Without contact filter, to compare with the filtered read (D-032).",
    },
    {
      file: "contacts/communication-ways.json",
      mirrors: ["contacts/communication-ways-1001.json"],
      path: "/CommunicationWay",
      query: { "contact[id]": "{contact}", "contact[objectName]": "Contact" },
      list: true,
      requires: ["contact"],
    },
    {
      file: "contacts/next-customer-number.json",
      mirrors: ["contacts/next-customer-number.json"],
      path: "/Contact/Factory/getNextCustomerNumber",
    },

    // --- invoices -------------------------------------------------------------------------
    {
      file: "invoices/invoices-list.json",
      mirrors: ["invoices/invoices-list.json"],
      path: "/Invoice",
      query: { embed: "contact" },
      list: true,
      collect: (objects) =>
        ids({
          invoice: firstId(objects),
          invoiceFinal: firstId(objects, (row) => !isDraft(row)),
        }),
    },
    {
      file: "invoices/invoice-by-id.json",
      mirrors: ["invoices/invoice-1001.json"],
      path: "/Invoice/{invoice}",
      query: { embed: "contact" },
      requires: ["invoice"],
    },
    {
      file: "invoices/invoice-positions.json",
      mirrors: ["invoices/invoice-positions-1001.json"],
      path: "/InvoicePos",
      query: { "invoice[id]": "{invoice}", "invoice[objectName]": "Invoice" },
      list: true,
      requires: ["invoice"],
    },
    {
      file: "invoices/invoice-positions-unfiltered.json",
      mirrors: ["invoices/invoice-positions-unfiltered.json"],
      path: "/InvoicePos",
      list: true,
      note: "Without invoice filter, to compare with the filtered read (D-035).",
    },

    // --- credit notes ---------------------------------------------------------------------
    {
      file: "credit-notes/credit-notes-list.json",
      mirrors: ["credit-notes/credit-notes-list.json"],
      path: "/CreditNote",
      query: { embed: "contact" },
      list: true,
      collect: (objects) =>
        ids({
          creditNote: firstId(objects),
          creditNoteFinal: firstId(objects, (row) => !isDraft(row)),
        }),
    },
    {
      file: "credit-notes/credit-note-by-id.json",
      // drafts/credit-note-2201.json: its ref names no endpoint, so it is mirrored explicitly.
      mirrors: ["credit-notes/credit-note-2001.json", "drafts/credit-note-2201.json"],
      path: "/CreditNote/{creditNote}",
      query: { embed: "contact" },
      requires: ["creditNote"],
    },
    {
      file: "credit-notes/credit-note-positions.json",
      mirrors: ["credit-notes/credit-note-positions-2001.json"],
      path: "/CreditNotePos",
      query: { "creditNote[id]": "{creditNote}", "creditNote[objectName]": "CreditNote" },
      list: true,
      requires: ["creditNote"],
    },

    // --- orders ---------------------------------------------------------------------------
    {
      file: "orders/orders-list.json",
      mirrors: ["orders/orders-list.json"],
      path: "/Order",
      query: { embed: "contact" },
      list: true,
      collect: (objects) =>
        ids({ order: firstId(objects), orderFinal: firstId(objects, (row) => !isDraft(row)) }),
    },
    {
      file: "orders/order-by-id.json",
      mirrors: ["orders/order-3002.json"],
      path: "/Order/{order}",
      query: { embed: "contact" },
      requires: ["order"],
    },
    {
      file: "orders/order-positions.json",
      mirrors: ["orders/order-positions-3002.json"],
      path: "/OrderPos",
      query: { "order[id]": "{order}", "order[objectName]": "Order" },
      list: true,
      requires: ["order"],
    },
    {
      file: "orders/order-related.json",
      mirrors: ["orders/order-related-3002.json"],
      path: "/Order/{order}/getRelatedObjects",
      query: { includeItself: 0 },
      requires: ["order"],
      note: "Shape on Update 2.0 (D-036 was observed on 1.0).",
    },

    // --- document files (non-drafts only) -------------------------------------------------
    {
      file: "documents/invoice-pdf.json",
      mirrors: ["documents/invoice-pdf.json"],
      path: "/Invoice/{invoiceFinal}/getPdf",
      query: { preventSendBy: "true" },
      requires: ["invoiceFinal"],
      note: "Preview of a non-draft invoice; content replaced by a fake PDF.",
    },
    {
      file: "documents/credit-note-pdf.json",
      mirrors: ["documents/credit-note-pdf.json"],
      path: "/CreditNote/{creditNoteFinal}/getPdf",
      query: { preventSendBy: "true" },
      requires: ["creditNoteFinal"],
      note: "Preview of a non-draft credit note; content replaced by a fake PDF.",
    },
    {
      file: "documents/order-pdf.json",
      mirrors: ["documents/order-pdf.json"],
      path: "/Order/{orderFinal}/getPdf",
      query: { preventSendBy: "true" },
      requires: ["orderFinal"],
      note: "Preview of a non-draft order; content replaced by a fake PDF.",
    },
    {
      file: "documents/invoice-xml.json",
      mirrors: ["documents/invoice-xml.json"],
      path: "/Invoice/{invoiceFinal}/getXml",
      requires: ["invoiceFinal"],
      note: "Only e-invoices have XML (D-033); the body is reduced to its root element.",
    },

    // --- vouchers -------------------------------------------------------------------------
    {
      file: "vouchers/vouchers-list.json",
      mirrors: ["vouchers/vouchers-list.json"],
      path: "/Voucher",
      list: true,
      collect: (objects) => ids({ voucher: firstId(objects) }),
    },
    {
      file: "vouchers/voucher-by-id.json",
      mirrors: ["vouchers/voucher-2001.json", "vouchers/voucher-2002.json"],
      path: "/Voucher/{voucher}",
      requires: ["voucher"],
      note: "Shows whether GET by id carries `document` (D-044).",
    },
    {
      file: "vouchers/voucher-positions.json",
      mirrors: ["vouchers/voucher-positions-2001.json", "vouchers/voucher-positions-2002.json"],
      path: "/VoucherPos",
      query: { "voucher[id]": "{voucher}", "voucher[objectName]": "Voucher" },
      list: true,
      requires: ["voucher"],
    },

    // --- banking --------------------------------------------------------------------------
    {
      file: "banking/check-accounts.json",
      mirrors: ["banking/check-accounts.json"],
      path: "/CheckAccount",
      list: true,
      collect: (objects) => ids({ checkAccount: firstId(objects) }),
    },
    {
      file: "banking/balance.json",
      mirrors: ["banking/balance-4001.json"],
      path: "/CheckAccount/{checkAccount}/getBalanceAtDate",
      query: { date: today },
      requires: ["checkAccount"],
    },
    {
      file: "banking/transactions-list.json",
      mirrors: ["banking/transactions-list.json"],
      path: "/CheckAccountTransaction",
      list: true,
    },

    // --- parts ----------------------------------------------------------------------------
    {
      file: "parts/parts-list.json",
      mirrors: ["parts/parts-list.json"],
      path: "/Part",
      list: true,
      collect: (objects) => ids({ part: firstId(objects) }),
    },
    {
      file: "parts/part-by-id.json",
      mirrors: ["parts/part-6001.json", "parts/part-6002.json"],
      path: "/Part/{part}",
      requires: ["part"],
    },
    {
      file: "parts/part-stock.json",
      mirrors: ["parts/part-stock-6002.json"],
      path: "/Part/{part}/getStock",
      requires: ["part"],
    },
  ];
}
