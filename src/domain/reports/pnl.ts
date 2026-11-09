/**
 * `sevdesk_profit_and_loss`: an EÜR-style income and expense overview (Einnahmenüberschuss-
 * rechnung) for a period, computed here from sevDesk's documents and positions.
 *
 * - **cash** (default; § 11 EStG Zufluss-/Abflussprinzip): income and expenses count on the day
 *   the money moved, from the bank reconciliation log (`PaymentsInPeriod`), each payment split
 *   over its document's positions by the share paid. Unreconciled payments are missing.
 * - **accrual**: by document date (Rechnungs-/Belegdatum), for a view closer to a balance sheet.
 *
 * Amounts are net (Nettomethode); VAT flows are reported apart: VAT collected on income, input VAT
 * paid on expenses, VAT paid to or refunded by the Finanzamt (tax rule 15). The official Anlage
 * EÜR works gross instead (collected VAT is income, line 17; input VAT and VAT paid are expenses,
 * lines 57 and 58), so its totals differ by those flows; the caveat says so. Income is grouped by
 * tax rule (Steuerregel), expenses by booking account (Buchungskonto, AccountDatev number and
 * name). Positions marked as fixed assets (Anlagegut, `isAsset`) are listed apart and not
 * expensed: depreciation (AfA) is not computed. Expenses without input VAT deduction (rule 10)
 * count gross; § 13b purchases without deduction (rule 13) add the VAT owed as recipient (19 %
 * where sevDesk booked 0 %). Payments against a document's usual direction (a bounced debit, a
 * refund) reduce it. Not taxable movements (rules 16 private, 22 transitory items) are left out
 * and listed.
 */
import { z } from "zod";

import type { SevdeskClient } from "../../sevdesk/types.js";
import { type AccountDatevList, findAccountDatev } from "../accounts-datev.js";
import { moneySchema } from "../common.js";
import {
  add,
  compare,
  type Decimal,
  decimal,
  DEFAULT_CURRENCY,
  type Money,
  money,
  subtract,
} from "../money.js";
import { taxRuleById } from "../reference-data.js";
import {
  collectPaidDocuments,
  contributedAmounts,
  type Contribution,
  contributionsOf,
  type DocumentHeader,
  headerKey,
  listDocumentHeaders,
  MAX_SCAN_DOCUMENTS,
  type PaidDocuments,
  type PaymentsInPeriod,
  percentOf,
  type PositionGroup,
  scanPositions,
  voucherDirections,
} from "./positions-scan.js";
import {
  invalidReportRequest,
  plural,
  REPORT_SOURCE,
  type ReportRunOptions,
  shiftDays,
} from "./shared.js";
import { RECIPIENT_TAX_DEFAULT_RATE, sameRate } from "./ustva-boxes.js";
import type { ReportPeriod } from "./vat.js";

export const PNL_BASES = ["cash", "accrual"] as const;
type PnlBasis = (typeof PNL_BASES)[number];

/** Stated in every profit and loss result. */
export const PNL_CAVEAT =
  "EÜR-style overview computed by this server from sevDesk data, not the Anlage EÜR and not a " +
  "tax return. Amounts are net (Nettomethode) with VAT flows shown apart; the Anlage EÜR works " +
  "gross (VAT collected as income, input VAT and VAT payments as expenses). Depreciation (AfA) " +
  "of fixed assets, private use and other adjustments are not computed. Check with your tax " +
  "adviser.";

const MAX_LISTED_REFS = 20;
/** Tax rules for VAT payments and refunds to/from the Finanzamt (Nicht steuerbar, Steuer). */
const VAT_PAYMENT_RULE = 15;
/** Tax rules outside the result: private withdrawals/deposits, transitory items. */
const NOT_OPERATING: Readonly<Record<number, string>> = {
  16: "Not operating: private withdrawals or deposits, own consumption (Nicht steuerbar, Ausgabe).",
  22: "Not operating: transitory items (durchlaufende Posten, Nicht steuerbar, Einnahme).",
};
/** Expenses without input VAT deduction: the gross amount is the cost. */
const NO_DEDUCTION_RULE = 10;
/**
 * § 13b purchases without input VAT deduction: the VAT owed as recipient is a cost too. sevDesk
 * books them at 0 %, so it is computed at the regular rate (as in the VAT summary).
 */
const REVERSE_CHARGE_NO_DEDUCTION_RULE = 13;
/** Cash basis: days before the period whose documents are listed up front. */
const CASH_LOOKBACK_DAYS = 62;

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const taxRuleRefSchema = z.object({
  id: z.number().int(),
  name: z.string().optional().describe("German name (Steuerregel)."),
});

const accountSchema = z.object({
  id: z.number().int().optional().describe("AccountDatev id (Buchungskonto)."),
  number: z.string().optional().describe("Account number in the chart (SKR03/SKR04)."),
  name: z.string().optional(),
  legacyAccountingTypeId: z
    .number()
    .int()
    .optional()
    .describe("Update 1.0 booking account (AccountingType id), for old positions."),
});

const documentRefSchema = z.object({
  objectName: z.enum(["Invoice", "CreditNote", "Voucher"]),
  id: z.number().int(),
  number: z.string().optional(),
});

export const profitAndLossSchema = z.object({
  source: z.string().describe("How the numbers were made."),
  caveat: z.string(),
  period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  basis: z.enum(PNL_BASES).describe("cash (by payment day) or accrual (by document date)."),
  income: z.object({
    total: moneySchema.describe("Net income (Betriebseinnahmen, netto)."),
    byTaxRule: z.array(
      z.object({
        taxRule: taxRuleRefSchema.optional(),
        net: moneySchema,
        documents: z.number().int(),
      }),
    ),
  }),
  expenses: z.object({
    total: moneySchema.describe("Net expenses (Betriebsausgaben, netto), without fixed assets."),
    byAccount: z.array(
      z.object({ account: accountSchema, net: moneySchema, documents: z.number().int() }),
    ),
  }),
  result: moneySchema.describe("income − expenses (Gewinn/Verlust before AfA)."),
  vatFlows: z.object({
    collected: moneySchema.describe("VAT on income (vereinnahmte Umsatzsteuer)."),
    inputVat: moneySchema.describe("Input VAT on expenses and assets (gezahlte Vorsteuer)."),
    paidToTaxOffice: moneySchema.describe("VAT paid to the Finanzamt (tax rule 15 expenses)."),
    refundedByTaxOffice: moneySchema.describe("VAT refunded by the Finanzamt (rule 15 income)."),
  }),
  assets: z
    .array(z.object({ account: accountSchema, net: moneySchema, documents: z.number().int() }))
    .describe("Fixed asset purchases (Anlagegüter, isAsset): not expensed, AfA not computed."),
  notOperating: z.array(
    z.object({
      taxRule: taxRuleRefSchema,
      net: moneySchema,
      tax: moneySchema,
      documents: z.number().int(),
      reason: z.string(),
    }),
  ),
  coverage: z.object({
    rowsRead: z
      .number()
      .int()
      .describe("Document rows listed (cash basis: from 62 days before the period on)."),
    documentsScanned: z.number().int(),
    truncated: z
      .boolean()
      .describe(`True when a cap (${MAX_SCAN_DOCUMENTS} documents) stopped reading.`),
    excluded: z.object({
      drafts: z.number().int(),
      recurringTemplates: z.number().int(),
      reminders: z.number().int(),
      unknownDirection: z.number().int(),
    }),
    unconvertible: z.array(documentRefSchema),
    unconvertibleCount: z.number().int(),
    adjustedToTotals: z.number().int(),
    positionsIncomplete: z.number().int(),
    payments: z
      .object({
        read: z.number().int(),
        used: z.number().int(),
        documentsFetched: z.number().int(),
        truncated: z.boolean(),
      })
      .optional(),
  }),
  notes: z.array(z.string()),
});

export type ProfitAndLoss = z.output<typeof profitAndLossSchema>;

// ---------------------------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------------------------

export interface ProfitAndLossParams {
  readonly period: ReportPeriod;
  readonly basis: PnlBasis;
  /** Cash basis source; required for `basis: "cash"`. */
  readonly payments?: PaymentsInPeriod | undefined;
  /** Booking accounts for names and numbers; `undefined` leaves accounts as ids. */
  readonly accounts?: AccountDatevList | undefined;
  readonly maxDocuments?: number | undefined;
  readonly maxRows?: number | undefined;
  readonly today?: string | undefined;
}

/** Builds the profit and loss overview; see the module doc. */
export async function profitAndLoss(
  client: SevdeskClient,
  params: ProfitAndLossParams,
  options: ReportRunOptions = {},
): Promise<ProfitAndLoss> {
  const { period, basis } = params;
  if (basis === "cash" && params.payments === undefined) {
    throw invalidReportRequest(
      "the cash basis needs the bank reconciliation log, which this server build cannot read; " +
        "use basis accrual.",
    );
  }
  const notes: string[] = [];
  const excluded = { draft: 0, recurring_template: 0, reminder: 0, unknown_direction: 0 };
  let rowsRead: number;
  let listTruncated: boolean;
  let headers: DocumentHeader[];
  let paid: PaidDocuments | undefined;

  if (basis === "accrual") {
    const listed = await listDocumentHeaders(
      client,
      { from: period.from, to: period.to, maxRows: params.maxRows, today: params.today },
      options,
    );
    Object.assign(excluded, listed.excluded);
    rowsRead = listed.rowsRead;
    listTruncated = listed.truncated;
    headers = [...listed.headers];
  } else {
    // Checked above; narrowed for the compiler.
    const source = params.payments as PaymentsInPeriod;
    // Documents dated shortly before or in the period are listed (cheap: 1,000 per request), so
    // most paid documents need no request by id; older ones are fetched, up to a cap.
    const listed = await listDocumentHeaders(
      client,
      {
        from: shiftDays(period.from, -CASH_LOOKBACK_DAYS),
        to: period.to,
        maxRows: params.maxRows,
        today: params.today,
      },
      options,
    );
    rowsRead = listed.rowsRead;
    listTruncated = listed.truncated;
    const result = await source(client, period, {
      ...options,
      voucherDirection: voucherDirections(listed.headers),
    });
    paid = await collectPaidDocuments(client, result, {
      known: new Map(listed.headers.map((header) => [headerKey(header), header])),
      accept: () => true,
      signal: options.signal,
      today: params.today,
    });
    notes.push(...paid.notes);
    for (const reason of Object.keys(excluded) as (keyof typeof excluded)[]) {
      excluded[reason] += paid.excluded[reason];
    }
    headers = [...paid.headers];
  }
  const paymentsCoverage = paid?.coverage;

  const scan = await scanPositions(client, headers, {
    maxDocuments: params.maxDocuments,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const contributions = contributionsOf(scan.documents, paid?.payments ?? new Map());

  const totals = aggregate(contributions, params.accounts);
  const truncated = listTruncated || scan.notRead > 0 || paymentsCoverage?.truncated === true;
  notes.push(...totals.notes);
  if (truncated) {
    notes.push("Reading stopped at a cap: the figures are incomplete. Use a shorter period.");
  }
  if (basis === "cash") {
    notes.push(
      "Cash basis: only payments sevDesk links to documents (bank reconciliation, booked " +
        "payments) count, on their value date; each is split over the document's positions by " +
        "the share paid. Payments not linked to a document are missing.",
    );
  } else {
    notes.push("Accrual basis: documents count by their document date (Rechnungs-/Belegdatum).");
  }
  if (scan.unconvertible.length > 0) {
    notes.push(
      `${plural(scan.unconvertible.length, "foreign-currency document")} without EUR values ` +
        "in sevDesk were left out (coverage.unconvertible).",
    );
  }
  if (params.accounts === undefined) {
    notes.push("Booking accounts could not be read; expenses are grouped by account id only.");
  }

  return {
    source: REPORT_SOURCE,
    caveat: PNL_CAVEAT,
    period: { from: period.from, to: period.to, label: period.label },
    basis,
    income: totals.income,
    expenses: totals.expenses,
    result: eur(
      subtract(decimal(totals.income.total.amount), decimal(totals.expenses.total.amount)),
    ),
    vatFlows: totals.vatFlows,
    assets: totals.assets,
    notOperating: totals.notOperating,
    coverage: {
      rowsRead,
      documentsScanned: scan.documents.length,
      truncated,
      excluded: {
        drafts: excluded.draft,
        recurringTemplates: excluded.recurring_template,
        reminders: excluded.reminder,
        unknownDirection: excluded.unknown_direction,
      },
      unconvertible: scan.unconvertible.slice(0, MAX_LISTED_REFS),
      unconvertibleCount: scan.unconvertible.length,
      adjustedToTotals: scan.documents.filter((doc) => doc.adjusted).length,
      positionsIncomplete: scan.documents.filter((doc) => !doc.positionsComplete).length,
      ...(paymentsCoverage === undefined ? {} : { payments: paymentsCoverage }),
    },
    notes,
  };
}

/** Trusted one-line summary (counts and the result only). */
export function profitAndLossSentence(report: ProfitAndLoss): string {
  const truncated = report.coverage.truncated ? " Incomplete: a cap stopped reading." : "";
  return (
    `Profit and loss ${report.period.label} (${report.basis}): income ${report.income.total.amount}, ` +
    `expenses ${report.expenses.total.amount}, result ${report.result.amount} EUR (net, before ` +
    `AfA); ${plural(report.coverage.documentsScanned, "document")} scanned.${truncated}`
  );
}

function eur(value: Decimal): Money {
  return money(value, DEFAULT_CURRENCY);
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

interface Sum {
  net: Decimal;
  tax: Decimal;
  readonly documents: Set<string>;
}

function newSum(): Sum {
  return { net: decimal(0), tax: decimal(0), documents: new Set() };
}

function bump<K>(map: Map<K, Sum>, key: K, net: Decimal, tax: Decimal, document: string): void {
  const sum = map.get(key) ?? newSum();
  sum.net = add(sum.net, net);
  sum.tax = add(sum.tax, tax);
  sum.documents.add(document);
  map.set(key, sum);
}

type AccountKey = string;

function accountKey(group: PositionGroup): AccountKey {
  if (group.accountDatevId !== undefined) return `datev:${String(group.accountDatevId)}`;
  if (group.accountingTypeId !== undefined) return `legacy:${String(group.accountingTypeId)}`;
  return "none";
}

function accountRef(
  key: AccountKey,
  accounts: AccountDatevList | undefined,
): z.output<typeof accountSchema> {
  const [kind, raw] = key.split(":");
  const id = Number(raw);
  if (kind === "legacy") return { legacyAccountingTypeId: id };
  if (kind !== "datev") return {};
  const account = accounts === undefined ? undefined : findAccountDatev(accounts, id);
  return {
    id,
    ...(account?.number === undefined ? {} : { number: account.number }),
    ...(account?.name === undefined ? {} : { name: account.name }),
  };
}

function ruleRef(id: number): z.output<typeof taxRuleRefSchema> {
  const rule = taxRuleById(id);
  return rule === undefined ? { id } : { id, name: rule.nameDe };
}

function aggregate(
  contributions: readonly Contribution[],
  accounts: AccountDatevList | undefined,
): {
  income: ProfitAndLoss["income"];
  expenses: ProfitAndLoss["expenses"];
  vatFlows: ProfitAndLoss["vatFlows"];
  assets: ProfitAndLoss["assets"];
  notOperating: ProfitAndLoss["notOperating"];
  notes: string[];
} {
  const income = new Map<number | undefined, Sum>();
  const expenses = new Map<AccountKey, Sum>();
  const assets = new Map<AccountKey, Sum>();
  const notOperating = new Map<number, Sum>();
  let collected = decimal(0);
  let inputVat = decimal(0);
  let paidToTaxOffice = decimal(0);
  let refunded = decimal(0);
  let reverseChargeCost = false;

  for (const { document, share } of contributions) {
    const { header } = document;
    const key = headerKey(header);
    const rule = header.taxRuleId;
    for (const group of document.groups) {
      const { net, tax } = contributedAmounts(group, share);
      if (rule === VAT_PAYMENT_RULE) {
        if (header.direction === "expense") paidToTaxOffice = add(paidToTaxOffice, add(net, tax));
        else refunded = add(refunded, add(net, tax));
        continue;
      }
      if (rule !== undefined && NOT_OPERATING[rule] !== undefined) {
        bump(notOperating, rule, net, tax, key);
        continue;
      }
      if (header.direction === "revenue") {
        bump(income, rule, net, decimal(0), key);
        collected = add(collected, tax);
        continue;
      }
      const deductible = rule !== NO_DEDUCTION_RULE;
      let cost = deductible ? net : add(net, tax);
      if (deductible) inputVat = add(inputVat, tax);
      if (rule === REVERSE_CHARGE_NO_DEDUCTION_RULE) {
        const rate = sameRate(group.rate, "0") ? RECIPIENT_TAX_DEFAULT_RATE : group.rate;
        cost = add(cost, percentOf(net, rate));
        reverseChargeCost = true;
      }
      bump(group.isAsset ? assets : expenses, accountKey(group), cost, decimal(0), key);
    }
  }

  const total = (map: ReadonlyMap<unknown, Sum>): Decimal =>
    [...map.values()].reduce((sum, entry) => add(sum, entry.net), decimal(0));
  const byNetDescending = (a: Sum, b: Sum): number => compare(b.net, a.net);
  const accountList = (map: ReadonlyMap<AccountKey, Sum>) =>
    [...map.entries()]
      .sort(([keyA, a], [keyB, b]) => byNetDescending(a, b) || keyA.localeCompare(keyB))
      .map(([accountKeyValue, sum]) => ({
        account: accountRef(accountKeyValue, accounts),
        net: eur(sum.net),
        documents: sum.documents.size,
      }));

  const notes: string[] = [];
  if (reverseChargeCost) {
    notes.push(
      "§ 13b purchases without input VAT deduction (tax rule 13) include the VAT owed as " +
        "recipient as a cost, computed at 19 % where sevDesk booked 0 %.",
    );
  }
  if (assets.size > 0) {
    notes.push(
      `${plural(assets.size, "asset account")} with fixed asset purchases (Anlagegüter) are ` +
        "listed apart and not expensed; depreciation (AfA) is not computed. Low-value assets " +
        "(GWG, up to 800 EUR net) may be expensed at once.",
    );
  }
  if (expenses.has("none")) {
    notes.push(
      "Expenses without a booking account (e.g. credit notes to suppliers) are grouped under " +
        "an empty account.",
    );
  }

  return {
    income: {
      total: eur(total(income)),
      byTaxRule: [...income.entries()]
        .sort(([ruleA, a], [ruleB, b]) => byNetDescending(a, b) || (ruleA ?? 0) - (ruleB ?? 0))
        .map(([ruleId, sum]) => ({
          ...(ruleId === undefined ? {} : { taxRule: ruleRef(ruleId) }),
          net: eur(sum.net),
          documents: sum.documents.size,
        })),
    },
    expenses: { total: eur(total(expenses)), byAccount: accountList(expenses) },
    vatFlows: {
      collected: eur(collected),
      inputVat: eur(inputVat),
      paidToTaxOffice: eur(paidToTaxOffice),
      refundedByTaxOffice: eur(refunded),
    },
    assets: accountList(assets),
    notOperating: [...notOperating.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ruleId, sum]) => ({
        taxRule: ruleRef(ruleId),
        net: eur(sum.net),
        tax: eur(sum.tax),
        documents: sum.documents.size,
        reason: NOT_OPERATING[ruleId] ?? "",
      })),
    notes,
  };
}
