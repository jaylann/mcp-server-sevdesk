/**
 * `sevdesk_reconcile_suggest`: for unassigned bank transactions, the open invoices, credit notes
 * and vouchers they most likely pay, with reasons, a confidence and the exact
 * `sevdesk_transaction_book` call. Scoring: `src/domain/reconciliation/matcher.ts`; loading:
 * `suggest.ts`.
 */
import { z } from "zod";

import { transactionDtoSchema } from "../../domain/banking.js";
import { dateRangeInputShape, moneySchema } from "../../domain/common.js";
import { refuse } from "../../domain/lifecycle/transitions.js";
import { money } from "../../domain/money.js";
import type { Match, OpenItemCandidate } from "../../domain/reconciliation/matcher.js";
import {
  OPEN_ITEMS_SCAN_MAX,
  suggestMatches,
  type TransactionSuggestion,
} from "../../domain/reconciliation/suggest.js";
import { defineTool } from "../define-tool.js";
import { argOfKind, DOCUMENT_KINDS, READ_ANNOTATIONS } from "./reconcile-shared.js";

const BOOK_TOOL = "sevdesk_transaction_book";

const allocationSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  id: z.number().int(),
  number: z.string().optional().describe("Document number or Belegnummer."),
  contact: z.object({ id: z.number().int().optional(), name: z.string().optional() }).optional(),
  date: z.string().optional().describe("Document date, YYYY-MM-DD."),
  dueDate: z.string().optional().describe("Due date, YYYY-MM-DD."),
  openAmount: moneySchema.describe("Open amount of the document (gross minus paid)."),
  amount: moneySchema.describe("What the suggested booking assigns to it."),
});

const matchSchema = z.object({
  type: z
    .enum(["single", "split"])
    .describe("single: one document; split: several whose open amounts add up exactly."),
  confidence: z.enum(["high", "medium", "low"]),
  score: z.number().int().describe("Points of the signals below; for ranking only."),
  reasons: z.array(z.string()).describe("Why it matches (and what speaks against it)."),
  allocations: z.array(allocationSchema),
  followUp: z
    .object({
      tool: z.literal(BOOK_TOOL),
      arguments: z.object({
        transactionId: z.number().int(),
        allocations: z.array(
          z.object({ kind: z.enum(DOCUMENT_KINDS), id: z.number().int(), amount: z.string() }),
        ),
      }),
    })
    .describe("The exact call that books this suggestion (asks a human to confirm)."),
});

const suggestionSchema = z.object({
  transaction: transactionDtoSchema,
  remaining: moneySchema.optional().describe("Still unassigned on the transaction."),
  skipped: z
    .string()
    .optional()
    .describe("Why nothing is suggested for this transaction (already booked, private, …)."),
  matches: z.array(matchSchema).describe("Best first. Empty when nothing fits."),
  otherCurrencyItems: z
    .number()
    .int()
    .optional()
    .describe("Open items left out because they are in another currency than the transaction."),
});

const output = z.object({
  suggestions: z.array(suggestionSchema),
  openItems: z
    .object({
      scanned: z.number().int().describe("Document rows read."),
      truncated: z
        .boolean()
        .describe(`True when the cap of ${OPEN_ITEMS_SCAN_MAX} rows stopped reading open items.`),
      excluded: z.object({
        notPayable: z.number().int().describe("Cancellations, reminders, recurring templates."),
        openUnknown: z
          .number()
          .int()
          .describe("Open amount unknown (partially paid credit notes, foreign currency)."),
        settled: z.number().int(),
      }),
    })
    .optional()
    .describe("Absent when no transaction could be booked (no open items were read)."),
  offset: z.number().int().describe("Offset in sevDesk transaction rows this page started at."),
  limit: z.number().int(),
  hasMore: z.boolean().describe("More transactions may follow: call again with nextOffset."),
  nextOffset: z.number().int().optional(),
  rowsScanned: z.number().int().describe("sevDesk transaction rows examined."),
});

type MatchOut = z.output<typeof matchSchema>;
type SuggestionOut = z.output<typeof suggestionSchema>;

export const reconcileSuggestTool = defineTool({
  name: "sevdesk_reconcile_suggest",
  title: "Suggest matches for sevDesk bank transactions",
  description:
    "Bank reconciliation (Kontoabgleich, Zuordnung): for unassigned bank transactions " +
    "(Kontoumsätze, status created, or partly linked with a rest), rank the open invoices " +
    "(Rechnungen), credit notes (Gutschriften) and vouchers (Belege, by Belegnummer) they most " +
    "likely pay: exact open amount, document number in the purpose (Verwendungszweck), " +
    "counterparty name, date; plus split suggestions (several documents adding up exactly). " +
    "Each match has reasons, a confidence and the exact sevdesk_transaction_book call; book " +
    "only after the user agrees. Call it directly: without arguments it scans the unassigned " +
    "transactions of every bank account; pass transactionId, or checkAccountId and/or a " +
    "value-date range to narrow it (page with offset). Imported bank accounts only: offline and " +
    "cash accounts get their transactions from bookings. Read-only.",
  toolset: "banking",
  tier: "read",
  annotations: READ_ANNOTATIONS,
  input: z.strictObject({
    transactionId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("One transaction (Umsatz) id; leave out to scan unassigned ones."),
    checkAccountId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Payment account (Zahlungskonto) id, from sevdesk_bank_accounts_list."),
    ...dateRangeInputShape,
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Transactions per call (default 10, at most 25)."),
    offset: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0)
      .describe("sevDesk transaction rows to skip: pass nextOffset from the previous call."),
    matches: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("Matches per transaction (default 3)."),
  }),
  output,
  handler: async (args, ctx) => {
    if (
      args.transactionId !== undefined &&
      (args.checkAccountId !== undefined || args.from !== undefined || args.to !== undefined)
    ) {
      refuse("Pass either transactionId or checkAccountId/from/to, not both.");
    }
    const result = await suggestMatches(
      ctx.client,
      {
        transactionId: args.transactionId,
        checkAccountId: args.checkAccountId,
        from: args.from,
        to: args.to,
        limit: args.limit,
        offset: args.offset,
        matchesPerTransaction: args.matches,
      },
      { signal: ctx.signal },
    );
    const suggestions = result.suggestions.map(toSuggestion);
    const withMatches = suggestions.filter((s) => s.matches.length > 0).length;
    return {
      data: {
        suggestions,
        ...(result.openItems === undefined ? {} : { openItems: result.openItems }),
        offset: args.offset,
        limit: args.limit,
        hasMore: result.hasMore,
        ...(result.hasMore ? { nextOffset: result.nextOffset } : {}),
        rowsScanned: result.rowsScanned,
      },
      summary:
        suggestions.length === 0
          ? "No unassigned transactions found."
          : `${String(suggestions.length)} ${suggestions.length === 1 ? "transaction" : "transactions"}, ` +
            `${String(withMatches)} with suggestions` +
            (result.openItems?.truncated === true ? "; open items were capped" : "") +
            (result.hasMore ? `; more may follow (nextOffset ${String(result.nextOffset)}).` : "."),
    };
  },
});

function toSuggestion(suggestion: TransactionSuggestion): SuggestionOut {
  const { transaction, remaining } = suggestion;
  const currency = transaction.amount.currency;
  return {
    transaction,
    ...(remaining.known ? { remaining: money(remaining.remaining, currency) } : {}),
    ...(suggestion.skipped === undefined ? {} : { skipped: suggestion.skipped }),
    matches: suggestion.matches.map((match) => toMatch(transaction.id, match)),
    ...(suggestion.excluded.currency > 0
      ? { otherCurrencyItems: suggestion.excluded.currency }
      : {}),
  };
}

function toMatch(transactionId: number, match: Match): MatchOut {
  const parts: { candidate: OpenItemCandidate; amount: string }[] =
    match.type === "single"
      ? [{ candidate: match.candidate, amount: match.amount }]
      : match.parts.map((candidate) => ({ candidate, amount: candidate.open }));
  return {
    type: match.type,
    confidence: match.confidence,
    score: match.score,
    reasons: [...match.reasons],
    allocations: parts.map(({ candidate, amount }) => ({
      kind: argOfKind(candidate.kind),
      id: candidate.id,
      ...(candidate.number === undefined ? {} : { number: candidate.number }),
      ...(candidate.contactId === undefined && candidate.contactName === undefined
        ? {}
        : {
            contact: {
              ...(candidate.contactId === undefined ? {} : { id: candidate.contactId }),
              ...(candidate.contactName === undefined ? {} : { name: candidate.contactName }),
            },
          }),
      ...(candidate.date === undefined ? {} : { date: candidate.date }),
      ...(candidate.dueDate === undefined ? {} : { dueDate: candidate.dueDate }),
      openAmount: money(candidate.open, candidate.currency),
      amount: money(amount, candidate.currency),
    })),
    followUp: {
      tool: BOOK_TOOL,
      arguments: {
        transactionId,
        allocations: parts.map(({ candidate, amount }) => ({
          kind: argOfKind(candidate.kind),
          id: candidate.id,
          amount: money(amount, candidate.currency).amount,
        })),
      },
    },
  };
}
