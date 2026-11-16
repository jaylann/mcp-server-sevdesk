/**
 * Check `recurring_gaps` of `sevdesk_records_audit`: suppliers that bill at a regular rhythm
 * (monthly, quarterly, yearly) with a bill missing inside the audited period, which usually means
 * a lost or unbooked receipt.
 *
 * What it reads: the expense vouchers (booked and drafts, `supplier-bills.ts`) dated from
 * {@link LOOKBACK_MONTHS} months before the period to {@link LOOKAHEAD_MONTHS} months after it, but
 * not after today. One list request per 1,000 vouchers, no positions. When the listing is cut by
 * its row cap no gap is reported at all, since a voucher not read would look like a gap.
 *
 * The rhythm comes from the vouchers themselves, per supplier ({@link findGaps}); amounts are not
 * compared, so a price change does not matter. For each rhythm of 1, 3 and 12 months, the first
 * that fits wins:
 * - The supplier's typical day is the median day of month of its bills. Every bill is moved by
 *   (15 − typical day) days before it is put into a calendar month, so a bill that moved a few days
 *   across a month end stays in its own period (a bill of the 31st arriving on the 2nd).
 * - Quarterly and yearly bills must fall in the same month of the quarter or year (the most common
 *   one): at least three in four bills.
 * - Regular: at least three in four of the periods with bills hold the supplier's usual number of
 *   bills (usually one), at least three in four bills lie within {@link ON_TIME_DAYS} days of the
 *   typical day, and at most one in four periods between the first and the last bill is empty.
 * - Enough evidence: a period counts as missing only when it lies between the supplier's first and
 *   last bill, with at least `before` periods with bills before it ({@link RHYTHMS}: 3 monthly, 2
 *   quarterly or yearly) and at least one after it. A supplier that simply stopped billing has
 *   none after it and is not reported, and the latest period is reported only once a later bill
 *   exists.
 * - A period next to a gap that holds more bills than usual covers the gap: the bill came late or
 *   early (two bills in one month), so nothing is missing.
 * - A missing period belongs to the audit when the day its bill was expected (the typical day in
 *   that month) lies in the period.
 *
 * sevDesk's recurring vouchers (RV) are templates, not bills: they are not read, and the vouchers
 * booked from them count like any other voucher. Vouchers without a supplier are not checked.
 */
import { berlinDateOf } from "../../../sevdesk/dates.js";
import type { DocumentHeader } from "../positions-scan.js";
import { monthOf, plural, shiftDays } from "../shared.js";
import type { ReportPeriod } from "../vat.js";
import {
  type AuditCheckContext,
  type AuditCheckResult,
  byDateThenId,
  excludedOf,
  type FindingDraft,
  type FindingText,
} from "./findings.js";
import { contactOf, listVoucherRows, supplierKey } from "./supplier-bills.js";

/** Months read before the period to learn each supplier's rhythm. */
export const LOOKBACK_MONTHS = 24;
/** Months read after the period (not after today) to tell a gap from a supplier that stopped. */
export const LOOKAHEAD_MONTHS = 12;
/** A bill counts as on time within this many days of the supplier's typical day. */
const ON_TIME_DAYS = 7;

export const RECURRING_GAP_FINDING_CODES = [
  "monthly_bill_missing",
  "quarterly_bill_missing",
  "yearly_bill_missing",
] as const;

type GapCode = (typeof RECURRING_GAP_FINDING_CODES)[number];

interface Rhythm {
  readonly code: GapCode;
  /** Length in months. */
  readonly months: number;
  /** Periods with bills needed before a gap. */
  readonly before: number;
  readonly noun: string;
  readonly title: string;
  readonly titleDe: string;
}

/** The rhythms, tried in this order. */
const RHYTHMS: readonly Rhythm[] = [
  {
    code: "monthly_bill_missing",
    months: 1,
    before: 3,
    noun: "month",
    title: "Monthly bill missing",
    titleDe: "Monatsrechnung fehlt",
  },
  {
    code: "quarterly_bill_missing",
    months: 3,
    before: 2,
    noun: "quarter",
    title: "Quarterly bill missing",
    titleDe: "Quartalsrechnung fehlt",
  },
  {
    code: "yearly_bill_missing",
    months: 12,
    before: 2,
    noun: "year",
    title: "Yearly bill missing",
    titleDe: "Jahresrechnung fehlt",
  },
];

function textOf(rhythm: Rhythm): FindingText {
  return {
    severity: "check",
    title: rhythm.title,
    titleDe: rhythm.titleDe,
    reason:
      `This supplier bills once a ${rhythm.noun} on about the same day: at least ` +
      `${String(rhythm.before)} ${rhythm.noun}s with a bill before the gap and one after it. No ` +
      "voucher exists for the months listed in missing. A missing bill of a regular supplier " +
      "usually means a lost or unbooked receipt; without the invoice the input VAT cannot be " +
      "deducted (§ 15 Abs. 1 Satz 1 Nr. 1 Satz 2 UStG) and the expense is missing from the books.",
    action:
      "Look for each missing bill (e-mail, the supplier's portal, the bank statement) and book " +
      "it. If the supplier did not bill that time (a pause, a credit, a contract change), " +
      "nothing is missing.",
  };
}

// ---------------------------------------------------------------------------------------------
// Rhythm and gaps (pure)
// ---------------------------------------------------------------------------------------------

/** Months since year 0: 2026-01 → 24312. */
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/** `YYYY-MM-DD` of day `day` (1–28) in month `index`. */
function dayOfMonthIndex(index: number, day: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The last day of month `index`. */
function lastDayOfMonthIndex(index: number): string {
  return shiftDays(dayOfMonthIndex(index + 1, 1), -1);
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

/** At least three in four. */
function mostly(part: number, whole: number): boolean {
  return whole > 0 && part * 4 >= whole * 3;
}

/** The most common value; ties go to the smallest. */
function modeOf(values: readonly number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

interface PlacedBill {
  readonly header: DocumentHeader;
  /** Month index after moving the date by the supplier's shift. */
  readonly month: number;
  /** Day of month after the shift; 15 is the typical day. */
  readonly day: number;
}

interface Fit {
  readonly rhythm: Rhythm;
  /** Days added to a bill's date to put its typical day on the 15th. */
  readonly shift: number;
  readonly phase: number;
  /** Bills per period index (on-phase bills only). */
  readonly slots: ReadonlyMap<number, readonly PlacedBill[]>;
  /** The usual number of bills per period. */
  readonly usual: number;
}

/** Whether `bills` (one supplier, dated, sorted by date) follow `rhythm`. */
function fit(bills: readonly DocumentHeader[], rhythm: Rhythm): Fit | undefined {
  if (bills.length < rhythm.before + 1) return undefined;
  const days = bills.map((bill) => Number((bill.date ?? "").slice(8, 10))).sort((a, b) => a - b);
  const typical = days[Math.floor((days.length - 1) / 2)] ?? 15;
  const shift = 15 - typical;
  const placed: PlacedBill[] = bills.map((header) => {
    const moved = shiftDays(header.date ?? "", shift);
    return { header, month: monthIndex(moved), day: Number(moved.slice(8, 10)) };
  });
  const phase = modeOf(placed.map((bill) => mod(bill.month, rhythm.months))) ?? 0;
  const onPhase = placed.filter((bill) => mod(bill.month - phase, rhythm.months) === 0);
  if (!mostly(onPhase.length, placed.length)) return undefined;

  const slots = new Map<number, PlacedBill[]>();
  for (const bill of onPhase) {
    const slot = (bill.month - phase) / rhythm.months;
    slots.set(slot, [...(slots.get(slot) ?? []), bill]);
  }
  const counts = [...slots.values()].map((list) => list.length);
  const usual = modeOf(counts) ?? 1;
  if (!mostly(counts.filter((count) => count === usual).length, counts.length)) return undefined;
  const onTime = onPhase.filter((bill) => Math.abs(bill.day - 15) <= ON_TIME_DAYS).length;
  if (!mostly(onTime, onPhase.length)) return undefined;
  const indexes = [...slots.keys()];
  const first = Math.min(...indexes);
  const last = Math.max(...indexes);
  if (slots.size < rhythm.before + 1 || !mostly(slots.size, last - first + 1)) return undefined;
  return { rhythm, shift, phase, slots, usual };
}

/** One period without a bill, with the supplier's bills around it. */
interface Gap {
  /** The month (YYYY-MM) of the day the bill was expected. */
  readonly month: string;
  /** The day the bill was expected (the typical day in that month). */
  readonly expected: string;
  /** The last bill before the gap and the first after it. */
  readonly before: DocumentHeader;
  readonly after: DocumentHeader;
}

export interface SupplierGaps {
  readonly rhythm: Rhythm;
  /** Missing periods whose expected day lies in the period; may be empty. */
  readonly gaps: readonly Gap[];
}

/**
 * The rhythm of one supplier's bills and the periods without a bill in `period` (see the module
 * doc for the rules). `bills` are the supplier's vouchers of the whole range read, each dated.
 * `undefined` when the bills follow no rhythm.
 */
export function findGaps(
  bills: readonly DocumentHeader[],
  period: Pick<ReportPeriod, "from" | "to">,
): SupplierGaps | undefined {
  const sorted = [...bills].filter((bill) => bill.date !== undefined).sort(byDateThenId);
  for (const rhythm of RHYTHMS) {
    const found = fit(sorted, rhythm);
    if (found === undefined) continue;
    return { rhythm, gaps: gapsOf(found, period) };
  }
  return undefined;
}

function gapsOf(found: Fit, period: Pick<ReportPeriod, "from" | "to">): Gap[] {
  const { slots, rhythm } = found;
  const filled = [...slots.keys()].sort((a, b) => a - b);
  const first = filled[0] ?? 0;
  const last = filled[filled.length - 1] ?? 0;
  const gaps: Gap[] = [];
  for (let slot = first + 1; slot < last; slot += 1) {
    if (slots.has(slot)) continue;
    const earlier = filled.filter((index) => index < slot);
    const previous = earlier[earlier.length - 1];
    const next = filled.find((index) => index > slot);
    if (previous === undefined || next === undefined || earlier.length < rhythm.before) continue;
    const previousBills = slots.get(previous) ?? [];
    const nextBills = slots.get(next) ?? [];
    // A neighbour with an extra bill covers the gap: the bill came early or late.
    const covered =
      (previous === slot - 1 && previousBills.length > found.usual) ||
      (next === slot + 1 && nextBills.length > found.usual);
    const before = previousBills[previousBills.length - 1];
    const after = nextBills[0];
    if (covered || before === undefined || after === undefined) continue;
    const month = found.phase + slot * rhythm.months;
    const expected = shiftDays(dayOfMonthIndex(month, 15), -found.shift);
    if (expected < period.from || expected > period.to) continue;
    gaps.push({ month: monthOf(expected), expected, before: before.header, after: after.header });
  }
  return gaps;
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

/** The range read: {@link LOOKBACK_MONTHS} before the period to {@link LOOKAHEAD_MONTHS} after. */
export function rangeRead(
  period: Pick<ReportPeriod, "from" | "to">,
  today: string,
): { readonly from: string; readonly to: string } {
  const from = dayOfMonthIndex(monthIndex(period.from) - LOOKBACK_MONTHS, 1);
  const ahead = lastDayOfMonthIndex(monthIndex(period.to) + LOOKAHEAD_MONTHS);
  const latest = today > period.to ? today : period.to;
  return { from, to: ahead < latest ? ahead : latest };
}

async function runRecurringGapsCheck(context: AuditCheckContext): Promise<AuditCheckResult> {
  const today = context.today ?? berlinDateOf(Date.now());
  const range = rangeRead(context.period, today);
  const rows = await listVoucherRows(context, range.from, range.to);
  const expenses = [...rows.booked, ...rows.drafts].filter(
    (header) => header.direction === "expense",
  );

  const bySupplier = new Map<string, DocumentHeader[]>();
  let withoutSupplier = 0;
  for (const header of expenses) {
    const key = supplierKey(header);
    if (key === undefined) {
      withoutSupplier += 1;
      continue;
    }
    bySupplier.set(key, [...(bySupplier.get(key) ?? []), header]);
  }

  const truncated = rows.listed.truncated;
  const drafts: FindingDraft[] = [];
  const rhythms = new Map<GapCode, number>();
  for (const bills of bySupplier.values()) {
    const result = findGaps(bills, context.period);
    if (result === undefined) continue;
    rhythms.set(result.rhythm.code, (rhythms.get(result.rhythm.code) ?? 0) + 1);
    // A cut listing makes every missing voucher look like a gap: report none.
    if (truncated) continue;
    const [first] = [...bills].sort(byDateThenId);
    const contact = first === undefined ? undefined : contactOf(first);
    const text = textOf(result.rhythm);
    for (const gap of result.gaps) {
      for (const header of [gap.before, gap.after]) {
        drafts.push({
          code: result.rhythm.code,
          text,
          contact,
          header,
          context: true,
          missing: gap.month,
        });
      }
    }
  }

  const notes: string[] = [
    `Rhythms are learned from the expense vouchers (booked and drafts) dated ${range.from} to ` +
      `${range.to}: ${String(LOOKBACK_MONTHS)} months before the period and up to ` +
      `${String(LOOKAHEAD_MONTHS)} months after it. A period counts as missing only with bills ` +
      "of that supplier before and after it, so a supplier that stopped billing, or whose next " +
      "bill has not come yet, is not reported. Amounts are not compared.",
    `Suppliers with a rhythm: ${String(rhythms.get("monthly_bill_missing") ?? 0)} monthly, ` +
      `${String(rhythms.get("quarterly_bill_missing") ?? 0)} quarterly, ` +
      `${String(rhythms.get("yearly_bill_missing") ?? 0)} yearly.`,
    "sevDesk's recurring voucher templates (RV) are not bills and were not read; vouchers booked " +
      "from them count like any other voucher.",
  ];
  if (withoutSupplier > 0) {
    notes.push(
      `${plural(withoutSupplier, "expense voucher")} without a supplier (no contact, no supplier ` +
        "name) could not be checked.",
    );
  }
  if (truncated) {
    notes.push(
      "The scan was cut: listing vouchers stopped at the cap, and a voucher not read would look " +
        "like a missing bill, so no gaps are reported. Use a shorter period (the range read is " +
        `the period plus ${String(LOOKBACK_MONTHS)} months before it).`,
    );
  }

  return {
    drafts,
    coverage: {
      rowsRead: rows.listed.rowsRead,
      documentsInScope: expenses.length,
      documentsChecked: expenses.length - withoutSupplier,
      documentsLeftOut: withoutSupplier,
      truncated,
      excluded: { ...excludedOf(rows.listed.excluded), drafts: 0 },
    },
    notes,
  };
}

/** Check `recurring_gaps`; see the module doc. */
export const recurringGapsCheck = {
  label: "missing bills of regular suppliers",
  summary:
    "suppliers that bill monthly, quarterly or yearly (learned from " +
    `${String(LOOKBACK_MONTHS)} months of vouchers) with no bill in a period inside the audited ` +
    "range, which usually means a lost receipt; a supplier that stopped billing is not reported",
  codes: RECURRING_GAP_FINDING_CODES,
  run: runRecurringGapsCheck,
};
