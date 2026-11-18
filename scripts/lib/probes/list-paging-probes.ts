/**
 * Probes for #162: which sevDesk lists can skip or repeat a row when the server reads them past
 * their first page with `offset`. #154 found that `GET /Voucher` orders rows that share a date
 * differently for different page sizes (D-100), so pages of 5 lost 12 of 56 vouchers and returned
 * 12 others twice. These probes ask the same question for every list query a reader of this
 * server pages through (internal scans, `listAll`, `listChildRows`, and the list tools the user
 * pages with `nextOffset`).
 *
 * Per case (one per distinct reader query, named after its reader): one page of 1000, then two
 * passes in pages of {@link LIST_PAGING_PAGE} from offset 0, each compared with the one page by
 * position and as sets, and the order the one page has (which fields run one way, how many rows
 * tie on them). Where the default order is not stable, the order parameters the spec documents
 * for that list (and the generic `orderBy[0][field]=id`) are tried too. Findings report counts,
 * positions and directions only, never ids or values.
 *
 * `read-list-paging-order` is read-only and opt-in (it sends up to {@link LIST_PAGING_BUDGET}
 * GETs). `write-list-paging-seed` is opt-in as well and needs `--allow-writes`: it creates tagged
 * contacts and draft invoices and credit notes of one day (ties a date order cannot settle),
 * compares the same reads over them and deletes every one again.
 */
import { documentDateFilter } from "../../../src/domain/common.js";
import { rowsOf } from "../fixture-plan.js";
import {
  addDays,
  berlinMidnight,
  createdId,
  type HttpResult,
  type ProbeContext,
  type ProbeDefinition,
  type ProbeOutcome,
  type Query,
  type Row,
  str,
} from "./core.js";
import { comparePaging, type PagingComparison, pagingText } from "./gaps-documents-probes.js";
import { data, inconclusive, isGone, outcomeOf, withCleanup } from "./m4-shared-probes.js";

/** Page size of the paged reads: small, so a few dozen rows make several pages. */
const LIST_PAGING_PAGE = 5;
/** The one page every paged read is compared with (sevDesk's largest page). */
const ONE_PAGE = 1000;
/** Fewest rows for a comparison worth making; fewer are "too few rows to tell". */
const LIST_PAGING_MIN_ROWS = 12;
/**
 * Most rows a paged pass reads (12 requests); a longer list is compared over its first rows only.
 * That keeps a case at 25 requests at most, however long the list is.
 */
const LIST_PAGING_PREFIX = 60;
/** Most GETs `read-list-paging-order` sends; cases beyond it are reported as not compared. */
export const LIST_PAGING_BUDGET = 500;
/** Most GETs the comparisons of `write-list-paging-seed` send (its writes and cleanup aside). */
const SEED_BUDGET = 200;
/** Contacts, draft invoices and draft credit notes `write-list-paging-seed` creates, each. */
export const LIST_PAGING_SEED_COUNT = 25;

// ---------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------

/** A field whose run through the one page the finding reports. */
interface OrderKey {
  readonly field: string;
  readonly kind: "number" | "date" | "text";
}

/** An explicit order to try when the default one is not stable. */
interface ExplicitOrder {
  /** Trusted, e.g. "orderByInvoiceNumber=ASC (documented in the spec)". */
  readonly label: string;
  readonly query: Query;
}

/** One reader's list query. */
export interface PagingCase {
  /** Short, after the main reader, e.g. `invoices_list`. Trusted. */
  readonly name: string;
  /** Every reader that sends this query, and how it pages. Trusted. */
  readonly readers: string;
  readonly path: string;
  /** The reader's own filters (no limit, offset or countAll: the probe adds them). */
  readonly query: Query;
  /** The query as the finding shows it, when a value should not appear (the run tag). */
  readonly shownQuery?: string;
  /** Fields besides `create`, `update` and `id` whose order the finding reports, first first. */
  readonly keys: readonly OrderKey[];
  readonly orders: readonly ExplicitOrder[];
}

const dateKey = (field: string): OrderKey => ({ field, kind: "date" });
const numberKey = (field: string): OrderKey => ({ field, kind: "number" });
const textKey = (field: string): OrderKey => ({ field, kind: "text" });

/** Every case reports these after its own keys. */
const COMMON_KEYS: readonly OrderKey[] = [dateKey("create"), dateKey("update"), numberKey("id")];

/** sevDesk's generic order parameter, which the spec does not document (ignored on vouchers). */
const BY_ID: ExplicitOrder = {
  label: "orderBy[0][field]=id, orderBy[0][arrangement]=asc (not in the spec)",
  query: { "orderBy[0][field]": "id", "orderBy[0][arrangement]": "asc" },
};

/** The documented `orderBy…Number=ASC` of a list, then {@link BY_ID}. */
function numberOrder(parameter: string): readonly ExplicitOrder[] {
  return [
    { label: `${parameter}=ASC (documented in the spec)`, query: { [parameter]: "ASC" } },
    BY_ID,
  ];
}

const INVOICE_ORDERS = numberOrder("orderByInvoiceNumber");
const CREDIT_NOTE_ORDERS = numberOrder("orderByCreditNoteNumber");
const ORDER_ORDERS = numberOrder("orderByOrderNumber");
const VOUCHER_ORDERS = numberOrder("orderByVoucherNumber");
const CONTACT_ORDERS = numberOrder("orderByCustomerNumber");
const ID_ONLY: readonly ExplicitOrder[] = [BY_ID];

/**
 * The list queries of every reader that pages past its first page, in the order they are compared
 * (the lists #162 names first: invoices, credit notes, transactions, contacts), each exactly as the
 * reader sends it. Readers whose filter is one record's id (a contact's persons, a document's
 * positions, an invoice's cancellations) are covered by the unfiltered list they fall back to or
 * that the filter narrows; those filters hold a handful of rows, too few to tell.
 *
 * Date ranges run from two years before `today` to 31 days after it, as in
 * `read-voucher-paging-order`; `updateAfter` (changed_since) starts two years back.
 */
export function listPagingCases(today: string): readonly PagingCase[] {
  const range = documentDateFilter({ from: addDays(today, -730), to: addDays(today, 31) }).query;
  const updateAfter = berlinMidnight(addDays(today, -730)) - 1;
  const invoiceKeys = [dateKey("invoiceDate")];
  const creditNoteKeys = [dateKey("creditNoteDate")];
  const orderKeys = [dateKey("orderDate")];
  const voucherKeys = [dateKey("voucherDate")];
  const transactionKeys = [dateKey("valueDate"), dateKey("entryDate")];
  const contactKeys = [textKey("customerNumber")];
  const positionKeys = [numberKey("positionNumber")];
  return [
    {
      name: "invoices_list",
      readers:
        "sevdesk_invoices_list (nextOffset; with a local filter the listDocuments scan in chunks of 200 from offset), records_summarize invoices without a range",
      path: "/Invoice",
      query: { embed: "contact" },
      keys: invoiceKeys,
      orders: INVOICE_ORDERS,
    },
    {
      name: "open invoices (aging, reconcile_suggest)",
      readers:
        "aging receivables and reconcile_suggest open items (scanPages from offset 0, pages of 1000), sevdesk_invoices_list status=open",
      path: "/Invoice",
      query: { embed: "contact", status: 200 },
      keys: invoiceKeys,
      orders: INVOICE_ORDERS,
    },
    {
      name: "records_summarize invoices (range)",
      readers: "records_summarize invoices (scanPages), sevdesk_invoices_list with from/to",
      path: "/Invoice",
      query: { embed: "contact", ...range },
      keys: invoiceKeys,
      orders: INVOICE_ORDERS,
    },
    {
      name: "credit_notes_list",
      readers:
        "sevdesk_credit_notes_list (nextOffset), records_summarize credit notes without a range",
      path: "/CreditNote",
      query: { embed: "contact" },
      keys: creditNoteKeys,
      orders: CREDIT_NOTE_ORDERS,
    },
    {
      name: "open credit notes (reconcile_suggest)",
      readers: "reconcile_suggest open items (scanPages), sevdesk_credit_notes_list status=open",
      path: "/CreditNote",
      query: { embed: "contact", status: 200 },
      keys: creditNoteKeys,
      orders: CREDIT_NOTE_ORDERS,
    },
    {
      name: "credit note numbers (drafts/numbering, changed_since)",
      readers:
        "drafts/numbering scanCreditNoteNumbers and changed_since credit notes (no filter), derived-documents findDerived (this list with contact[id])",
      path: "/CreditNote",
      query: {},
      keys: creditNoteKeys,
      orders: CREDIT_NOTE_ORDERS,
    },
    {
      name: "transactions_list",
      readers:
        "sevdesk_transactions_list (nextOffset; a local filter scans from offset in pages of up to 1000), records_summarize transactions, transaction-log payments in a period, reconcile_suggest, changed_since transactions",
      path: "/CheckAccountTransaction",
      query: {},
      keys: transactionKeys,
      orders: ID_ONLY,
    },
    {
      name: "open transactions (rule estimate)",
      readers:
        "private-transaction-rules estimateMatches (status created), sevdesk_transactions_list with one status",
      path: "/CheckAccountTransaction",
      query: { status: 100 },
      keys: transactionKeys,
      orders: ID_ONLY,
    },
    {
      name: "contacts_search",
      readers:
        "sevdesk_contacts_search (nextOffset), audit parties (scanPages), e-invoice voucher-suggestion loadContactIndex (listAll, pages of 1000); contacts-write and contacts-delete send this with name or parent[id]",
      path: "/Contact",
      query: { depth: "1" },
      keys: contactKeys,
      orders: CONTACT_ORDERS,
    },
    {
      name: "contact addresses (audit parties)",
      readers: "audit parties listContactAddressLocations (scanPages)",
      path: "/ContactAddress",
      query: {},
      keys: [],
      orders: ID_ONLY,
    },
    {
      name: "transaction log (readWholeLog)",
      readers:
        "reconciliation readWholeLog (listAll, pages of 1000), readTransactionLog when one transaction's filter answers more than a page",
      path: "/CheckAccountTransactionLog",
      query: {},
      keys: [dateKey("bookingDate")],
      orders: ID_ONLY,
    },
    {
      name: "orders_list",
      readers: "sevdesk_orders_list (nextOffset; the listDocuments scan with a local filter)",
      path: "/Order",
      query: { embed: "contact" },
      keys: orderKeys,
      orders: ORDER_ORDERS,
    },
    {
      name: "order follow-ups (AB)",
      readers:
        "order-follow-ups scanOrders (listAll, pages of 1000; also with contact[id], and orderType LI)",
      path: "/Order",
      query: { orderType: "AB" },
      keys: orderKeys,
      orders: ORDER_ORDERS,
    },
    {
      name: "vouchers_list",
      readers: "sevdesk_vouchers_list (nextOffset; with a type the listDocuments scan)",
      path: "/Voucher",
      query: {},
      keys: voucherKeys,
      orders: VOUCHER_ORDERS,
    },
    {
      name: "open expense vouchers (aging, reconcile_suggest)",
      readers:
        "aging payables and reconcile_suggest open vouchers (scanPages over the listDocuments scan)",
      path: "/Voucher",
      query: { status: 100, creditDebit: "C", voucherType: "VOU" },
      keys: voucherKeys,
      orders: VOUCHER_ORDERS,
    },
    {
      name: "parts_list",
      readers: "sevdesk_parts_list (nextOffset)",
      path: "/Part",
      query: {},
      keys: [textKey("partNumber")],
      orders: ID_ONLY,
    },
    {
      name: "tags_list",
      readers: "sevdesk_tags_list (nextOffset), findTagsByName and readDocumentTags (listAll)",
      path: "/Tag",
      query: {},
      keys: [],
      orders: ID_ONLY,
    },
    {
      name: "tag relations (listAll)",
      readers:
        "tags listTags, readDocumentTags (listAll), countTagUses and findTagRelation when the tag filter answers more than a page (listChildRows)",
      path: "/TagRelation",
      query: {},
      keys: [],
      orders: ID_ONLY,
    },
    {
      name: "invoice positions (listChildRows fallback)",
      readers:
        "listDocumentPositions and lifecycle content (listChildRows: the whole list when invoice[id] is ignored or answers more than a page)",
      path: "/InvoicePos",
      query: {},
      keys: positionKeys,
      orders: ID_ONLY,
    },
    {
      name: "credit note positions (listChildRows fallback)",
      readers: "listDocumentPositions and lifecycle content (listChildRows)",
      path: "/CreditNotePos",
      query: {},
      keys: positionKeys,
      orders: ID_ONLY,
    },
    {
      name: "order positions (listChildRows fallback)",
      readers: "listDocumentPositions and lifecycle content (listChildRows)",
      path: "/OrderPos",
      query: {},
      keys: positionKeys,
      orders: ID_ONLY,
    },
    {
      name: "voucher positions (listChildRows fallback)",
      readers: "listVoucherPositions, drafts/voucher-current and lifecycle content (listChildRows)",
      path: "/VoucherPos",
      query: {},
      keys: positionKeys,
      orders: ID_ONLY,
    },
    {
      name: "booking accounts (accounts-datev)",
      readers: "accounts-datev fetchAccountsDatev (offset loop, pages of 1000)",
      path: "/AccountDatev",
      query: {},
      keys: [textKey("number")],
      orders: ID_ONLY,
    },
    {
      name: "private-transaction rules",
      readers: "private-transaction-rules readRulePage (offset loop), the rule list tool",
      path: "/PrivateTransactionRule",
      query: {},
      keys: [],
      orders: ID_ONLY,
    },
    {
      name: "e-mail addresses (contacts-write)",
      readers: "contacts-write findContactsByEmail (listAll, pages of 1000)",
      path: "/CommunicationWay",
      query: { type: "EMAIL" },
      keys: [],
      orders: ID_ONLY,
    },
    {
      name: "partially paid invoices (aging, reconcile_suggest)",
      readers: "aging receivables and reconcile_suggest open items, second status",
      path: "/Invoice",
      query: { embed: "contact", status: 750 },
      keys: invoiceKeys,
      orders: INVOICE_ORDERS,
    },
    {
      name: "changed_since invoices",
      readers: "changed_since invoices (offset from the user, pages of limit)",
      path: "/Invoice",
      query: { showAll: "true", updateAfter },
      keys: invoiceKeys,
      orders: INVOICE_ORDERS,
    },
    {
      name: "changed_since contacts",
      readers: "changed_since contacts",
      path: "/Contact",
      query: { depth: "1", updateAfter },
      keys: contactKeys,
      orders: CONTACT_ORDERS,
    },
    {
      name: "changed_since orders",
      readers: "changed_since orders",
      path: "/Order",
      query: { updateAfter },
      keys: orderKeys,
      orders: ORDER_ORDERS,
    },
    {
      name: "changed_since vouchers",
      readers: "changed_since vouchers",
      path: "/Voucher",
      query: { updateAfter },
      keys: voucherKeys,
      orders: VOUCHER_ORDERS,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Order of one page
// ---------------------------------------------------------------------------------------------

/** A field's value for comparing, or `undefined` when the row has none that reads. */
function valueOf(row: Row, key: OrderKey): number | string | undefined {
  const raw = str(row, key.field);
  if (raw === "") return undefined;
  switch (key.kind) {
    case "number": {
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    case "date": {
      const value = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    case "text":
      return raw;
    default: {
      const unexpected: never = key.kind;
      return String(unexpected);
    }
  }
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "de");
}

/** How a field runs through the rows. */
interface FieldRun {
  readonly field: string;
  /** `ascending`/`descending` (equal neighbours allowed), `all equal`, `mixed (…)`, or few values. */
  readonly direction: string;
  /** Whether the field runs one way (ascending or descending). */
  readonly monotone: boolean;
  /** Rows whose value another row of the page shares (ties the field cannot order). */
  readonly ties: number;
}

/** The run of each key through `rows` (keys without any value left out). */
function fieldRuns(rows: readonly Row[], keys: readonly OrderKey[]): FieldRun[] {
  const runs: FieldRun[] = [];
  for (const key of keys) {
    const values = rows
      .map((row) => valueOf(row, key))
      .filter((value): value is number | string => value !== undefined);
    if (values.length === 0) continue;
    let up = 0;
    let down = 0;
    for (let index = 1; index < values.length; index += 1) {
      const step = compareValues(values[index] ?? 0, values[index - 1] ?? 0);
      if (step > 0) up += 1;
      else if (step < 0) down += 1;
    }
    const direction =
      values.length === 1
        ? "one value"
        : up === 0 && down === 0
          ? "all equal"
          : down === 0
            ? "ascending"
            : up === 0
              ? "descending"
              : `mixed (${up} steps up, ${down} down)`;
    const counts = new Map<string, number>();
    for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
    const ties = values.filter((value) => (counts.get(String(value)) ?? 0) > 1).length;
    runs.push({
      field: key.field,
      direction,
      monotone: direction === "ascending" || direction === "descending",
      ties,
    });
  }
  return runs;
}

/**
 * The order of a page in words: each field's run with its ties, then the apparent sort key (the
 * first field that runs one way, case keys before `create`, `update` and `id`).
 */
export function orderText(rows: readonly Row[], keys: readonly OrderKey[]): string {
  const runs = fieldRuns(rows, [...keys, ...COMMON_KEYS]);
  const listed = runs
    .map((run) => `${run.field} ${run.direction}${run.ties > 0 ? ` (${run.ties} rows tie)` : ""}`)
    .join(", ");
  const key = runs.find((run) => run.monotone);
  const apparent =
    key === undefined
      ? "no field here runs one way"
      : `apparent sort key ${key.field} ${key.direction}, ${key.ties} rows tie on it` +
        (key.field === "id" ? " (a total order)" : "");
  return `order: ${listed || "no field to tell"}; ${apparent}`;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** GETs left; every list read takes one. */
interface Budget {
  left: number;
}

async function budgetedGet(
  ctx: ProbeContext,
  budget: Budget,
  path: string,
  query: Query,
): Promise<HttpResult> {
  budget.left -= 1;
  return ctx.http.get(path, query);
}

function idsOf(result: HttpResult): string[] {
  const rows =
    result.objects === undefined || result.objects === null ? [] : rowsOf(result.objects);
  return rows.map((row) => str(row, "id"));
}

/** One page of {@link ONE_PAGE}: rows and sevDesk's total, or why it failed. */
async function onePage(
  ctx: ProbeContext,
  budget: Budget,
  path: string,
  query: Query,
): Promise<{
  readonly rows: Row[];
  readonly total: number | undefined;
  readonly failure?: string;
}> {
  const result = await budgetedGet(ctx, budget, path, {
    ...query,
    limit: ONE_PAGE,
    offset: 0,
    countAll: true,
  });
  if (!result.ok) return { rows: [], total: undefined, failure: outcomeOf(result) };
  const rows =
    result.objects === undefined || result.objects === null ? [] : rowsOf(result.objects);
  const rawTotal = (result.json as { total?: unknown } | undefined)?.total;
  const total = rawTotal === undefined || rawTotal === null ? undefined : Number(rawTotal);
  return { rows, total: Number.isFinite(total) ? total : undefined };
}

/**
 * Reads `query` in pages of {@link LIST_PAGING_PAGE} from offset 0 until `target` ids were read or
 * a page comes back short, with an explicit `limit` and `countAll` as the client sends them. The
 * first `target` ids in the order given, or where it failed.
 */
async function pagedIds(
  ctx: ProbeContext,
  budget: Budget,
  path: string,
  query: Query,
  target: number,
): Promise<{ readonly ids: string[]; readonly failure?: string }> {
  const ids: string[] = [];
  for (let offset = 0; ids.length < target; offset += LIST_PAGING_PAGE) {
    const result = await budgetedGet(ctx, budget, path, {
      ...query,
      limit: LIST_PAGING_PAGE,
      offset,
      countAll: true,
    });
    if (!result.ok) {
      return { ids, failure: `limit ${LIST_PAGING_PAGE} at offset ${offset} ${outcomeOf(result)}` };
    }
    const page = idsOf(result);
    ids.push(...page);
    if (page.length < LIST_PAGING_PAGE) break;
  }
  return { ids: ids.slice(0, target) };
}

/** Requests of one paged pass over `target` rows. */
function passCost(target: number): number {
  return Math.ceil(target / LIST_PAGING_PAGE);
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

/**
 * What one case showed: the same rows in the same order (`identical`), every row once in another
 * order (`reordered`), rows missing or repeated (`broken`), too few rows to tell (`few`), or no
 * answer (`unanswered`: a read was refused or stopped, or the request budget was used up).
 */
type CaseKind = "identical" | "reordered" | "broken" | "few" | "unanswered";

interface CaseResult {
  readonly name: string;
  readonly kind: CaseKind;
  /** Trusted: the case's reads in words (counts, positions, directions). */
  readonly line: string;
}

/** The kinds of a paged read that could be compared. */
type Compared = "identical" | "reordered" | "broken";

function kindOf(comparison: PagingComparison): Compared {
  return comparison.identical ? "identical" : comparison.sameRows ? "reordered" : "broken";
}

const KIND_RANK: Readonly<Record<Compared, number>> = { identical: 0, reordered: 1, broken: 2 };

/** The query of a case as the finding shows it. */
function shownQuery(paging: PagingCase): string {
  if (paging.shownQuery !== undefined) return paging.shownQuery;
  const params = Object.entries(paging.query).map(([key, value]) => `${key}=${String(value)}`);
  return params.length === 0 ? "no filter" : params.join("&");
}

/** The over-what part of a paged comparison: every row, or the first `target` of them. */
function scope(target: number, rows: number): string {
  return target === rows ? `all ${rows} rows` : `the first ${target} of ${rows} rows`;
}

/**
 * Runs one case: the one page, then (with at least {@link LIST_PAGING_MIN_ROWS} rows and enough
 * budget) two paged passes over at most {@link LIST_PAGING_PREFIX} rows, then, when those were not
 * identical to the one page, each explicit order with one page and one pass.
 */
async function compareCase(
  ctx: ProbeContext,
  budget: Budget,
  paging: PagingCase,
): Promise<CaseResult> {
  const head = `${paging.name}: GET ${paging.path} (${shownQuery(paging)}; read by ${paging.readers})`;
  const result = (kind: CaseKind, text: string): CaseResult => ({
    name: paging.name,
    kind,
    line: `${head}: ${text}`,
  });
  if (budget.left < 1) return result("unanswered", "not read, the request budget was used up");
  const single = await onePage(ctx, budget, paging.path, paging.query);
  if (single.failure !== undefined) {
    return result("unanswered", `one page (limit ${ONE_PAGE}) ${single.failure}`);
  }
  const rows = single.rows.length;
  const counted = `one page (limit ${ONE_PAGE}) ${rows} rows, total ${single.total ?? "none"}`;
  if (rows < LIST_PAGING_MIN_ROWS) {
    return result(
      "few",
      `${counted}: too few rows to tell (the comparison needs ${LIST_PAGING_MIN_ROWS})`,
    );
  }
  const order = orderText(single.rows, paging.keys);
  const target = Math.min(rows, LIST_PAGING_PREFIX);
  const cost = 2 * passCost(target);
  if (cost > budget.left) {
    return result(
      "unanswered",
      `${counted}, ${order}; not paged: the two passes need ${cost} requests and ${budget.left} were left of the budget`,
    );
  }
  const ids = single.rows.map((row) => str(row, "id"));
  const expected = ids.slice(0, target);
  const passes = [
    await pagedIds(ctx, budget, paging.path, paging.query, target),
    await pagedIds(ctx, budget, paging.path, paging.query, target),
  ];
  // The worst of the two passes; undefined once one of them stopped.
  let worst: Compared | undefined = "identical";
  const described: string[] = [];
  for (const [number, pass] of passes.entries()) {
    const label = number === 0 ? "first pass" : "second pass";
    if (pass.failure !== undefined) {
      worst = undefined;
      described.push(`${label} stopped: ${pass.failure}`);
      continue;
    }
    const comparison = comparePaging(expected, pass.ids);
    const kind = kindOf(comparison);
    if (worst !== undefined && KIND_RANK[kind] > KIND_RANK[worst]) worst = kind;
    described.push(`${label} ${pass.ids.length} rows, ${pagingText(comparison)}`);
  }
  const [first, second] = passes;
  const agree =
    first?.failure === undefined &&
    second?.failure === undefined &&
    comparePaging(first?.ids ?? [], second?.ids ?? []).identical;
  const lines = [
    `${counted}, ${order}; pages of ${LIST_PAGING_PAGE} over ${scope(target, rows)}: ${described.join("; ")}; ` +
      `the two passes ${agree ? "gave the same ids in the same order" : "differ from each other"}`,
  ];
  if (worst === "reordered" || worst === "broken") {
    for (const explicit of paging.orders) {
      lines.push(await compareOrder(ctx, budget, paging, explicit, ids, target));
    }
  }
  return result(worst ?? "unanswered", lines.join(". "));
}

/** One explicit order of a case: one page and one paged pass, compared with each other. */
async function compareOrder(
  ctx: ProbeContext,
  budget: Budget,
  paging: PagingCase,
  explicit: ExplicitOrder,
  defaultIds: readonly string[],
  target: number,
): Promise<string> {
  const cost = 1 + passCost(target);
  if (cost > budget.left) {
    return `${explicit.label}: not tried, it needs ${cost} requests and ${budget.left} were left`;
  }
  const query = { ...paging.query, ...explicit.query };
  const single = await onePage(ctx, budget, paging.path, query);
  if (single.failure !== undefined) return `${explicit.label}: one page ${single.failure}`;
  const ids = single.rows.map((row) => str(row, "id"));
  const sameAsDefault = comparePaging(defaultIds, ids).identical
    ? "the same order as without it (ignored?)"
    : "another order than without it";
  const pass = await pagedIds(ctx, budget, paging.path, query, Math.min(ids.length, target));
  return (
    `${explicit.label}: one page ${ids.length} rows, ${orderText(single.rows, paging.keys)}, ${sameAsDefault}; ` +
    `pages of ${LIST_PAGING_PAGE}: ` +
    (pass.failure === undefined
      ? pagingText(comparePaging(ids.slice(0, target), pass.ids))
      : `stopped: ${pass.failure}`)
  );
}

/** The words that open the finding for each kind of case. */
const KIND_HEADINGS: Readonly<Record<CaseKind, string>> = {
  broken: "NOT stable (rows skipped or repeated)",
  reordered: "every row once, but not in the order of one page",
  identical: "stable (the same rows in the same order, both passes)",
  few: "too few rows to tell",
  unanswered: "not compared (refused, stopped or over the request budget)",
};

const KIND_ORDER: readonly CaseKind[] = ["broken", "reordered", "identical", "few", "unanswered"];

/**
 * The finding over all cases: a plain answer per kind naming its cases, the requests sent, then
 * one line per case. Inconclusive when no case could be compared.
 */
function pagingFinding(
  results: readonly CaseResult[],
  sent: number,
  budget: number,
  before: string,
): ProbeOutcome {
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    names: results.filter((item) => item.kind === kind).map((item) => item.name),
  })).filter((group) => group.names.length > 0);
  const answer = groups
    .map((group) => `${KIND_HEADINGS[group.kind]}: ${group.names.join(", ")}`)
    .join("; ");
  const finding =
    `Answer per list, pages of ${LIST_PAGING_PAGE} against one page of ${ONE_PAGE}: ${answer}. ${before}` +
    `${sent} GETs of a budget of ${budget}; every read carries an explicit limit, offset 0 or a multiple of ${LIST_PAGING_PAGE}, and countAll, as the client sends them. ` +
    `${results.map((item) => item.line).join(". ")}.`;
  const compared = results.some(
    (item) => item.kind === "identical" || item.kind === "reordered" || item.kind === "broken",
  );
  return compared ? { verdict: "observed", finding } : inconclusive(finding);
}

/** Runs `cases` in order within `limit` GETs. */
async function runCases(
  ctx: ProbeContext,
  cases: readonly PagingCase[],
  limit: number,
): Promise<{ readonly results: CaseResult[]; readonly sent: number }> {
  const budget: Budget = { left: limit };
  const results: CaseResult[] = [];
  for (const paging of cases) results.push(await compareCase(ctx, budget, paging));
  return { results, sent: limit - budget.left };
}

/** The body of `read-list-paging-order`. */
async function listPagingOrder(ctx: ProbeContext): Promise<ProbeOutcome> {
  const { results, sent } = await runCases(ctx, listPagingCases(ctx.today), LIST_PAGING_BUDGET);
  const few = results.filter((item) => item.kind === "few").length;
  const before =
    few > 0
      ? `Of the lists with too few rows, contacts, invoices and credit notes can be seeded: write-list-paging-seed creates ${LIST_PAGING_SEED_COUNT} tagged contacts, draft invoices and draft credit notes of one day, compares and deletes them. `
      : "";
  return pagingFinding(results, sent, LIST_PAGING_BUDGET, before);
}

// ---------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------

/** A record `write-list-paging-seed` created, for its cleanup. */
interface OwnRecord {
  readonly objectName: "Contact" | "Invoice" | "CreditNote";
  readonly id: number;
}

/** `POST /Contact`: a tagged organisation (customer, active), registered for cleanup. */
async function seedContact(ctx: ProbeContext, label: string): Promise<number | string> {
  const result = await ctx.http.write("POST", "/Contact", {
    tier: "write",
    body: {
      name: `${data(ctx).tag} ${label}`,
      category: { id: 3, objectName: "Category" },
      status: 1000,
    },
  });
  const id = createdId(result.objects);
  if (id === undefined) return `POST /Contact ${outcomeOf(result)}`;
  data(ctx).register("Contact", id, "active (can be deleted in the web app)");
  return id;
}

/** The lists the seed compares: its own rows, with the filters the readers send. */
function seedCases(today: string, tag: string): readonly PagingCase[] {
  const day = documentDateFilter({ from: today, to: today }).query;
  return [
    {
      name: "seeded contacts",
      readers: "contacts_search and the contact scans (depth=1), narrowed to the run's tag by name",
      path: "/Contact",
      query: { depth: "1", name: tag },
      shownQuery: "depth=1&name=<the run tag>",
      keys: [textKey("customerNumber")],
      orders: CONTACT_ORDERS,
    },
    {
      name: "seeded draft invoices",
      readers: "invoices_list and records_summarize with a range of the run's day",
      path: "/Invoice",
      query: { embed: "contact", ...day },
      keys: [dateKey("invoiceDate")],
      orders: INVOICE_ORDERS,
    },
    {
      name: "seeded draft credit notes",
      readers: "credit_notes_list and records_summarize with a range of the run's day",
      path: "/CreditNote",
      query: { embed: "contact", ...day },
      keys: [dateKey("creditNoteDate")],
      orders: CREDIT_NOTE_ORDERS,
    },
  ];
}

/**
 * The body of `write-list-paging-seed`: {@link LIST_PAGING_SEED_COUNT} tagged contacts, draft
 * invoices and draft credit notes (all dated the run's day), then the comparison over them.
 * Created records go into `own` the moment they have an id.
 */
async function seededListPaging(ctx: ProbeContext, own: OwnRecord[]): Promise<ProbeOutcome> {
  const testData = data(ctx);
  for (let number = 1; number <= LIST_PAGING_SEED_COUNT; number += 1) {
    const label = `Seite ${String(number).padStart(2, "0")}`;
    const contact = await seedContact(ctx, label);
    if (typeof contact === "string") {
      return inconclusive(`Contact ${number} of ${LIST_PAGING_SEED_COUNT}: ${contact}.`);
    }
    own.push({ objectName: "Contact", id: contact });
  }
  for (const kind of ["Invoice", "CreditNote"] as const) {
    for (let number = 1; number <= LIST_PAGING_SEED_COUNT; number += 1) {
      const draft = await testData.draft(kind);
      if (draft.id === undefined) {
        return inconclusive(
          `Draft ${kind} ${number} of ${LIST_PAGING_SEED_COUNT}: ${outcomeOf(draft.result)}.`,
        );
      }
      own.push({ objectName: kind, id: draft.id });
    }
  }
  const { results, sent } = await runCases(ctx, seedCases(ctx.today, testData.tag), SEED_BUDGET);
  return pagingFinding(
    results,
    sent,
    SEED_BUDGET,
    `The probe created ${LIST_PAGING_SEED_COUNT} tagged contacts, ${LIST_PAGING_SEED_COUNT} draft invoices and ${LIST_PAGING_SEED_COUNT} draft credit notes dated ${ctx.today}. `,
  );
}

/**
 * Deletes the seeded records that are still there, documents before contacts: DELETE, then a GET
 * to see it gone. One note per record it could not delete; deleted ones are marked in the
 * cleanup list.
 */
async function deleteSeeded(ctx: ProbeContext, own: readonly OwnRecord[]): Promise<string[]> {
  const notes: string[] = [];
  const documentsFirst = [
    ...own.filter((record) => record.objectName !== "Contact"),
    ...own.filter((record) => record.objectName === "Contact"),
  ];
  let deleted = 0;
  for (const { objectName, id } of documentsFirst) {
    const answer = await ctx.http.write("DELETE", `/${objectName}/${id}`, { tier: "write" });
    const after = await ctx.http.get(`/${objectName}/${id}`);
    if (isGone(after)) {
      data(ctx).mark(objectName, id, "deleted by the probe");
      deleted += 1;
    } else {
      notes.push(`${objectName} ${id} left (DELETE ${outcomeOf(answer)})`);
    }
  }
  return documentsFirst.length === 0 ? notes : [`${deleted} records deleted`, ...notes];
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

export const LIST_PAGING_PROBES: readonly ProbeDefinition[] = [
  {
    id: "read-list-paging-order",
    title: "Which list reads past their first page can skip or repeat rows",
    mode: "read",
    optIn: true,
    question:
      "For every list query a reader pages past its first page (#162: internal scans, listAll, listChildRows and the list tools paged with nextOffset), with " +
      `exactly the filters that reader sends: are the ids of two passes in pages of ${LIST_PAGING_PAGE} from offset 0 those of one page of ${ONE_PAGE}, in the same order; ` +
      "is any id missing or repeated; do the two passes agree; which field the one page is sorted by and how many rows tie on it. Where the default order is not " +
      "stable, the order parameters the spec documents for that list (orderByInvoiceNumber, orderByCreditNoteNumber, orderByOrderNumber, orderByVoucherNumber, " +
      "orderByCustomerNumber) and orderBy[0][field]=id are tried too. " +
      `Lists with fewer than ${LIST_PAGING_MIN_ROWS} rows are too few to tell; a paged pass reads at most the first ${LIST_PAGING_PREFIX} rows. ` +
      `Opt-in because it sends up to ${LIST_PAGING_BUDGET} GETs. Counts, positions and directions only.`,
    deviations: ["D-146", "D-100", "D-145", "D-088", "D-099"],
    run: listPagingOrder,
  },
  {
    id: "write-list-paging-seed",
    title: `${LIST_PAGING_SEED_COUNT} tagged contacts, invoices and credit notes of one day: are their lists stable between pages`,
    mode: "write",
    optIn: true,
    question:
      `The question of read-list-paging-order (#162) on ${LIST_PAGING_SEED_COUNT} tagged contacts, ${LIST_PAGING_SEED_COUNT} draft invoices and ` +
      `${LIST_PAGING_SEED_COUNT} draft credit notes the probe creates, all dated the run's day (ties a date order cannot settle): the contacts found by the ` +
      "run tag (depth=1&name), the documents by the run's day with embed=contact. " +
      `Opt-in: it creates ${3 * LIST_PAGING_SEED_COUNT} records and deletes every one at the end, also when a step fails.`,
    deviations: ["D-146", "D-100"],
    async run(ctx) {
      const own: OwnRecord[] = [];
      return withCleanup(
        () => seededListPaging(ctx, own),
        () => deleteSeeded(ctx, own),
      );
    },
  },
];
