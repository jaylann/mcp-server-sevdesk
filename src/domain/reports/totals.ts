/**
 * Exact running totals for reports, kept apart per currency (and, for vouchers, per kind): amounts
 * of different currencies are never added. All arithmetic uses the decimal module; a total is
 * rendered as `Money` only at the end, so nothing is rounded on the way.
 */
import { z } from "zod";

import { moneySchema } from "../common.js";
import {
  add,
  compare,
  type Decimal,
  decimal,
  DEFAULT_CURRENCY,
  type Money,
  money,
} from "../money.js";

/** Net/tax/gross of one document in its own currency, plus sevDesk's EUR values if it has them. */
export interface DocumentAmounts {
  readonly currency: string;
  readonly net?: Money | undefined;
  readonly tax?: Money | undefined;
  readonly gross?: Money | undefined;
  /** Foreign-currency documents only: the EUR amounts sevDesk books (base values). */
  readonly eur?:
    | {
        readonly net?: Money | undefined;
        readonly tax?: Money | undefined;
        readonly gross?: Money | undefined;
      }
    | undefined;
}

/** Voucher kind a totals line belongs to; `undefined` for other documents. */
export type LineKind = "expense" | "revenue" | "unknown";

const sumsSchema = z.object({
  net: moneySchema.optional().describe("Sum of net amounts (Netto)."),
  tax: moneySchema.optional().describe("Sum of tax (Umsatzsteuer/Vorsteuer)."),
  gross: moneySchema.optional().describe("Sum of gross amounts (Brutto)."),
});

/** One currency's totals inside a group or the overall totals. */
export const totalsLineSchema = z.object({
  currency: z.string().length(3).describe("ISO 4217; amounts of different currencies never mix."),
  kind: z
    .enum(["expense", "revenue", "unknown"])
    .optional()
    .describe("Vouchers only: expense (Ausgabe) or revenue (Einnahme); never summed together."),
  count: z.number().int().describe("Records in this line."),
  ...sumsSchema.shape,
  eur: sumsSchema
    .extend({
      records: z.number().int().describe("How many of the line's records have EUR values."),
    })
    .optional()
    .describe(
      "Foreign-currency lines only: sevDesk's EUR values (Buchungswährung) of the records that " +
        "have them. Complete only when records equals count.",
    ),
  incompleteRecords: z
    .number()
    .int()
    .optional()
    .describe("Records without some of net/tax/gross; their missing parts are not in the sums."),
  incoming: moneySchema
    .optional()
    .describe("Transactions only: sum of incoming (positive) amounts (Eingänge)."),
  outgoing: moneySchema
    .optional()
    .describe("Transactions only: sum of outgoing amounts, negative as on the account."),
  netFlow: moneySchema.optional().describe("Transactions only: incoming + outgoing."),
});

export type TotalsLine = z.output<typeof totalsLineSchema>;

interface DocumentLine {
  readonly kind: LineKind | undefined;
  readonly currency: string;
  count: number;
  incomplete: number;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
  eurRecords: number;
  eurNet: Decimal;
  eurTax: Decimal;
  eurGross: Decimal;
}

interface FlowLine {
  readonly currency: string;
  count: number;
  incoming: Decimal;
  outgoing: Decimal;
}

const ZERO = decimal(0);
const KIND_ORDER: readonly (LineKind | undefined)[] = [undefined, "expense", "revenue", "unknown"];

/** Accumulates document amounts (invoices, credit notes, vouchers) per currency and kind. */
export class DocumentTotals {
  private readonly lines = new Map<string, DocumentLine>();

  /** Records added so far. */
  count = 0;

  add(amounts: DocumentAmounts, kind?: LineKind): void {
    const key = `${kind ?? ""}|${amounts.currency}`;
    let line = this.lines.get(key);
    if (line === undefined) {
      line = {
        kind,
        currency: amounts.currency,
        count: 0,
        incomplete: 0,
        net: ZERO,
        tax: ZERO,
        gross: ZERO,
        eurRecords: 0,
        eurNet: ZERO,
        eurTax: ZERO,
        eurGross: ZERO,
      };
      this.lines.set(key, line);
    }
    this.count += 1;
    line.count += 1;
    const { net, tax, gross, eur } = amounts;
    if (net === undefined || tax === undefined || gross === undefined) line.incomplete += 1;
    line.net = addMoney(line.net, net, amounts.currency);
    line.tax = addMoney(line.tax, tax, amounts.currency);
    line.gross = addMoney(line.gross, gross, amounts.currency);
    if (eur !== undefined && amounts.currency !== DEFAULT_CURRENCY) {
      line.eurRecords += 1;
      line.eurNet = addMoney(line.eurNet, eur.net, DEFAULT_CURRENCY);
      line.eurTax = addMoney(line.eurTax, eur.tax, DEFAULT_CURRENCY);
      line.eurGross = addMoney(line.eurGross, eur.gross, DEFAULT_CURRENCY);
    }
  }

  /**
   * Gross in EUR across lines: EUR lines plus the EUR values of foreign lines. Used only to order
   * groups (largest first), never shown as a total.
   */
  eurGrossForOrdering(): Decimal {
    let total = ZERO;
    for (const line of this.lines.values()) {
      total = add(total, line.currency === DEFAULT_CURRENCY ? line.gross : line.eurGross);
    }
    return total;
  }

  lineList(): TotalsLine[] {
    return sortLines([...this.lines.values()]).map((line) => {
      const foreign = line.currency !== DEFAULT_CURRENCY;
      return {
        currency: line.currency,
        ...(line.kind === undefined ? {} : { kind: line.kind }),
        count: line.count,
        net: money(line.net, line.currency),
        tax: money(line.tax, line.currency),
        gross: money(line.gross, line.currency),
        ...(foreign && line.eurRecords > 0
          ? {
              eur: {
                records: line.eurRecords,
                net: money(line.eurNet, DEFAULT_CURRENCY),
                tax: money(line.eurTax, DEFAULT_CURRENCY),
                gross: money(line.eurGross, DEFAULT_CURRENCY),
              },
            }
          : {}),
        ...(line.incomplete > 0 ? { incompleteRecords: line.incomplete } : {}),
      };
    });
  }
}

/** Accumulates signed transaction amounts per currency: incoming, outgoing and the net flow. */
export class FlowTotals {
  private readonly lines = new Map<string, FlowLine>();

  count = 0;

  add(amount: Money): void {
    let line = this.lines.get(amount.currency);
    if (line === undefined) {
      line = { currency: amount.currency, count: 0, incoming: ZERO, outgoing: ZERO };
      this.lines.set(amount.currency, line);
    }
    this.count += 1;
    line.count += 1;
    if (compare(amount.amount, 0) >= 0) line.incoming = add(line.incoming, amount.amount);
    else line.outgoing = add(line.outgoing, amount.amount);
  }

  lineList(): TotalsLine[] {
    return sortLines([...this.lines.values()]).map((line) => ({
      currency: line.currency,
      count: line.count,
      incoming: money(line.incoming, line.currency),
      outgoing: money(line.outgoing, line.currency),
      netFlow: money(add(line.incoming, line.outgoing), line.currency),
    }));
  }
}

/** Adds an optional amount; its currency must be the line's (a mismatch is a programming error). */
function addMoney(total: Decimal, amount: Money | undefined, currency: string): Decimal {
  if (amount === undefined) return total;
  if (amount.currency !== currency) {
    throw new Error(`Report totals: ${amount.currency} amount in a ${currency} line.`);
  }
  return add(total, amount.amount);
}

/** EUR first, then by currency code; within a currency by kind. */
function sortLines<L extends { readonly currency: string; readonly kind?: LineKind | undefined }>(
  lines: L[],
): L[] {
  return lines.sort((a, b) => {
    const byCurrency = currencyRank(a.currency) - currencyRank(b.currency);
    if (byCurrency !== 0) return byCurrency;
    if (a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
    return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });
}

function currencyRank(currency: string): number {
  return currency === DEFAULT_CURRENCY ? 0 : 1;
}
