/**
 * Check `duplicates` of `sevdesk_records_audit`: vouchers booked twice, and drafts stuck for weeks.
 *
 * What it reads: the vouchers (Belege) dated from {@link NUMBER_LOOKBACK_DAYS} days before the
 * period to its end, drafts included (`supplier-bills.ts`), and the invoice and credit note drafts
 * dated in the period. No positions. To confirm possible duplicates it reads the receipt checksum
 * of at most {@link MAX_RECEIPT_HASH_VOUCHERS} vouchers (two reads each, see below).
 *
 * The rules. Two vouchers are compared only when they have the same supplier (`supplierKey`: the
 * contact, else the supplier name; a voucher with neither is not compared) and the same direction
 * (expense or revenue). A pair is reported in the period of its later voucher (by date, then id),
 * so consecutive audits do not report it twice.
 * - **Same document number** (`voucher_number_twice`): both carry the same number (sevDesk's
 *   description field, compared without case, spaces and `-_/.#`), dated at most
 *   {@link NUMBER_WINDOW_DAYS} days apart. Only a number with a digit counts: "Miete" or "Telefon"
 *   typed as the description is a text, not a number. The window keeps out a description
 *   repeated on every monthly bill ("Miete 2026", a contract or customer number): those bills
 *   lie about four weeks apart, while the same invoice booked twice is dated the same day or,
 *   booked once more by its payment, within a two-week payment term. Two vouchers
 *   whose amounts cancel each other out (+x and −x) are a reversal, not a duplicate.
 * - **Same amount within a few days** (`voucher_amount_twice`): the same gross amount in the same
 *   currency (`sameGross`, the comparison of the draft duplicate warning in
 *   `src/domain/drafts/duplicates.ts`), dated at most {@link AMOUNT_WINDOW_DAYS} days apart, and not
 *   told apart by two different numbers. A gross of 0 doubles nothing and is not compared.
 * - **Same receipt file** (`voucher_receipt_twice`): a same-amount pair whose receipt files have
 *   the same SHA-256 checksum. The checksum costs two reads per voucher (`GET /Voucher/{id}` for
 *   the attached document, `GET /Document/{id}` for its `contentHash`), so it is read only for the
 *   vouchers of same-amount pairs, at most {@link MAX_RECEIPT_HASH_VOUCHERS} of them, in the order
 *   of the pairs' dates, and never after the time budget. Different checksums prove nothing (the
 *   same paper scanned twice gives two files), so the pair then stays a `check`.
 * - Booked means any status but draft (open, transferred, partially paid, paid). A pair of a
 *   draft and a booked voucher is `draft_repeats_voucher`, a pair of two drafts `draft_twice`.
 * - **Drafts across suppliers**: a pair that involves a draft is also found without comparing
 *   the supplier: the same direction, the same document number (with a digit, at most
 *   {@link NUMBER_WINDOW_DAYS} days apart) and the same gross amount (not 0). sevDesk's receipt
 *   recognition (`Voucher/Factory/createVoucherFromFile`) fills in the PDF's date, invoice number
 *   and sums, but names no supplier contact and a supplier name that is not the PDF's supplier
 *   (recorded 2026-11-16, spec/deviations.md D-103 on main): the same PDF reaching sevDesk twice
 *   gives two drafts, or a draft next to the booked voucher, under different suppliers or none.
 * - **Stuck drafts** (`voucher_draft_stuck`, `sales_draft_stuck`): a voucher, invoice or credit
 *   note dated in the period that is still a draft and was created at least
 *   {@link STUCK_DRAFT_DAYS} days before today (sevDesk's `create` date; the document date when
 *   sevDesk sends none). The creation date and not the document date decides: a receipt dated in
 *   January but uploaded yesterday is not stuck.
 *
 * Sales invoices are not paired: their numbers come from sevDesk's own number range, an invoice
 * issued twice is corrected with a cancellation invoice (which a pair rule would have to match
 * up), and an invoice created twice through this server is already warned about when the draft is
 * created. Their drafts are checked for being stuck, since an unsent invoice is revenue not billed.
 * To find them, every invoice and credit note dated in the period is listed (one request per
 * 1,000) and the drafts are picked out here: `GET /Invoice` and `GET /CreditNote` declare a
 * `status` filter, but no recording shows that `status=100` returns only drafts, so it is not
 * sent.
 */
import { berlinDateOf } from "../../../sevdesk/dates.js";
import { SevdeskError } from "../../../sevdesk/errors.js";
import { fetchVoucherReceiptHash } from "../../document-files.js";
import { sameGross } from "../../drafts/duplicates.js";
import { compare, isZero, negate } from "../../money.js";
import { type DocumentHeader, listDocumentHeaders } from "../positions-scan.js";
import { daysBetween, deadlineReached, plural, shiftDays, throwIfAborted } from "../shared.js";
import {
  type AuditCheckContext,
  type AuditCheckResult,
  type AuditContact,
  byDateThenId,
  excludedOf,
  type FindingDraft,
  type FindingText,
} from "./findings.js";
import { contactOf, inPeriod, listVoucherRows, supplierKey } from "./supplier-bills.js";

/** Two vouchers with the same amount count as a possible duplicate up to this many days apart. */
export const AMOUNT_WINDOW_DAYS = 5;
/**
 * Two vouchers with the same document number count as booked twice up to this many days apart:
 * more than a two-week payment term, less than the four weeks between two monthly bills.
 */
const NUMBER_WINDOW_DAYS = 21;
/** How far before the period vouchers are read to find the earlier one of a pair. */
const NUMBER_LOOKBACK_DAYS = 31;
/** A draft created this many days before today or earlier counts as stuck. */
export const STUCK_DRAFT_DAYS = 21;
/** Vouchers whose receipt checksum is read to confirm same-amount pairs (two reads each). */
export const MAX_RECEIPT_HASH_VOUCHERS = 40;

export const DUPLICATE_FINDING_CODES = [
  "voucher_number_twice",
  "voucher_receipt_twice",
  "voucher_amount_twice",
  "draft_repeats_voucher",
  "draft_twice",
  "voucher_draft_stuck",
  "sales_draft_stuck",
] as const;

type DuplicateFindingCode = (typeof DUPLICATE_FINDING_CODES)[number];

const UNDO =
  "Keep one and undo the other in sevDesk; ask your tax adviser how to correct a voucher that " +
  "is already enshrined (festgeschrieben).";

const TEXTS: Readonly<Record<DuplicateFindingCode, FindingText>> = {
  voucher_number_twice: {
    severity: "warning",
    title: "Voucher booked twice: same supplier and document number",
    titleDe: "Beleg doppelt gebucht: gleicher Lieferant und gleiche Belegnummer",
    reason:
      "Booked vouchers of the same supplier and direction, dated at most " +
      `${String(NUMBER_WINDOW_DAYS)} days apart, carry the same document number. A ` +
      "supplier issues each invoice number once (§ 14 Abs. 4 Satz 1 Nr. 4 UStG), so the same " +
      "invoice is probably booked twice and its amount and VAT counted twice. Where the amounts " +
      "differ, one may be a corrected invoice that replaced the other.",
    action: `Compare the vouchers with the receipt. ${UNDO}`,
  },
  voucher_receipt_twice: {
    severity: "warning",
    title: "Same receipt file booked twice",
    titleDe: "Gleiche Belegdatei doppelt gebucht",
    reason:
      `Booked vouchers of the same supplier with the same gross amount, at most ` +
      `${String(AMOUNT_WINDOW_DAYS)} days apart, carry receipt files with the same SHA-256 ` +
      "checksum: the same file was uploaded twice, so its amount and VAT are probably counted " +
      "twice.",
    action: `Open the vouchers and check that they are the same receipt. ${UNDO}`,
  },
  voucher_amount_twice: {
    severity: "check",
    title: "Possible duplicate: same supplier and amount within a few days",
    titleDe: "Mögliche Doppelbuchung: gleicher Lieferant und Betrag innerhalb weniger Tage",
    reason:
      `Booked vouchers of the same supplier and direction with the same gross amount, dated at ` +
      `most ${String(AMOUNT_WINDOW_DAYS)} days apart, and no two different document numbers ` +
      "that would tell them apart. Often the same receipt booked twice (from the e-mail and " +
      "from the scan); repeated purchases of the same amount are the legitimate case.",
    action:
      "Compare the vouchers with the receipts. If they are the same receipt, keep one and undo " +
      "the other; otherwise enter each receipt's own number so they are told apart.",
  },
  draft_repeats_voucher: {
    severity: "check",
    title: "Draft repeats a booked voucher",
    titleDe: "Entwurf wiederholt einen gebuchten Beleg",
    reason:
      "A draft voucher carries the same document number as a booked voucher, at most " +
      `${String(NUMBER_WINDOW_DAYS)} days apart, and either the same supplier or the same ` +
      "gross amount (under another supplier or none: sevDesk's receipt recognition does not " +
      "name the supplier's contact); or it has the same supplier and gross amount within " +
      `${String(AMOUNT_WINDOW_DAYS)} days. Usually the same receipt reached sevDesk twice ` +
      "(upload, e-mail inbox, receipt recognition); booking the draft would count it twice.",
    action:
      "Compare the draft with the booked voucher; if it is the same receipt, delete the draft " +
      "instead of booking it.",
  },
  draft_twice: {
    severity: "check",
    title: "Draft repeats another draft",
    titleDe: "Entwurf wiederholt einen anderen Entwurf",
    reason:
      "Two draft vouchers of the same direction carry the same document number, at most " +
      `${String(NUMBER_WINDOW_DAYS)} days apart, and either the same supplier or the same ` +
      "gross amount (whatever supplier sevDesk's receipt recognition named); or they have the " +
      `same supplier and gross amount within ${String(AMOUNT_WINDOW_DAYS)} days. Usually the ` +
      "same receipt reached sevDesk twice (upload, e-mail inbox, receipt recognition); booking " +
      "both would count it twice.",
    action:
      "Compare the drafts with the receipt; if they are the same receipt, delete one and book " +
      "the other.",
  },
  voucher_draft_stuck: {
    severity: "check",
    title: `Voucher draft open for ${String(STUCK_DRAFT_DAYS)} days or more`,
    titleDe: `Belegentwurf seit mindestens ${String(STUCK_DRAFT_DAYS)} Tagen offen`,
    reason:
      `The voucher was created at least ${String(STUCK_DRAFT_DAYS)} days ago and is still a ` +
      "draft. Drafts are not booked: the amount and its VAT are missing from the books, the " +
      "reports and the UStVA until the voucher is booked.",
    action:
      "Complete and book the voucher, or delete the draft if it is not needed (for example a " +
      "receipt uploaded twice).",
  },
  sales_draft_stuck: {
    severity: "check",
    title: `Invoice or credit note draft open for ${String(STUCK_DRAFT_DAYS)} days or more`,
    titleDe: `Rechnungs- oder Gutschriftsentwurf seit mindestens ${String(STUCK_DRAFT_DAYS)} Tagen offen`,
    reason:
      `The document was created at least ${String(STUCK_DRAFT_DAYS)} days ago and is still a ` +
      "draft, so it was not issued: the customer has not been billed and the amount is missing " +
      "from the books. An invoice for a supply to a business is due within six months of the " +
      "supply (§ 14 Abs. 2 Satz 1 Nr. 2 UStG).",
    action: "Finalize and send it, or delete the draft if it is not needed.",
  },
};

/** sevDesk's voucher draft status (`positions-scan.ts` leaves drafts out by it as well). */
const VOUCHER_DRAFT = 50;

// ---------------------------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------------------------

/** A document number as compared: upper case without spaces and `-_/.#`; must hold a digit. */
export function numberKey(number: string | undefined): string | undefined {
  if (number === undefined) return undefined;
  const key = number.toUpperCase().replace(/[\s\-_/.#]/g, "");
  return /\d/.test(key) ? key : undefined;
}

/** How a pair was found: per supplier by number or amount, or across suppliers (drafts). */
type PairRule = "number" | "amount" | "number_and_amount";

interface VoucherPair {
  readonly rule: PairRule;
  /** The earlier voucher (by date, then id). */
  readonly first: DocumentHeader;
  /** The later voucher, which decides the period. */
  readonly second: DocumentHeader;
  readonly contact: AuditContact | undefined;
}

const isDraft = (header: DocumentHeader): boolean => header.statusCode === VOUCHER_DRAFT;

/** Two amounts that cancel each other out: a voucher and its reversal. */
function reverses(a: DocumentHeader, b: DocumentHeader): boolean {
  return (
    a.currency === b.currency &&
    a.gross !== undefined &&
    b.gross !== undefined &&
    !isZero(a.gross) &&
    compare(a.gross, negate(b.gross)) === 0
  );
}

/** Whether both are dated and at most `days` days apart. */
function within(a: DocumentHeader, b: DocumentHeader, days: number): boolean {
  return (
    a.date !== undefined && b.date !== undefined && Math.abs(daysBetween(a.date, b.date)) <= days
  );
}

/** `[earlier, later]` by date, then id. */
function ordered(a: DocumentHeader, b: DocumentHeader): [DocumentHeader, DocumentHeader] {
  return byDateThenId(a, b) <= 0 ? [a, b] : [b, a];
}

function pairKey(pair: VoucherPair): string {
  return `${String(pair.first.id)}|${String(pair.second.id)}`;
}

/** The pairs among the vouchers of one supplier and direction, sorted by date. */
function pairsOf(
  vouchers: readonly DocumentHeader[],
  contact: AuditContact | undefined,
): VoucherPair[] {
  const pairs: VoucherPair[] = [];
  const seen = new Set<string>();
  const add = (rule: PairRule, a: DocumentHeader, b: DocumentHeader): void => {
    const [first, second] = ordered(a, b);
    const pair = { rule, first, second, contact };
    if (seen.has(pairKey(pair))) return;
    seen.add(pairKey(pair));
    pairs.push(pair);
  };

  const byNumber = new Map<string, DocumentHeader[]>();
  for (const voucher of vouchers) {
    const key = numberKey(voucher.number);
    if (key === undefined) continue;
    byNumber.set(key, [...(byNumber.get(key) ?? []), voucher]);
  }
  for (const same of byNumber.values()) {
    for (let i = 0; i < same.length; i += 1) {
      for (let j = i + 1; j < same.length; j += 1) {
        const a = same[i];
        const b = same[j];
        if (a === undefined || b === undefined || reverses(a, b)) continue;
        if (!within(a, b, NUMBER_WINDOW_DAYS)) continue;
        add("number", a, b);
      }
    }
  }

  // `vouchers` is sorted by date, so the window ends at the first one too far away.
  for (let i = 0; i < vouchers.length; i += 1) {
    const a = vouchers[i];
    if (a?.date === undefined || a.gross === undefined || isZero(a.gross)) continue;
    for (let j = i + 1; j < vouchers.length; j += 1) {
      const b = vouchers[j];
      if (b?.date === undefined) continue;
      if (daysBetween(a.date, b.date) > AMOUNT_WINDOW_DAYS) break;
      if (!sameGross(a, b)) continue;
      const numbers = [numberKey(a.number), numberKey(b.number)];
      if (numbers[0] !== undefined && numbers[1] !== undefined && numbers[0] !== numbers[1]) {
        continue;
      }
      add("amount", a, b);
    }
  }
  return pairs.sort((x, y) => byDateThenId(x.second, y.second) || byDateThenId(x.first, y.first));
}

/** The pairs whose later voucher is dated in the period, over all suppliers. */
function findPairs(
  context: AuditCheckContext,
  vouchers: readonly DocumentHeader[],
): { readonly pairs: VoucherPair[]; readonly withoutSupplier: number } {
  const groups = new Map<string, DocumentHeader[]>();
  let withoutSupplier = 0;
  for (const voucher of vouchers) {
    const supplier = supplierKey(voucher);
    if (supplier === undefined) {
      if (inPeriod(context, voucher.date)) withoutSupplier += 1;
      continue;
    }
    const key = `${supplier}|${voucher.direction ?? "unknown"}`;
    groups.set(key, [...(groups.get(key) ?? []), voucher]);
  }
  const pairs: VoucherPair[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(byDateThenId);
    const [first] = sorted;
    if (first === undefined) continue;
    // One contact per supplier, so a pair typed with two spellings of a name stays one finding.
    const contact = contactOf(first);
    for (const pair of pairsOf(sorted, contact)) {
      if (inPeriod(context, pair.second.date)) pairs.push(pair);
    }
  }
  // A pair already found per supplier keeps its rule and contact.
  const seen = new Set(pairs.map(pairKey));
  for (const pair of draftPairsAcrossSuppliers(vouchers)) {
    if (seen.has(pairKey(pair)) || !inPeriod(context, pair.second.date)) continue;
    seen.add(pairKey(pair));
    pairs.push(pair);
  }
  return {
    pairs: pairs.sort((x, y) => byDateThenId(x.second, y.second)),
    withoutSupplier,
  };
}

/**
 * The pairs that involve a draft, found without comparing the supplier (see the module doc): the
 * same direction, the same document number at most {@link NUMBER_WINDOW_DAYS} days apart and the
 * same gross amount, not 0. Vouchers without any supplier take part.
 */
function draftPairsAcrossSuppliers(vouchers: readonly DocumentHeader[]): VoucherPair[] {
  const byNumber = new Map<string, DocumentHeader[]>();
  for (const voucher of vouchers) {
    const key = numberKey(voucher.number);
    if (key === undefined || voucher.gross === undefined || isZero(voucher.gross)) continue;
    const group = `${key}|${voucher.direction ?? "unknown"}`;
    byNumber.set(group, [...(byNumber.get(group) ?? []), voucher]);
  }
  const pairs: VoucherPair[] = [];
  for (const same of byNumber.values()) {
    if (!same.some(isDraft)) continue;
    const sorted = [...same].sort(byDateThenId);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        if (a === undefined || b === undefined || (!isDraft(a) && !isDraft(b))) continue;
        if (!sameGross(a, b) || !within(a, b, NUMBER_WINDOW_DAYS)) continue;
        const [first, second] = ordered(a, b);
        pairs.push({ rule: "number_and_amount", first, second, contact: pairContact(a, b) });
      }
    }
  }
  return pairs;
}

/**
 * The contact a pair across suppliers is listed under: one with a contact id first (the booked
 * voucher's before a draft's), else the first known by name.
 */
function pairContact(a: DocumentHeader, b: DocumentHeader): AuditContact | undefined {
  const rank = (header: DocumentHeader): number =>
    (header.contact?.id === undefined ? 2 : 0) + (isDraft(header) ? 1 : 0);
  const [best, other] = rank(a) <= rank(b) ? [a, b] : [b, a];
  return contactOf(best) ?? contactOf(other);
}

// ---------------------------------------------------------------------------------------------
// Receipt checksums
// ---------------------------------------------------------------------------------------------

interface HashReads {
  readonly hashes: ReadonlyMap<number, string | undefined>;
  /** Vouchers of same-amount pairs whose checksum was not read (cap or time budget). */
  readonly notRead: number;
  readonly failed: number;
  readonly timedOut: boolean;
}

/** Reads the receipt checksums of the vouchers of `pairs`, bounded (see the module doc). */
async function readReceiptHashes(
  context: AuditCheckContext,
  pairs: readonly VoucherPair[],
): Promise<HashReads> {
  const ids: number[] = [];
  for (const pair of pairs) {
    for (const header of [pair.first, pair.second]) {
      if (!ids.includes(header.id)) ids.push(header.id);
    }
  }
  const cap = MAX_RECEIPT_HASH_VOUCHERS;
  const hashes = new Map<number, string | undefined>();
  let failed = 0;
  let timedOut = false;
  for (const id of ids.slice(0, cap)) {
    throwIfAborted(context.options.signal);
    if (deadlineReached(context.options.deadline)) {
      timedOut = true;
      break;
    }
    try {
      hashes.set(id, await fetchVoucherReceiptHash(context.client, id, context.options.signal));
    } catch (error) {
      // A receipt that cannot be read leaves its pair a `check`; cancellation still stops.
      if (!(error instanceof SevdeskError) || error.kind === "aborted") throw error;
      failed += 1;
      hashes.set(id, undefined);
    }
  }
  return { hashes, notRead: ids.length - hashes.size, failed, timedOut };
}

function sameReceipt(pair: VoucherPair, hashes: ReadonlyMap<number, string | undefined>): boolean {
  const a = hashes.get(pair.first.id);
  return a !== undefined && a === hashes.get(pair.second.id);
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

function codeOf(pair: VoucherPair, confirmed: boolean): DuplicateFindingCode {
  if (isDraft(pair.first) && isDraft(pair.second)) return "draft_twice";
  if (isDraft(pair.first) || isDraft(pair.second)) return "draft_repeats_voucher";
  if (pair.rule === "number") return "voucher_number_twice";
  return confirmed ? "voucher_receipt_twice" : "voucher_amount_twice";
}

/** Whether a draft dated in the period is old enough to count as stuck. */
function stuck(header: DocumentHeader, today: string): boolean {
  const created = header.createdAt ?? header.date;
  return created !== undefined && daysBetween(created, today) >= STUCK_DRAFT_DAYS;
}

async function runDuplicatesCheck(context: AuditCheckContext): Promise<AuditCheckResult> {
  const { period } = context;
  const today = context.today ?? berlinDateOf(Date.now());
  const vouchers = await listVoucherRows(
    context,
    shiftDays(period.from, -NUMBER_LOOKBACK_DAYS),
    period.to,
  );
  const sales = await listDocumentHeaders(
    context.client,
    {
      from: period.from,
      to: period.to,
      kinds: ["invoice", "credit_note"],
      keepDrafts: true,
      maxRows: context.limits?.maxRows,
      today: context.today,
    },
    context.options,
  );

  const all = [...vouchers.booked, ...vouchers.drafts];
  const { pairs, withoutSupplier } = findPairs(context, all);
  const amountPairs = pairs.filter(
    (pair) => pair.rule === "amount" && !isDraft(pair.first) && !isDraft(pair.second),
  );
  const reads =
    amountPairs.length === 0
      ? { hashes: new Map<number, string | undefined>(), notRead: 0, failed: 0, timedOut: false }
      : await readReceiptHashes(context, amountPairs);

  // One draft per document and code: a voucher in two pairs of the same kind is listed once.
  const drafts: FindingDraft[] = [];
  const listed = new Set<string>();
  const push = (
    code: DuplicateFindingCode,
    header: DocumentHeader,
    contact?: AuditContact,
  ): void => {
    const key = `${code}|${header.kind}|${String(header.id)}`;
    if (listed.has(key)) return;
    listed.add(key);
    drafts.push({ code, text: TEXTS[code], contact: contact ?? contactOf(header), header });
  };
  for (const pair of pairs) {
    const code = codeOf(pair, sameReceipt(pair, reads.hashes));
    push(code, pair.first, pair.contact);
    push(code, pair.second, pair.contact);
  }
  const stuckVouchers = vouchers.drafts.filter(
    (header) => inPeriod(context, header.date) && stuck(header, today),
  );
  const stuckSales = sales.drafts.filter((header) => stuck(header, today));
  for (const header of stuckVouchers) push("voucher_draft_stuck", header);
  for (const header of stuckSales) push("sales_draft_stuck", header);

  const inScope =
    all.filter((header) => inPeriod(context, header.date)).length + sales.drafts.length;
  const truncated = vouchers.listed.truncated || sales.truncated;
  const notes: string[] = [
    `Vouchers are compared per supplier and direction: the same document number (with a digit) ` +
      `at most ${String(NUMBER_WINDOW_DAYS)} days apart, or the same gross amount at most ` +
      `${String(AMOUNT_WINDOW_DAYS)} days apart. A pair that involves a draft is also found ` +
      "across suppliers, by the same number and gross amount. Vouchers dated up to " +
      `${String(NUMBER_LOOKBACK_DAYS)} days before the period were read; a pair counts in the ` +
      "period of its later voucher. Drafts count as stuck " +
      `${String(STUCK_DRAFT_DAYS)} days after they were created (as of ${today}); every invoice ` +
      "and credit note dated in the period was listed to find their drafts. Sales " +
      "invoices are checked for stuck drafts only.",
  ];
  if (amountPairs.length > 0) {
    const read = reads.hashes.size;
    let text =
      `Receipt files were compared by SHA-256 checksum for ${plural(read, "voucher")} of ` +
      "same-amount pairs (two reads each)";
    if (reads.timedOut) {
      text +=
        `; the time budget stopped it, ${plural(reads.notRead, "voucher")} not compared ` +
        "(those pairs stay possible duplicates)";
    } else if (reads.notRead > 0) {
      text +=
        `; the scan was cut at ${String(MAX_RECEIPT_HASH_VOUCHERS)} vouchers, ` +
        `${plural(reads.notRead, "voucher")} not compared (those pairs stay possible duplicates)`;
    }
    if (reads.failed > 0) {
      text += `; the receipt of ${plural(reads.failed, "voucher")} could not be read`;
    }
    notes.push(`${text}.`);
  }
  if (withoutSupplier > 0) {
    notes.push(
      `${plural(withoutSupplier, "voucher")} in the period without a supplier (no contact, no ` +
        "supplier name) could be compared only in pairs with a draft, by number and gross amount.",
    );
  }
  if (truncated) {
    notes.push(
      "The scan was cut: listing documents stopped at the cap, so duplicates and drafts may be " +
        "missing. Use a shorter period.",
    );
  }

  return {
    drafts,
    coverage: {
      rowsRead: vouchers.listed.rowsRead + sales.rowsRead,
      documentsInScope: inScope,
      documentsChecked: inScope,
      documentsLeftOut: 0,
      truncated,
      ...(reads.timedOut ? { timeBudgetReached: true } : {}),
      // This check looks at the drafts, so they are not "excluded" here.
      excluded: {
        ...excludedOf(vouchers.listed.excluded),
        drafts: 0,
        recurringTemplates:
          vouchers.listed.excluded.recurring_template + sales.excluded.recurring_template,
        reminders: sales.excluded.reminder,
      },
    },
    notes,
  };
}

/** Check `duplicates`; see the module doc. */
export const duplicatesCheck = {
  label: "vouchers booked twice and stuck drafts",
  summary:
    "vouchers booked twice (same supplier and document number, the same receipt file, or the " +
    `same amount within ${String(AMOUNT_WINDOW_DAYS)} days), drafts that repeat a booked ` +
    `voucher or another draft (also across suppliers), and voucher, invoice and credit note ` +
    `drafts open for ${String(STUCK_DRAFT_DAYS)} ` +
    "days or more",
  codes: DUPLICATE_FINDING_CODES,
  run: runDuplicatesCheck,
};
