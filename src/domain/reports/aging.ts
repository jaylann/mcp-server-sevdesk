/**
 * Aging of open items (offene Posten): receivables (Forderungen) from open and partially paid
 * invoices, payables (Verbindlichkeiten) from open and partially paid expense vouchers. Each item's
 * outstanding amount is gross − paid, exact, in the document's currency; items are bucketed by
 * calendar days past their due date relative to `asOf`, and the largest debtors/creditors are
 * ranked per currency.
 *
 * Paid amounts. sevDesk's `paidAmount` is used where its currency is known: EUR invoices (the
 * invoices module leaves `paid` out otherwise) and vouchers without separate EUR base values.
 * When it is not usable, an item that is open by status (nothing paid) counts with its full gross
 * and is marked approximate; a partially paid one is listed as unknown with its gross and left out
 * of the outstanding sums. Nothing is converted between currencies.
 *
 * Reference day. sevDesk only reports which items are open now, so `asOf` must be today or later
 * (Berlin): a past day's open items cannot be reconstructed. A later `asOf` ages today's open
 * items as of that day, assuming nothing is paid until then.
 *
 * Left out, each counted: cancellation invoices (SR), recurring templates (WKR invoices, RV
 * vouchers: they generate the real documents), reminders (MA: they repeat an invoice's amount),
 * items with nothing left to pay, and items with a negative gross, which mean money owed to the
 * customer (or by the supplier) and are reported apart as credit balances.
 */
import { z } from "zod";

import { berlinDateOf } from "../../sevdesk/dates.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { compact, moneySchema } from "../common.js";
import { INVOICE_STATUS_FILTERS, type InvoiceRow, listInvoices } from "../invoices.js";
import {
  add,
  compare,
  type Decimal,
  decimal,
  DEFAULT_CURRENCY,
  money,
  negate,
  subtract,
} from "../money.js";
import { listVouchers, type VoucherDto } from "../vouchers.js";
import {
  coverageOutputShape,
  daysBetween,
  invalidReportRequest,
  plural,
  REPORT_SCAN_MAX,
  REPORT_SOURCE,
  type ReportRunOptions,
  type ScanPage,
  scanPages,
} from "./shared.js";

// ---------------------------------------------------------------------------------------------
// Open items
// ---------------------------------------------------------------------------------------------

/** Invoice statuses that still expect money: open (200) and partially paid (750). */
const OPEN_INVOICE_CODE = INVOICE_STATUS_FILTERS.open;
const PARTIALLY_PAID_INVOICE_CODE = INVOICE_STATUS_FILTERS.partially_paid;
/**
 * Voucher statuses that still expect a payment (spec tag `Voucher`, "Types and status of
 * vouchers"): unpaid/due (100) and partially paid (750).
 */
const OPEN_VOUCHER_CODE = 100;
const PARTIALLY_PAID_VOUCHER_CODE = 750;

/** How an item's outstanding amount was determined. */
type OutstandingQuality = "exact" | "approximate" | "unknown";

interface Party {
  readonly id?: number | undefined;
  readonly name?: string | undefined;
}

/** One open receivable or payable, normalized. Amounts are exact decimal strings. */
export interface OpenItem {
  readonly id: number;
  readonly party: Party | undefined;
  readonly currency: string;
  /** Gross in the item's currency; `undefined` when sevDesk sent none. */
  readonly gross: string | undefined;
  /** gross − paid (exact), or gross when nothing is paid by status (approximate); else unknown. */
  readonly outstanding: string | undefined;
  readonly quality: OutstandingQuality;
  readonly dueDate: string | undefined;
  /** Payables: the paid amount is negative (a payment booked with the wrong sign). */
  readonly paidWrongSign?: true;
}

/** An open item with a negative gross: money owed to the customer (or by the supplier). */
interface CreditItem {
  readonly credit: true;
  readonly currency: string;
  /** The amount owed, positive. */
  readonly amount: string;
}

export interface OpenItems {
  readonly items: readonly OpenItem[];
  /** Open items with a negative gross, reported apart. */
  readonly credits: readonly CreditItem[];
  readonly scanned: number;
  readonly truncated: boolean;
  /** Rows left out, by reason. */
  readonly excluded: {
    /** Cancellation invoices (SR): not receivables. */
    readonly cancellations: number;
    /** Nothing left to pay (outstanding ≤ 0) although listed as open. */
    readonly settled: number;
    /** Rows with another status or kind than requested (filter re-check). */
    readonly mismatched: number;
    /** Recurring templates: WKR invoices, RV vouchers. */
    readonly templates: number;
    /** Reminders (MA). */
    readonly reminders: number;
  };
}

export interface CollectOptions extends ReportRunOptions {
  /** Row cap for all scans of this collection; defaults to {@link REPORT_SCAN_MAX}. */
  readonly maxRecords?: number | undefined;
  /** Rows read by earlier scans of the same report, for continuous progress counts. */
  readonly alreadyScanned?: number | undefined;
}

type Exclusion = "cancellation" | "settled" | "mismatched" | "template" | "reminder";
type Classified = OpenItem | CreditItem | Exclusion;

/**
 * Open receivables: `GET /Invoice` with `status=200`, then `status=750` (documented filters),
 * re-checked here. Cancellation invoices (SR) are left out: the invoice they cancel keeps status
 * paid, so neither is open. Recurring templates (WKR) and reminders (MA) are left out as well.
 */
export async function collectReceivables(
  client: SevdeskClient,
  options: CollectOptions = {},
): Promise<OpenItems> {
  return collect(
    ["open", "partially_paid"] as const,
    (status) => async (offset, limit) => {
      const page = await listInvoices(client, { status, limit, offset }, options.signal);
      return { ...page, items: page.items.map(classifyInvoice) };
    },
    "open invoices",
    options,
  );
}

/**
 * Open payables: `GET /Voucher` with `creditDebit=C` (expense), `voucherType=VOU` (no recurring
 * templates) and `status=100`, then `status=750`, all re-checked here. Transferred vouchers (150,
 * Überwiesen) count as paid.
 */
export async function collectPayables(
  client: SevdeskClient,
  options: CollectOptions = {},
): Promise<OpenItems> {
  return collect(
    ["open", "partially_paid"] as const,
    (status) => async (offset, limit) => {
      const page = await listVouchers(
        client,
        { status, kind: "expense", type: "normal", limit, offset },
        options.signal,
      );
      return {
        items: page.items.map(classifyVoucher),
        received: page.window.received,
        total: page.window.total,
        hasMore: page.state.hasMore,
        nextOffset: page.state.nextOffset,
      };
    },
    "open vouchers",
    options,
    // The vouchers module drops rows of another voucher type: RV templates sevDesk returned.
    "templates",
  );
}

async function collect<S extends string>(
  statuses: readonly S[],
  fetcher: (status: S) => (offset: number, limit: number) => Promise<ScanPage<Classified>>,
  noun: string,
  options: CollectOptions,
  /** What rows the list read but did not return are (its own re-check), if anything. */
  droppedAs?: "templates",
): Promise<OpenItems> {
  const max = options.maxRecords ?? REPORT_SCAN_MAX;
  const base = options.alreadyScanned ?? 0;
  const items: OpenItem[] = [];
  const credits: CreditItem[] = [];
  const excluded = { cancellations: 0, settled: 0, mismatched: 0, templates: 0, reminders: 0 };
  const counters: Readonly<Record<Exclusion, keyof typeof excluded>> = {
    cancellation: "cancellations",
    settled: "settled",
    mismatched: "mismatched",
    template: "templates",
    reminder: "reminders",
  };
  let scanned = 0;
  let truncated = false;
  for (const status of statuses) {
    const scan = await scanPages(fetcher(status), {
      max: max - scanned,
      noun,
      alreadyScanned: base + scanned,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    scanned += scan.scanned;
    if (droppedAs !== undefined) excluded[droppedAs] += scan.scanned - scan.items.length;
    for (const item of scan.items) {
      if (typeof item === "string") excluded[counters[item]] += 1;
      else if ("credit" in item) credits.push(item);
      else items.push(item);
    }
    if (scan.truncated) {
      truncated = true;
      break;
    }
  }
  return { items, credits, scanned, truncated, excluded };
}

function classifyInvoice(row: InvoiceRow): Classified {
  const code = row.status.code;
  if (code !== OPEN_INVOICE_CODE && code !== PARTIALLY_PAID_INVOICE_CODE) return "mismatched";
  if (row.type.code === "SR") return "cancellation";
  if (row.type.code === "WKR") return "template";
  if (row.type.code === "MA") return "reminder";
  return openItem({
    id: row.id,
    party: row.contact,
    currency: row.currency,
    gross: row.totals.gross?.amount,
    paid: row.paid?.amount,
    nothingPaidByStatus: code === OPEN_INVOICE_CODE,
    dueDate: row.dueDate,
  });
}

function classifyVoucher(row: VoucherDto): Classified {
  const code = row.status?.code;
  if (row.kind !== "expense") return "mismatched";
  if (code !== OPEN_VOUCHER_CODE && code !== PARTIALLY_PAID_VOUCHER_CODE) return "mismatched";
  // A foreign-currency voucher's paid amount is taken as EUR by the vouchers module (unverified),
  // so it is only used when the voucher has no separate EUR values (totalsEur).
  const paid =
    row.totalsEur === undefined && row.paid?.currency === row.currency
      ? row.paid.amount
      : undefined;
  const wrongSign = paid !== undefined && compare(paid, 0) < 0;
  const item = openItem({
    id: row.id,
    party: row.supplier,
    currency: row.currency,
    gross: row.totals.gross?.amount,
    // With a wrong-signed payment, what is still open cannot be told: unknown.
    paid: wrongSign ? undefined : paid,
    nothingPaidByStatus: !wrongSign && code === OPEN_VOUCHER_CODE,
    dueDate: row.paymentDeadline,
  });
  return wrongSign && typeof item !== "string" && !("credit" in item)
    ? { ...item, paidWrongSign: true }
    : item;
}

function openItem(input: {
  readonly id: number;
  readonly party: Party | undefined;
  readonly currency: string;
  readonly gross: string | undefined;
  readonly paid: string | undefined;
  readonly nothingPaidByStatus: boolean;
  readonly dueDate: string | undefined;
}): OpenItem | CreditItem | "settled" {
  const { gross, paid } = input;
  let outstanding: string | undefined;
  let quality: OutstandingQuality = "unknown";
  if (gross !== undefined && paid !== undefined) {
    outstanding = money(subtract(gross, paid), input.currency).amount;
    quality = "exact";
  } else if (gross !== undefined && input.nothingPaidByStatus) {
    outstanding = gross;
    quality = "approximate";
  }
  if (gross !== undefined && compare(gross, 0) < 0) {
    // A negative document: money owed to the customer (or by the supplier), not an open item.
    const owed = negate(outstanding ?? gross);
    return compare(owed, 0) <= 0
      ? "settled"
      : { credit: true, currency: input.currency, amount: money(owed, input.currency).amount };
  }
  if (outstanding !== undefined && compare(outstanding, 0) <= 0) return "settled";
  return {
    id: input.id,
    party: input.party,
    currency: input.currency,
    gross,
    outstanding,
    quality,
    dueDate: input.dueDate,
  };
}

// ---------------------------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------------------------

export const AGING_BUCKETS = [
  "not_due",
  "days_1_30",
  "days_31_60",
  "days_61_90",
  "days_over_90",
  "no_due_date",
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

const BUCKET_LABELS: Readonly<Record<AgingBucket, string>> = {
  not_due: "Not yet due on asOf (nicht fällig): due on asOf or later",
  days_1_30: "1–30 days overdue (überfällig)",
  days_31_60: "31–60 days overdue",
  days_61_90: "61–90 days overdue",
  days_over_90: "More than 90 days overdue",
  no_due_date: "No due date in sevDesk (Zahlungsziel/Fälligkeit missing)",
};

/** Calendar days past due on `asOf`: 0 on the due date, negative before it. */
export function daysOverdue(dueDate: string, asOf: string): number {
  return daysBetween(dueDate, asOf);
}

/** The bucket of a due date relative to `asOf`. Due on `asOf` itself is not yet overdue. */
export function bucketOf(dueDate: string | undefined, asOf: string): AgingBucket {
  if (dueDate === undefined) return "no_due_date";
  const days = daysOverdue(dueDate, asOf);
  if (days <= 0) return "not_due";
  if (days <= 30) return "days_1_30";
  if (days <= 60) return "days_31_60";
  if (days <= 90) return "days_61_90";
  return "days_over_90";
}

/** Outstanding per currency of a set of open items. */
const agingLineSchema = z.object({
  currency: z.string().length(3),
  count: z.number().int().describe("Items in this line, including unknown ones."),
  outstanding: moneySchema.describe(
    "Sum still to be paid (offen): gross − paid; includes the approximate part.",
  ),
  approximate: z
    .object({ count: z.number().int(), outstanding: moneySchema })
    .optional()
    .describe(
      "Part of outstanding that assumes nothing was paid (status open, but no usable paid " +
        "amount in sevDesk, e.g. foreign currency).",
    ),
  unknown: z
    .object({ count: z.number().int(), gross: moneySchema })
    .optional()
    .describe(
      "Items without a usable paid amount that are partially paid: gross, NOT in outstanding.",
    ),
});

type AgingLine = z.output<typeof agingLineSchema>;

const bucketSchema = z.object({
  bucket: z.enum(AGING_BUCKETS),
  label: z.string(),
  count: z.number().int(),
  lines: z.array(agingLineSchema).describe("Per currency; empty when the bucket is empty."),
});

const partySchema = z.object({
  id: z.number().int().optional().describe("Contact id, for sevdesk_contact_get."),
  name: z.string().optional(),
});

const rankedSchema = z.object({
  currency: z.string().length(3),
  outstanding: moneySchema,
  count: z.number().int().describe("Open items of this party in this currency."),
  approximate: z
    .boolean()
    .optional()
    .describe("True when part of outstanding assumes nothing was paid."),
  unknownCount: z
    .number()
    .int()
    .optional()
    .describe("Items whose outstanding is unknown (not in outstanding)."),
  oldestDueDate: z.string().optional().describe("Earliest due date of its open items."),
  maxDaysOverdue: z
    .number()
    .int()
    .optional()
    .describe("Days the oldest item is past due on asOf (only when overdue)."),
});

type RankedOutput = z.output<typeof rankedSchema>;

/** Credit balances per currency: open items with a negative gross. */
const creditLinesSchema = z.array(
  z.object({
    currency: z.string().length(3),
    count: z.number().int(),
    amount: moneySchema.describe("Amount owed (positive)."),
  }),
);

const totalsSchema = z.object({
  count: z.number().int(),
  lines: z.array(agingLineSchema).describe("All open items per currency."),
  overdue: z.array(agingLineSchema).describe("Only the overdue buckets (1 day or more)."),
});

const AS_OF_DESCRIPTION =
  "Reference day (Stichtag), YYYY-MM-DD, Berlin: today or later. Items are those open in " +
  "sevDesk today; days overdue are counted up to this day.";

export const receivablesAgingSchema = z.object({
  asOf: z.string().describe(AS_OF_DESCRIPTION),
  buckets: z.array(bucketSchema),
  totals: totalsSchema,
  topDebtors: z
    .array(rankedSchema.extend({ contact: partySchema.optional() }))
    .describe("Largest debtors (Schuldner) by outstanding, ranked within each currency."),
  owedToCustomers: creditLinesSchema.describe(
    "Open invoices with a negative gross (e.g. a final invoice whose advance payments exceed " +
      "its total, or a negative invoice used as a credit): money owed to the customer, not in " +
      "the buckets.",
  ),
  excluded: z.object({
    cancellationInvoices: z.number().int().describe("SR invoices (Stornorechnungen) left out."),
    recurringTemplates: z
      .number()
      .int()
      .describe("WKR templates (Abo-Rechnungen) left out; their generated invoices count."),
    reminders: z.number().int().describe("MA reminders (Mahnungen) left out: they repeat amounts."),
    nothingOutstanding: z.number().int().describe("Listed as open, but paid ≥ gross: left out."),
  }),
  ...coverageOutputShape,
});

export type ReceivablesAging = z.output<typeof receivablesAgingSchema>;

export const payablesAgingSchema = z.object({
  asOf: z.string().describe(AS_OF_DESCRIPTION),
  buckets: z.array(bucketSchema),
  totals: totalsSchema,
  topCreditors: z
    .array(rankedSchema.extend({ supplier: partySchema.optional() }))
    .describe("Largest creditors (Lieferanten) by outstanding, ranked within each currency."),
  owedBySuppliers: creditLinesSchema.describe(
    "Open expense vouchers with a negative gross: money the supplier owes back (Gutschrift), " +
      "not in the buckets.",
  ),
  excluded: z.object({
    recurringTemplates: z
      .number()
      .int()
      .describe(
        "RV templates (wiederkehrende Belege) sevDesk returned although only normal vouchers " +
          "were asked for; left out (their generated vouchers count).",
      ),
    nothingOutstanding: z.number().int().describe("Listed as open, but paid ≥ gross: left out."),
  }),
  ...coverageOutputShape,
});

export type PayablesAging = z.output<typeof payablesAgingSchema>;

interface AgingSums {
  count: number;
  outstanding: Decimal;
  approxCount: number;
  approx: Decimal;
  unknownCount: number;
  unknownGross: Decimal;
}

/** Accumulates open items per currency (exact, approximate and unknown parts kept apart). */
class AgingTotals {
  private readonly lines = new Map<string, AgingSums>();

  count = 0;

  add(item: OpenItem): void {
    let line = this.lines.get(item.currency);
    if (line === undefined) {
      line = {
        count: 0,
        outstanding: decimal(0),
        approxCount: 0,
        approx: decimal(0),
        unknownCount: 0,
        unknownGross: decimal(0),
      };
      this.lines.set(item.currency, line);
    }
    this.count += 1;
    line.count += 1;
    if (item.outstanding === undefined) {
      line.unknownCount += 1;
      if (item.gross !== undefined) line.unknownGross = add(line.unknownGross, item.gross);
      return;
    }
    line.outstanding = add(line.outstanding, item.outstanding);
    if (item.quality === "approximate") {
      line.approxCount += 1;
      line.approx = add(line.approx, item.outstanding);
    }
  }

  lineList(): AgingLine[] {
    return [...this.lines.entries()]
      .sort(([a], [b]) => currencyOrder(a, b))
      .map(([currency, line]) => ({
        currency,
        count: line.count,
        outstanding: money(line.outstanding, currency),
        ...(line.approxCount > 0
          ? { approximate: { count: line.approxCount, outstanding: money(line.approx, currency) } }
          : {}),
        ...(line.unknownCount > 0
          ? { unknown: { count: line.unknownCount, gross: money(line.unknownGross, currency) } }
          : {}),
      }));
  }
}

/** EUR first, then by code. */
export function currencyOrder(a: string, b: string): number {
  if (a === b) return 0;
  if (a === DEFAULT_CURRENCY) return -1;
  if (b === DEFAULT_CURRENCY) return 1;
  return a < b ? -1 : 1;
}

interface RankedParty {
  readonly party: Party | undefined;
  readonly line: RankedOutput;
}

interface AgingCore {
  readonly buckets: z.output<typeof bucketSchema>[];
  readonly totals: z.output<typeof totalsSchema>;
  readonly top: readonly RankedParty[];
}

/** Buckets, totals and the top `top` parties per currency of a set of open items. */
export function buildAging(items: readonly OpenItem[], asOf: string, top: number): AgingCore {
  const byBucket = new Map<AgingBucket, AgingTotals>();
  const all = new AgingTotals();
  const overdue = new AgingTotals();
  for (const item of items) {
    const bucket = bucketOf(item.dueDate, asOf);
    let totals = byBucket.get(bucket);
    if (totals === undefined) {
      totals = new AgingTotals();
      byBucket.set(bucket, totals);
    }
    totals.add(item);
    all.add(item);
    if (bucket !== "not_due" && bucket !== "no_due_date") overdue.add(item);
  }
  return {
    buckets: AGING_BUCKETS.map((bucket) => {
      const totals = byBucket.get(bucket);
      return {
        bucket,
        label: BUCKET_LABELS[bucket],
        count: totals?.count ?? 0,
        lines: totals?.lineList() ?? [],
      };
    }),
    totals: { count: all.count, lines: all.lineList(), overdue: overdue.lineList() },
    top: rankParties(items, asOf, top),
  };
}

function partyKey(party: Party | undefined): string {
  if (party?.id !== undefined) return `id:${party.id}`;
  if (party?.name !== undefined) return `name:${party.name.toLowerCase()}`;
  return "none";
}

interface PartyGroup {
  readonly key: string;
  readonly party: Party | undefined;
  readonly currency: string;
  outstanding: Decimal;
  count: number;
  approximate: boolean;
  unknownCount: number;
  oldestDueDate: string | undefined;
}

/** Parties ranked by outstanding (largest first) within each currency, `top` per currency. */
function rankParties(items: readonly OpenItem[], asOf: string, top: number): RankedParty[] {
  const groups = new Map<string, PartyGroup>();
  for (const item of items) {
    const key = partyKey(item.party);
    const groupKey = `${item.currency}|${key}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        key,
        party: item.party,
        currency: item.currency,
        outstanding: decimal(0),
        count: 0,
        approximate: false,
        unknownCount: 0,
        oldestDueDate: undefined,
      };
      groups.set(groupKey, group);
    }
    group.count += 1;
    if (item.outstanding === undefined) group.unknownCount += 1;
    else group.outstanding = add(group.outstanding, item.outstanding);
    if (item.quality === "approximate") group.approximate = true;
    if (
      item.dueDate !== undefined &&
      (group.oldestDueDate === undefined || item.dueDate < group.oldestDueDate)
    ) {
      group.oldestDueDate = item.dueDate;
    }
  }

  const ranked = [...groups.values()].sort(
    (a, b) =>
      currencyOrder(a.currency, b.currency) ||
      compare(b.outstanding, a.outstanding) ||
      b.count - a.count ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const shownPerCurrency = new Map<string, number>();
  const result: RankedParty[] = [];
  for (const group of ranked) {
    const shown = shownPerCurrency.get(group.currency) ?? 0;
    if (shown >= top) continue;
    shownPerCurrency.set(group.currency, shown + 1);
    const days =
      group.oldestDueDate === undefined ? undefined : daysOverdue(group.oldestDueDate, asOf);
    result.push({
      party: group.party,
      line: compact({
        currency: group.currency,
        outstanding: money(group.outstanding, group.currency),
        count: group.count,
        approximate: group.approximate ? true : undefined,
        unknownCount: group.unknownCount > 0 ? group.unknownCount : undefined,
        oldestDueDate: group.oldestDueDate,
        maxDaysOverdue: days !== undefined && days > 0 ? days : undefined,
      }),
    });
  }
  return result;
}

/** The party as output: `undefined` when neither id nor name is known. */
function partyOutput(party: Party | undefined): Party | undefined {
  if (party === undefined || (party.id === undefined && party.name === undefined)) {
    return undefined;
  }
  return compact({ id: party.id, name: party.name });
}

/** Credit balances summed per currency (EUR first). */
function creditLines(credits: readonly CreditItem[]): z.output<typeof creditLinesSchema> {
  const sums = new Map<string, { count: number; amount: Decimal }>();
  for (const credit of credits) {
    const sum = sums.get(credit.currency) ?? { count: 0, amount: decimal(0) };
    sum.count += 1;
    sum.amount = add(sum.amount, credit.amount);
    sums.set(credit.currency, sum);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => currencyOrder(a, b))
    .map(([currency, sum]) => ({
      currency,
      count: sum.count,
      amount: money(sum.amount, currency),
    }));
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

/**
 * The reference day: `asOf`, or today (Berlin). A day before today is refused: sevDesk only
 * reports today's open items and payments, so an aging for a past day cannot be computed.
 */
export function referenceDay(asOf: string | undefined, today: string, what: string): string {
  if (asOf === undefined) return today;
  if (asOf < today) {
    throw invalidReportRequest(
      `asOf ${asOf} is in the past (today is ${today}). sevDesk only reports which items are ` +
        `open now, not which were open on an earlier day, so ${what} for a past day cannot be ` +
        "computed from its data. Use today or a later day.",
    );
  }
  return asOf;
}

export interface AgingParams {
  /** Reference day, `YYYY-MM-DD` Berlin, today or later; defaults to today. */
  readonly asOf?: string | undefined;
  /** Today in Berlin, `YYYY-MM-DD` (tests); defaults to the current date. */
  readonly today?: string | undefined;
  /** Parties to rank per currency. */
  readonly top: number;
  readonly maxRecords?: number | undefined;
}

/** Receivables aging (Forderungen nach Fälligkeit). */
export async function receivablesAging(
  client: SevdeskClient,
  params: AgingParams,
  options: ReportRunOptions = {},
): Promise<ReceivablesAging> {
  const today = params.today ?? berlinDateOf(Date.now());
  const asOf = referenceDay(params.asOf, today, "an aging (offene Posten)");
  const open = await collectReceivables(client, { ...options, maxRecords: params.maxRecords });
  const core = buildAging(open.items, asOf, params.top);
  return {
    asOf,
    buckets: core.buckets,
    totals: core.totals,
    topDebtors: core.top.map(({ party, line }) => {
      const contact = partyOutput(party);
      return contact === undefined ? line : { contact, ...line };
    }),
    owedToCustomers: creditLines(open.credits),
    excluded: {
      cancellationInvoices: open.excluded.cancellations,
      recurringTemplates: open.excluded.templates,
      reminders: open.excluded.reminders,
      nothingOutstanding: open.excluded.settled,
    },
    source: REPORT_SOURCE,
    recordsScanned: open.scanned,
    truncated: open.truncated,
    notes: agingNotes("receivables", open, {
      max: params.maxRecords ?? REPORT_SCAN_MAX,
      asOf,
      today,
    }),
  };
}

/** Payables aging (Verbindlichkeiten nach Fälligkeit). */
export async function payablesAging(
  client: SevdeskClient,
  params: AgingParams,
  options: ReportRunOptions = {},
): Promise<PayablesAging> {
  const today = params.today ?? berlinDateOf(Date.now());
  const asOf = referenceDay(params.asOf, today, "an aging (offene Posten)");
  const open = await collectPayables(client, { ...options, maxRecords: params.maxRecords });
  const core = buildAging(open.items, asOf, params.top);
  return {
    asOf,
    buckets: core.buckets,
    totals: core.totals,
    topCreditors: core.top.map(({ party, line }) => {
      const supplier = partyOutput(party);
      return supplier === undefined ? line : { supplier, ...line };
    }),
    owedBySuppliers: creditLines(open.credits),
    excluded: {
      recurringTemplates: open.excluded.templates,
      nothingOutstanding: open.excluded.settled,
    },
    source: REPORT_SOURCE,
    recordsScanned: open.scanned,
    truncated: open.truncated,
    notes: agingNotes("payables", open, {
      max: params.maxRecords ?? REPORT_SCAN_MAX,
      asOf,
      today,
    }),
  };
}

/** Trusted one-line summary of an aging report: counts only. */
export function agingSentence(
  title: string,
  report: {
    readonly asOf: string;
    readonly totals: z.output<typeof totalsSchema>;
    readonly recordsScanned: number;
    readonly truncated: boolean;
  },
): string {
  const overdue = report.totals.overdue.reduce((sum, line) => sum + line.count, 0);
  const currencies = report.totals.lines.length;
  const truncated = report.truncated ? " Stopped at the row cap: the aging is incomplete." : "";
  return (
    `${title} as of ${report.asOf}: ${plural(report.totals.count, "open item")} ` +
    `(${overdue} overdue) in ${plural(currencies, "currency", "currencies")}; ` +
    `${report.recordsScanned} sevDesk rows read.${truncated}`
  );
}

function agingNotes(
  kind: "receivables" | "payables",
  open: OpenItems,
  context: { readonly max: number; readonly asOf: string; readonly today: string },
): string[] {
  const noun = kind === "receivables" ? "invoice" : "voucher";
  const notes: string[] = [];
  if (open.truncated) {
    notes.push(
      `Reading stopped at the cap of ${context.max} rows: the aging covers only the rows read.`,
    );
  }
  if (context.asOf > context.today) {
    notes.push(
      `asOf ${context.asOf} is after today (${context.today}): the items are those open in ` +
        "sevDesk today, aged as of asOf on the assumption that nothing is paid until then.",
    );
  }
  notes.push(
    kind === "receivables"
      ? "Due date = invoice date + payment term (Zahlungsziel); outstanding = gross − paid " +
          "(sevDesk's paidAmount), in each invoice's currency."
      : "Due date = the voucher's payment deadline (Fälligkeit); outstanding = gross − paid " +
          "(sevDesk's paidAmount), in each voucher's currency. Only expense vouchers (Ausgaben) " +
          "with status open or partially paid count; transferred ones (Überwiesen) count as " +
          "paid, and recurring templates (RV) are not read (voucherType=VOU).",
  );
  const approximate = open.items.filter((item) => item.quality === "approximate").length;
  const wrongSign = open.items.filter((item) => item.paidWrongSign === true).length;
  const unknown = open.items.filter((item) => item.quality === "unknown").length - wrongSign;
  if (approximate > 0) {
    notes.push(
      `${plural(approximate, `open ${noun}`)} without a usable paid amount (sevDesk's paid ` +
        "amount is only reliable in the account currency, EUR) count with their full gross, " +
        "marked approximate.",
    );
  }
  if (unknown > 0) {
    notes.push(
      `${plural(unknown, noun)} with an unknown outstanding amount (partially paid without a ` +
        "usable paid amount, or no gross from sevDesk) are listed under unknown and are not in " +
        "outstanding.",
    );
  }
  if (wrongSign > 0) {
    notes.push(
      `${plural(wrongSign, noun)} have a negative paid amount (a payment booked with the wrong ` +
        "sign); their outstanding amount is unknown and not in outstanding.",
    );
  }
  if (open.excluded.cancellations > 0) {
    notes.push(
      `${plural(open.excluded.cancellations, "cancellation invoice")} (SR, Stornorechnung) were ` +
        "left out; a cancelled invoice keeps status paid in sevDesk and is not open.",
    );
  }
  if (open.excluded.settled > 0) {
    notes.push(
      `${plural(open.excluded.settled, noun)} listed as open with nothing left to pay (paid ≥ ` +
        "gross) were left out.",
    );
  }
  if (open.excluded.mismatched > 0) {
    notes.push(
      `${plural(open.excluded.mismatched, "row")} sevDesk returned did not match the requested ` +
        "status or kind and were left out.",
    );
  }
  if (open.excluded.templates > 0) {
    notes.push(
      kind === "receivables"
        ? `${plural(open.excluded.templates, "recurring invoice template")} (WKR, Abo-Rechnung) ` +
            "were left out: the invoices they generate are the receivables."
        : `${plural(open.excluded.templates, "recurring voucher template")} (RV) were left out: ` +
            "the vouchers they generate are the payables.",
    );
  }
  if (open.excluded.reminders > 0) {
    notes.push(
      `${plural(open.excluded.reminders, "reminder")} (MA, Mahnung) were left out: a reminder ` +
        "repeats the amount of the invoice it reminds of, which is counted itself.",
    );
  }
  if (open.credits.length > 0) {
    notes.push(
      kind === "receivables"
        ? `${plural(open.credits.length, "open invoice")} with a negative gross mean money owed ` +
            "to the customer, not a receivable; they are listed in owedToCustomers."
        : `${plural(open.credits.length, "open voucher")} with a negative gross mean money the ` +
            "supplier owes back, not a payable; they are listed in owedBySuppliers.",
    );
  }
  return notes;
}
