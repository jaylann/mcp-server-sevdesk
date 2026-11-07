/**
 * Cash position (Liquidität): the balance of every payment account as sevDesk computes it, totals
 * per currency, and optionally an outlook of what is expected to come in and go out within the
 * next days from open receivables and payables (by due date). The outlook is an expectation from
 * open items, never a booked amount, and says so.
 *
 * sevDesk only reports which items are open now, so an outlook needs `asOf` today or later; its
 * window starts today (not at a later `asOf`), so items falling due before `asOf` still count as
 * expected. Balances alone may be asked for any day.
 */
import { z } from "zod";

import { berlinDateOf } from "../../sevdesk/dates.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { bankAccountDtoSchema, listBankAccounts } from "../banking.js";
import { moneySchema } from "../common.js";
import { add, type Decimal, decimal, money, subtract } from "../money.js";
import {
  collectPayables,
  collectReceivables,
  currencyOrder,
  type OpenItem,
  referenceDay,
} from "./aging.js";
import {
  coverageOutputShape,
  plural,
  REPORT_BASIS,
  REPORT_SCAN_MAX,
  type ReportRunOptions,
  shiftDays,
} from "./shared.js";

const EXPECTED_LABEL =
  "Expected, not booked: open items by due date, assuming each is paid in full on its due date.";

const expectedSumSchema = z.object({
  count: z.number().int(),
  amount: moneySchema,
  approximateCount: z
    .number()
    .int()
    .optional()
    .describe("Items counted with their full gross because sevDesk has no usable paid amount."),
});

const outlookLineSchema = z.object({
  currency: z.string().length(3),
  receivablesDue: expectedSumSchema.describe("Customer invoices due in the window (Forderungen)."),
  payablesDue: expectedSumSchema.describe(
    "Expense vouchers due in the window (Verbindlichkeiten).",
  ),
  expectedNet: moneySchema.describe("receivablesDue − payablesDue (expected, not booked)."),
  projectedBalance: moneySchema
    .optional()
    .describe(
      "Booked balance of this currency's accounts + expectedNet. Only when every account in " +
        "this currency has a balance; overdue items are not included.",
    ),
  overdueReceivables: expectedSumSchema.describe(
    "Due before today (already overdue), not in expectedNet.",
  ),
  overduePayables: expectedSumSchema.describe(
    "Due before today (already overdue), not in expectedNet.",
  ),
  unknownCount: z
    .number()
    .int()
    .optional()
    .describe("Items due in the window whose outstanding amount is unknown (not counted)."),
  noDueDateCount: z
    .number()
    .int()
    .optional()
    .describe("Open items without a due date (not counted)."),
});

type OutlookLine = z.output<typeof outlookLineSchema>;

export const cashPositionSchema = z.object({
  asOf: z.string().describe("Day the balances refer to (Stichtag), YYYY-MM-DD, Berlin."),
  accounts: z.array(bankAccountDtoSchema).describe("Payment accounts (Zahlungskonten)."),
  balances: z
    .array(
      z.object({
        currency: z.string().length(3),
        balance: moneySchema.describe("Sum of the booked balances of this currency's accounts."),
        accounts: z.number().int().describe("Accounts in the sum."),
        accountsWithoutBalance: z
          .number()
          .int()
          .optional()
          .describe("Accounts of this currency whose balance sevDesk did not give (not summed)."),
      }),
    )
    .describe("Booked balance (Kontostand) per currency, as sevDesk computes it."),
  accountsComplete: z
    .boolean()
    .describe("False when sevDesk has more accounts than one request returns."),
  archivedHidden: z.number().int().describe("Archived accounts left out."),
  outlook: z
    .object({
      label: z.string(),
      days: z.number().int(),
      from: z
        .string()
        .describe("First day of the window: today (Berlin); items due before it are overdue."),
      until: z.string().describe("Last day of the window: asOf + days."),
      lines: z.array(outlookLineSchema),
    })
    .optional()
    .describe("Only with outlookDays: expected inflows and outflows, not booked."),
  ...coverageOutputShape,
});

export type CashPosition = z.output<typeof cashPositionSchema>;

export interface CashPositionParams {
  /** Balance day, `YYYY-MM-DD` Berlin; defaults to today; today or later with an outlook. */
  readonly asOf?: string | undefined;
  /** Today in Berlin, `YYYY-MM-DD` (tests); defaults to the current date. */
  readonly today?: string | undefined;
  readonly includeArchived: boolean;
  /** Days ahead for the outlook; no outlook when undefined. */
  readonly outlookDays?: number | undefined;
  readonly maxRecords?: number | undefined;
}

/**
 * Account balances via the banking module (`GET /CheckAccount`, then `getBalanceAtDate` per
 * account), and with `outlookDays` the open receivables and payables (shared row cap) summed by
 * due date: due in `[today, asOf + days]` → expected; due before today → overdue, shown apart.
 * With an outlook, a past `asOf` is refused before anything is read.
 */
export async function cashPosition(
  client: SevdeskClient,
  params: CashPositionParams,
  options: ReportRunOptions = {},
): Promise<CashPosition> {
  const today = params.today ?? berlinDateOf(Date.now());
  const asOf =
    params.outlookDays === undefined
      ? (params.asOf ?? today)
      : referenceDay(params.asOf, today, "an outlook from open items");
  const accounts = await listBankAccounts(
    client,
    { balanceDate: asOf, includeArchived: params.includeArchived },
    options.signal,
  );
  const balances = balanceLines(accounts.items);

  let outlook: CashPosition["outlook"];
  let scanned = 0;
  let truncated = false;
  const notes: string[] = [];
  if (params.outlookDays !== undefined) {
    const max = params.maxRecords ?? REPORT_SCAN_MAX;
    const receivables = await collectReceivables(client, { ...options, maxRecords: max });
    const payables = await collectPayables(client, {
      ...options,
      maxRecords: Math.max(0, max - receivables.scanned),
      alreadyScanned: receivables.scanned,
    });
    scanned = receivables.scanned + payables.scanned;
    truncated = receivables.truncated || payables.truncated;
    const until = shiftDays(asOf, params.outlookDays);
    outlook = {
      label: EXPECTED_LABEL,
      days: params.outlookDays,
      from: today,
      until,
      lines: outlookLines(receivables.items, payables.items, today, until, balances),
    };
    if (truncated) {
      notes.push(
        `Reading open items stopped at the cap of ${max} rows: the outlook is incomplete.`,
      );
    }
    notes.push(
      "The outlook uses today's open items in sevDesk; due date = invoice date + payment term " +
        "for invoices and the payment deadline for expense vouchers.",
    );
    if (asOf > today) {
      notes.push(
        `The window starts today (${today}), not at asOf, so items falling due before asOf ` +
          "count as expected; the balances are sevDesk's for asOf.",
      );
    }
    const credits = receivables.credits.length + payables.credits.length;
    if (credits > 0) {
      notes.push(
        `${plural(credits, "open item")} with a negative gross (money owed to a customer or by ` +
          "a supplier) are not in the outlook; see the aging tools.",
      );
    }
    const left = receivables.excluded.templates + receivables.excluded.reminders;
    const leftVouchers = payables.excluded.templates;
    if (left + leftVouchers > 0) {
      notes.push(
        `${plural(left + leftVouchers, "template or reminder", "templates or reminders")} ` +
          "(WKR, RV, MA) were left out: they are not payments of their own.",
      );
    }
  }
  const missing = accounts.items.filter((account) => account.balance === undefined).length;
  if (missing > 0) {
    notes.push(
      `${plural(missing, "account")} without a balance from sevDesk (see balanceMissing) are ` +
        "not in the balances.",
    );
  }
  if (!accounts.complete) {
    notes.push("sevDesk has more accounts than one request returns; balances are incomplete.");
  }
  notes.push(
    "Balances are sevDesk's: the sum of the transactions it knows up to asOf, which differs " +
      "from the bank's balance if transactions are missing.",
  );

  return {
    asOf,
    accounts: [...accounts.items],
    balances: balances.map(({ currency, balance, count, missing: without }) => ({
      currency,
      balance: money(balance, currency),
      accounts: count,
      ...(without > 0 ? { accountsWithoutBalance: without } : {}),
    })),
    accountsComplete: accounts.complete,
    archivedHidden: accounts.archivedHidden,
    ...(outlook === undefined ? {} : { outlook }),
    basis: REPORT_BASIS,
    recordsScanned: scanned,
    truncated,
    notes,
  };
}

/** Trusted one-line summary: counts only. */
export function cashPositionSentence(report: CashPosition): string {
  const outlook =
    report.outlook === undefined
      ? ""
      : ` Outlook ${report.outlook.days} days (expected, not booked) from ` +
        `${report.recordsScanned} open-item rows.`;
  const truncated = report.truncated ? " Stopped at the row cap: the outlook is incomplete." : "";
  return (
    `Cash position as of ${report.asOf}: ${plural(report.accounts.length, "account")} in ` +
    `${plural(report.balances.length, "currency", "currencies")}.${outlook}${truncated}`
  );
}

interface BalanceLine {
  readonly currency: string;
  balance: Decimal;
  count: number;
  missing: number;
}

function balanceLines(accounts: readonly z.output<typeof bankAccountDtoSchema>[]): BalanceLine[] {
  const lines = new Map<string, BalanceLine>();
  for (const account of accounts) {
    let line = lines.get(account.currency);
    if (line === undefined) {
      line = { currency: account.currency, balance: decimal(0), count: 0, missing: 0 };
      lines.set(account.currency, line);
    }
    if (account.balance === undefined) {
      line.missing += 1;
    } else {
      line.count += 1;
      line.balance = add(line.balance, account.balance.amount);
    }
  }
  return [...lines.values()].sort((a, b) => currencyOrder(a.currency, b.currency));
}

interface ExpectedSum {
  count: number;
  amount: Decimal;
  approximate: number;
}

type SumKey = "receivablesDue" | "payablesDue" | "overdueReceivables" | "overduePayables";

interface OutlookState {
  receivablesDue: ExpectedSum;
  payablesDue: ExpectedSum;
  overdueReceivables: ExpectedSum;
  overduePayables: ExpectedSum;
  unknown: number;
  noDueDate: number;
}

function emptySum(): ExpectedSum {
  return { count: 0, amount: decimal(0), approximate: 0 };
}

function outlookLines(
  receivables: readonly OpenItem[],
  payables: readonly OpenItem[],
  from: string,
  until: string,
  balances: readonly BalanceLine[],
): OutlookLine[] {
  const states = new Map<string, OutlookState>();
  const state = (currency: string): OutlookState => {
    let value = states.get(currency);
    if (value === undefined) {
      value = {
        receivablesDue: emptySum(),
        payablesDue: emptySum(),
        overdueReceivables: emptySum(),
        overduePayables: emptySum(),
        unknown: 0,
        noDueDate: 0,
      };
      states.set(currency, value);
    }
    return value;
  };
  const place = (item: OpenItem, due: SumKey, overdue: SumKey): void => {
    const target = state(item.currency);
    if (item.dueDate === undefined) {
      target.noDueDate += 1;
      return;
    }
    if (item.dueDate > until) return;
    const isOverdue = item.dueDate < from;
    if (item.outstanding === undefined) {
      if (!isOverdue) target.unknown += 1;
      return;
    }
    const sum = target[isOverdue ? overdue : due];
    sum.count += 1;
    sum.amount = add(sum.amount, item.outstanding);
    if (item.quality === "approximate") sum.approximate += 1;
  };
  for (const item of receivables) place(item, "receivablesDue", "overdueReceivables");
  for (const item of payables) place(item, "payablesDue", "overduePayables");

  return [...states.entries()]
    .sort(([a], [b]) => currencyOrder(a, b))
    .map(([currency, value]) => {
      const expectedNet = subtract(value.receivablesDue.amount, value.payablesDue.amount);
      const balance = balances.find((line) => line.currency === currency);
      const projectable = balance !== undefined && balance.missing === 0 && balance.count > 0;
      return {
        currency,
        receivablesDue: sumOutput(value.receivablesDue, currency),
        payablesDue: sumOutput(value.payablesDue, currency),
        expectedNet: money(expectedNet, currency),
        ...(projectable
          ? { projectedBalance: money(add(balance.balance, expectedNet), currency) }
          : {}),
        overdueReceivables: sumOutput(value.overdueReceivables, currency),
        overduePayables: sumOutput(value.overduePayables, currency),
        ...(value.unknown > 0 ? { unknownCount: value.unknown } : {}),
        ...(value.noDueDate > 0 ? { noDueDateCount: value.noDueDate } : {}),
      };
    });
}

function sumOutput(sum: ExpectedSum, currency: string): z.output<typeof expectedSumSchema> {
  return {
    count: sum.count,
    amount: money(sum.amount, currency),
    ...(sum.approximate > 0 ? { approximateCount: sum.approximate } : {}),
  };
}
