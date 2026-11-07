/**
 * Banking (Bankkonten und Umsätze): lenient parsing of sevDesk's `CheckAccount` and
 * `CheckAccountTransaction` records, the compact DTOs the banking tools return, and the read
 * operations behind them.
 *
 * Conventions pinned by `test/regressions/expense-sign.test.ts`: a transaction amount is signed as
 * the money moves on the account, positive = incoming (Eingang), negative = outgoing (Ausgang).
 *
 * Shapes: recorded `GET /CheckAccount` and `GET /CheckAccountTransaction` (emuuu/sevDesk.NET,
 * 2026-02-19). `amount` arrived as a string there; j-mastr reports JSON numbers too
 * (spec/deviations.md D-008), so both parse. Names, purposes and IBANs are untrusted: text goes
 * through `sanitizeUntrusted` (via {@link cleanText}); of an IBAN only the last four characters
 * are shown.
 */
import { z } from "zod";

import { toUnixSeconds } from "../sevdesk/dates.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import {
  parseUpstream,
  zBerlinDate,
  zBool01,
  zDecimalString,
  zId,
  zNullableInt,
  zOptionalRef,
  zText,
} from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import {
  cleanText,
  compact,
  currencyCode,
  moneyFromUpstream,
  moneySchema,
  statusDto,
  statusDtoSchema,
  toUnixRange,
} from "./common.js";
import { compare, DEFAULT_CURRENCY } from "./money.js";
import { pageState } from "./paging.js";

const NAME_MAX = 200;
const PURPOSE_MAX = 500;
/** sevDesk's maximum page size: one request reads all check accounts. */
const ACCOUNT_PAGE_SIZE = 1000;
/** At most this many `getBalanceAtDate` calls per tool call (one per account). */
export const MAX_BALANCE_ACCOUNTS = 25;
/** Upper bound of sevDesk rows one transaction search examines when filtering locally. */
export const MAX_SCAN_ROWS = 5000;

// ---------------------------------------------------------------------------------------------
// Fixed vocabularies
// ---------------------------------------------------------------------------------------------

const ACCOUNT_TYPES = ["bank", "clearing", "cash", "unknown"] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Spec `Model_CheckAccountResponse.type`: `online` (bank or PayPal connection, CSV/MT940 import),
 * `offline` (Verrechnungskonto, kept by hand; the base account of every setup is one), `register`
 * (Kasse).
 */
const ACCOUNT_TYPE_BY_SEVDESK: Readonly<Record<string, AccountType>> = {
  online: "bank",
  offline: "clearing",
  register: "cash",
};

/** Spec `Model_CheckAccountResponse.status`: 0 archived, 100 active. */
const ACCOUNT_STATUS_LABELS: Readonly<Record<number, string>> = { 0: "Archived", 100: "Active" };
const ARCHIVED_STATUS = 0;

export const TRANSACTION_STATUS_KEYS = [
  "created",
  "linked",
  "private",
  "auto_booked",
  "booked",
] as const;
type TransactionStatusKey = (typeof TRANSACTION_STATUS_KEYS)[number];

/** Spec `Model_CheckAccountTransactionResponse.status` (350 only there, see D-031). */
const TRANSACTION_STATUS_CODES: Readonly<Record<TransactionStatusKey, number>> = {
  created: 100,
  linked: 200,
  private: 300,
  auto_booked: 350,
  booked: 400,
};

export const DIRECTIONS = ["in", "out"] as const;
type Direction = (typeof DIRECTIONS)[number] | "none";

/**
 * Direction of a signed transaction amount: positive = `in` (money received), negative = `out`
 * (money paid), zero = `none`.
 */
export function directionOf(amount: string): Direction {
  const sign = compare(amount, 0);
  return sign > 0 ? "in" : sign < 0 ? "out" : "none";
}

// ---------------------------------------------------------------------------------------------
// Upstream schemas (lenient)
// ---------------------------------------------------------------------------------------------

/** `CheckAccount` (spec `Model_CheckAccountResponse`, recorded `GET /CheckAccount`). */
const accountRecordSchema = z.object({
  id: zId,
  name: zText,
  iban: zText,
  type: zText,
  currency: zText,
  defaultAccount: zBool01.optional(),
  status: zNullableInt,
  balance: zDecimalString.optional(),
  accountingNumber: zText,
});

type AccountRecord = z.output<typeof accountRecordSchema>;

/** `CheckAccountTransaction` (spec response model, recorded `GET /CheckAccountTransaction`). */
const transactionRecordSchema = z.object({
  id: zId,
  valueDate: zBerlinDate,
  entryDate: zBerlinDate,
  amount: zDecimalString.pipe(z.string()),
  payeePayerName: zText,
  paymtPurpose: zText,
  checkAccount: zOptionalRef,
  status: zNullableInt,
  enshrined: zText,
});

type TransactionRecord = z.output<typeof transactionRecordSchema>;

// ---------------------------------------------------------------------------------------------
// DTOs (also the tools' output schemas)
// ---------------------------------------------------------------------------------------------

/** One check account (Zahlungskonto) with its balance. */
export const bankAccountDtoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z
    .enum(ACCOUNT_TYPES)
    .describe(
      "bank (sevDesk 'online': bank/PayPal connection or CSV/MT940 import), clearing " +
        "('offline': Verrechnungskonto kept by hand), cash ('register': Kasse).",
    ),
  sevdeskType: z.string().optional().describe("sevDesk's own type value."),
  currency: z.string(),
  status: statusDtoSchema.optional(),
  isDefault: z.boolean().describe("Standardkonto."),
  ibanMasked: z
    .string()
    .optional()
    .describe("Last four characters of the IBAN; the rest is withheld for privacy."),
  accountingNumber: z.string().optional().describe("Booking account (Buchungskonto), e.g. 1800."),
  balance: moneySchema
    .optional()
    .describe(
      "Saldo at balanceDate as sevDesk computes it: the sum of all transactions it knows up to " +
        "and including that day. Differs from the real bank balance if old transactions are missing.",
    ),
  balanceMissing: z
    .enum(["sevdesk_error", "account_cap"])
    .optional()
    .describe(
      "Why balance is absent: sevDesk refused it for this account, or the per-call cap of " +
        "accounts was reached.",
    ),
  providerBalance: moneySchema
    .optional()
    .describe("Balance reported by the bank connection (finAPI/PayPal), when there is one."),
});

type BankAccountDto = z.output<typeof bankAccountDtoSchema>;

/** One bank transaction (Umsatz). */
export const transactionDtoSchema = z.object({
  id: z.number().int(),
  account: z
    .object({ id: z.number().int(), name: z.string().optional() })
    .optional()
    .describe("Check account (Zahlungskonto) it belongs to."),
  valueDate: z
    .string()
    .optional()
    .describe("Date of the transaction, YYYY-MM-DD: the date sevDesk requires and dates it by."),
  entryDate: z
    .string()
    .optional()
    .describe("Second date sevDesk may store (import date per the spec's request model)."),
  amount: moneySchema.describe(
    "Signed exact amount: positive = incoming (Eingang), negative = outgoing (Ausgang).",
  ),
  direction: z.enum(["in", "out", "none"]).describe("in = money received, out = money paid."),
  status: statusDtoSchema.optional(),
  counterparty: z.string().optional().describe("Payee or payer (Empfänger/Auftraggeber)."),
  purpose: z.string().optional().describe("Verwendungszweck as sent by the bank."),
  enshrined: z.boolean().describe("Festgeschrieben: locked, can no longer be changed."),
});

type TransactionDto = z.output<typeof transactionDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

function parseAccount(raw: unknown): AccountRecord {
  return parseUpstream(accountRecordSchema, raw, "a check account");
}

function parseTransaction(raw: unknown): TransactionRecord {
  return parseUpstream(transactionRecordSchema, raw, "a bank transaction");
}

function accountName(record: AccountRecord): string {
  return cleanText(record.name, NAME_MAX) ?? `(unnamed account ${record.id})`;
}

/**
 * `****` plus the last four letters or digits of an IBAN; `undefined` when it has fewer than five.
 * Only alphanumerics survive, so nothing else from the untrusted value reaches the output.
 */
export function maskIban(iban: string | undefined): string | undefined {
  const characters = (iban ?? "").replace(/[^A-Za-z0-9]/g, "");
  return characters.length < 5 ? undefined : `****${characters.slice(-4).toUpperCase()}`;
}

function toAccountDto(record: AccountRecord): BankAccountDto {
  const sevdeskType = cleanText(record.type, 20);
  const currency = currencyCode(record.currency);
  return compact({
    id: record.id,
    name: accountName(record),
    type: ACCOUNT_TYPE_BY_SEVDESK[sevdeskType ?? ""] ?? "unknown",
    sevdeskType,
    currency,
    status:
      record.status === undefined
        ? undefined
        : { code: record.status, label: ACCOUNT_STATUS_LABELS[record.status] ?? "unknown" },
    isDefault: record.defaultAccount ?? false,
    ibanMasked: maskIban(record.iban),
    accountingNumber: cleanText(record.accountingNumber, 20),
    providerBalance: moneyFromUpstream(record.balance, currency),
  });
}

interface AccountInfo {
  readonly name: string;
  readonly currency: string;
}

function toTransactionDto(
  record: TransactionRecord,
  accounts: ReadonlyMap<number, AccountInfo>,
): TransactionDto {
  const account =
    record.checkAccount === undefined ? undefined : accounts.get(record.checkAccount.id);
  const currency = account?.currency ?? DEFAULT_CURRENCY;
  const amount = moneyFromUpstream(record.amount, currency) ?? { amount: "0.00", currency };
  return compact({
    id: record.id,
    account:
      record.checkAccount === undefined
        ? undefined
        : compact({ id: record.checkAccount.id, name: account?.name }),
    valueDate: record.valueDate,
    entryDate: record.entryDate,
    amount,
    direction: directionOf(amount.amount),
    status: record.status === undefined ? undefined : statusDto("transaction", record.status),
    counterparty: cleanText(record.payeePayerName, NAME_MAX),
    purpose: cleanText(record.paymtPurpose, PURPOSE_MAX),
    enshrined: record.enshrined !== undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// Operations: accounts
// ---------------------------------------------------------------------------------------------

export interface BankAccountListParams {
  /** Day the balances refer to, `YYYY-MM-DD` (Berlin). */
  readonly balanceDate: string;
  readonly includeArchived: boolean;
}

export interface BankAccountList {
  readonly items: readonly BankAccountDto[];
  /** Archived accounts left out because `includeArchived` was false. */
  readonly archivedHidden: number;
  /** False when sevDesk has more accounts than one request returns (1000). */
  readonly complete: boolean;
}

/**
 * Lists the check accounts (`GET /CheckAccount`) with each account's balance at `balanceDate`
 * (`GET /CheckAccount/{id}/getBalanceAtDate?date=YYYY-MM-DD`: spec `format: date`, also how
 * genz-its/sevdesk and sevDesk.NET send it). One balance call per account, for at most
 * {@link MAX_BALANCE_ACCOUNTS} accounts; the rest are marked `account_cap`. A balance sevDesk
 * refuses for one account (validation, not found, odd response) marks only that account; other
 * failures (auth, network, cancellation) fail the call.
 */
export async function listBankAccounts(
  client: SevdeskClient,
  params: BankAccountListParams,
  signal?: AbortSignal,
): Promise<BankAccountList> {
  const withSignal = signal === undefined ? {} : { signal };
  const page = await client.list("/CheckAccount", undefined, {
    limit: ACCOUNT_PAGE_SIZE,
    ...withSignal,
  });
  const records = page.items.map(parseAccount);
  const visible = params.includeArchived
    ? records
    : records.filter((record) => record.status !== ARCHIVED_STATUS);

  const items = await Promise.all(
    visible.map(async (record, index): Promise<BankAccountDto> => {
      const dto = toAccountDto(record);
      if (index >= MAX_BALANCE_ACCOUNTS) return { ...dto, balanceMissing: "account_cap" };
      const balance = await fetchBalance(client, record.id, params.balanceDate, signal);
      return balance === undefined
        ? { ...dto, balanceMissing: "sevdesk_error" }
        : { ...dto, balance: moneyFromUpstream(balance, dto.currency) };
    }),
  );

  const received = page.items.length;
  return {
    items,
    archivedHidden: records.length - visible.length,
    complete: page.total === undefined ? received < ACCOUNT_PAGE_SIZE : page.total <= received,
  };
}

/** The balance as an exact decimal string, or `undefined` when sevDesk refused it. */
async function fetchBalance(
  client: SevdeskClient,
  accountId: number,
  date: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const payload = await client.request({
      method: "GET",
      path: sevdeskPath("CheckAccount", accountId, "getBalanceAtDate"),
      query: { date },
      ...(signal === undefined ? {} : { signal }),
    });
    const balance = parseUpstream(zDecimalString, payload, "an account balance");
    if (balance === undefined) {
      throw new SevdeskError({
        kind: "unexpected_response",
        message: "sevDesk returned an empty account balance.",
      });
    }
    return balance;
  } catch (error) {
    if (
      error instanceof SevdeskError &&
      (error.kind === "validation" ||
        error.kind === "not_found" ||
        error.kind === "unexpected_response")
    ) {
      return undefined;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Operations: transactions
// ---------------------------------------------------------------------------------------------

/** Which transaction date a `from`/`to` range applies to. */
export const TRANSACTION_DATE_FIELDS = ["value", "entry"] as const;
type TransactionDateField = (typeof TRANSACTION_DATE_FIELDS)[number];

export interface TransactionListParams {
  readonly checkAccountId?: number | undefined;
  /** Date range (inclusive Berlin days) on the date `dateField` names. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** `value` (default): filtered here on `valueDate`; `entry`: filtered by sevDesk on `entryDate`. */
  readonly dateField?: TransactionDateField | undefined;
  readonly statuses?: readonly TransactionStatusKey[] | undefined;
  readonly direction?: (typeof DIRECTIONS)[number] | undefined;
  readonly limit: number;
  /** Offset in sevDesk rows (not in matches). */
  readonly offset: number;
}

export interface TransactionListResult {
  readonly items: readonly TransactionDto[];
  /** sevDesk rows examined for this page; `nextOffset` = offset + rowsScanned. */
  readonly rowsScanned: number;
  /** sevDesk's count for the server-side part of the query (account, dates), when reported. */
  readonly rowsTotal: number | undefined;
  /** Whether status, direction or date filters were applied here, after fetching. */
  readonly filteredLocally: boolean;
  /** True when {@link MAX_SCAN_ROWS} stopped the search before `limit` matches or the end. */
  readonly scanCapped: boolean;
  readonly hasMore: boolean;
  readonly nextOffset: number;
}

/**
 * Lists bank transactions (`GET /CheckAccountTransaction`).
 *
 * Server-side filters: `checkAccount[id]` (spec; used by genz-its/sevdesk and sevDesk.NET). Dates:
 * sevDesk's `startDate`/`endDate` cut by `entryDate` (measured by sevdesk-rs, spec/deviations.md
 * D-047), so they are sent (as ISO date-times with the Berlin offset) only for
 * `dateField: "entry"`, and the entry date is checked again here. A value-date range
 * (`dateField: "value"`, the default) is filtered here only.
 *
 * Status: `isBooked=false` is ignored by sevDesk and no status filter is documented, but
 * `status=<code>` reportedly works (D-020). A single requested status is sent to narrow the read;
 * the status is always checked here as well, so a server that ignores it changes nothing.
 *
 * With any local filter (status, direction, value-date range) the search reads sevDesk pages from
 * `offset` until it has `limit` matches, reaches the end, or has examined {@link MAX_SCAN_ROWS}
 * rows. `nextOffset` always counts sevDesk rows, so the next call continues exactly after the
 * last row examined, and no unexamined row is skipped. The account and entry-date re-checks only
 * drop rows sevDesk should not have sent; they do not start a scan.
 */
export async function listTransactions(
  client: SevdeskClient,
  params: TransactionListParams,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: (scanned: number, total: number | undefined) => Promise<void> | void;
  } = {},
): Promise<TransactionListResult> {
  const withSignal = options.signal === undefined ? {} : { signal: options.signal };
  const accountId =
    params.checkAccountId === undefined ? undefined : toSevdeskId(params.checkAccountId);
  // Validates the range (from ≤ to) before anything is sent.
  toUnixRange({ from: params.from, to: params.to });

  const byEntryDate = params.dateField === "entry";
  const hasRange = params.from !== undefined || params.to !== undefined;
  const statuses = params.statuses ?? [];

  const query: Record<string, QueryValue> = {};
  if (accountId !== undefined) {
    query["checkAccount[id]"] = accountId;
    query["checkAccount[objectName]"] = "CheckAccount";
  }
  if (byEntryDate && params.from !== undefined) {
    query["startDate"] = berlinDateTime(params.from, "start");
  }
  if (byEntryDate && params.to !== undefined) {
    query["endDate"] = berlinDateTime(params.to, "end");
  }
  const [onlyStatus] = statuses;
  if (statuses.length === 1 && onlyStatus !== undefined) {
    query["status"] = TRANSACTION_STATUS_CODES[onlyStatus];
  }

  const matches = transactionMatcher(params, accountId);
  const filteredLocally =
    statuses.length > 0 || params.direction !== undefined || (hasRange && !byEntryDate);

  const accounts = await accountDirectory(client, options.signal);
  const items: TransactionDto[] = [];
  const keep = (record: TransactionRecord): void => {
    items.push(toTransactionDto(record, accounts));
  };

  if (!filteredLocally) {
    const page = await client.list("/CheckAccountTransaction", query, {
      limit: params.limit,
      offset: params.offset,
      ...withSignal,
    });
    for (const raw of page.items) {
      const record = parseTransaction(raw);
      if (matches(record)) keep(record);
    }
    const received = page.items.length;
    return {
      items,
      rowsScanned: received,
      rowsTotal: page.total,
      filteredLocally,
      scanCapped: false,
      ...pageState({ offset: params.offset, received, total: page.total }),
    };
  }

  const pageSize = Math.min(1000, Math.max(100, params.limit * 4));
  let position = params.offset;
  let total: number | undefined;
  let ended = false;
  let scanCapped = false;
  for (;;) {
    const scanned = position - params.offset;
    if (scanned >= MAX_SCAN_ROWS) {
      scanCapped = true;
      break;
    }
    const page = await client.list("/CheckAccountTransaction", query, {
      limit: Math.min(pageSize, MAX_SCAN_ROWS - scanned),
      offset: position,
      ...withSignal,
    });
    total = page.total ?? total;
    if (page.items.length === 0) {
      ended = true;
      break;
    }
    let filled = false;
    for (const raw of page.items) {
      const record = parseTransaction(raw);
      position += 1;
      if (matches(record)) keep(record);
      if (items.length >= params.limit) {
        filled = true;
        break;
      }
    }
    await options.onProgress?.(position - params.offset, total);
    if (filled) break;
    if (total !== undefined && position >= total) {
      ended = true;
      break;
    }
  }

  return {
    items,
    rowsScanned: position - params.offset,
    rowsTotal: total,
    filteredLocally,
    scanCapped,
    hasMore: !ended && (total === undefined || position < total),
    nextOffset: position,
  };
}

/**
 * The local filter: account (re-checked in case sevDesk ignores `checkAccount[id]`), statuses,
 * direction and the inclusive date range on the value or entry date.
 */
function transactionMatcher(
  params: TransactionListParams,
  accountId: number | undefined,
): (record: TransactionRecord) => boolean {
  const statusCodes =
    params.statuses === undefined || params.statuses.length === 0
      ? undefined
      : new Set(params.statuses.map((key) => TRANSACTION_STATUS_CODES[key]));
  const { from, to, direction } = params;
  return (record) => {
    if (accountId !== undefined && record.checkAccount?.id !== accountId) return false;
    if (statusCodes !== undefined && !statusCodes.has(record.status ?? -1)) return false;
    if (direction !== undefined && directionOf(record.amount) !== direction) return false;
    if (from === undefined && to === undefined) return true;
    const day = params.dateField === "entry" ? record.entryDate : record.valueDate;
    return (
      day !== undefined && (from === undefined || day >= from) && (to === undefined || day <= to)
    );
  };
}

/** Names and currencies of all check accounts, for labelling transactions (one request). */
async function accountDirectory(
  client: SevdeskClient,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<number, AccountInfo>> {
  const page = await client.list("/CheckAccount", undefined, {
    limit: ACCOUNT_PAGE_SIZE,
    ...(signal === undefined ? {} : { signal }),
  });
  const directory = new Map<number, AccountInfo>();
  for (const raw of page.items) {
    const record = parseAccount(raw);
    directory.set(record.id, {
      name: accountName(record),
      currency: currencyCode(record.currency),
    });
  }
  return directory;
}

/**
 * ISO 8601 date-time with Berlin's UTC offset for the start (00:00:00) or end (23:59:59) of a
 * calendar day, e.g. `2026-01-31T23:59:59+01:00`. The explicit offset keeps the instant right
 * whether sevDesk parses the full value or only its date part. DST-correct.
 */
export function berlinDateTime(date: string, edge: "start" | "end"): string {
  const unix = toUnixSeconds(date, edge);
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const [hour, minute, second] = edge === "start" ? [0, 0, 0] : [23, 59, 59];
  const wallSeconds = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  const offsetMinutes = (wallSeconds - unix) / 60;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const time = [hour, minute, second].map((part) => String(part).padStart(2, "0")).join(":");
  return `${date}T${time}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
