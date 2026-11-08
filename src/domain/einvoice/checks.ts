/**
 * A documented subset of the EN 16931-1 business rules (and of the XRechnung 3.0 national rules
 * `BR-DE-*` when the profile is XRechnung), checked on a parsed e-invoice. This is not a full
 * validator (the official one is the KoSIT validator with the CEN and XRechnung Schematron); it
 * covers what matters before an invoice is booked: required terms, the arithmetic of the totals,
 * the VAT breakdown per category, and the identifiers VAT treatment depends on.
 *
 * Rules checked (rule ids as in EN 16931-1:2017+A1:2019 and XRechnung 3.0):
 * - Required terms: BR-01 (BT-24), BR-06/BR-07 (seller/buyer name), BR-08/BR-09 (seller postal
 *   address, country), BR-10/BR-11 (buyer postal address, country), BR-12–BR-15 (BT-106, BT-109,
 *   BT-112, BT-115; BT-110 is reported with them), BR-16 (at least one line). BR-02–BR-05 (number,
 *   date, type, currency) are enforced by the readers: without them the file is refused.
 * - Totals: BR-CO-10 (BT-106 = Σ BT-131), BR-CO-11 (BT-107 = Σ BT-92), BR-CO-12 (BT-108 =
 *   Σ BT-99), BR-CO-13 (BT-109 = BT-106 − BT-107 + BT-108), BR-CO-14 (BT-110 = Σ BT-117),
 *   BR-CO-15 (BT-112 = BT-109 + BT-110), BR-CO-16 (BT-115 = BT-112 − BT-113 + BT-114). Sums are
 *   rounded to two decimals before comparing, as the CEN Schematron does; values are compared
 *   exactly with the decimal type, never as floats.
 * - VAT breakdown per category C ∈ {S, Z, E, AE, K, G, O, L, M}: BR-C-01 (a category used on a
 *   line, allowance or charge has a breakdown row), BR-C-08 (taxable amount = Σ line net − Σ
 *   allowances + Σ charges of that category, per rate for S/L/M), BR-C-09 / BR-CO-17 (VAT amount:
 *   taxable × rate for S/L/M within the Schematron tolerance of one currency unit; 0 for the
 *   others), BR-C-05 (line VAT rate: above 0 for S, 0 for Z/E/AE/K/G, none for O), BR-C-10
 *   (exemption reason text or code for E/AE/K/G/O).
 * - Identifiers: BR-CO-26 (seller identifier, legal registration or VAT id), BR-S-02 / BR-Z-02 /
 *   BR-E-02 (seller VAT id or tax registration), BR-AE-02 (seller VAT id and buyer VAT id or
 *   legal registration), BR-K-02 (seller and buyer VAT id), BR-G-02 (seller VAT id).
 * - Payment: BR-CO-25 (a positive amount due needs a due date or payment terms).
 * - XRechnung only: BR-DE-1 (payment instructions, BG-16), BR-DE-3/BR-DE-4 (seller city and post
 *   code), BR-DE-8/BR-DE-9 (buyer city and post code), BR-DE-15 (buyer reference BT-10, the
 *   Leitweg-ID for public buyers), BR-DE-23-a (credit transfer needs the payee account, BG-17).
 * - Ours (`SD-…`): SD-PROFILE (MINIMUM / BASIC WL carry no lines and are booking aids, not
 *   invoices under §14 UStG), SD-TYPE (BT-3 is neither an invoice nor a credit note code).
 *
 * Every message is trusted text: it names business terms and may quote amounts, which are
 * validated decimal numbers; it never quotes text from the invoice.
 */
import {
  add,
  compare,
  type Decimal,
  decimal,
  isZero,
  multiply,
  round,
  subtract,
  toDecimalString,
} from "../money.js";
import { CREDIT_TRANSFER_MEANS, PROFILE_LABELS } from "./codes.js";
import { withinTolerance } from "./decimal.js";
import type { EInvoiceContent, EInvoiceFacts } from "./extracted.js";
import type { EInvoiceFinding, VatCategoryCode } from "./model.js";

/** Categories whose breakdown is per rate (several rows per category). */
const PER_RATE: ReadonlySet<VatCategoryCode> = new Set(["S", "L", "M"]);
/** Categories that carry no VAT amount. */
const ZERO_TAX: ReadonlySet<VatCategoryCode> = new Set(["Z", "E", "AE", "K", "G", "O"]);
/** Categories that need an exemption reason (BT-120 or BT-121). */
const NEEDS_EXEMPTION_REASON: ReadonlySet<VatCategoryCode> = new Set(["E", "AE", "K", "G", "O"]);
/** BR-CO-17 tolerance of the CEN Schematron: one currency unit. */
const VAT_AMOUNT_TOLERANCE = "1";

/** Runs the checks of the module doc; findings in rule order, errors before warnings. */
export function checkEInvoice(content: EInvoiceContent, facts: EInvoiceFacts): EInvoiceFinding[] {
  const findings: EInvoiceFinding[] = [];
  const error = (code: string, message: string): void => {
    findings.push({ code, severity: "error", message });
  };
  const warning = (code: string, message: string): void => {
    findings.push({ code, severity: "warning", message });
  };

  checkProfileAndType(content, error, warning);
  // MINIMUM and BASIC WL carry no lines and few required terms: the profile finding says it all.
  if (content.profile === "minimum" || content.profile === "basic_wl") {
    return sortFindings(findings);
  }
  checkRequiredTerms(content, facts, error);
  checkTotals(content, facts, error);
  checkVatBreakdown(content, error);
  checkIdentifiers(content, facts, error);
  checkPayment(content, error);
  if (content.profile === "xrechnung") checkXRechnung(content, facts, error);

  return sortFindings(findings);
}

/** Errors first, otherwise in the given order; duplicates (same code and message) removed. */
export function sortFindings(findings: readonly EInvoiceFinding[]): EInvoiceFinding[] {
  const seen = new Set<string>();
  const unique = findings.filter((finding) => {
    const key = `${finding.code}\u0000${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [
    ...unique.filter((finding) => finding.severity === "error"),
    ...unique.filter((finding) => finding.severity === "warning"),
  ];
}

type Report = (code: string, message: string) => void;

function checkProfileAndType(content: EInvoiceContent, error: Report, warning: Report): void {
  if (content.profile === "minimum" || content.profile === "basic_wl") {
    error(
      "SD-PROFILE",
      `The file uses the ${PROFILE_LABELS[content.profile]} profile, which carries no invoice ` +
        "lines. Under German VAT law (§14 UStG) it is a booking aid, not an invoice: the PDF is " +
        "the invoice. Book it from the PDF (sevdesk_voucher_create_draft with the file) and " +
        "check the amounts by eye.",
    );
  }
  if (content.documentKind === "other") {
    warning(
      "SD-TYPE",
      "The invoice type code (BT-3) is neither an invoice nor a credit note code of EN 16931.",
    );
  }
}

function checkRequiredTerms(content: EInvoiceContent, facts: EInvoiceFacts, error: Report): void {
  if (content.specificationId === undefined) {
    error("BR-01", "The specification identifier (BT-24) is missing.");
  }
  if (content.seller.name === "") error("BR-06", "The seller name (BT-27) is missing.");
  if (content.buyer.name === "") error("BR-07", "The buyer name (BT-44) is missing.");
  if (Object.keys(content.seller.address).length === 0) {
    error("BR-08", "The seller postal address (BG-5) is missing.");
  }
  if (content.seller.address.countryCode === undefined) {
    error("BR-09", "The seller country code (BT-40) is missing.");
  }
  if (Object.keys(content.buyer.address).length === 0) {
    error("BR-10", "The buyer postal address (BG-8) is missing.");
  }
  if (content.buyer.address.countryCode === undefined) {
    error("BR-11", "The buyer country code (BT-55) is missing.");
  }
  const totalRules: Readonly<Record<string, string>> = {
    "BT-106": "BR-12",
    "BT-109": "BR-13",
    "BT-110": "BR-CO-14",
    "BT-112": "BR-14",
    "BT-115": "BR-15",
  };
  for (const term of facts.missingTotals) {
    error(
      totalRules[term] ?? "BR-12",
      `The total ${term} is missing or unreadable; the value shown is computed from the other ` +
        "amounts and must not be trusted.",
    );
  }
  if (content.lines.length === 0) error("BR-16", "The invoice has no lines (BG-25).");
}

function checkTotals(content: EInvoiceContent, facts: EInvoiceFacts, error: Report): void {
  const { totals } = content;
  const missing = new Set<string>(facts.missingTotals);
  const allowances = content.allowancesCharges.filter((entry) => entry.kind === "allowance");
  const charges = content.allowancesCharges.filter((entry) => entry.kind === "charge");

  const compareSum = (code: string, stated: string, computed: Decimal, what: string): void => {
    const expected = round(computed, 2);
    if (compare(stated, expected) !== 0) {
      error(
        code,
        `${what}: stated ${stated}, computed ${toDecimalString(expected)} (${content.currency}).`,
      );
    }
  };

  if (!missing.has("BT-106") && content.lines.length > 0) {
    compareSum(
      "BR-CO-10",
      totals.lineNet,
      sum(content.lines.map((line) => line.netAmount)),
      "The sum of line net amounts (BT-106) does not equal the line net amounts (BT-131)",
    );
  }
  if (totals.allowances !== undefined || allowances.length > 0) {
    compareSum(
      "BR-CO-11",
      totals.allowances ?? "0",
      sum(allowances.map((entry) => entry.amount)),
      "The sum of allowances (BT-107) does not equal the document allowances (BT-92)",
    );
  }
  if (totals.charges !== undefined || charges.length > 0) {
    compareSum(
      "BR-CO-12",
      totals.charges ?? "0",
      sum(charges.map((entry) => entry.amount)),
      "The sum of charges (BT-108) does not equal the document charges (BT-99)",
    );
  }
  if (!missing.has("BT-109") && !missing.has("BT-106")) {
    compareSum(
      "BR-CO-13",
      totals.net,
      add(subtract(totals.lineNet, totals.allowances ?? "0"), totals.charges ?? "0"),
      "The total without VAT (BT-109) does not equal BT-106 − BT-107 + BT-108",
    );
  }
  if (!missing.has("BT-110") && content.vatBreakdown.length > 0) {
    compareSum(
      "BR-CO-14",
      totals.tax,
      sum(content.vatBreakdown.map((row) => row.taxAmount)),
      "The total VAT amount (BT-110) does not equal the VAT category tax amounts (BT-117)",
    );
  }
  if (!missing.has("BT-112") && !missing.has("BT-109") && !missing.has("BT-110")) {
    compareSum(
      "BR-CO-15",
      totals.gross,
      add(totals.net, totals.tax),
      "The total with VAT (BT-112) does not equal BT-109 + BT-110",
    );
  }
  if (!missing.has("BT-115") && !missing.has("BT-112")) {
    compareSum(
      "BR-CO-16",
      totals.due,
      add(subtract(totals.gross, totals.prepaid ?? "0"), totals.rounding ?? "0"),
      "The amount due (BT-115) does not equal BT-112 − BT-113 + BT-114",
    );
  }
}

function checkVatBreakdown(content: EInvoiceContent, error: Report): void {
  interface Group {
    readonly category: VatCategoryCode;
    readonly rate: string | undefined;
    total: Decimal;
  }
  const groups = new Map<string, Group>();
  const keyOf = (category: VatCategoryCode, rate: string | undefined): string =>
    PER_RATE.has(category)
      ? `${category}|${rate === undefined ? "" : toDecimalString(rate)}`
      : category;
  const addTo = (category: VatCategoryCode, rate: string | undefined, amount: Decimal): void => {
    const key = keyOf(category, rate);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { category, rate, total: amount });
    else group.total = add(group.total, amount);
  };
  for (const line of content.lines) {
    addTo(line.vatCategory, line.vatRate, decimal(line.netAmount));
  }
  for (const entry of content.allowancesCharges) {
    const amount = decimal(entry.amount);
    addTo(
      entry.vatCategory,
      entry.vatRate,
      entry.kind === "allowance" ? multiply(amount, -1) : amount,
    );
  }

  // BR-C-05: the rate on lines.
  const lineRateRules = new Set<string>();
  for (const line of content.lines) {
    const problem = lineRateProblem(line.vatCategory, line.vatRate);
    if (problem !== undefined && !lineRateRules.has(line.vatCategory)) {
      lineRateRules.add(line.vatCategory);
      error(`BR-${line.vatCategory}-05`, problem);
    }
  }

  const rowsByKey = new Map<string, EInvoiceContent["vatBreakdown"][number]>();
  for (const row of content.vatBreakdown) rowsByKey.set(keyOf(row.category, row.rate), row);

  // BR-C-01: every category used has a breakdown row.
  const reportedMissing = new Set<string>();
  for (const [key, group] of groups) {
    if (rowsByKey.has(key) || reportedMissing.has(group.category)) continue;
    reportedMissing.add(group.category);
    const rate =
      PER_RATE.has(group.category) && group.rate !== undefined ? ` at ${group.rate} %` : "";
    error(
      `BR-${group.category}-01`,
      `VAT category ${group.category}${rate} is used on lines, allowances or charges but has no ` +
        "VAT breakdown row (BG-23).",
    );
  }

  for (const row of content.vatBreakdown) {
    const category = row.category;
    const group = groups.get(keyOf(category, row.rate));
    const rate = PER_RATE.has(category) && row.rate !== undefined ? ` at ${row.rate} %` : "";
    // BR-C-08: taxable amount.
    const expected = round(group?.total ?? decimal(0), 2);
    if (compare(row.taxableAmount, expected) !== 0) {
      error(
        `BR-${category}-08`,
        `The VAT category taxable amount (BT-116) of category ${category}${rate} is ` +
          `${row.taxableAmount}, but its lines, allowances and charges add up to ` +
          `${toDecimalString(expected)} (${content.currency}).`,
      );
    }
    // BR-C-09 / BR-CO-17: VAT amount.
    if (ZERO_TAX.has(category)) {
      if (!isZero(row.taxAmount)) {
        error(
          `BR-${category}-09`,
          `The VAT amount (BT-117) of category ${category} must be 0, but it is ${row.taxAmount}.`,
        );
      }
    } else if (row.rate !== undefined) {
      const product = multiply(row.taxableAmount, row.rate);
      // taxable × rate / 100, rounded to cents.
      const expectedTax = round({ units: product.units, scale: product.scale + 2 }, 2);
      if (!withinTolerance(row.taxAmount, expectedTax, VAT_AMOUNT_TOLERANCE)) {
        error(
          "BR-CO-17",
          `The VAT amount (BT-117) of category ${category}${rate} is ${row.taxAmount}, but ` +
            `${row.taxableAmount} × ${row.rate} % is ${toDecimalString(expectedTax)} ` +
            `(${content.currency}).`,
        );
      }
    }
    // BR-C-10: exemption reason.
    if (
      NEEDS_EXEMPTION_REASON.has(category) &&
      row.exemptionReason === undefined &&
      row.exemptionCode === undefined
    ) {
      error(
        `BR-${category}-10`,
        `The VAT breakdown row of category ${category} has no exemption reason text (BT-120) ` +
          "or code (BT-121).",
      );
    }
  }
}

function lineRateProblem(category: VatCategoryCode, rate: string | undefined): string | undefined {
  if (category === "S") {
    return rate === undefined || compare(rate, 0) <= 0
      ? "A line with VAT category S (standard rate) needs a VAT rate above 0 (BT-152)."
      : undefined;
  }
  if (category === "O") {
    return rate === undefined
      ? undefined
      : "A line with VAT category O (not subject to VAT) must not have a VAT rate (BT-152).";
  }
  if (category === "L" || category === "M") return undefined;
  return rate === undefined || compare(rate, 0) !== 0
    ? `A line with VAT category ${category} needs a VAT rate of 0 (BT-152).`
    : undefined;
}

function checkIdentifiers(content: EInvoiceContent, facts: EInvoiceFacts, error: Report): void {
  const { seller, buyer } = content;
  if (seller.identifier === undefined && !facts.sellerLegalId && seller.vatId === undefined) {
    error(
      "BR-CO-26",
      "The seller has no identifier (BT-29), legal registration identifier (BT-30) or VAT " +
        "identifier (BT-31); the buyer cannot identify the seller.",
    );
  }
  const used = new Set<VatCategoryCode>([
    ...content.lines.map((line) => line.vatCategory),
    ...content.allowancesCharges.map((entry) => entry.vatCategory),
    ...content.vatBreakdown.map((row) => row.category),
  ]);
  for (const category of ["S", "Z", "E"] as const) {
    if (used.has(category) && seller.vatId === undefined && seller.taxNumber === undefined) {
      error(
        `BR-${category}-02`,
        `Category ${category} needs the seller VAT identifier (BT-31) or tax registration ` +
          "identifier (BT-32, Steuernummer).",
      );
    }
  }
  if (used.has("AE")) {
    if (seller.vatId === undefined || (buyer.vatId === undefined && !facts.buyerLegalId)) {
      error(
        "BR-AE-02",
        "Reverse charge (category AE) needs the seller VAT identifier (BT-31) and the buyer VAT " +
          "identifier (BT-48) or legal registration identifier (BT-47).",
      );
    }
  }
  if (used.has("K") && (seller.vatId === undefined || buyer.vatId === undefined)) {
    error(
      "BR-K-02",
      "An intra-community supply (category K) needs the seller VAT identifier (BT-31) and the " +
        "buyer VAT identifier (BT-48).",
    );
  }
  if (used.has("G") && seller.vatId === undefined) {
    error("BR-G-02", "An export (category G) needs the seller VAT identifier (BT-31).");
  }
}

function checkPayment(content: EInvoiceContent, error: Report): void {
  if (
    compare(content.totals.due, 0) > 0 &&
    content.dueDate === undefined &&
    content.payment.terms === undefined
  ) {
    error(
      "BR-CO-25",
      "The amount due (BT-115) is positive, but there is neither a due date (BT-9) nor payment " +
        "terms (BT-20).",
    );
  }
}

function checkXRechnung(content: EInvoiceContent, facts: EInvoiceFacts, error: Report): void {
  if (!facts.paymentInstructions) {
    error("BR-DE-1", "XRechnung needs payment instructions (BG-16) with a payment means code.");
  }
  if (content.seller.address.city === undefined) {
    error("BR-DE-3", "XRechnung needs the seller city (BT-37).");
  }
  if (content.seller.address.postcode === undefined) {
    error("BR-DE-4", "XRechnung needs the seller post code (BT-38).");
  }
  if (content.buyer.address.city === undefined) {
    error("BR-DE-8", "XRechnung needs the buyer city (BT-52).");
  }
  if (content.buyer.address.postcode === undefined) {
    error("BR-DE-9", "XRechnung needs the buyer post code (BT-53).");
  }
  if (content.buyerReference === undefined) {
    error(
      "BR-DE-15",
      "XRechnung needs the buyer reference (BT-10): the Leitweg-ID for public buyers, otherwise " +
        "a reference the buyer gave.",
    );
  }
  if (
    content.payment.meansCode !== undefined &&
    CREDIT_TRANSFER_MEANS.has(content.payment.meansCode) &&
    content.payment.iban === undefined
  ) {
    error(
      "BR-DE-23-a",
      "Payment by credit transfer (BT-81 = 30 or 58) needs the payee account (IBAN, BT-84).",
    );
  }
}

function sum(values: readonly string[]): Decimal {
  return values.reduce<Decimal>((total, value) => add(total, value), decimal(0));
}
