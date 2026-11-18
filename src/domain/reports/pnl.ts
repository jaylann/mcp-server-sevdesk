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
 * and listed. Import VAT (Einfuhrumsatzsteuer), which sevDesk books as the amount of a position
 * on the import VAT account, is input VAT and not an expense (`import-vat.ts`).
 *
 * `coverage.truncated` is set whenever something was not read: a cap, the time budget of an HTTP
 * deployment (`ReportDeadline`), a document whose positions could not all be read, or a day with
 * more documents than one page, read page by page (`coverage.pagedRead`, D-100, D-146).
 *
 * Tags and cost centres (spec/deviations.md D-088–D-092). `costCentre` and `tag` filter the
 * documents before their positions are read: both are resolved first (an unknown or ambiguous
 * one is refused, never answered with the whole account's figures) and every document is checked
 * here, by the cost centre on its head and by the tag's relations, so no list filter of sevDesk is
 * relied on. A cost centre belongs to the whole document (one per invoice, credit note or voucher;
 * a voucher position sent with a cost centre of its own reads back without one, D-092). `groupBy`
 * adds a breakdown of income, expenses
 * and result per cost centre (a split of the totals, with "none") or per tag (overlapping: a
 * document with several tags counts in each).
 */
import { z } from "zod";

import type { SevdeskClient } from "../../sevdesk/types.js";
import { type AccountDatevList, findAccountDatev } from "../accounts-datev.js";
import { compact, moneySchema } from "../common.js";
import {
  type CostCentre,
  type CostCentreArg,
  costCentreDtoSchema,
  listCostCentres,
  resolveCostCentre,
} from "../cost-centres.js";
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
  type DocumentTags,
  readDocumentTags,
  resolveTagDocuments,
  TAG_READ_MAX,
  type TagDocuments,
  tagNamesCutNote,
} from "../tags.js";
import { importVatAccountIds, isImportVat } from "./import-vat.js";
import {
  collectPaidDocuments,
  contributedAmounts,
  type Contribution,
  contributionsOf,
  type DocumentHeader,
  headerKey,
  listDocumentHeaders,
  MAX_SCAN_DOCUMENTS,
  pagedRangesNote,
  type PaidDocuments,
  type PaymentsInPeriod,
  percentOf,
  type PositionGroup,
  refOf,
  scanPositions,
  voucherDirections,
} from "./positions-scan.js";
import {
  filterLimits,
  incompleteSuffix,
  incompleteTaxReportNotes,
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

/** Breakdowns of the result: per cost centre (Kostenstelle) or per tag. */
export const PNL_GROUPINGS = ["cost_centre", "tag"] as const;
type PnlGrouping = (typeof PNL_GROUPINGS)[number];

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

const tagRefSchema = z.object({
  id: z.number().int(),
  name: z.string().optional().describe("Tag name as stored in sevDesk."),
});

const breakdownSchema = z.object({
  by: z.enum(PNL_GROUPINGS),
  overlap: z
    .boolean()
    .describe(
      "True when at least one document counts in several groups (several tags): the groups " +
        "then add up to more than income, expenses and result and are not a split of them.",
    ),
  complete: z
    .boolean()
    .describe(
      "False when the breakdown is incomplete: the figures are truncated, or the account has " +
        `more than ${TAG_READ_MAX.toLocaleString("en-US")} tag relations, so some documents may ` +
        "sit in the wrong tag group or in none.",
    ),
  groups: z.array(
    z.object({
      key: z.string().describe("cost_centre:<id>, tag:<id>, or none (no cost centre or tag)."),
      costCentre: costCentreDtoSchema.optional(),
      tag: tagRefSchema.optional(),
      income: moneySchema.describe("Net income of the group's documents."),
      expenses: moneySchema.describe("Net expenses of the group's documents (no fixed assets)."),
      result: moneySchema.describe("income − expenses of the group."),
      documents: z
        .number()
        .int()
        .describe(
          "Documents in the group, each once: also those whose amounts are all outside income " +
            "and expenses (VAT payments to or from the Finanzamt, import VAT, fixed assets, " +
            "not-operating items), so a group can hold documents and show no income or expenses.",
        ),
    }),
  ),
});

export const profitAndLossSchema = z.object({
  source: z.string().describe("How the numbers were made."),
  caveat: z.string(),
  period: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  basis: z.enum(PNL_BASES).describe("cash (by payment day) or accrual (by document date)."),
  filters: z
    .object({
      costCentre: costCentreDtoSchema
        .optional()
        .describe("Only documents on this Kostenstelle (the cost centre of the whole document)."),
      tag: tagRefSchema.optional().describe("Only documents with this tag."),
    })
    .optional()
    .describe("Present when the figures are limited to a cost centre or a tag."),
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
    inputVat: moneySchema.describe(
      "Input VAT on expenses and assets (gezahlte Vorsteuer), including importVat.",
    ),
    importVat: moneySchema
      .optional()
      .describe(
        "Import VAT (Einfuhrumsatzsteuer) booked on the import VAT account: part of inputVat, " +
          "not an expense. Present when there is any.",
      ),
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
  breakdown: breakdownSchema
    .optional()
    .describe("With groupBy: income, expenses and result per cost centre or per tag."),
  coverage: z.object({
    rowsRead: z
      .number()
      .int()
      .describe("Document rows listed (cash basis: from 62 days before the period on)."),
    documentsScanned: z.number().int(),
    truncated: z
      .boolean()
      .describe(
        `True when the figures are incomplete: a cap (${MAX_SCAN_DOCUMENTS} documents) or the ` +
          "time budget stopped reading, a document's positions could not all be read, or a " +
          "day's documents had to be read page by page.",
      ),
    timeBudgetReached: z
      .boolean()
      .optional()
      .describe(
        "True when this server stopped reading documents to answer within its time limit " +
          "(HTTP deployments): narrow the period.",
      ),
    pagedRead: z
      .boolean()
      .optional()
      .describe(
        "True when a day held more than 1,000 documents of one kind, so they were read page by " +
          "page and some may be missing (see notes).",
      ),
    excluded: z.object({
      drafts: z.number().int(),
      recurringTemplates: z.number().int(),
      reminders: z.number().int(),
      unknownDirection: z.number().int(),
    }),
    unconvertible: z.array(documentRefSchema),
    unconvertibleCount: z.number().int(),
    adjustedToTotals: z.number().int(),
    positionsIncomplete: z
      .number()
      .int()
      .describe(
        "Documents whose positions could not all be read: their totals were split over the " +
          "positions that were read, so accounts may be wrong. Makes the report truncated.",
      ),
    positionsIncompleteDocuments: z
      .array(documentRefSchema)
      .optional()
      .describe(`The first ${MAX_LISTED_REFS} of those documents.`),
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
  /**
   * The account's chart (`AccountSettings.chartOfAccounts`, e.g. "skr04"), to find the import
   * VAT account by its number in `accounts`; without it only the recorded id is recognized.
   */
  readonly chartOfAccounts?: string | undefined;
  /** Only documents on this cost centre: id, number or name (`resolveCostCentre`). */
  readonly costCentre?: CostCentreArg | undefined;
  /** Only documents with this tag, by name (`resolveTagDocuments`). */
  readonly tag?: string | undefined;
  /** A breakdown of income, expenses and result per cost centre or per tag. */
  readonly groupBy?: PnlGrouping | undefined;
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
  // Filters first: an unknown or ambiguous one is refused before any document is read.
  const filter = await resolveFilter(client, params, options.signal);
  const accept = (header: DocumentHeader): boolean =>
    (filter.costCentre === undefined || header.costCentreId === filter.costCentre.id) &&
    (filter.tag === undefined || filter.tag.documents.has(headerKey(header)));
  const grouping = await groupingSource(client, params.groupBy, options.signal);
  const notes: string[] = [];
  const excluded = { draft: 0, recurring_template: 0, reminder: 0, unknown_direction: 0 };
  let rowsRead: number;
  let listTruncated: boolean;
  let headers: DocumentHeader[];
  let paid: PaidDocuments | undefined;
  // Accrual only: on the cash basis a paid document the listing missed is read by id.
  let pagedNote: string | undefined;

  if (basis === "accrual") {
    const listed = await listDocumentHeaders(
      client,
      { from: period.from, to: period.to, maxRows: params.maxRows, today: params.today, accept },
      options,
    );
    Object.assign(excluded, listed.excluded);
    rowsRead = listed.rowsRead;
    listTruncated = listed.truncated;
    pagedNote = pagedRangesNote(listed);
    headers = [...listed.headers];
  } else {
    // Checked above; narrowed for the compiler.
    const source = params.payments as PaymentsInPeriod;
    // Documents dated shortly before or in the period are listed (cheap: 1,000 per request), so
    // most paid documents need no request by id; older ones are fetched, up to a cap. The filter
    // applies to the payments' documents (`accept` below), so the listed ones all stay known and
    // none of them is read again by id.
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
      accept,
      signal: options.signal,
      today: params.today,
      deadline: options.deadline,
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
    deadline: options.deadline,
  });
  const contributions = contributionsOf(scan.documents, paid?.payments ?? new Map());

  const importVatAccounts = importVatAccountIds({
    accounts: params.accounts,
    chartOfAccounts: params.chartOfAccounts,
  });
  const totals = aggregate(contributions, params.accounts, importVatAccounts);
  // Ways of not having read everything; each makes the report truncated.
  const timedOut = scan.timedOut || paid?.timedOut === true;
  const capped =
    listTruncated ||
    (scan.notRead > 0 && !scan.timedOut) ||
    (paymentsCoverage?.truncated === true && paid?.timedOut !== true);
  // Split over the positions that were read: amounts may sit on the wrong account (review
  // 2026-11, round 3).
  const incomplete = scan.documents.filter((doc) => !doc.positionsComplete);
  // A tag with more uses than were read: its documents beyond them are not known here.
  const tagCut = filter.tag !== undefined && !filter.tag.complete;
  const truncated =
    capped || timedOut || incomplete.length > 0 || tagCut || pagedNote !== undefined;
  notes.push(...totals.notes);
  if (capped) {
    notes.push("Reading stopped at a cap: the figures are incomplete. Use a shorter period.");
  }
  if (pagedNote !== undefined) notes.push(pagedNote);
  notes.push(...filterNotes(filter, tagCut));
  const breakdown =
    params.groupBy === undefined
      ? undefined
      : breakdownOf(params.groupBy, contributions, grouping, {
          accounts: params.accounts,
          importVatAccounts,
          truncated,
        });
  if (breakdown !== undefined) {
    const outside = new Set(contributions.map((entry) => headerKey(entry.document.header)));
    for (const key of totals.resultDocuments) outside.delete(key);
    notes.push(...breakdownNotes(breakdown, grouping, outside.size));
  }
  notes.push(
    ...incompleteTaxReportNotes({
      timedOut,
      documentsScanned: scan.documents.length,
      documentsToScan: headers.length,
      positionsIncomplete: incomplete.length,
    }),
  );
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
    ...(filter.costCentre === undefined && filter.tag === undefined
      ? {}
      : {
          filters: compact({
            costCentre: filter.costCentre,
            tag:
              filter.tag === undefined
                ? undefined
                : { id: filter.tag.tag.id, name: filter.tag.tag.name },
          }),
        }),
    income: totals.income,
    expenses: totals.expenses,
    result: eur(
      subtract(decimal(totals.income.total.amount), decimal(totals.expenses.total.amount)),
    ),
    vatFlows: totals.vatFlows,
    assets: totals.assets,
    notOperating: totals.notOperating,
    ...(breakdown === undefined ? {} : { breakdown }),
    coverage: {
      rowsRead,
      documentsScanned: scan.documents.length,
      truncated,
      ...(timedOut ? { timeBudgetReached: true } : {}),
      ...(pagedNote !== undefined && !capped ? { pagedRead: true } : {}),
      excluded: {
        drafts: excluded.draft,
        recurringTemplates: excluded.recurring_template,
        reminders: excluded.reminder,
        unknownDirection: excluded.unknown_direction,
      },
      unconvertible: scan.unconvertible.slice(0, MAX_LISTED_REFS),
      unconvertibleCount: scan.unconvertible.length,
      adjustedToTotals: scan.documents.filter((doc) => doc.adjusted).length,
      positionsIncomplete: incomplete.length,
      ...(incomplete.length === 0
        ? {}
        : {
            positionsIncompleteDocuments: incomplete
              .slice(0, MAX_LISTED_REFS)
              .map((doc) => refOf(doc.header)),
          }),
      ...(paymentsCoverage === undefined ? {} : { payments: paymentsCoverage }),
    },
    notes,
  };
}

/** Trusted one-line summary (counts, ids and the result only; no names). */
export function profitAndLossSentence(report: ProfitAndLoss): string {
  const limits = filterLimits({
    costCentreId: report.filters?.costCentre?.id,
    tagId: report.filters?.tag?.id,
  });
  const filtered = limits === "" ? "" : `, ${limits}`;
  const breakdown =
    report.breakdown === undefined
      ? ""
      : ` Breakdown by ${report.breakdown.by === "tag" ? "tag" : "cost centre"}: ` +
        plural(report.breakdown.groups.length, "group") +
        (report.breakdown.overlap ? " (overlapping: they do not add up to the totals)" : "") +
        `${report.breakdown.complete ? "" : ", incomplete"}.`;
  return (
    `Profit and loss ${report.period.label} (${report.basis}${filtered}): income ` +
    `${report.income.total.amount}, expenses ${report.expenses.total.amount}, result ` +
    `${report.result.amount} EUR (net, before AfA); ` +
    `${plural(report.coverage.documentsScanned, "document")} scanned.${breakdown}` +
    incompleteSuffix(report.coverage)
  );
}

function eur(value: Decimal): Money {
  return money(value, DEFAULT_CURRENCY);
}

// ---------------------------------------------------------------------------------------------
// Cost centres and tags
// ---------------------------------------------------------------------------------------------

/** The resolved `costCentre` and `tag` filters. */
interface PnlFilter {
  readonly costCentre?: CostCentre | undefined;
  readonly tag?: TagDocuments | undefined;
}

/**
 * Resolves the filters before any document is read: an unknown or ambiguous cost centre or tag is
 * a `validation` error (D-090, D-092), never the figures of the whole account.
 */
async function resolveFilter(
  client: SevdeskClient,
  params: ProfitAndLossParams,
  signal: AbortSignal | undefined,
): Promise<PnlFilter> {
  const costCentre =
    params.costCentre === undefined
      ? undefined
      : await resolveCostCentre(client, params.costCentre, signal);
  const tag =
    params.tag === undefined ? undefined : await resolveTagDocuments(client, params.tag, signal);
  return { costCentre, tag };
}

/** What a breakdown needs besides the documents: the tags per document or the cost centres. */
interface GroupingSource {
  readonly documentTags?: DocumentTags | undefined;
  readonly costCentres?: readonly CostCentre[] | undefined;
}

async function groupingSource(
  client: SevdeskClient,
  groupBy: PnlGrouping | undefined,
  signal: AbortSignal | undefined,
): Promise<GroupingSource> {
  switch (groupBy) {
    case undefined:
      return {};
    case "tag":
      return { documentTags: await readDocumentTags(client, signal) };
    case "cost_centre":
      return { costCentres: (await listCostCentres(client, signal)).items };
    default: {
      const unknown: never = groupBy;
      throw new Error(`unknown grouping ${String(unknown)}`);
    }
  }
}

function filterNotes(filter: PnlFilter, tagCut: boolean): string[] {
  const notes: string[] = [];
  if (filter.costCentre !== undefined) {
    notes.push(
      "Only documents on the cost centre in filters.costCentre count: the cost centre of the " +
        "whole document (sevDesk keeps one per invoice, credit note or voucher); cost centres on " +
        "single voucher positions are not read.",
    );
  }
  if (filter.tag !== undefined) {
    notes.push("Only documents with the tag in filters.tag count.");
  }
  if (tagCut) {
    notes.push(
      `The tag has more than ${TAG_READ_MAX.toLocaleString("en-US")} uses: documents beyond the ` +
        "first ones are not known here and were left out, so the figures are incomplete.",
    );
  }
  return notes;
}

type Breakdown = z.output<typeof breakdownSchema>;
type BreakdownGroup = Breakdown["groups"][number];

/**
 * Income, expenses and result per cost centre or per tag: each group's contributions run through
 * the same {@link aggregate} as the whole report, so a cost-centre breakdown (one group per
 * document, "none" included) adds up to the totals exactly; tag groups overlap when a document has
 * several tags.
 */
function breakdownOf(
  by: PnlGrouping,
  contributions: readonly Contribution[],
  source: GroupingSource,
  context: {
    readonly accounts: AccountDatevList | undefined;
    readonly importVatAccounts: ReadonlySet<number>;
    readonly truncated: boolean;
  },
): Breakdown {
  const parts = new Map<string, Contribution[]>();
  let overlap = false;
  for (const contribution of contributions) {
    const keys = groupKeysOf(by, contribution.document.header, source);
    if (keys.length > 1) overlap = true;
    for (const key of keys) {
      const part = parts.get(key) ?? [];
      part.push(contribution);
      parts.set(key, part);
    }
  }
  const groups = [...parts].map(([key, part]): BreakdownGroup => {
    const sums = aggregate(part, context.accounts, context.importVatAccounts);
    const income = decimal(sums.income.total.amount);
    const expenses = decimal(sums.expenses.total.amount);
    return {
      key,
      ...groupLabel(by, key, source),
      income: eur(income),
      expenses: eur(expenses),
      result: eur(subtract(income, expenses)),
      documents: new Set(part.map((entry) => headerKey(entry.document.header))).size,
    };
  });
  groups.sort(
    (a, b) =>
      Number(a.key === "none") - Number(b.key === "none") ||
      compare(b.expenses.amount, a.expenses.amount) ||
      compare(b.income.amount, a.income.amount) ||
      a.key.localeCompare(b.key),
  );
  return {
    by,
    overlap,
    complete: !context.truncated && source.documentTags?.complete !== false,
    groups,
  };
}

/** The groups a document counts in: its cost centre, or each of its tags; `none` without. */
function groupKeysOf(by: PnlGrouping, header: DocumentHeader, source: GroupingSource): string[] {
  if (by === "cost_centre") {
    return [header.costCentreId === undefined ? "none" : `cost_centre:${header.costCentreId}`];
  }
  const ids = source.documentTags?.byDocument.get(headerKey(header)) ?? [];
  return ids.length === 0 ? ["none"] : ids.map((id) => `tag:${id}`);
}

function groupLabel(
  by: PnlGrouping,
  key: string,
  source: GroupingSource,
): Pick<BreakdownGroup, "costCentre" | "tag"> {
  const match = /:(\d+)$/.exec(key);
  if (match?.[1] === undefined) return {};
  const id = Number(match[1]);
  if (by === "cost_centre") {
    return { costCentre: source.costCentres?.find((centre) => centre.id === id) ?? { id } };
  }
  return { tag: compact({ id, name: source.documentTags?.tags.get(id)?.name }) };
}

/**
 * What the breakdown means. `outsideResult` is the number of its documents whose amounts are all
 * outside income and expenses: they count in their group's `documents` all the same.
 */
function breakdownNotes(
  breakdown: Breakdown,
  source: GroupingSource,
  outsideResult: number,
): string[] {
  const notes: string[] = [];
  if (breakdown.by === "cost_centre") {
    notes.push(
      "Breakdown by the cost centre (Kostenstelle) of the whole document: one per document, so " +
        "the groups add up to income, expenses and result; documents without one are in the " +
        "group none.",
    );
  } else {
    notes.push(
      breakdown.overlap
        ? "Breakdown by tag: a document with several tags counts in each of its tag groups, so " +
            "the groups add up to more than income, expenses and result (breakdown.overlap). " +
            "Documents without a tag are in the group none."
        : "Breakdown by tag: no document here has more than one tag, so the groups add up to " +
            "the totals. Documents without a tag are in the group none.",
    );
  }
  if (source.documentTags?.complete === false) {
    notes.push(
      `The account has more than ${TAG_READ_MAX.toLocaleString("en-US")} tag relations; only ` +
        "the first ones were read, so some documents may be missing from their tag groups or " +
        "sit in none: the breakdown is incomplete.",
    );
  }
  const namesCut = tagNamesCutNote(source.documentTags);
  if (namesCut !== undefined) notes.push(namesCut);
  if (outsideResult > 0) {
    notes.push(
      "A group's documents counts every document in it, including " +
        `${plural(outsideResult, "document")} whose amounts are all outside income and expenses ` +
        "(VAT payments to or from the Finanzamt or import VAT in vatFlows, fixed assets in " +
        "assets, not-operating items in notOperating): a group can hold documents and show no " +
        "income or expenses.",
    );
  }
  return notes;
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
  importVatAccounts: ReadonlySet<number>,
): {
  income: ProfitAndLoss["income"];
  expenses: ProfitAndLoss["expenses"];
  vatFlows: ProfitAndLoss["vatFlows"];
  assets: ProfitAndLoss["assets"];
  notOperating: ProfitAndLoss["notOperating"];
  notes: string[];
  /** Keys ({@link headerKey}) of the documents with an amount in income or expenses. */
  resultDocuments: ReadonlySet<string>;
} {
  const income = new Map<number | undefined, Sum>();
  const expenses = new Map<AccountKey, Sum>();
  const assets = new Map<AccountKey, Sum>();
  const notOperating = new Map<number, Sum>();
  let collected = decimal(0);
  let inputVat = decimal(0);
  let paidToTaxOffice = decimal(0);
  let refunded = decimal(0);
  let importVat = decimal(0);
  let importVatSeen = false;
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
      if (isImportVat(header, group, importVatAccounts)) {
        // The whole amount on the import VAT account is tax paid to customs, deductible as
        // input VAT: a VAT flow under the net method, never a cost (`import-vat.ts`).
        const paidAsTax = add(net, tax);
        importVat = add(importVat, paidAsTax);
        inputVat = add(inputVat, paidAsTax);
        importVatSeen = true;
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
  if (importVatSeen) {
    notes.push(
      "Amounts booked on the import VAT account (Einfuhrumsatzsteuer, SKR04 1433 / SKR03 1588) " +
        "under tax rule 9 are deductible import VAT: they count as input VAT " +
        "(vatFlows.importVat), not as expenses. Import VAT booked on another account is not " +
        "recognized and counts as an expense.",
    );
  }
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
      ...(importVatSeen ? { importVat: eur(importVat) } : {}),
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
    resultDocuments: new Set(
      [...income.values(), ...expenses.values()].flatMap((sum) => [...sum.documents]),
    ),
  };
}
