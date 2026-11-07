/**
 * `sevdesk_records_summarize`: one aggregate over invoices, credit notes, vouchers or bank
 * transactions, optionally grouped by month, quarter, status, contact or account. Instead of
 * paging through hundreds of rows, the model gets counts and exact sums per currency.
 *
 * Records come from the domain list functions (the same parsing and filters as the list tools),
 * read page by page up to {@link REPORT_SCAN_MAX} rows. Date ranges are handled by those
 * functions: document lists send sevDesk's `startDate`/`endDate` and re-check each row's date
 * (spec/deviations.md D-046); transactions are filtered by value date in the banking module
 * (sevDesk's own date filter cuts by entry date, D-047), so a range there reads the account's rows
 * and keeps the matching ones. Rows read but dropped by those checks count in `recordsScanned`,
 * not in the totals.
 *
 * Templates are not records: recurring vouchers (RV) and recurring invoices (WKR) generate the
 * real documents, and reminders (MA) repeat an invoice's amount. Vouchers are requested as normal
 * vouchers (`voucherType=VOU`, re-checked by the vouchers module, which drops RV rows); WKR and
 * MA rows are left out here (counted in the notes) unless that invoice type is asked for.
 */
import { z } from "zod";

import type { SevdeskClient } from "../../sevdesk/types.js";
import {
  listTransactions,
  TRANSACTION_STATUS_KEYS,
  type transactionDtoSchema,
} from "../banking.js";
import { compact, toUnixRange } from "../common.js";
import { CREDIT_NOTE_STATUS_FILTERS, listCreditNotes } from "../credit-notes.js";
import {
  INVOICE_STATUS_FILTERS,
  INVOICE_TYPE_FILTERS,
  type InvoiceRow,
  type InvoiceTypeFilter,
  listInvoices,
} from "../invoices.js";
import { compare, DEFAULT_CURRENCY, isZero, type Money } from "../money.js";
import { listVouchers, VOUCHER_KINDS, VOUCHER_STATUS_KEYS, type VoucherKind } from "../vouchers.js";
import {
  coverageOutputShape,
  invalidReportRequest,
  monthOf,
  plural,
  quarterOf,
  REPORT_BASIS,
  REPORT_SCAN_MAX,
  type ReportRunOptions,
  type ScanPage,
  scanPages,
} from "./shared.js";
import {
  type DocumentAmounts,
  DocumentTotals,
  FlowTotals,
  type LineKind,
  type TotalsLine,
  totalsLineSchema,
} from "./totals.js";

export const SUMMARY_SUBJECTS = ["invoices", "credit_notes", "vouchers", "transactions"] as const;

/** Invoice types (Rechnungsarten) a summary can be limited to. */
export const INVOICE_TYPE_KEYS = Object.keys(INVOICE_TYPE_FILTERS) as [
  InvoiceTypeFilter,
  ...InvoiceTypeFilter[],
];
type SummarySubject = (typeof SUMMARY_SUBJECTS)[number];

export const SUMMARY_GROUPINGS = [
  "none",
  "month",
  "quarter",
  "status",
  "contact",
  "account",
] as const;
type SummaryGrouping = (typeof SUMMARY_GROUPINGS)[number];

/** Every status key of every subject (each subject accepts its own subset, checked at run time). */
export const SUMMARY_STATUS_KEYS = [
  "draft",
  "open",
  "partially_paid",
  "paid",
  "transferred",
  "created",
  "linked",
  "private",
  "auto_booked",
  "booked",
] as const;
type SummaryStatusKey = (typeof SUMMARY_STATUS_KEYS)[number];

/** The status keys each subject's list function understands. */
export const STATUS_KEYS_BY_SUBJECT: Readonly<Record<SummarySubject, readonly string[]>> = {
  invoices: Object.keys(INVOICE_STATUS_FILTERS),
  credit_notes: Object.keys(CREDIT_NOTE_STATUS_FILTERS),
  vouchers: VOUCHER_STATUS_KEYS,
  transactions: TRANSACTION_STATUS_KEYS,
};

/** Trusted nouns per subject: plural for messages, the date periods refer to. */
const SUBJECTS: Readonly<
  Record<
    SummarySubject,
    { readonly noun: string; readonly title: string; readonly dateField: string }
  >
> = {
  invoices: { noun: "invoices", title: "Invoices", dateField: "invoice date (Rechnungsdatum)" },
  credit_notes: {
    noun: "credit notes",
    title: "Credit notes",
    dateField: "credit note date (Gutschriftsdatum)",
  },
  vouchers: { noun: "vouchers", title: "Vouchers", dateField: "voucher date (Belegdatum)" },
  transactions: {
    noun: "transactions",
    title: "Transactions",
    dateField: "value date of the transaction (Buchungstag/Wertstellung)",
  },
};

/** Invoice types that are not documents of their own unless asked for: WKR templates, MA reminders. */
const NON_DOCUMENT_INVOICE_TYPES: Readonly<Record<string, InvoiceTypeFilter>> = {
  WKR: "recurring",
  MA: "reminder",
};

/** Status code of a draft per subject (Entwurf); transactions have none. */
const DRAFT_CODES: Readonly<Partial<Record<SummarySubject, number>>> = {
  invoices: INVOICE_STATUS_FILTERS.draft,
  credit_notes: CREDIT_NOTE_STATUS_FILTERS.draft,
  vouchers: 50,
};

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const statusSchema = z.object({ code: z.number().int(), label: z.string() });

const partySchema = z.object({
  id: z.number().int().optional().describe("Contact id, for sevdesk_contact_get."),
  name: z.string().optional(),
});

const groupSchema = z.object({
  key: z
    .string()
    .describe(
      "YYYY-MM (month), YYYY-Qn (quarter), the status code, contact:<id>, name:<supplier " +
        "name> (vouchers without a contact), account:<id>, or no_date/no_status/none.",
    ),
  status: statusSchema.optional(),
  contact: partySchema.optional().describe("Customer or supplier of the group (contact groups)."),
  account: z
    .object({ id: z.number().int(), name: z.string().optional() })
    .optional()
    .describe("Payment account (Zahlungskonto) of the group (account groups)."),
  count: z.number().int(),
  lines: z.array(totalsLineSchema).describe("Totals per currency (and kind for vouchers)."),
});

type SummaryGroup = z.output<typeof groupSchema>;

export const summaryReportSchema = z.object({
  subject: z.enum(SUMMARY_SUBJECTS),
  groupBy: z.enum(SUMMARY_GROUPINGS),
  filters: z
    .object({
      status: z.enum(SUMMARY_STATUS_KEYS).optional(),
      contactId: z.number().int().optional(),
      kind: z.enum(VOUCHER_KINDS).optional(),
      invoiceType: z.enum(INVOICE_TYPE_KEYS).optional(),
      accountId: z.number().int().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .describe("The filters this summary applied."),
  dateField: z.string().describe("The date that the period, from/to and month/quarter refer to."),
  period: z.object({
    from: z.string().optional().describe("Requested first day (inclusive)."),
    to: z.string().optional().describe("Requested last day (inclusive)."),
    earliest: z.string().optional().describe("Earliest date among the counted records."),
    latest: z.string().optional().describe("Latest date among the counted records."),
  }),
  recordsCounted: z.number().int().describe("Records in the totals."),
  totals: z.object({ count: z.number().int(), lines: z.array(totalsLineSchema) }),
  groups: z.array(groupSchema).describe("Empty when groupBy is none."),
  groupsOmitted: z
    .number()
    .int()
    .optional()
    .describe("Groups left out beyond maxGroups (their records are still in totals)."),
  ...coverageOutputShape,
});

export type SummaryReport = z.output<typeof summaryReportSchema>;

// ---------------------------------------------------------------------------------------------
// Normalized records
// ---------------------------------------------------------------------------------------------

type TransactionRow = z.output<typeof transactionDtoSchema>;

interface SummaryRecord {
  readonly id: number | undefined;
  readonly date: string | undefined;
  readonly status: { readonly code: number; readonly label: string } | undefined;
  readonly party:
    { readonly id?: number | undefined; readonly name?: string | undefined } | undefined;
  readonly account: { readonly id: number; readonly name?: string | undefined } | undefined;
  readonly kind: LineKind | undefined;
  readonly amounts: DocumentAmounts | undefined;
  readonly flow: Money | undefined;
  readonly cancellation: boolean;
  /** SR invoices: the invoice they cancel. */
  readonly cancelsInvoiceId?: number | undefined;
  /** Invoices: status paid with a paid amount of 0, how sevDesk shows a cancelled one (D-037). */
  readonly paidNothing?: boolean | undefined;
  /** Why the row is not a record of its own (templates, reminders); `undefined` when it is. */
  readonly template?: "recurring_invoice" | "reminder" | undefined;
}

interface DocumentSums {
  readonly net?: Money | undefined;
  readonly tax?: Money | undefined;
  readonly gross?: Money | undefined;
}

function documentRecord(row: {
  readonly id: number;
  readonly date?: string | undefined;
  readonly status: { readonly code: number; readonly label: string };
  readonly contact?: { readonly id: number; readonly name?: string | undefined } | undefined;
  readonly currency: string;
  readonly totals: DocumentSums;
  readonly totalsEur?: DocumentSums | undefined;
  readonly type?: { readonly code: string } | undefined;
}): SummaryRecord {
  return {
    id: row.id,
    date: row.date,
    status: row.status,
    party: row.contact,
    account: undefined,
    kind: undefined,
    amounts: { currency: row.currency, ...row.totals, eur: row.totalsEur },
    flow: undefined,
    cancellation: row.type?.code === "SR",
  };
}

function invoiceRecord(row: InvoiceRow, invoiceType: InvoiceTypeFilter | undefined): SummaryRecord {
  const wanted = NON_DOCUMENT_INVOICE_TYPES[row.type.code];
  const gross = row.totals.gross;
  return {
    ...documentRecord(row),
    cancelsInvoiceId: row.cancelsInvoiceId,
    paidNothing:
      row.status.code === INVOICE_STATUS_FILTERS.paid &&
      row.paid !== undefined &&
      isZero(row.paid.amount) &&
      gross !== undefined &&
      compare(gross.amount, 0) > 0,
    template:
      wanted === undefined || wanted === invoiceType
        ? undefined
        : wanted === "reminder"
          ? "reminder"
          : "recurring_invoice",
  };
}

// ---------------------------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------------------------

export interface SummaryParams {
  readonly subject: SummarySubject;
  readonly groupBy: SummaryGrouping;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly status?: SummaryStatusKey | undefined;
  /** Customer (invoices, credit notes) or supplier (vouchers). */
  readonly contactId?: number | undefined;
  /** Vouchers only. */
  readonly kind?: VoucherKind | undefined;
  /** Invoices only: one invoice type; WKR and MA rows are counted only when asked for here. */
  readonly invoiceType?: InvoiceTypeFilter | undefined;
  /** Transactions only: the payment account. */
  readonly accountId?: number | undefined;
  readonly maxGroups: number;
  /** Row cap; defaults to {@link REPORT_SCAN_MAX} (lower values for tests). */
  readonly maxRecords?: number | undefined;
}

/**
 * Reads the subject's records with the given filters (server-side, as the list tools do) and
 * aggregates them. Throws a local `validation` error for filters the subject does not have.
 */
export async function summarizeRecords(
  client: SevdeskClient,
  params: SummaryParams,
  options: ReportRunOptions = {},
): Promise<SummaryReport> {
  checkParams(params);
  const { signal } = options;
  const subject = SUBJECTS[params.subject];
  const fetchPage = pageFetcher(client, params, signal);
  const scan = await scanPages(fetchPage, {
    max: params.maxRecords ?? REPORT_SCAN_MAX,
    noun: subject.noun,
    signal,
    onProgress: options.onProgress,
  });
  const counted = scan.items.filter((record) => record.template === undefined);
  const templates = scan.items.filter((record) => record.template !== undefined);

  const totals = newTotals(params.subject);
  const groups = new Map<string, GroupState>();
  for (const record of counted) {
    addRecord(totals, record);
    if (params.groupBy === "none") continue;
    const key = groupKey(params.groupBy, record);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, record, totals: newTotals(params.subject) };
      groups.set(key, group);
    }
    addRecord(group.totals, record);
  }

  const ordered = orderGroups(params.groupBy, [...groups.values()]);
  const shown = ordered.slice(0, params.maxGroups).map((group) => toGroup(params.groupBy, group));
  const dates = counted
    .map((record) => record.date)
    .filter((date): date is string => date !== undefined)
    .sort();
  const totalLines = totals.lineList();

  return {
    basis: REPORT_BASIS,
    subject: params.subject,
    groupBy: params.groupBy,
    filters: compact({
      status: params.status,
      contactId: params.contactId,
      kind: params.kind,
      invoiceType: params.invoiceType,
      accountId: params.accountId,
      from: params.from,
      to: params.to,
    }),
    dateField: subject.dateField,
    period: compact({
      from: params.from,
      to: params.to,
      earliest: dates[0],
      latest: dates.at(-1),
    }),
    recordsScanned: scan.scanned,
    recordsCounted: counted.length,
    truncated: scan.truncated,
    totals: { count: counted.length, lines: totalLines },
    groups: shown,
    ...(ordered.length > shown.length ? { groupsOmitted: ordered.length - shown.length } : {}),
    notes: summaryNotes(params, counted, templates, totalLines, {
      leftOut: scan.scanned - scan.items.length,
      truncated: scan.truncated,
      max: params.maxRecords ?? REPORT_SCAN_MAX,
    }),
  };
}

/** Trusted one-line summary of a report: counts only. */
export function summaryReportSentence(report: SummaryReport): string {
  const subject = SUBJECTS[report.subject];
  const currencies = new Set(report.totals.lines.map((line) => line.currency)).size;
  const grouped =
    report.groupBy === "none"
      ? ""
      : `, ${plural(report.groups.length + (report.groupsOmitted ?? 0), "group")} by ` +
        `${report.groupBy}${report.groupsOmitted === undefined ? "" : ` (${report.groups.length} shown)`}`;
  const truncated = report.truncated
    ? ` Stopped at the cap of ${report.recordsScanned} rows read: totals are incomplete.`
    : "";
  return (
    `${subject.title}: ${report.recordsCounted} counted in ${plural(currencies, "currency", "currencies")}` +
    `${grouped}; ${report.recordsScanned} sevDesk rows read.${truncated}`
  );
}

function checkParams(params: SummaryParams): void {
  // Validates from ≤ to before anything is sent.
  toUnixRange({ from: params.from, to: params.to });
  const { subject } = params;
  if (params.status !== undefined && !STATUS_KEYS_BY_SUBJECT[subject].includes(params.status)) {
    throw invalidReportRequest(
      `status '${params.status}' does not apply to ${SUBJECTS[subject].noun}; use one of ` +
        `${STATUS_KEYS_BY_SUBJECT[subject].join(", ")}.`,
    );
  }
  if (params.invoiceType !== undefined && subject !== "invoices") {
    throw invalidReportRequest("invoiceType applies to invoices only.");
  }
  if (params.kind !== undefined && subject !== "vouchers") {
    throw invalidReportRequest("kind applies to vouchers only.");
  }
  if (params.accountId !== undefined && subject !== "transactions") {
    throw invalidReportRequest("accountId applies to transactions only.");
  }
  if (params.contactId !== undefined && subject === "transactions") {
    throw invalidReportRequest(
      "transactions have no contact; filter by accountId or summarize invoices or vouchers.",
    );
  }
  if (params.groupBy === "contact" && subject === "transactions") {
    throw invalidReportRequest("transactions have no contact; group them by account instead.");
  }
  if (params.groupBy === "account" && subject !== "transactions") {
    throw invalidReportRequest("groupBy account applies to transactions only.");
  }
}

function pageFetcher(
  client: SevdeskClient,
  params: SummaryParams,
  signal: AbortSignal | undefined,
): (offset: number, limit: number) => Promise<ScanPage<SummaryRecord>> {
  // The domain lists send the range to sevDesk and re-check every row's date themselves.
  const range = { from: params.from, to: params.to };
  switch (params.subject) {
    case "invoices":
      return async (offset, limit) => {
        const page = await listInvoices(
          client,
          {
            ...range,
            status: params.status as keyof typeof INVOICE_STATUS_FILTERS | undefined,
            type: params.invoiceType,
            contactId: params.contactId,
            limit,
            offset,
          },
          signal,
        );
        return { ...page, items: page.items.map((row) => invoiceRecord(row, params.invoiceType)) };
      };
    case "credit_notes":
      return async (offset, limit) => {
        const page = await listCreditNotes(
          client,
          {
            ...range,
            status: params.status as keyof typeof CREDIT_NOTE_STATUS_FILTERS | undefined,
            contactId: params.contactId,
            limit,
            offset,
          },
          signal,
        );
        return { ...page, items: page.items.map(documentRecord) };
      };
    case "vouchers":
      return async (offset, limit) => {
        const page = await listVouchers(
          client,
          {
            ...range,
            status: params.status as (typeof VOUCHER_STATUS_KEYS)[number] | undefined,
            kind: params.kind,
            supplierId: params.contactId,
            // Recurring vouchers (RV) are templates; their generated vouchers are the records.
            type: "normal",
            limit,
            offset,
          },
          signal,
        );
        return {
          items: page.items.map((row): SummaryRecord => ({
            id: row.id,
            date: row.date,
            status: row.status,
            party: row.supplier,
            account: undefined,
            kind: row.kind ?? "unknown",
            amounts: {
              currency: row.currency,
              net: row.net,
              tax: row.tax,
              gross: row.gross,
              eur: row.base,
            },
            flow: undefined,
            cancellation: false,
          })),
          received: page.window.received,
          total: page.window.total,
          hasMore: page.state.hasMore,
          nextOffset: page.state.nextOffset,
        };
      };
    case "transactions":
      return async (offset, limit) => {
        const page = await listTransactions(
          client,
          {
            ...range,
            dateField: "value",
            checkAccountId: params.accountId,
            statuses:
              params.status === undefined
                ? undefined
                : [params.status as (typeof TRANSACTION_STATUS_KEYS)[number]],
            limit,
            offset,
          },
          { signal },
        );
        return {
          items: page.items.map(transactionRecord),
          received: page.rowsScanned,
          total: page.rowsTotal,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
        };
      };
  }
}

function transactionRecord(row: TransactionRow): SummaryRecord {
  return {
    id: row.id,
    date: row.valueDate,
    status: row.status,
    party: undefined,
    account: row.account,
    kind: undefined,
    amounts: undefined,
    flow: row.amount,
    cancellation: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------

type Totals = DocumentTotals | FlowTotals;

interface GroupState {
  readonly key: string;
  /** First record of the group, for its label (status, contact, account). */
  readonly record: SummaryRecord;
  readonly totals: Totals;
}

function newTotals(subject: SummarySubject): Totals {
  return subject === "transactions" ? new FlowTotals() : new DocumentTotals();
}

function addRecord(totals: Totals, record: SummaryRecord): void {
  if (totals instanceof FlowTotals) {
    if (record.flow !== undefined) totals.add(record.flow);
    return;
  }
  if (record.amounts !== undefined) totals.add(record.amounts, record.kind);
}

function groupKey(groupBy: Exclude<SummaryGrouping, "none">, record: SummaryRecord): string {
  switch (groupBy) {
    case "month":
      return record.date === undefined ? "no_date" : monthOf(record.date);
    case "quarter":
      return record.date === undefined ? "no_date" : quarterOf(record.date);
    case "status":
      return record.status === undefined ? "no_status" : String(record.status.code);
    case "contact":
      if (record.party?.id !== undefined) return `contact:${record.party.id}`;
      return record.party?.name === undefined ? "none" : `name:${record.party.name.toLowerCase()}`;
    case "account":
      return record.account === undefined ? "none" : `account:${record.account.id}`;
  }
}

const LAST_KEYS: ReadonlySet<string> = new Set(["no_date", "no_status", "none"]);

function orderGroups(groupBy: SummaryGrouping, groups: GroupState[]): GroupState[] {
  const last = (group: GroupState): number => (LAST_KEYS.has(group.key) ? 1 : 0);
  return groups.sort((a, b) => {
    const byLast = last(a) - last(b);
    if (byLast !== 0) return byLast;
    if (groupBy === "status") {
      return (a.record.status?.code ?? 0) - (b.record.status?.code ?? 0);
    }
    if (groupBy === "account") return (a.record.account?.id ?? 0) - (b.record.account?.id ?? 0);
    if (groupBy === "contact" && a.totals instanceof DocumentTotals) {
      const amountOrder = compareDescending(a.totals, b.totals as DocumentTotals);
      if (amountOrder !== 0) return amountOrder;
      if (a.totals.count !== b.totals.count) return b.totals.count - a.totals.count;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** Larger EUR gross first. */
function compareDescending(a: DocumentTotals, b: DocumentTotals): number {
  return compare(b.eurGrossForOrdering(), a.eurGrossForOrdering());
}

function toGroup(groupBy: SummaryGrouping, group: GroupState): SummaryGroup {
  const { record } = group;
  const label: Partial<SummaryGroup> = {};
  if (groupBy === "status" && record.status !== undefined) label.status = record.status;
  if (groupBy === "contact" && record.party !== undefined) {
    label.contact = compact({ id: record.party.id, name: record.party.name });
  }
  if (groupBy === "account" && record.account !== undefined) {
    label.account = compact({ id: record.account.id, name: record.account.name });
  }
  return { key: group.key, ...label, count: group.totals.count, lines: group.totals.lineList() };
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

function summaryNotes(
  params: SummaryParams,
  counted: readonly SummaryRecord[],
  templates: readonly SummaryRecord[],
  lines: readonly TotalsLine[],
  scan: { readonly leftOut: number; readonly truncated: boolean; readonly max: number },
): string[] {
  const notes: string[] = [];
  const draftCode = DRAFT_CODES[params.subject];
  const drafts = counted.filter((record) => record.status?.code === draftCode).length;
  if (scan.truncated) {
    notes.push(
      `Reading stopped at the cap of ${scan.max} rows: the totals cover only the rows read. ` +
        "Narrow the date range or filters for complete numbers.",
    );
  }
  if (drafts > 0 && params.status === undefined) {
    notes.push(
      `${plural(drafts, "draft")} (Entwurf) are included; pass a status to leave drafts out.`,
    );
  }
  notes.push(...cancellationNotes(counted));
  notes.push(...templateNotes(templates));
  if (lines.some((line) => line.currency !== DEFAULT_CURRENCY)) {
    notes.push(
      "Foreign-currency records are totalled in their own currency; eur holds sevDesk's EUR " +
        "values where sevDesk provides them.",
    );
  }
  if (params.subject === "vouchers") {
    notes.push(
      "Only normal vouchers are counted: recurring voucher templates (RV) are not read " +
        "(voucherType=VOU), because the vouchers they generate are the records.",
    );
  }
  if (params.subject === "vouchers" && params.kind === undefined) {
    notes.push(
      "Expense (Ausgabe) and revenue (Einnahme) vouchers are totalled in separate lines (kind); " +
        "voucher sums are positive for both.",
    );
  }
  if (params.subject === "transactions") {
    notes.push("outgoing is negative, as on the account; netFlow = incoming + outgoing.");
    if (params.from !== undefined || params.to !== undefined) {
      notes.push(
        "The date range is checked here by value date (sevDesk's own date filter cuts by entry " +
          "date), so all rows of the account(s) are read; the row cap applies to them.",
      );
    }
  }
  if (scan.leftOut > 0) {
    notes.push(
      `${plural(scan.leftOut, "row")} sevDesk returned did not pass the filters re-checked after ` +
        "reading (date range, voucher type, transaction status) and were left out; " +
        "recordsScanned counts them.",
    );
  }
  return notes;
}

/**
 * What the counted cancellation invoices (SR) do to the totals. An SR carries negative sums and
 * points to the invoice it cancels; that invoice keeps status paid with a paid amount of 0
 * (spec/deviations.md D-037). A pair nets to zero only when both are counted.
 */
function cancellationNotes(counted: readonly SummaryRecord[]): string[] {
  const notes: string[] = [];
  const ids = new Set(counted.map((record) => record.id));
  const cancellations = counted.filter((record) => record.cancellation);
  const targets = new Set(cancellations.map((record) => record.cancelsInvoiceId));
  const paired = cancellations.filter(
    (record) => record.cancelsInvoiceId !== undefined && ids.has(record.cancelsInvoiceId),
  ).length;
  const unpaired = cancellations.length - paired;
  if (cancellations.length > 0) {
    const pairs =
      paired === 0
        ? ""
        : ` Of these, ${paired} ${paired === 1 ? "cancels an invoice that is" : "cancel invoices that are"} ` +
          "also counted here; each such pair nets to zero.";
    const alone =
      unpaired === 0
        ? ""
        : ` ${unpaired} ${unpaired === 1 ? "cancels an invoice that is" : "cancel invoices that are"} ` +
          "not in this summary (another period or filter, or no link in sevDesk), so " +
          `${unpaired === 1 ? "its negative sums are" : "their negative sums are"} not offset here.`;
    notes.push(
      `${plural(cancellations.length, "cancellation invoice")} (SR, Stornorechnung) ` +
        `${cancellations.length === 1 ? "is" : "are"} included with negative sums.${pairs}${alone}`,
    );
  }
  const cancelledAlone = counted.filter(
    (record) =>
      record.paidNothing === true && !record.cancellation && !targets.has(record.id ?? -1),
  ).length;
  if (cancelledAlone > 0) {
    notes.push(
      `${plural(cancelledAlone, "counted invoice")} have status paid with a paid amount of 0, ` +
        "which is how sevDesk shows a cancelled invoice; their cancellation invoices are not in " +
        "this summary, so these sums are not offset here.",
    );
  }
  return notes;
}

/** Templates and reminders that were read but are not records of their own. */
function templateNotes(templates: readonly SummaryRecord[]): string[] {
  const count = (template: SummaryRecord["template"]): number =>
    templates.filter((record) => record.template === template).length;
  const notes: string[] = [];
  const invoices = count("recurring_invoice");
  const reminders = count("reminder");
  if (invoices > 0) {
    notes.push(
      `${plural(invoices, "recurring invoice template")} (WKR, Abo-Rechnung) were left out: ` +
        "the invoices they generate are the records. Pass invoiceType recurring to see them.",
    );
  }
  if (reminders > 0) {
    notes.push(
      `${plural(reminders, "reminder")} (MA, Mahnung) were left out: they repeat the amount of ` +
        "the invoice they remind of. Pass invoiceType reminder to see them.",
    );
  }
  return notes;
}
