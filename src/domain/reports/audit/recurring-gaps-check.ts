/**
 * Check `recurring_gaps` of `sevdesk_records_audit`: suppliers that bill at a regular rhythm
 * (monthly, quarterly, yearly) with a bill missing inside the audited period, which usually means
 * a lost or unbooked receipt.
 *
 * What it reads: the expense vouchers (booked and drafts, `supplier-bills.ts`) dated from
 * {@link LOOKBACK_MONTHS} months before the period to {@link LOOKAHEAD_MONTHS} months after it, but
 * not after today. Date windows of at most 1,000 vouchers per list request, no positions. When
 * the listing is cut by its row cap, or a day had to be read page by page (D-100), no gap is
 * reported at all, since a voucher not read would look like a gap.
 *
 * The rhythm comes from the vouchers themselves, per supplier ({@link findGaps}); amounts are not
 * compared, so a price change does not matter. It is learned anew for each month of the period,
 * from the supplier's bills around that month only ({@link RHYTHMS}: 12 months before and after
 * it, for yearly bills 24 before), so a supplier that changed its rhythm (monthly, then
 * quarterly) is judged by its bills of that time and not by three years at once. For each rhythm
 * of 1, 3 and 12 months, the first that fits those bills wins:
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
 * - A missing period belongs to the audit when the day its bill was expected lies in the period:
 *   the typical day in the period's month, or that month's last day when it is shorter (a bill of
 *   the 31st is expected on 30 June, not on 1 July).
 *
 * sevDesk's recurring vouchers (RV) are templates, not bills: they are not read, and the vouchers
 * booked from them count like any other voucher. Vouchers without a supplier are not checked; a
 * voucher known only by its supplier name counts for the contact whose vouchers carry that name
 * (`supplierKeysJoiningNames`), so one bill booked without the contact leaves no gap.
 */
import { berlinDateOf } from "../../../sevdesk/dates.js";
import { type DocumentHeader, pagedRangesNote } from "../positions-scan.js";
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
import { contactOf, listVoucherRows, supplierKeysJoiningNames } from "./supplier-bills.js";

/** Months read before the period to learn each supplier's rhythm. */
export const LOOKBACK_MONTHS = 24;
/** Months read after the period (not after today) to tell a gap from a supplier that stopped. */
export const LOOKAHEAD_MONTHS = 12;
/** A bill counts as on time within this many days of the supplier's typical day. */
const ON_TIME_DAYS = 7;
/** Months of bills around a month that teach a monthly or quarterly rhythm there. */
const LEARN_MONTHS = 12;
/**
 * A month more on each side of those windows, so a bill dated just across the window's edge (the
 * bill of the 31st arriving on the 2nd) still counts for its own month.
 */
const EDGE_MONTHS = 1;

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
  /**
   * Months of bills before and after a month that the rhythm is learned from there; yearly bills
   * need {@link LOOKBACK_MONTHS} to show two years before a gap.
   */
  readonly learnBefore: number;
  readonly learnAfter: number;
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
    learnBefore: LEARN_MONTHS,
    learnAfter: LEARN_MONTHS,
    noun: "month",
    title: "Monthly bill missing",
    titleDe: "Monatsrechnung fehlt",
  },
  {
    code: "quarterly_bill_missing",
    months: 3,
    before: 2,
    learnBefore: LEARN_MONTHS,
    learnAfter: LEARN_MONTHS,
    noun: "quarter",
    title: "Quarterly bill missing",
    titleDe: "Quartalsrechnung fehlt",
  },
  {
    code: "yearly_bill_missing",
    months: 12,
    before: 2,
    learnBefore: LOOKBACK_MONTHS,
    learnAfter: LOOKAHEAD_MONTHS,
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

/** `YYYY-MM-DD` of day `day` in month `index`; `day` must exist in that month. */
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
  /** The rhythm the bills around the gap follow. */
  readonly rhythm: Rhythm;
  /** The month (YYYY-MM) in which the bill was expected: the period's month. */
  readonly month: string;
  /** The day the bill was expected: the typical day in that month, or its last day. */
  readonly expected: string;
  /** The last bill before the gap and the first after it. */
  readonly before: DocumentHeader;
  readonly after: DocumentHeader;
}

export interface SupplierGaps {
  /**
   * The rhythms found around the months of the period, in the order of {@link RHYTHMS}: usually
   * one, two when the supplier changed its rhythm in that time.
   */
  readonly rhythms: readonly Rhythm[];
  /** Missing periods whose expected day lies in the period, by date; may be empty. */
  readonly gaps: readonly Gap[];
}

/**
 * The rhythm of one supplier's bills around each month of `period` and the periods without a
 * bill (see the module doc for the rules). `bills` are the supplier's vouchers of the whole range
 * read. For each month the rhythm is fitted to the bills of its window (`learnBefore` and
 * `learnAfter` of each rhythm, plus {@link EDGE_MONTHS}), and the month is a gap when it starts a
 * period of that rhythm without a bill. `undefined` when no month shows a rhythm.
 */
export function findGaps(
  bills: readonly DocumentHeader[],
  period: Pick<ReportPeriod, "from" | "to">,
): SupplierGaps | undefined {
  const dated = [...bills]
    .flatMap((bill) => (bill.date === undefined ? [] : [{ bill, month: monthIndex(bill.date) }]))
    .sort((a, b) => byDateThenId(a.bill, b.bill));
  const found = new Set<Rhythm>();
  const gaps: Gap[] = [];
  for (let month = monthIndex(period.from); month <= monthIndex(period.to); month += 1) {
    for (const rhythm of RHYTHMS) {
      const from = month - rhythm.learnBefore - EDGE_MONTHS;
      const to = month + rhythm.learnAfter + EDGE_MONTHS;
      const around = dated.filter((entry) => entry.month >= from && entry.month <= to);
      const fitted = fit(
        around.map((entry) => entry.bill),
        rhythm,
      );
      if (fitted === undefined) continue;
      found.add(rhythm);
      const gap = gapAt(fitted, month);
      if (gap !== undefined && gap.expected >= period.from && gap.expected <= period.to) {
        gaps.push(gap);
      }
      break;
    }
  }
  if (found.size === 0) return undefined;
  return { rhythms: RHYTHMS.filter((rhythm) => found.has(rhythm)), gaps };
}

/** The gap of `found` that starts in month `month` (an index), if that period has no bill. */
function gapAt(found: Fit, month: number): Gap | undefined {
  const { slots, rhythm } = found;
  if (mod(month - found.phase, rhythm.months) !== 0) return undefined;
  const slot = (month - found.phase) / rhythm.months;
  if (slots.has(slot)) return undefined;
  const filled = [...slots.keys()].sort((a, b) => a - b);
  const earlier = filled.filter((index) => index < slot);
  const previous = earlier[earlier.length - 1];
  const next = filled.find((index) => index > slot);
  if (previous === undefined || next === undefined || earlier.length < rhythm.before) {
    return undefined;
  }
  const previousBills = slots.get(previous) ?? [];
  const nextBills = slots.get(next) ?? [];
  // A neighbour with an extra bill covers the gap: the bill came early or late.
  const covered =
    (previous === slot - 1 && previousBills.length > found.usual) ||
    (next === slot + 1 && nextBills.length > found.usual);
  const before = previousBills[previousBills.length - 1];
  const after = nextBills[0];
  if (covered || before === undefined || after === undefined) return undefined;
  // The typical day in the gap's own month, or the month's last day when it is shorter: moving
  // the 15th back by the shift would put a bill of the 31st into the next month.
  const lastDay = Number(lastDayOfMonthIndex(month).slice(8, 10));
  const expected = dayOfMonthIndex(month, Math.min(15 - found.shift, lastDay));
  return {
    rhythm,
    month: monthOf(expected),
    expected,
    before: before.header,
    after: after.header,
  };
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

  const keyOf = supplierKeysJoiningNames(expenses);
  const bySupplier = new Map<string, DocumentHeader[]>();
  let withoutSupplier = 0;
  for (const header of expenses) {
    const key = keyOf(header);
    if (key === undefined) {
      withoutSupplier += 1;
      continue;
    }
    bySupplier.set(key, [...(bySupplier.get(key) ?? []), header]);
  }

  // A day read page by page may miss vouchers (D-100): like a cut listing, it reports no gaps.
  const pagedNote = pagedRangesNote(rows.listed);
  const truncated = rows.listed.truncated || pagedNote !== undefined;
  const drafts: FindingDraft[] = [];
  const rhythms = new Map<GapCode, number>();
  for (const bills of bySupplier.values()) {
    const result = findGaps(bills, context.period);
    if (result === undefined) continue;
    for (const rhythm of result.rhythms) {
      rhythms.set(rhythm.code, (rhythms.get(rhythm.code) ?? 0) + 1);
    }
    // A cut listing makes every missing voucher look like a gap: report none.
    if (truncated) continue;
    // Name the contact when any bill has one (a bill known only by name may have joined it).
    const sorted = [...bills].sort(byDateThenId);
    const named = sorted.find((bill) => bill.contact?.id !== undefined) ?? sorted[0];
    const contact = named === undefined ? undefined : contactOf(named);
    for (const gap of result.gaps) {
      for (const header of [gap.before, gap.after]) {
        drafts.push({
          code: gap.rhythm.code,
          text: textOf(gap.rhythm),
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
      `${String(LOOKAHEAD_MONTHS)} months after it. Each month of the period is judged by the ` +
      `supplier's bills of the ${String(LEARN_MONTHS)} months before and after it (yearly bills: ` +
      `${String(LOOKBACK_MONTHS)} months before), so a changed rhythm counts from when it ` +
      "changed. A period counts as missing only with bills of that supplier before and after " +
      "it, so a supplier that stopped billing, or whose next bill has not come yet, is not " +
      "reported. A voucher with only a supplier name counts for the contact whose vouchers " +
      "carry that name. Amounts are not compared.",
    `Suppliers with a rhythm around the period: ` +
      `${String(rhythms.get("monthly_bill_missing") ?? 0)} monthly, ` +
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
  if (pagedNote !== undefined) {
    notes.push(
      `${pagedNote} A voucher not read would look like a missing bill, so no gaps are reported.`,
    );
  }
  if (rows.listed.truncated) {
    notes.push(
      `The scan was cut: listing vouchers stopped at its cap of ` +
        `${rows.listed.rowsRead.toLocaleString("en-US")} rows, and a voucher not read would look ` +
        "like a missing bill, so no gaps are reported. A shorter period does not help: the " +
        `range read always spans the ${String(LOOKBACK_MONTHS)} months before the period and up ` +
        `to ${String(LOOKAHEAD_MONTHS)} after it, and this account has more vouchers in that ` +
        "range than this check can read.",
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
    "suppliers that bill monthly, quarterly or yearly (learned from each supplier's vouchers " +
    "around the period) with no bill in a period inside the audited range, which usually means " +
    "a lost receipt; a supplier that stopped billing is not reported",
  codes: RECURRING_GAP_FINDING_CODES,
  run: runRecurringGapsCheck,
};
