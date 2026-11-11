/**
 * Reconciliation suggestions (Zuordnungsvorschläge): for unassigned bank transactions (status 100)
 * and partly assigned ones (200, remaining amount from the booking log), the open items they most
 * likely pay, ranked by {@link matchTransaction}.
 *
 * Open items are read with the list functions of the document modules, so rows are parsed and
 * sanitized as in the list tools: invoices open (200) or partially paid (750), without
 * cancellations (SR), recurring templates (WKR) and reminders (MA); credit notes open (200);
 * normal vouchers (VOU) open (100) or partially paid (750), expense and revenue. Each item's open
 * amount is computed the way the payment booking computes it (`openAmount` in
 * `lifecycle/payments.ts`): gross minus sevDesk's paid amount. Items whose open amount the booking
 * would refuse to compute (a partially paid credit note, which reports no paid amount; a
 * foreign-currency document with payments, D-043; a negative paid amount, D-041) are left out
 * and counted. Reading stops at {@link OPEN_ITEMS_SCAN_MAX} rows, which is reported.
 */
import type { SevdeskClient } from "../../sevdesk/types.js";
import { getTransactionDetails, listTransactions, type TransactionDto } from "../banking.js";
import { listCreditNotes } from "../credit-notes.js";
import { listInvoices } from "../invoices.js";
import { compare, DEFAULT_CURRENCY, subtract, toDecimalString } from "../money.js";
import { type ScanPage, scanPages } from "../reports/shared.js";
import { listVouchers } from "../vouchers.js";
import {
  type Match,
  type MatchResult,
  matchTransaction,
  type OpenItemCandidate,
} from "./matcher.js";
import {
  readTransactionLog,
  type RemainingAmount,
  remainingAmount,
  TRANSACTION_STATUS,
} from "./transaction-log.js";

/** Cap of document rows read for open items, over all lists of one call. */
export const OPEN_ITEMS_SCAN_MAX = 3_000;

// ---------------------------------------------------------------------------------------------
// Open items
// ---------------------------------------------------------------------------------------------

/** Open items and how completely they were read. */
export interface OpenItemsRead {
  readonly candidates: readonly OpenItemCandidate[];
  /** Document rows read. */
  readonly scanned: number;
  /** True when {@link OPEN_ITEMS_SCAN_MAX} stopped reading. */
  readonly truncated: boolean;
  /** Rows left out, by reason. */
  readonly excluded: {
    /** SR, WKR, MA invoices; recurring vouchers. */
    readonly notPayable: number;
    /** The open amount cannot be computed the way the booking computes it. */
    readonly openUnknown: number;
    /** Nothing left to pay, or a negative gross. */
    readonly settled: number;
  };
}

type Classified = OpenItemCandidate | "notPayable" | "openUnknown" | "settled";

/**
 * Reads the open items that can receive a payment in `directions`: money in → invoices and
 * revenue vouchers, money out → credit notes and expense vouchers.
 */
export async function loadOpenItems(
  client: SevdeskClient,
  directions: ReadonlySet<"in" | "out">,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<OpenItemsRead> {
  type Source = {
    readonly noun: string;
    readonly fetch: (offset: number, limit: number) => Promise<ScanPage<Classified>>;
  };
  const sources: Source[] = [];
  const { signal } = options;
  if (directions.has("in")) {
    for (const status of ["open", "partially_paid"] as const) {
      sources.push({
        noun: "invoices",
        fetch: async (offset, limit) => {
          const page = await listInvoices(client, { status, limit, offset }, signal);
          return { ...page, items: page.items.map(classifyInvoice) };
        },
      });
    }
  }
  if (directions.has("out")) {
    sources.push({
      noun: "credit notes",
      fetch: async (offset, limit) => {
        const page = await listCreditNotes(client, { status: "open", limit, offset }, signal);
        return { ...page, items: page.items.map(classifyCreditNote) };
      },
    });
  }
  const voucherKind =
    directions.size === 2 ? undefined : directions.has("in") ? "revenue" : "expense";
  for (const status of ["open", "partially_paid"] as const) {
    sources.push({
      noun: "vouchers",
      fetch: async (offset, limit) => {
        const page = await listVouchers(
          client,
          {
            status,
            type: "normal",
            ...(voucherKind === undefined ? {} : { kind: voucherKind }),
            limit,
            offset,
          },
          signal,
        );
        return {
          items: page.items.map(classifyVoucher),
          received: page.window.received,
          total: page.window.total,
          hasMore: page.state.hasMore,
          nextOffset: page.state.nextOffset,
        };
      },
    });
  }

  const candidates: OpenItemCandidate[] = [];
  const seen = new Set<string>();
  const excluded = { notPayable: 0, openUnknown: 0, settled: 0 };
  let scanned = 0;
  let truncated = false;
  for (const source of sources) {
    if (scanned >= OPEN_ITEMS_SCAN_MAX) {
      truncated = true;
      break;
    }
    const scan = await scanPages(source.fetch, {
      max: OPEN_ITEMS_SCAN_MAX - scanned,
      noun: source.noun,
      signal,
    });
    scanned += scan.scanned;
    for (const item of scan.items) {
      if (typeof item === "string") {
        excluded[item] += 1;
        continue;
      }
      // A status filter sevDesk ignored would list an item twice (once per status read).
      const key = `${item.kind}:${String(item.id)}`;
      if (directions.has(item.direction) && !seen.has(key)) {
        seen.add(key);
        candidates.push(item);
      }
    }
    if (scan.truncated) {
      truncated = true;
      break;
    }
  }
  return { candidates, scanned, truncated, excluded };
}

/** Row shapes the classifiers read (the list DTOs). */
type InvoiceRowLike = Awaited<ReturnType<typeof listInvoices>>["items"][number];
type CreditNoteRowLike = Awaited<ReturnType<typeof listCreditNotes>>["items"][number];
type VoucherRowLike = Awaited<ReturnType<typeof listVouchers>>["items"][number];

function classifyInvoice(row: InvoiceRowLike): Classified {
  const code = row.type.code;
  if (code === "SR" || code === "WKR" || code === "MA") return "notPayable";
  const status = row.status.code;
  if (status !== 200 && status !== 750) return "notPayable";
  // The same rules as `openAmount` (`lifecycle/payments.ts`), which guards the booking: a
  // suggestion must not name an open amount the booking would refuse to trust.
  const paidRaw = row.paid?.amount;
  // The invoice list leaves `paid` out for foreign-currency invoices (its currency is
  // undocumented, D-043), so such an invoice counts only while it is open: nothing paid yet.
  if (row.currency !== DEFAULT_CURRENCY && status !== 200) return "openUnknown";
  // A negative paid amount is the trace of a wrongly signed booking (D-041).
  if (paidRaw !== undefined && compare(paidRaw, 0) < 0) return "openUnknown";
  // Partially paid without a paid amount: how much is open is not known. Reading the missing
  // amount as 0 suggested the whole gross as the "exact open amount" (review 2026-11, round 3).
  if (paidRaw === undefined && status === 750) return "openUnknown";
  const paid = paidRaw ?? "0";
  return candidate(
    {
      kind: "invoice",
      id: row.id,
      number: row.number,
      contactId: row.contact?.id,
      contactName: row.contact?.name,
      currency: row.currency,
      direction: "in",
      date: row.date,
      dueDate: row.dueDate,
    },
    row.totals.gross?.amount,
    paid,
  );
}

function classifyCreditNote(row: CreditNoteRowLike): Classified {
  // Only open credit notes: sevDesk reports no paid amount for credit notes, so a partially paid
  // one has an unknown open amount (the booking refuses it).
  if (row.status.code !== 200) return "openUnknown";
  return candidate(
    {
      kind: "creditNote",
      id: row.id,
      number: row.number,
      contactId: row.contact?.id,
      contactName: row.contact?.name,
      currency: row.currency,
      direction: "out",
      date: row.date,
      dueDate: undefined,
    },
    row.totals.gross?.amount,
    "0",
  );
}

function classifyVoucher(row: VoucherRowLike): Classified {
  if (row.type === "recurring") return "notPayable";
  const status = row.status?.code;
  if (status !== 100 && status !== 750) return "notPayable";
  if (row.kind === undefined) return "openUnknown";
  const paidRaw = row.paid?.amount;
  const hasPayments = paidRaw !== undefined && compare(paidRaw, 0) !== 0;
  if (row.currency !== DEFAULT_CURRENCY && (hasPayments || status !== 100)) return "openUnknown";
  if (paidRaw !== undefined && compare(paidRaw, 0) < 0) return "openUnknown";
  if (paidRaw === undefined && status === 750) return "openUnknown";
  return candidate(
    {
      kind: "voucher",
      id: row.id,
      number: row.number,
      contactId: row.supplier?.id,
      contactName: row.supplier?.name,
      currency: row.currency,
      direction: row.kind === "expense" ? "out" : "in",
      date: row.date,
      dueDate: row.paymentDeadline,
    },
    row.totals.gross?.amount,
    paidRaw ?? "0",
  );
}

function candidate(
  base: Omit<OpenItemCandidate, "open">,
  gross: string | undefined,
  paid: string,
): Classified {
  if (gross === undefined) return "openUnknown";
  if (compare(gross, 0) <= 0) return "settled";
  const open = toDecimalString(subtract(gross, paid));
  if (compare(open, 0) <= 0) return "settled";
  return { ...base, open };
}

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

export interface SuggestParams {
  /** One transaction; otherwise the unassigned ones of an account and/or date range. */
  readonly transactionId?: number | undefined;
  readonly checkAccountId?: number | undefined;
  /** Inclusive Berlin days on the value date. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Transactions per call (list mode). */
  readonly limit: number;
  /** Offset in sevDesk transaction rows (list mode). */
  readonly offset: number;
  /** Matches per transaction. */
  readonly matchesPerTransaction: number;
}

/** The suggestions for one transaction. */
export interface TransactionSuggestion {
  readonly transaction: TransactionDto;
  /** What is still free to assign on it. */
  readonly remaining: RemainingAmount;
  /** Trusted reason when the transaction cannot be booked (nothing is suggested then). */
  readonly skipped?: string | undefined;
  readonly matches: readonly Match[];
  readonly excluded: MatchResult["excluded"];
  readonly splitSearch: MatchResult["splitSearch"];
}

export interface SuggestResult {
  readonly suggestions: readonly TransactionSuggestion[];
  /** `undefined` when no transaction could be booked, so no open items were read. */
  readonly openItems: Omit<OpenItemsRead, "candidates"> | undefined;
  /** List mode: sevDesk rows examined and where the next call continues. */
  readonly rowsScanned: number;
  readonly hasMore: boolean;
  readonly nextOffset: number;
}

interface Prepared {
  readonly transaction: TransactionDto;
  readonly iban: string | undefined;
  readonly remaining: RemainingAmount;
  readonly skipped: string | undefined;
}

/**
 * Builds suggestions: reads the transaction(s), their remaining amounts, the open items once for
 * all of them, and ranks matches per transaction.
 */
export async function suggestMatches(
  client: SevdeskClient,
  params: SuggestParams,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<SuggestResult> {
  const { signal } = options;
  const prepared: Prepared[] = [];
  let rowsScanned = 0;
  let hasMore = false;
  let nextOffset = params.offset;

  if (params.transactionId !== undefined) {
    const details = await getTransactionDetails(client, params.transactionId, signal);
    const log = await readTransactionLog(client, details.transaction.id, signal);
    const remaining = remainingAmount(details.transaction, log);
    prepared.push({
      transaction: details.transaction,
      iban: details.counterpartyAccount,
      remaining,
      skipped: skipReason(details.transaction, remaining),
    });
  } else {
    const page = await listTransactions(
      client,
      {
        checkAccountId: params.checkAccountId,
        from: params.from,
        to: params.to,
        dateField: "value",
        statuses: ["created", "linked"],
        limit: params.limit,
        offset: params.offset,
      },
      { signal },
    );
    rowsScanned = page.rowsScanned;
    hasMore = page.hasMore;
    nextOffset = page.nextOffset;
    for (const transaction of page.items) {
      // A free transaction's log is empty (resetToOpen deletes entries, D-060): no read needed.
      const remaining =
        transaction.status?.code === TRANSACTION_STATUS.created
          ? remainingAmount(transaction, { entries: [], complete: true })
          : remainingAmount(transaction, await readTransactionLog(client, transaction.id, signal));
      prepared.push({
        transaction,
        iban: undefined,
        remaining,
        skipped: skipReason(transaction, remaining),
      });
    }
  }

  const directions = new Set<"in" | "out">();
  for (const item of prepared) {
    const direction = item.transaction.direction;
    if (item.skipped === undefined && direction !== "none") directions.add(direction);
  }
  const openItems =
    directions.size === 0 ? undefined : await loadOpenItems(client, directions, { signal });

  const suggestions = prepared.map((item): TransactionSuggestion => {
    const { transaction, remaining } = item;
    if (item.skipped !== undefined || openItems === undefined || !remaining.known) {
      return {
        transaction,
        remaining,
        skipped: item.skipped,
        matches: [],
        excluded: { direction: 0, currency: 0 },
        splitSearch: { combinations: 0, capped: false },
      };
    }
    const result = matchTransaction(
      {
        id: transaction.id,
        available: remaining.remaining,
        direction: transaction.direction === "out" ? "out" : "in",
        currency: transaction.amount.currency,
        valueDate: transaction.valueDate,
        counterparty: transaction.counterparty,
        purpose: transaction.purpose,
        iban: item.iban,
      },
      openItems.candidates,
      {
        maxSingles: params.matchesPerTransaction,
        maxSplits: Math.min(3, params.matchesPerTransaction),
      },
    );
    return {
      transaction,
      remaining,
      matches: result.matches.slice(0, params.matchesPerTransaction),
      excluded: result.excluded,
      splitSearch: result.splitSearch,
    };
  });

  return {
    suggestions,
    openItems:
      openItems === undefined
        ? undefined
        : {
            scanned: openItems.scanned,
            truncated: openItems.truncated,
            excluded: openItems.excluded,
          },
    rowsScanned,
    hasMore,
    nextOffset,
  };
}

/**
 * Why a transaction gets no suggestions (trusted text), or `undefined` when it can be booked:
 * it must be free (100) or partly linked (200) with a known remaining amount, not enshrined, and
 * belong to an account.
 */
export function skipReason(
  transaction: TransactionDto,
  remaining: RemainingAmount,
): string | undefined {
  const status = transaction.status?.code;
  if (transaction.enshrined) {
    return "It is enshrined (festgeschrieben) and cannot be booked anymore.";
  }
  if (status === TRANSACTION_STATUS.private) return "It is marked as private.";
  if (status === TRANSACTION_STATUS.booked || status === TRANSACTION_STATUS.autoBooked) {
    return "It is already booked.";
  }
  if (status !== TRANSACTION_STATUS.created && status !== TRANSACTION_STATUS.linked) {
    return `It has status ${status === undefined ? "unknown" : String(status)}, which cannot be booked.`;
  }
  if (transaction.account === undefined) return "It belongs to no check account.";
  if (transaction.direction === "none") return "Its amount is zero.";
  if (!remaining.known) return `Its remaining amount is unknown: ${remaining.reason}.`;
  if (compare(remaining.remaining, 0) <= 0) return "Nothing of it is left to assign.";
  return undefined;
}
