/**
 * The booking log of bank transactions (Zuordnungen): which documents a transaction (Umsatz) was
 * booked against and with how much, read from sevDesk's undocumented
 * `GET /CheckAccountTransactionLog` (spec/deviations.md D-057), the exact amount still unassigned
 * on a transaction, and the payments of a period for the cash-basis (Ist) reports.
 *
 * What is known about the log (jernoxit/sevdesk-rs, measured, recorded fixture
 * `tests/fixtures/transaction_log.json`, 2026-09-29):
 * - `GET /CheckAccountTransactionLog?checkAccountTransaction[id]=…&checkAccountTransaction[objectName]=CheckAccountTransaction`
 *   lists the entries of one transaction; filters by document are ignored; without a filter the
 *   whole log of the sevDesk client pages stably with `limit`/`offset`.
 * - An entry: `id`, `checkAccountTransaction` `{id, objectName}`, `object` (the booked document,
 *   `{id, objectName: Invoice|CreditNote|Voucher|…}`), `amountPaid` (a JSON number, "signed like
 *   the transaction", in the transaction's currency: the entry has none of its own),
 *   `fromStatus`/`toStatus` (the transaction's status before and after, e.g. "100" → "400"),
 *   `bookingDate` (ISO date-time).
 * - A transaction split over two documents moves to status 200 with the first share and to 400
 *   with the second (firsttris/haben, Update 1.0). `resetToOpen` on a document deletes its entries
 *   (D-060).
 *
 * Everything about the entry's shape lives in {@link logEntryRecordSchema} and
 * {@link entryShare}, so a probe result is a one-line change. The schema is lenient: unknown or
 * missing members never fail a read; what cannot be attributed is reported, not guessed.
 */
import { z } from "zod";

import { SevdeskError } from "../../sevdesk/errors.js";
import { toSevdeskId } from "../../sevdesk/paths.js";
import {
  parseUpstream,
  zBerlinDate,
  zId,
  zOptionalDecimal,
  zOptionalInt,
  zOptionalRef,
} from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import {
  directionOf,
  listTransactions,
  TRANSACTION_STATUS_KEYS,
  type TransactionDto,
} from "../banking.js";
import { type PaymentKind, readLifecycleDocument } from "../lifecycle/documents.js";
import { add, compare, isZero, type Money, money, negate, toDecimalString } from "../money.js";

const TRANSACTION_LOG_PATH = "/CheckAccountTransactionLog";

/** sevDesk's maximum page size; one page holds the entries of any single transaction. */
const LOG_PAGE_SIZE = 1000;

/** Transaction statuses (spec, D-031). */
export const TRANSACTION_STATUS = {
  created: 100,
  linked: 200,
  private: 300,
  autoBooked: 350,
  booked: 400,
} as const;

// ---------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------

/** One log entry as sevDesk sends it (lenient; see the module doc). */
const logEntryRecordSchema = z.object({
  id: zId,
  checkAccountTransaction: zOptionalRef.catch(undefined),
  object: zOptionalRef.catch(undefined),
  amountPaid: zOptionalDecimal.catch(undefined),
  fromStatus: zOptionalInt.catch(undefined),
  toStatus: zOptionalInt.catch(undefined),
  bookingDate: zBerlinDate.catch(undefined),
});

/** The documents a log entry can point to: the payment kinds, or anything else. */
type LoggedDocumentKind = PaymentKind | "other";

/** `objectName` of the documents the payment tools handle. */
const PAYMENT_OBJECT_NAMES: Readonly<Record<PaymentKind, PaidDocumentObjectName>> = {
  invoice: "Invoice",
  creditNote: "CreditNote",
  voucher: "Voucher",
};

/** `objectName` of a document sevDesk links payments to. */
type PaidDocumentObjectName = "Invoice" | "CreditNote" | "Voucher";

const KIND_BY_OBJECT_NAME: Readonly<Record<string, PaymentKind>> = {
  Invoice: "invoice",
  CreditNote: "creditNote",
  Voucher: "voucher",
};

/** The document a log entry booked. */
interface LoggedDocument {
  readonly kind: LoggedDocumentKind;
  /** sevDesk's `objectName`, reduced to letters (upstream text, at most 40 characters). */
  readonly objectName: string;
  readonly id: number;
}

/** One booking of a transaction against a document. */
export interface TransactionLogEntry {
  readonly id: number;
  /** The transaction the entry belongs to; `undefined` when sevDesk sent no reference. */
  readonly transactionId: number | undefined;
  readonly document: LoggedDocument | undefined;
  /** `amountPaid` exactly as sent (signed like the transaction, see {@link entryShare}). */
  readonly amountPaid: string | undefined;
  readonly fromStatus: number | undefined;
  readonly toStatus: number | undefined;
  /** Berlin day of `bookingDate`, `YYYY-MM-DD`. */
  readonly bookingDate: string | undefined;
}

/** Parses one raw log entry; a row without a usable `id` is `unexpected_response`. */
export function parseLogEntry(raw: unknown): TransactionLogEntry {
  const record = parseUpstream(logEntryRecordSchema, raw, "a transaction log entry");
  const object = record.object;
  let document: LoggedDocument | undefined;
  if (object !== undefined) {
    const objectName = object.objectName.replace(/[^A-Za-z]/g, "").slice(0, 40);
    document = { kind: KIND_BY_OBJECT_NAME[objectName] ?? "other", objectName, id: object.id };
  }
  return {
    id: record.id,
    transactionId: record.checkAccountTransaction?.id,
    document,
    amountPaid: record.amountPaid,
    fromStatus: record.fromStatus,
    toStatus: record.toStatus,
    bookingDate: record.bookingDate,
  };
}

/** The entries of one transaction and whether they are known to be all of them. */
export interface TransactionLog {
  readonly transactionId: number;
  /** Ordered by entry id (the order sevDesk wrote them). */
  readonly entries: readonly TransactionLogEntry[];
  /**
   * False when sevDesk may have more entries than were read (a full page while the transaction
   * filter seemed to be ignored): the remaining amount is then unknown.
   */
  readonly complete: boolean;
}

/**
 * Reads the booking log of one transaction: `GET /CheckAccountTransactionLog` filtered by the
 * transaction (one page of 1000; the filter is honored: recorded 2026-11-08, D-057). Every
 * entry's transaction is checked here as well, so an ignored filter changes nothing: entries of
 * other transactions are dropped, and if the page was full, the whole log is read (up to
 * {@link WHOLE_LOG_MAX} entries) and filtered here. Entries without a transaction reference count
 * as this transaction's while the filter evidently worked; otherwise they make the log
 * incomplete.
 */
export async function readTransactionLog(
  client: SevdeskClient,
  transactionId: number,
  signal?: AbortSignal,
): Promise<TransactionLog> {
  const id = toSevdeskId(transactionId);
  const query = {
    "checkAccountTransaction[id]": id,
    "checkAccountTransaction[objectName]": "CheckAccountTransaction",
  };
  const withSignal = signal === undefined ? {} : { signal };
  const page = await client.list(TRANSACTION_LOG_PATH, query, {
    limit: LOG_PAGE_SIZE,
    ...withSignal,
  });
  const received = page.items.length;
  const pageComplete = page.total === undefined ? received < LOG_PAGE_SIZE : page.total <= received;
  let rows = page.items;
  let complete = pageComplete;
  if (!pageComplete) {
    const all = await client.listAll(TRANSACTION_LOG_PATH, query, {
      max: WHOLE_LOG_MAX,
      pageSize: LOG_PAGE_SIZE,
      ...withSignal,
    });
    rows = all.items;
    complete = !all.truncated;
  }
  const parsed = rows.map(parseLogEntry);
  const filterIgnored = parsed.some(
    (entry) => entry.transactionId !== undefined && entry.transactionId !== id,
  );
  const unattributed = parsed.some((entry) => entry.transactionId === undefined);
  const entries = parsed.filter(
    (entry) => entry.transactionId === id || (!filterIgnored && entry.transactionId === undefined),
  );
  return {
    transactionId: id,
    entries: byEntryId(entries),
    complete: complete && !(filterIgnored && unattributed),
  };
}

function byEntryId(entries: readonly TransactionLogEntry[]): TransactionLogEntry[] {
  return [...entries].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------------------------
// Remaining amount
// ---------------------------------------------------------------------------------------------

/** How much of a transaction is assigned and still free, or why that cannot be told. */
export type RemainingAmount =
  | {
      readonly known: true;
      /** Positive exact decimals in the transaction's currency. */
      readonly total: string;
      readonly assigned: string;
      readonly remaining: string;
    }
  | {
      readonly known: false;
      /** Trusted text, e.g. "its booking log has an entry without an amount". */
      readonly reason: string;
    };

/**
 * The share of the transaction an entry assigned, positive, or a trusted reason why it cannot be
 * used. `amountPaid` is signed like the transaction (recorded 2026-11-08: +119 on an incoming
 * transaction, −119 on an outgoing one, D-057): an entry moves money in the transaction's
 * direction; one with the opposite sign is unclear (firsttris/haben marks such payments unclear
 * too).
 */
export function entryShare(
  entry: Pick<TransactionLogEntry, "amountPaid">,
  transactionAmount: string,
): { readonly share: string } | { readonly problem: string } {
  if (entry.amountPaid === undefined) {
    return { problem: "its booking log has an entry without an amount" };
  }
  if (isZero(entry.amountPaid)) return { share: "0" };
  if (compare(entry.amountPaid, 0) !== compare(transactionAmount, 0)) {
    return { problem: "its booking log has an entry against the transaction's direction" };
  }
  const amount = entry.amountPaid;
  return { share: toDecimalString(compare(amount, 0) < 0 ? negate(amount) : amount) };
}

/**
 * The amount of `transaction` not yet assigned to documents, from its log, exactly. Unknown when
 * the log is incomplete, has an entry without an amount or against the transaction's direction,
 * assigns more than the transaction holds, or contradicts the status (entries on a free
 * transaction, none on a partly linked one).
 */
export function remainingAmount(
  transaction: Pick<TransactionDto, "amount" | "status">,
  log: Pick<TransactionLog, "entries" | "complete">,
): RemainingAmount {
  if (!log.complete) {
    return { known: false, reason: "its booking log could not be read completely" };
  }
  const signed = transaction.amount.amount;
  const total = toDecimalString(compare(signed, 0) < 0 ? negate(signed) : signed);
  let assigned = "0";
  for (const entry of log.entries) {
    const share = entryShare(entry, signed);
    if ("problem" in share) return { known: false, reason: share.problem };
    assigned = toDecimalString(add(assigned, share.share));
  }
  if (compare(assigned, total) > 0) {
    return { known: false, reason: "its booking log assigns more than the transaction amount" };
  }
  const status = transaction.status?.code;
  if (status === TRANSACTION_STATUS.created && log.entries.length > 0) {
    return {
      known: false,
      reason: "it is marked unbooked (status 100) but its booking log has entries",
    };
  }
  if (status === TRANSACTION_STATUS.linked && log.entries.length === 0) {
    return {
      known: false,
      reason: "it is marked partly linked (status 200) but its booking log has no entries",
    };
  }
  return {
    known: true,
    total,
    assigned,
    remaining: toDecimalString(add(total, negate(assigned))),
  };
}

// ---------------------------------------------------------------------------------------------
// Payments of a period (cash basis, Ist-Versteuerung)
// ---------------------------------------------------------------------------------------------

/** One payment on a document: the share of one transaction booked against it. */
export interface DocumentPayment {
  /** Value date (Wertstellung) of the transaction, `YYYY-MM-DD` Berlin: the payment day. */
  readonly date: string;
  readonly document: { readonly objectName: PaidDocumentObjectName; readonly id: number };
  /**
   * Absolute amount the transaction settled on the document (always > 0), in the transaction's
   * currency (= its check account's; sevDesk links only documents in that currency). Never
   * converted.
   */
  readonly amount: Money;
  /** `in` = money received, `out` = money paid (the sign of the log entry). */
  readonly direction: "in" | "out";
  /**
   * `amount` signed for the document, ready to sum per document: positive when the money moved
   * in the document's own payment direction (an invoice or revenue voucher receiving money, a
   * credit note or expense voucher paying it out), negative when it moved against it (a bounced
   * direct debit or a refund linked to the same document). The payments of one document in a
   * period add up to what it was paid net. Same currency as `amount`.
   */
  readonly signedForDocument: Money;
  readonly transactionId: number;
  readonly checkAccountId: number | undefined;
  /** Berlin day of the log entry's `bookingDate`, when sevDesk sent one. */
  readonly bookingDate?: string;
}

export interface PaymentsInPeriodResult {
  /** Sorted by date, transaction id, log entry order. */
  readonly payments: DocumentPayment[];
  /** True when a cap stopped reading: the payments are incomplete. */
  readonly truncated: boolean;
  /** Trusted caveats (skipped entries, booked transactions without entries, …). */
  readonly notes: string[];
  /** sevDesk transaction rows examined. */
  readonly transactionsScanned: number;
  /** Booked or linked transactions in the period whose log was read. */
  readonly transactionsRead: number;
}

export interface PaymentsInPeriodRange {
  /** Inclusive Berlin days on the transactions' value date. */
  readonly from: string;
  readonly to: string;
  /** Check accounts to include; all when absent or empty. */
  readonly accountIds?: readonly number[] | undefined;
}

export interface PaymentsInPeriodOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?:
    | ((done: number, total: number | undefined, message: string) => Promise<void> | void)
    | undefined;
  /** Most booked transactions to read the log for; default {@link PAYMENTS_MAX_TRANSACTIONS}. */
  readonly maxTransactions?: number | undefined;
  /**
   * The payment direction of a voucher (expense `out`, revenue `in`) when the caller already
   * knows it. For a voucher it returns `undefined` for (or without this option), the voucher is
   * read once (`GET /Voucher/{id}`) to sign {@link DocumentPayment.signedForDocument}.
   */
  readonly voucherDirection?: ((voucherId: number) => "in" | "out" | undefined) | undefined;
}

/** Default cap of booked transactions `paymentsInPeriod` reads the log for. */
const PAYMENTS_MAX_TRANSACTIONS = 2_000;
/** Cap of transaction rows examined per account (value dates are filtered here, D-047). */
const PAYMENTS_MAX_ROWS = 20_000;
/** From this many transactions on, one scan of the whole log is cheaper than one read each. */
const WHOLE_LOG_THRESHOLD = 25;
/** Cap of log entries read in one scan of the whole log. */
const WHOLE_LOG_MAX = 50_000;
/** Matches per `listTransactions` call. */
const TRANSACTION_PAGE = 500;

/** Statuses of transactions that can carry log entries: linked, auto-booked, booked. */
const BOOKED_STATUS_KEYS = [
  "linked",
  "auto_booked",
  "booked",
] as const satisfies readonly (typeof TRANSACTION_STATUS_KEYS)[number][];

/** Payment direction of the kinds whose direction is fixed. */
const FIXED_DIRECTION: Readonly<Record<Exclude<PaymentKind, "voucher">, "in" | "out">> = {
  invoice: "in",
  creditNote: "out",
};

/**
 * The payments of a period for cash-basis reports: transactions whose value date lies in
 * `from`–`to` (linked, auto-booked or booked; read with `listTransactions`, value dates checked
 * here, D-047), then their log entries, one {@link DocumentPayment} per entry on an invoice,
 * credit note or voucher. Bookings without an imported transaction count too: sevDesk creates a
 * booked transaction for them on the offline or cash account (D-071).
 *
 * Log reads: one request per transaction for a few transactions; from
 * {@link WHOLE_LOG_THRESHOLD} on, one scan of the whole log (paged, joined by transaction id),
 * falling back to one request each if that scan hits its cap. At most `maxTransactions`
 * transactions are read; beyond that, and when a row cap stops the transaction scan, the result
 * is `truncated`. Vouchers with payments are read once each for their direction unless
 * `voucherDirection` knows it; a voucher sevDesk no longer has is left out with a note.
 */
export async function paymentsInPeriod(
  client: SevdeskClient,
  range: PaymentsInPeriodRange,
  options: PaymentsInPeriodOptions = {},
): Promise<PaymentsInPeriodResult> {
  if (range.from > range.to) {
    throw new SevdeskError({
      kind: "validation",
      message: "The date range is empty: 'from' is after 'to'.",
    });
  }
  const maxTransactions = options.maxTransactions ?? PAYMENTS_MAX_TRANSACTIONS;
  const accounts =
    range.accountIds === undefined || range.accountIds.length === 0
      ? [undefined]
      : [...new Set(range.accountIds.map((id) => toSevdeskId(id)))];

  const transactions: TransactionDto[] = [];
  let scanned = 0;
  let truncated = false;
  for (const accountId of accounts) {
    let offset = 0;
    let accountRows = 0;
    for (;;) {
      throwIfAborted(options.signal);
      const page = await listTransactions(
        client,
        {
          checkAccountId: accountId,
          from: range.from,
          to: range.to,
          dateField: "value",
          statuses: BOOKED_STATUS_KEYS,
          limit: TRANSACTION_PAGE,
          offset,
        },
        { signal: options.signal },
      );
      scanned += page.rowsScanned;
      accountRows += page.rowsScanned;
      transactions.push(...page.items);
      await options.onProgress?.(scanned, undefined, `Examined ${scanned} bank transactions.`);
      if (!page.hasMore || page.rowsScanned === 0) break;
      if (accountRows >= PAYMENTS_MAX_ROWS) {
        truncated = true;
        break;
      }
      offset = page.nextOffset;
    }
  }

  const unique = [...new Map(transactions.map((t) => [t.id, t])).values()].sort(
    (a, b) => (a.valueDate ?? "").localeCompare(b.valueDate ?? "") || a.id - b.id,
  );
  const selected = unique.slice(0, maxTransactions);
  if (unique.length > selected.length) truncated = true;

  const logs = await readLogs(client, selected, options);
  if (logs.truncated) truncated = true;

  const skipped = {
    other: 0,
    noAmount: 0,
    zero: 0,
    against: 0,
    noEntries: 0,
    unread: 0,
    voucherUnknown: 0,
  };
  const candidates: { transaction: TransactionDto; entry: TransactionLogEntry }[] = [];
  for (const transaction of selected) {
    const entries = logs.byTransaction.get(transaction.id);
    if (entries === undefined) {
      skipped.unread += 1;
      continue;
    }
    if (entries.length === 0) skipped.noEntries += 1;
    for (const entry of entries) candidates.push({ transaction, entry });
  }

  const directions = await voucherDirections(client, candidates, options);
  const payments: DocumentPayment[] = [];
  for (const { transaction, entry } of candidates) {
    const payment = toPayment(transaction, entry, directions);
    if (typeof payment === "string") skipped[payment] += 1;
    else payments.push(payment);
  }

  return {
    payments,
    truncated,
    notes: paymentNotes(skipped, truncated),
    transactionsScanned: scanned,
    transactionsRead: selected.length - skipped.unread,
  };
}

/**
 * The payment direction of every voucher the entries book: from `options.voucherDirection`, else
 * read once (`GET /Voucher/{id}`); `undefined` when sevDesk no longer has the voucher or it does
 * not say whether it is an expense or revenue.
 */
async function voucherDirections(
  client: SevdeskClient,
  candidates: readonly { readonly entry: TransactionLogEntry }[],
  options: PaymentsInPeriodOptions,
): Promise<ReadonlyMap<number, "in" | "out" | undefined>> {
  const directions = new Map<number, "in" | "out" | undefined>();
  for (const { entry } of candidates) {
    const document = entry.document;
    if (document?.kind !== "voucher" || directions.has(document.id)) continue;
    const known = options.voucherDirection?.(document.id);
    if (known !== undefined) {
      directions.set(document.id, known);
      continue;
    }
    throwIfAborted(options.signal);
    try {
      // Vouchers do not enrich country addresses, so this read does not use the country cache.
      const voucher = await readLifecycleDocument(client, "voucher", document.id, {
        signal: options.signal,
        cacheOwner: client,
      });
      directions.set(document.id, voucher.direction);
    } catch (error) {
      if (
        error instanceof SevdeskError &&
        (error.kind === "not_found" || error.kind === "unexpected_response")
      ) {
        directions.set(document.id, undefined);
        continue;
      }
      throw error;
    }
  }
  return directions;
}

type SkipReason = "other" | "noAmount" | "zero" | "against" | "voucherUnknown";

function toPayment(
  transaction: TransactionDto,
  entry: TransactionLogEntry,
  voucherDirections: ReadonlyMap<number, "in" | "out" | undefined>,
): DocumentPayment | SkipReason {
  const document = entry.document;
  if (document === undefined || document.kind === "other") return "other";
  if (entry.amountPaid === undefined) return "noAmount";
  if (isZero(entry.amountPaid)) return "zero";
  const direction = directionOf(entry.amountPaid);
  if (direction === "none") return "zero";
  if (transaction.direction !== "none" && direction !== transaction.direction) return "against";
  const documentDirection =
    document.kind === "voucher"
      ? voucherDirections.get(document.id)
      : FIXED_DIRECTION[document.kind];
  if (documentDirection === undefined) return "voucherUnknown";
  const absolute = compare(entry.amountPaid, 0) < 0 ? negate(entry.amountPaid) : entry.amountPaid;
  const currency = transaction.amount.currency;
  return {
    // Selected by a value-date range, so the date is set.
    date: transaction.valueDate ?? "",
    document: { objectName: PAYMENT_OBJECT_NAMES[document.kind], id: document.id },
    amount: money(absolute, currency),
    direction,
    signedForDocument: money(
      direction === documentDirection ? absolute : negate(absolute),
      currency,
    ),
    transactionId: transaction.id,
    checkAccountId: transaction.account?.id,
    ...(entry.bookingDate === undefined ? {} : { bookingDate: entry.bookingDate }),
  };
}

function paymentNotes(
  skipped: Readonly<Record<SkipReason | "noEntries" | "unread", number>>,
  truncated: boolean,
): string[] {
  const notes = [
    "Payments are the shares of bank transactions booked against documents (sevDesk's booking " +
      "log), dated by the transaction's value date (Wertstellung).",
  ];
  if (truncated) {
    notes.push("A cap stopped reading transactions or their booking log: payments are missing.");
  }
  if (skipped.other > 0) {
    notes.push(
      `${skipped.other} log entries book something other than an invoice, credit note or voucher ` +
        "and are left out.",
    );
  }
  if (skipped.noAmount > 0 || skipped.against > 0) {
    notes.push(
      `${skipped.noAmount + skipped.against} log entries have no amount or one against the ` +
        "transaction's direction and are left out.",
    );
  }
  if (skipped.voucherUnknown > 0) {
    notes.push(
      `${skipped.voucherUnknown} log entries book vouchers that sevDesk no longer has or that do ` +
        "not say whether they are an expense or revenue; they are left out.",
    );
  }
  if (skipped.noEntries > 0) {
    notes.push(
      `${skipped.noEntries} booked or linked transactions have no booking log entries (booked ` +
        "another way, e.g. directly to an account) and are left out.",
    );
  }
  return notes;
}

/** The whole booking log of the sevDesk client, or `complete: false` when it hit the cap. */
export interface WholeLog {
  /** Ordered by entry id; empty when `complete` is false (nothing is parsed then). */
  readonly entries: readonly TransactionLogEntry[];
  readonly complete: boolean;
}

/**
 * Reads the whole booking log (`GET /CheckAccountTransactionLog` without a filter, paged; it pages
 * stably per sevdesk-rs and our probe) up to {@link WHOLE_LOG_MAX} entries. Log filters by
 * document are ignored by sevDesk, so this is how the entries of a document are found.
 */
export async function readWholeLog(
  client: SevdeskClient,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly onProgress?: ((done: number, total: number | undefined) => void) | undefined;
  } = {},
): Promise<WholeLog> {
  const scan = await client.listAll(TRANSACTION_LOG_PATH, undefined, {
    max: WHOLE_LOG_MAX,
    pageSize: LOG_PAGE_SIZE,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  if (scan.truncated) return { entries: [], complete: false };
  return { entries: byEntryId(scan.items.map(parseLogEntry)), complete: true };
}

interface LogsRead {
  /** Entries per transaction id; a transaction missing from the map was not read. */
  readonly byTransaction: ReadonlyMap<number, readonly TransactionLogEntry[]>;
  readonly truncated: boolean;
}

/** The log entries of `transactions`: one read each, or one scan of the whole log. */
async function readLogs(
  client: SevdeskClient,
  transactions: readonly TransactionDto[],
  options: PaymentsInPeriodOptions,
): Promise<LogsRead> {
  if (transactions.length >= WHOLE_LOG_THRESHOLD) {
    const whole = await readWholeLog(client, {
      signal: options.signal,
      onProgress: (done, total) => {
        void options.onProgress?.(done, total, `Read ${done} booking log entries.`);
      },
    });
    if (whole.complete) {
      const byTransaction = new Map<number, TransactionLogEntry[]>(
        transactions.map((t) => [t.id, []]),
      );
      for (const entry of whole.entries) {
        if (entry.transactionId !== undefined) byTransaction.get(entry.transactionId)?.push(entry);
      }
      return { byTransaction, truncated: false };
    }
  }
  const byTransaction = new Map<number, readonly TransactionLogEntry[]>();
  let truncated = false;
  let done = 0;
  for (const transaction of transactions) {
    throwIfAborted(options.signal);
    const log = await readTransactionLog(client, transaction.id, options.signal);
    if (!log.complete) truncated = true;
    byTransaction.set(transaction.id, log.entries);
    done += 1;
    await options.onProgress?.(
      done,
      transactions.length,
      `Read the booking log of ${done} of ${transactions.length} transactions.`,
    );
  }
  return { byTransaction, truncated };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
  }
}
