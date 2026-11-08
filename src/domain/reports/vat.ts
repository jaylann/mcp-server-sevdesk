/**
 * `sevdesk_vat_summary`: an estimate of the German VAT return (Umsatzsteuer-Voranmeldung, UStVA)
 * for a month, quarter, year or date range, computed here from sevDesk's documents and positions:
 * the form lines (Kennzahlen) this server can fill, the remaining amount (Kz 83), the
 * Zusammenfassende Meldung (ZM) per buyer VAT id, OSS sales per country, and everything that does
 * not fit (unmapped tax rules, documents without EUR values) with its amounts.
 *
 * Bases (sevDesk help "Umsatzsteuervoranmeldung"; § 13, § 20 UStG):
 * - **accrual** (Sollversteuerung, the default): each document counts in the period of its tax
 *   point (`ustva-boxes.ts` `TaxPointRule`): revenue by the end of the supply (delivery date,
 *   else the document date), input VAT once both invoice and supply exist, intra-EU supplies,
 *   § 18b services, intra-EU acquisitions and § 13b(2) purchases by the invoice date but no later
 *   than the month after the supply. Corrections (cancellation invoices, credit notes) count at
 *   their own document date (§ 17 UStG). Documents are listed by document date with a margin of
 *   {@link ACCRUAL_MARGIN_DAYS} days on both sides of the period, so a document whose tax point
 *   lies in the period but whose date is further away is missed (said in the notes).
 * - **cash** (Istversteuerung, only with the Finanzamt's permission): taxable revenue (rule 1)
 *   counts when it is paid, split over each document's rates in proportion to the amount paid;
 *   input VAT, § 13b and acquisition tax and tax-free supplies stay on accrual (they do not depend
 *   on payment). Payments come from the bank reconciliation log (`PaymentsInPeriod`).
 *
 * Kleinunternehmer accounts (§ 19 UStG) file no UStVA; the report says so and reads nothing else.
 * The result is an estimate for checking, never a filing.
 */
import { z } from "zod";

import type { SevdeskClient } from "../../sevdesk/types.js";
import { type AccountSettings, type TaxRegime, taxRegimeOf } from "../account-settings.js";
import { moneySchema } from "../common.js";
import {
  add,
  compare,
  type Decimal,
  decimal,
  DEFAULT_CURRENCY,
  isZero,
  type Money,
  money,
  subtract,
} from "../money.js";
import { listCountries, taxRuleById } from "../reference-data.js";
import {
  collectPaidDocuments,
  contributedAmounts,
  type Contribution,
  contributionsOf,
  type DocumentHeader,
  headerKey,
  listDocumentHeaders,
  loadContactVatIds,
  MAX_SCAN_DOCUMENTS,
  type PaidDocuments,
  type PaymentsInPeriod,
  percentOf,
  type ScannedDocument,
  scanPositions,
  voucherDirections,
} from "./positions-scan.js";
import {
  invalidReportRequest,
  plural,
  REPORT_BASIS,
  type ReportRunOptions,
  shiftDays,
} from "./shared.js";
import {
  type TaxPointRule,
  USTVA_FORM,
  USTVA_LINES,
  type UstvaLineKey,
  type UstvaTarget,
  ustvaTarget,
  type VatDirection,
  type ZmKind,
} from "./ustva-boxes.js";

export const VAT_BASES = ["accrual", "cash"] as const;
type VatBasis = (typeof VAT_BASES)[number];

/**
 * The basis when the call names none: accrual, the legal default (§ 16 UStG). sevDesk keeps
 * Ist/Soll in its company settings ("Unternehmen, Buchhaltung & Steuer"), but `GET /SevClient`
 * has no key for it (all 92 keys checked by the live probe on 2026-11-08), so the API cannot tell.
 */
const DEFAULT_VAT_BASIS: VatBasis = "accrual";

/** Days around the period whose documents are listed to find their tax points (accrual). */
const ACCRUAL_MARGIN_DAYS = 62;
/** Documents listed by reference in `coverage.unconvertible` (the count is complete). */
const MAX_LISTED_REFS = 20;

/** Stated in every VAT summary. */
export const VAT_CAVEAT =
  "Estimate computed by this server from sevDesk data, not a tax filing and not sevDesk's own " +
  "UStVA: check every figure (and sevDesk's Auswertungen) before submitting via ELSTER. Bases " +
  "go into the form in whole euros; the form computes the tax of Kz 81, 86, 89 and 93 itself.";

// ---------------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------------

/** A report period: inclusive calendar days plus a readable label. */
export interface ReportPeriod {
  readonly from: string;
  readonly to: string;
  /** e.g. "2026-03", "2026-Q1", "2026", "2026-01-15 to 2026-02-14". */
  readonly label: string;
}

export interface PeriodInput {
  readonly year?: number | undefined;
  readonly month?: number | undefined;
  readonly quarter?: number | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/**
 * The period of `year` (+ `month` 1–12 or `quarter` 1–4) or of `from`/`to`; exactly one of the two
 * forms. Throws a local `validation` error otherwise.
 */
export function resolvePeriod(input: PeriodInput): ReportPeriod {
  const byYear = input.year !== undefined;
  const byRange = input.from !== undefined || input.to !== undefined;
  if (byYear === byRange) {
    throw invalidReportRequest(
      "give either year (with month or quarter, or neither for the whole year) or from and to.",
    );
  }
  if (input.year === undefined) {
    if (input.from === undefined || input.to === undefined) {
      throw invalidReportRequest("give both from and to.");
    }
    if (input.month !== undefined || input.quarter !== undefined) {
      throw invalidReportRequest("month and quarter go with year, not with from/to.");
    }
    if (input.from > input.to) throw invalidReportRequest("from is after to.");
    return { from: input.from, to: input.to, label: `${input.from} to ${input.to}` };
  }
  const year = String(input.year).padStart(4, "0");
  if (input.month !== undefined && input.quarter !== undefined) {
    throw invalidReportRequest("give month or quarter, not both.");
  }
  if (input.month !== undefined) {
    const month = String(input.month).padStart(2, "0");
    return {
      from: `${year}-${month}-01`,
      to: lastDayOfMonth(`${year}-${month}-01`),
      label: `${year}-${month}`,
    };
  }
  if (input.quarter !== undefined) {
    const first = String(input.quarter * 3 - 2).padStart(2, "0");
    const last = String(input.quarter * 3).padStart(2, "0");
    return {
      from: `${year}-${first}-01`,
      to: lastDayOfMonth(`${year}-${last}-01`),
      label: `${year}-Q${String(input.quarter)}`,
    };
  }
  return { from: `${year}-01-01`, to: `${year}-12-31`, label: year };
}

/** Last day of the month of `date` (YYYY-MM-DD). */
export function lastDayOfMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Last day of the month after the month of `date`. */
function lastDayOfNextMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Tax points
// ---------------------------------------------------------------------------------------------

/** The day a document's tax falls due under accrual, and which of its dates decided it. */
export interface TaxPoint {
  readonly date: string | undefined;
  readonly by: "delivery" | "document";
}

/** Whether a document corrects earlier revenue (§ 17 UStG): SR invoices, revenue credit notes. */
function isCorrection(header: DocumentHeader): boolean {
  return header.invoiceType === "SR" || (header.kind === "credit_note" && header.sign < 0);
}

/** The tax point of `header` under `timing` (see `TaxPointRule`). */
export function taxPoint(header: DocumentHeader, timing: TaxPointRule): TaxPoint {
  const supplyEnd = header.deliveryDateUntil ?? header.deliveryDate;
  const document: TaxPoint = { date: header.date, by: "document" };
  if (isCorrection(header) || supplyEnd === undefined) return document;
  const delivery: TaxPoint = { date: supplyEnd, by: "delivery" };
  if (header.date === undefined) {
    return timing === "invoice_or_next_month"
      ? { date: lastDayOfNextMonth(supplyEnd), by: "delivery" }
      : delivery;
  }
  switch (timing) {
    case "supply":
      return delivery;
    case "supply_and_invoice":
      return supplyEnd > header.date ? delivery : document;
    case "invoice_or_next_month": {
      const latest = lastDayOfNextMonth(supplyEnd);
      return header.date <= latest ? document : { date: latest, by: "delivery" };
    }
  }
}

/**
 * Where a position of `header` goes: the rule's target, or `unmapped` for an Update 1.0 document
 * whose tax type has no single Update 2.0 rule (the reason names only the known type words,
 * never sevDesk's text).
 */
function targetOf(header: DocumentHeader, direction: VatDirection, rate: string): UstvaTarget {
  if (header.taxRuleId === undefined && header.legacyTaxType !== undefined) {
    return { kind: "unmapped", reason: legacyReason(header.legacyTaxType) };
  }
  return ustvaTarget(header.taxRuleId, direction, rate);
}

function legacyReason(taxType: string): string {
  if (taxType === "eu") {
    return (
      "Update 1.0 tax type eu (intra-EU) does not tell goods from services: supplies belong to " +
      "Kz 41 or 21, purchases to Kz 89 or 46/47. Check the documents and place them by hand."
    );
  }
  if (taxType === "custom") {
    return "Update 1.0 custom tax set (taxType custom): this server cannot place it.";
  }
  return "Update 1.0 tax type without one matching Update 2.0 tax rule: check by hand.";
}

/** The timing rule of a document's tax rule (rate-independent); `supply` when unmapped. */
function timingOf(header: DocumentHeader): TaxPointRule {
  if (header.direction === undefined) return "supply";
  const target = targetOf(header, header.direction, "19");
  return target.kind === "line" || target.kind === "input_tax" ? target.timing : "supply";
}

/** Whether a document's revenue counts by payment under cash accounting (rule 1 revenue). */
function countsByPayment(header: DocumentHeader): boolean {
  if (header.direction !== "revenue") return false;
  const target = targetOf(header, "revenue", "19");
  return target.kind === "line" && target.cashBasis;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const taxRuleRefSchema = z.object({
  id: z.number().int(),
  name: z.string().optional().describe("German name (Steuerregel)."),
});

const documentRefSchema = z.object({
  objectName: z.enum(["Invoice", "CreditNote", "Voucher"]),
  id: z.number().int(),
  number: z.string().optional(),
});

const boxSchema = z.object({
  line: z.number().int().describe("Line (Zeile) on the 2026 form."),
  kz: z.string().describe("Kennzahl of the base, or of the tax for input VAT lines."),
  taxKz: z.string().optional().describe("Kennzahl of the tax, when the form has its own."),
  label: z.string(),
  labelDe: z.string(),
  base: moneySchema.optional().describe("Bemessungsgrundlage (net, EUR, exact cents)."),
  tax: moneySchema.optional().describe("Umsatzsteuer or Vorsteuer (EUR)."),
  taxComputedOnForm: z
    .boolean()
    .optional()
    .describe("True for Kz 81/86/89/93: the form computes the tax from the base itself."),
  recipientTaxAssumed: z
    .boolean()
    .optional()
    .describe(
      "True when the tax owed as recipient (reverse charge, acquisitions) was computed at the " +
        "regular 19 % because sevDesk books those positions at 0 %.",
    ),
  documents: z.number().int().describe("Documents contributing to this line."),
});

const zmEntrySchema = z.object({
  vatId: z.string().describe("Buyer's USt-IdNr. as stored on the contact."),
  country: z.string().describe("Country prefix of the VAT id (EL = Greece)."),
  kind: z.enum(["L", "S"]).describe("L intra-EU supplies of goods, S services (§ 3a(2) UStG)."),
  amount: moneySchema.describe("Sum of bases (EUR); the ZM takes whole euros."),
  documents: z.number().int(),
});

const ossCountrySchema = z.object({
  country: z.string().describe("ISO country code of the document address, or 'unknown'."),
  lines: z.array(z.object({ rate: z.string(), net: moneySchema, tax: moneySchema })),
  documents: z.number().int(),
});

export const vatSummarySchema = z.object({
  source: z.string().describe("How the numbers were made."),
  caveat: z.string(),
  form: z.object({ name: z.string(), year: z.number().int(), checked: z.string() }),
  period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  basis: z.enum(VAT_BASES).describe("accrual (Soll) or cash (Ist)."),
  basisSource: z
    .enum(["requested", "default"])
    .describe(
      "requested: from the call; default: accrual, because sevDesk's API does not expose the " +
        "account's Ist/Soll setting.",
    ),
  regime: z.enum(["regular", "small_business"]).optional(),
  applicable: z
    .boolean()
    .describe(
      "False when no UStVA is required: a Kleinunternehmer account (§ 19 UStG) without taxable " +
        "or reverse-charge amounts in the period. Boxes then show at most Kz 48 (§ 19 turnover).",
    ),
  boxes: z.array(boxSchema).describe("Form lines with amounts, in form order."),
  estimate: z
    .object({
      outputVat: moneySchema.describe("Sum of the tax of the output VAT lines."),
      inputVat: moneySchema.describe("Sum of Kz 66, 61, 67."),
      kz83: moneySchema.describe(
        "Remaining advance payment (positive) or refund (negative), before Sondervorauszahlung.",
      ),
    })
    .optional()
    .describe("Left out when no UStVA is required or reading was incomplete (truncated)."),
  zm: z.object({
    entries: z.array(zmEntrySchema).describe("Zusammenfassende Meldung, per VAT id and kind."),
    withoutVatId: z
      .object({ documents: z.number().int(), amount: moneySchema })
      .optional()
      .describe("ZM-relevant documents whose contact has no VAT id (fix before filing)."),
  }),
  oss: z.array(ossCountrySchema).describe("One-Stop-Shop sales (rules 18–20) per country."),
  notInUstva: z
    .array(
      z.object({
        taxRule: taxRuleRefSchema,
        net: moneySchema,
        tax: moneySchema,
        documents: z.number().int(),
        reason: z.string(),
      }),
    )
    .describe("Amounts under tax rules that have no UStVA box (by design)."),
  unmapped: z
    .array(
      z.object({
        taxRule: taxRuleRefSchema.optional(),
        direction: z.enum(["revenue", "expense"]),
        rate: z.string(),
        net: moneySchema,
        tax: moneySchema,
        documents: z.number().int(),
        reason: z.string(),
      }),
    )
    .describe("Amounts this server could not place: check them by hand."),
  coverage: z.object({
    rowsRead: z.number().int().describe("Document rows listed from sevDesk."),
    documentsInPeriod: z.number().int(),
    documentsScanned: z.number().int().describe("Documents whose positions were read."),
    truncated: z
      .boolean()
      .describe(`True when a cap (${MAX_SCAN_DOCUMENTS} documents) stopped reading.`),
    excluded: z.object({
      drafts: z.number().int(),
      recurringTemplates: z.number().int(),
      reminders: z.number().int(),
      unknownDirection: z.number().int(),
    }),
    unconvertible: z
      .array(documentRefSchema)
      .describe("Foreign-currency documents without EUR values in sevDesk (left out)."),
    unconvertibleCount: z.number().int(),
    datedBy: z.object({ delivery: z.number().int(), document: z.number().int() }),
    legacyTaxTypes: z
      .number()
      .int()
      .describe("Update 1.0 documents (tax type, no rule); mapped only when unambiguous."),
    adjustedToTotals: z
      .number()
      .int()
      .describe("Documents whose totals were split over their positions in proportion."),
    positionsIncomplete: z.number().int(),
    payments: z
      .object({
        read: z.number().int(),
        used: z.number().int(),
        documentsFetched: z.number().int(),
        truncated: z.boolean(),
      })
      .optional()
      .describe("Cash basis: payments from the bank reconciliation log."),
  }),
  notes: z.array(z.string()),
});

export type VatSummary = z.output<typeof vatSummarySchema>;

// ---------------------------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------------------------

export interface VatSummaryParams {
  readonly period: ReportPeriod;
  /** Omitted: {@link DEFAULT_VAT_BASIS} (sevDesk's API does not expose the account's setting). */
  readonly basis?: VatBasis | undefined;
  /** Account settings (`loadAccountSettings`); `undefined` when they could not be read. */
  readonly settings: AccountSettings | undefined;
  /** Cash basis source; required for `basis: "cash"`. */
  readonly payments?: PaymentsInPeriod | undefined;
  readonly maxDocuments?: number | undefined;
  readonly maxRows?: number | undefined;
  readonly today?: string | undefined;
}

interface LineAccumulator {
  base: Decimal;
  tax: Decimal;
  /** Base per recipient rate, for tax computed here (reverse charge, acquisitions). */
  readonly recipient: Map<string, Decimal>;
  readonly documents: Set<string>;
  assumed: boolean;
  touched: boolean;
}

interface AmountAccumulator {
  net: Decimal;
  tax: Decimal;
  readonly documents: Set<string>;
}

/** Builds the VAT summary; see the module doc. */
export async function vatSummary(
  client: SevdeskClient,
  params: VatSummaryParams,
  options: ReportRunOptions = {},
): Promise<VatSummary> {
  const { period } = params;
  const regime: TaxRegime | undefined = taxRegimeOf(params.settings);
  const basis: VatBasis = params.basis ?? DEFAULT_VAT_BASIS;
  const base = {
    source: REPORT_BASIS,
    caveat: VAT_CAVEAT,
    form: { name: USTVA_FORM.name, year: USTVA_FORM.year, checked: USTVA_FORM.checked },
    period: { from: period.from, to: period.to, label: period.label },
    basis,
    basisSource: params.basis === undefined ? ("default" as const) : ("requested" as const),
    ...(regime === undefined ? {} : { regime }),
  };
  if (basis === "cash" && params.payments === undefined) {
    throw invalidReportRequest(
      "the cash basis (Istversteuerung) needs the bank reconciliation log, which this server " +
        "build cannot read; use basis accrual.",
    );
  }

  const notes: string[] = [];
  const window = {
    from: shiftDays(period.from, -ACCRUAL_MARGIN_DAYS),
    to: shiftDays(period.to, ACCRUAL_MARGIN_DAYS),
  };
  const listed = await listDocumentHeaders(
    client,
    { ...window, maxRows: params.maxRows, today: params.today },
    options,
  );

  // Accrual documents whose tax point lies in the period (cash-basis revenue comes from payments).
  const datedBy = { delivery: 0, document: 0 };
  const accrual: DocumentHeader[] = [];
  const byKey = new Map<string, DocumentHeader>();
  for (const header of listed.headers) {
    byKey.set(headerKey(header), header);
    if (basis === "cash" && countsByPayment(header)) continue;
    const point = taxPoint(header, timingOf(header));
    if (point.date === undefined || point.date < period.from || point.date > period.to) continue;
    datedBy[point.by] += 1;
    accrual.push(header);
  }

  // Cash basis: payments on rule-1 revenue documents in the period.
  let paid: PaidDocuments | undefined;
  if (basis === "cash" && params.payments !== undefined) {
    const result = await params.payments(client, period, {
      ...options,
      voucherDirection: voucherDirections(listed.headers),
    });
    paid = await collectPaidDocuments(client, result, {
      known: byKey,
      accept: countsByPayment,
      signal: options.signal,
      today: params.today,
    });
    notes.push(...paid.notes);
  }
  const paymentsCoverage = paid?.coverage;

  const toScan = [...accrual, ...(paid?.headers ?? [])];
  const scan = await scanPositions(client, toScan, {
    maxDocuments: params.maxDocuments,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const contributions = contributionsOf(scan.documents, paid?.payments ?? new Map());

  const aggregate = await aggregateVat(client, contributions, options.signal);
  const truncated = listed.truncated || scan.notRead > 0 || paymentsCoverage?.truncated === true;
  // A Kleinunternehmer files no UStVA unless the period has amounts one has to declare (an earlier
  // regular period, § 13b tax owed as recipient): the regime is today's, the period may be older.
  const declarable = aggregate.boxes.filter((box) => box.kz !== "48").map((box) => `Kz ${box.kz}`);
  // A truncated scan cannot confirm "nothing to declare" (e.g. § 13b invoices past the cap).
  const applicable =
    regime !== "small_business" ||
    declarable.length > 0 ||
    aggregate.unmapped.length > 0 ||
    truncated;
  if (regime === "small_business") {
    const unconfirmed = declarable.length === 0 && aggregate.unmapped.length === 0 && truncated;
    notes.push(...smallBusinessNotes(applicable, declarable, unconfirmed));
  }
  notes.push(...aggregate.notes);
  if (truncated && applicable) {
    notes.push("Kz 83 is not estimated: reading was incomplete, so the balance would be biased.");
  }
  notes.push(
    ...coverageNotes({
      truncated,
      basis,
      margin: ACCRUAL_MARGIN_DAYS,
      settingsUnread: params.settings === undefined,
      scan: scan.documents,
      unconvertible: scan.unconvertible.length,
      basisDefaulted: params.basis === undefined,
    }),
  );

  return {
    ...base,
    applicable,
    boxes: aggregate.boxes,
    ...(applicable && !truncated ? { estimate: aggregate.estimate } : {}),
    zm: aggregate.zm,
    oss: aggregate.oss,
    notInUstva: aggregate.notInUstva,
    unmapped: aggregate.unmapped,
    coverage: {
      rowsRead: listed.rowsRead,
      documentsInPeriod: toScan.length,
      documentsScanned: scan.documents.length,
      truncated,
      excluded: {
        drafts: listed.excluded.draft,
        recurringTemplates: listed.excluded.recurring_template,
        reminders: listed.excluded.reminder,
        unknownDirection: listed.excluded.unknown_direction,
      },
      unconvertible: scan.unconvertible.slice(0, MAX_LISTED_REFS),
      unconvertibleCount: scan.unconvertible.length,
      datedBy,
      legacyTaxTypes: scan.documents.filter((doc) => doc.header.legacyTaxType !== undefined).length,
      adjustedToTotals: scan.documents.filter((doc) => doc.adjusted).length,
      positionsIncomplete: scan.documents.filter((doc) => !doc.positionsComplete).length,
      ...(paymentsCoverage === undefined ? {} : { payments: paymentsCoverage }),
    },
    notes,
  };
}

/** Trusted one-line summary (counts and the Kz 83 estimate only). */
export function vatSummarySentence(report: VatSummary): string {
  if (!report.applicable) {
    return (
      `VAT summary ${report.period.label}: Kleinunternehmer account without taxable amounts in ` +
      "the period, no UStVA required."
    );
  }
  const kz83 = report.estimate?.kz83;
  const estimate = kz83 === undefined ? "" : `; Kz 83 estimate ${kz83.amount} ${kz83.currency}`;
  const truncated = report.coverage.truncated ? " Incomplete: a cap stopped reading." : "";
  return (
    `VAT summary ${report.period.label} (${report.basis}): ${plural(report.coverage.documentsScanned, "document")} ` +
    `scanned, ${plural(report.boxes.length, "form line")}${estimate}.${truncated}`
  );
}

/** Notes for a Kleinunternehmer account (§ 19 UStG, sevDesk setting `smallSettlement`). */
function smallBusinessNotes(
  applicable: boolean,
  declarable: readonly string[],
  unconfirmed: boolean,
): string[] {
  if (unconfirmed) {
    return [
      "The account uses the Kleinunternehmerregelung (§ 19 UStG), but reading stopped at a cap, " +
        "so it could not be confirmed that this period has nothing to declare (e.g. VAT owed as " +
        "recipient under § 13b). Narrow the period and run the summary again.",
    ];
  }
  if (!applicable) {
    return [
      "The account uses the Kleinunternehmerregelung (§ 19 UStG, sevDesk setting " +
        "smallSettlement) and this period has no taxable or reverse-charge amounts: no " +
        "Umsatzsteuer-Voranmeldung and no Zusammenfassende Meldung are required.",
      "Exception: VAT owed as recipient (§ 13b UStG, tax rule 13) or on intra-EU acquisitions " +
        "above the threshold must still be declared; none was found in sevDesk for this period.",
    ];
  }
  return [
    "The account uses the Kleinunternehmerregelung today (§ 19 UStG), but this period has " +
      `amounts a UStVA declares (${declarable.length === 0 ? "unmapped amounts" : declarable.join(", ")}). ` +
      "Either the regime changed (then the switch date goes into Zeile 12, Kz 70) or VAT is owed " +
      "as recipient (§ 13b UStG); check which applies before filing.",
  ];
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

interface ZmItem {
  readonly header: DocumentHeader;
  readonly kind: ZmKind;
  readonly net: Decimal;
}

interface VatAggregate {
  readonly boxes: VatSummary["boxes"];
  readonly estimate: NonNullable<VatSummary["estimate"]>;
  readonly zm: VatSummary["zm"];
  readonly oss: VatSummary["oss"];
  readonly notInUstva: VatSummary["notInUstva"];
  readonly unmapped: VatSummary["unmapped"];
  readonly notes: string[];
}

function eur(value: Decimal): Money {
  return money(value, DEFAULT_CURRENCY);
}

function emptyLine(): LineAccumulator {
  return {
    base: decimal(0),
    tax: decimal(0),
    recipient: new Map(),
    documents: new Set(),
    assumed: false,
    touched: false,
  };
}

function emptyAmounts(): AmountAccumulator {
  return { net: decimal(0), tax: decimal(0), documents: new Set() };
}

/** OSS sales of one country: amounts per rate. */
interface OssAccumulator {
  readonly rates: Map<string, AmountAccumulator>;
  readonly documents: Set<string>;
}

function emptyOss(): OssAccumulator {
  return { rates: new Map(), documents: new Set() };
}

/** Adds the positions of every contribution to the form lines and side sections. */
async function aggregateVat(
  client: SevdeskClient,
  contributions: readonly Contribution[],
  signal: AbortSignal | undefined,
): Promise<VatAggregate> {
  const lines = new Map<UstvaLineKey, LineAccumulator>();
  const line = (key: UstvaLineKey): LineAccumulator => {
    let entry = lines.get(key);
    if (entry === undefined) {
      entry = emptyLine();
      lines.set(key, entry);
    }
    return entry;
  };
  const excluded = new Map<number, AmountAccumulator & { reason: string }>();
  const unmapped = new Map<
    string,
    AmountAccumulator & {
      ruleId: number | undefined;
      direction: "revenue" | "expense";
      rate: string;
      reason: string;
    }
  >();
  const zmItems: ZmItem[] = [];
  const oss = new Map<number | undefined, OssAccumulator>();
  let taxOnTaxFree = 0;

  for (const { document, share } of contributions) {
    const { header } = document;
    const key = headerKey(header);
    /* The scan only passes documents with a direction (others are excluded when listed). */
    const direction = header.direction ?? "revenue";
    for (const group of document.groups) {
      const { net, tax } = contributedAmounts(group, share);
      const target = targetOf(header, direction, group.rate);
      switch (target.kind) {
        case "line": {
          const entry = line(target.line);
          entry.base = add(entry.base, net);
          entry.documents.add(key);
          entry.touched = true;
          const definition = USTVA_LINES.find((candidate) => candidate.key === target.line);
          if (target.recipientRate !== undefined) {
            entry.recipient.set(
              target.recipientRate,
              add(entry.recipient.get(target.recipientRate) ?? decimal(0), net),
            );
            entry.assumed ||= target.assumedRate === true;
            if (target.inputTax !== undefined) {
              const input = line(target.inputTax);
              input.recipient.set(
                target.recipientRate,
                add(input.recipient.get(target.recipientRate) ?? decimal(0), net),
              );
              input.documents.add(key);
              input.assumed ||= target.assumedRate === true;
              input.touched = true;
            }
          } else if (definition?.taxOnForm === "none") {
            // OSS sales carry the destination country's VAT, reported in the OSS section.
            if (!isZero(tax) && target.oss !== true) taxOnTaxFree += 1;
          } else {
            entry.tax = add(entry.tax, tax);
          }
          if (target.zm !== undefined) zmItems.push({ header, kind: target.zm, net });
          if (target.oss === true) {
            const country = oss.get(header.countryId) ?? emptyOss();
            const rate = country.rates.get(group.rate) ?? emptyAmounts();
            rate.net = add(rate.net, net);
            rate.tax = add(rate.tax, tax);
            country.rates.set(group.rate, rate);
            country.documents.add(key);
            oss.set(header.countryId, country);
          }
          break;
        }
        case "input_tax": {
          const entry = line(target.line);
          entry.tax = add(entry.tax, tax);
          entry.documents.add(key);
          entry.touched = true;
          break;
        }
        case "excluded": {
          const ruleId = header.taxRuleId ?? 0;
          const entry = excluded.get(ruleId) ?? { ...emptyAmounts(), reason: target.reason };
          entry.net = add(entry.net, net);
          entry.tax = add(entry.tax, tax);
          entry.documents.add(key);
          excluded.set(ruleId, entry);
          break;
        }
        case "unmapped": {
          const unmappedKey = `${String(header.taxRuleId)}|${direction}|${group.rate}`;
          const entry = unmapped.get(unmappedKey) ?? {
            ...emptyAmounts(),
            ruleId: header.taxRuleId,
            direction,
            rate: group.rate,
            reason: target.reason,
          };
          entry.net = add(entry.net, net);
          entry.tax = add(entry.tax, tax);
          entry.documents.add(key);
          unmapped.set(unmappedKey, entry);
          break;
        }
      }
    }
  }

  // Tax owed as recipient: base × rate per rate, on the tax line and its input VAT line.
  for (const entry of lines.values()) {
    for (const [rate, base] of entry.recipient) entry.tax = add(entry.tax, percentOf(base, rate));
  }

  let outputVat = decimal(0);
  let inputVat = decimal(0);
  const boxes: VatSummary["boxes"] = [];
  for (const definition of USTVA_LINES) {
    const entry = lines.get(definition.key);
    if (entry === undefined || !entry.touched) continue;
    if (definition.side === "output") outputVat = add(outputVat, entry.tax);
    if (definition.side === "input") inputVat = add(inputVat, entry.tax);
    const hasBase = definition.baseKz !== undefined;
    const hasTax = definition.taxOnForm !== "none";
    boxes.push({
      line: definition.line,
      kz: definition.baseKz ?? definition.taxKz ?? definition.key,
      ...(definition.baseKz !== undefined && definition.taxKz !== undefined
        ? { taxKz: definition.taxKz }
        : {}),
      label: definition.label,
      labelDe: definition.labelDe,
      ...(hasBase ? { base: eur(entry.base) } : {}),
      ...(hasTax ? { tax: eur(entry.tax) } : {}),
      ...(definition.taxOnForm === "computed" ? { taxComputedOnForm: true } : {}),
      ...(entry.assumed ? { recipientTaxAssumed: true } : {}),
      documents: entry.documents.size,
    });
  }

  const notes: string[] = [];
  if (taxOnTaxFree > 0) {
    notes.push(
      `${plural(taxOnTaxFree, "position group")} under a tax-free or non-taxable rule carried ` +
        "VAT in sevDesk; that VAT is not in any line. Check the tax rule of those documents.",
    );
  }
  if (boxes.some((box) => box.recipientTaxAssumed === true)) {
    notes.push(
      "sevDesk books reverse-charge purchases (§ 13b) and intra-EU acquisitions at 0 %; the tax " +
        "owed as recipient was computed here at 19 %. Adjust for positions taxed at 7 %.",
    );
  }
  if (lines.has("48")) {
    notes.push(
      "Kz 48 holds tax-free supplies under § 4 UStG (rule 4) and § 19 turnover (rule 11); " +
        "§ 4 Nr. 2–7 supplies (e.g. cross-border transport) belong to Kz 43 instead.",
    );
  }
  if (lines.has("84") && contributions.some((c) => c.document.header.taxRuleId === 13)) {
    notes.push(
      "Rule 13 (§ 13b without input VAT deduction) is reported under Kz 84/85; services from a " +
        "business in another EU state belong to Kz 46/47 instead.",
    );
  }

  const zm = await buildZm(client, zmItems, signal);
  notes.push(...zm.notes);
  const ossCountries = await buildOss(client, oss, signal);

  return {
    boxes,
    estimate: {
      outputVat: eur(outputVat),
      inputVat: eur(inputVat),
      kz83: eur(subtract(outputVat, inputVat)),
    },
    zm: zm.section,
    oss: ossCountries,
    notInUstva: [...excluded.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ruleId, entry]) => ({
        taxRule: ruleRef(ruleId),
        net: eur(entry.net),
        tax: eur(entry.tax),
        documents: entry.documents.size,
        reason: entry.reason,
      })),
    unmapped: [...unmapped.values()]
      .sort((a, b) => (a.ruleId ?? -1) - (b.ruleId ?? -1) || a.rate.localeCompare(b.rate))
      .map((entry) => ({
        ...(entry.ruleId === undefined ? {} : { taxRule: ruleRef(entry.ruleId) }),
        direction: entry.direction,
        rate: entry.rate,
        net: eur(entry.net),
        tax: eur(entry.tax),
        documents: entry.documents.size,
        reason: entry.reason,
      })),
    notes,
  };
}

function ruleRef(id: number): { id: number; name?: string } {
  const rule = taxRuleById(id);
  return rule === undefined ? { id } : { id, name: rule.nameDe };
}

/** ZM entries per (VAT id, kind); VAT ids come from the embedded contact or `GET /Contact/{id}`. */
async function buildZm(
  client: SevdeskClient,
  items: readonly ZmItem[],
  signal: AbortSignal | undefined,
): Promise<{ section: VatSummary["zm"]; notes: string[] }> {
  const lookups = items
    .filter(
      (item) => item.header.contactVatId === undefined && item.header.contact?.id !== undefined,
    )
    .map((item) => item.header.contact?.id as number);
  const vatIds =
    lookups.length === 0
      ? new Map<number, string | undefined>()
      : await loadContactVatIds(client, lookups, signal);
  const entries = new Map<
    string,
    { vatId: string; kind: ZmKind; amount: Decimal; documents: Set<string> }
  >();
  let missingAmount = decimal(0);
  const missingDocuments = new Set<string>();
  for (const item of items) {
    const contactId = item.header.contact?.id;
    const embedded = item.header.contactVatId;
    const vatId =
      embedded === undefined
        ? contactId === undefined
          ? undefined
          : vatIds.get(contactId)
        : (embedded ?? undefined);
    if (vatId === undefined) {
      missingAmount = add(missingAmount, item.net);
      missingDocuments.add(headerKey(item.header));
      continue;
    }
    const key = `${vatId}|${item.kind}`;
    const entry = entries.get(key) ?? {
      vatId,
      kind: item.kind,
      amount: decimal(0),
      documents: new Set(),
    };
    entry.amount = add(entry.amount, item.net);
    entry.documents.add(headerKey(item.header));
    entries.set(key, entry);
  }
  const notes: string[] = [];
  const domestic = [...entries.values()].filter((entry) => entry.vatId.startsWith("DE")).length;
  if (domestic > 0) {
    notes.push(
      `${plural(domestic, "ZM entry", "ZM entries")} carry a German VAT id (DE…): intra-EU supplies ` +
        "and services need the buyer's VAT id from another EU state.",
    );
  }
  return {
    section: {
      entries: [...entries.values()]
        .sort((a, b) => a.vatId.localeCompare(b.vatId) || a.kind.localeCompare(b.kind))
        .map((entry) => ({
          vatId: entry.vatId,
          country: vatCountry(entry.vatId),
          kind: entry.kind,
          amount: eur(entry.amount),
          documents: entry.documents.size,
        })),
      ...(missingDocuments.size === 0
        ? {}
        : { withoutVatId: { documents: missingDocuments.size, amount: eur(missingAmount) } }),
    },
    notes,
  };
}

/** Country of a VAT id from its prefix; Greece uses EL. */
function vatCountry(vatId: string): string {
  const prefix = vatId.slice(0, 2);
  return /^[A-Z]{2}$/.test(prefix) ? (prefix === "EL" ? "GR" : prefix) : "unknown";
}

/** OSS sales per destination country (document address country). */
async function buildOss(
  client: SevdeskClient,
  oss: ReadonlyMap<number | undefined, OssAccumulator>,
  signal: AbortSignal | undefined,
): Promise<VatSummary["oss"]> {
  if (oss.size === 0) return [];
  const countries = await listCountries(client, signal);
  const codeOf = (id: number | undefined): string => {
    if (id === undefined) return "unknown";
    const code = countries.items.find((country) => country.id === id)?.code?.toUpperCase();
    return code !== undefined && /^[A-Z]{2}$/.test(code) ? code : "unknown";
  };
  const merged = new Map<string, OssAccumulator>();
  for (const [id, entry] of oss) {
    const code = codeOf(id);
    const target = merged.get(code) ?? emptyOss();
    for (const [rate, amounts] of entry.rates) {
      const sum = target.rates.get(rate) ?? emptyAmounts();
      sum.net = add(sum.net, amounts.net);
      sum.tax = add(sum.tax, amounts.tax);
      target.rates.set(rate, sum);
    }
    for (const document of entry.documents) target.documents.add(document);
    merged.set(code, target);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => (a === "unknown" ? 1 : b === "unknown" ? -1 : a.localeCompare(b)))
    .map(([country, entry]) => ({
      country,
      lines: [...entry.rates.entries()]
        .sort(([a], [b]) => compare(b, a))
        .map(([rate, amounts]) => ({ rate, net: eur(amounts.net), tax: eur(amounts.tax) })),
      documents: entry.documents.size,
    }));
}

function coverageNotes(input: {
  readonly truncated: boolean;
  readonly basis: VatBasis;
  readonly margin: number;
  readonly settingsUnread: boolean;
  readonly scan: readonly ScannedDocument[];
  readonly unconvertible: number;
  readonly basisDefaulted: boolean;
}): string[] {
  const notes: string[] = [];
  if (input.truncated) {
    notes.push(
      "Reading stopped at a cap: the figures are incomplete. Use a shorter period (month or " +
        "quarter).",
    );
  }
  if (input.basisDefaulted) {
    notes.push(
      "Basis accrual (Sollversteuerung) by default: sevDesk's API does not expose the account's " +
        "Ist/Soll setting. Pass basis cash if the Finanzamt allowed Istversteuerung.",
    );
  }
  if (input.basis === "cash") {
    notes.push(
      "Cash basis: taxable revenue (rule 1) counts on the payment day, split over the " +
        "document's rates by the share paid; input VAT, § 13b, acquisitions and tax-free " +
        "supplies stay on accrual. Payments come from sevDesk's bank reconciliation (linked or " +
        "booked transactions); unreconciled payments are missing.",
    );
  }
  notes.push(
    `Accrual tax points: documents dated up to ${String(input.margin)} days before or after the ` +
      "period were checked; a document further away whose delivery date falls into the period is " +
      "missed.",
  );
  if (input.settingsUnread) {
    notes.push(
      "sevDesk's account settings could not be read, so whether the account is a " +
        "Kleinunternehmer (no UStVA) was not checked.",
    );
  }
  if (input.unconvertible > 0) {
    notes.push(
      `${plural(input.unconvertible, "foreign-currency document")} without EUR values in ` +
        "sevDesk were left out (coverage.unconvertible).",
    );
  }
  const adjusted = input.scan.filter((doc) => doc.adjusted).length;
  if (adjusted > 0) {
    notes.push(
      `${plural(adjusted, "document")} did not add up from their positions (discounts, rounding, ` +
        "foreign currency); their EUR totals were split over the positions in proportion.",
    );
  }
  const derived = input.scan.filter((doc) => doc.derivedRate).length;
  if (derived > 0) {
    notes.push(
      `${plural(derived, "document")} had no positions; their rate was derived from tax ÷ net.`,
    );
  }
  return notes;
}
