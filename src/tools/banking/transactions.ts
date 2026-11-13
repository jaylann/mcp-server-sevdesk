import { z } from "zod";

import {
  DIRECTIONS,
  listTransactions,
  MAX_SCAN_ROWS,
  TRANSACTION_DATE_FIELDS,
  TRANSACTION_STATUS_KEYS,
  transactionDtoSchema,
  type TransactionListResult,
} from "../../domain/banking.js";
import { dateRangeInputShape } from "../../domain/common.js";
import {
  listDetailInputShape,
  transactionSummary,
  transactionSummarySchema,
} from "../../domain/list-summary.js";
import { pagingInputShape } from "../../domain/paging.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  items: z.array(z.union([transactionDtoSchema, transactionSummarySchema])),
  total: z
    .number()
    .int()
    .optional()
    .describe("All matches in sevDesk; only without local filters (see filteredLocally)."),
  offset: z.number().int().describe("Offset in sevDesk rows this page started at."),
  limit: z.number().int(),
  hasMore: z
    .boolean()
    .describe("More rows may follow: call again with offset = nextOffset. An empty page ends."),
  nextOffset: z
    .number()
    .int()
    .optional()
    .describe("offset plus rowsScanned: counts sevDesk rows examined, not matches."),
  rowsScanned: z.number().int().describe("sevDesk rows examined for this page."),
  rowsTotal: z
    .number()
    .int()
    .optional()
    .describe("sevDesk rows matching what sevDesk filtered (account, entry dates, one status)."),
  filteredLocally: z
    .boolean()
    .describe("True when status, direction or value dates were filtered here after reading."),
});

/** `sevdesk_transactions_list`: bank transactions (Umsätze), e.g. the unbooked ones. */
export const transactionsListTool = defineTool({
  name: "sevdesk_transactions_list",
  title: "List sevDesk bank transactions",
  description:
    "List bank transactions (Umsätze) of the payment accounts. Amounts are signed: positive = " +
    "incoming, negative = outgoing (direction in/out). Filter by account id, date range, " +
    "direction and status: created (offen, not yet booked), linked (verknüpft), private, " +
    "auto_booked, booked (gebucht). Unbooked = status created. Status, direction and value-date " +
    `ranges are checked here while reading up to ${MAX_SCAN_ROWS} rows per call; ` +
    "dateField=entry lets sevDesk filter by entry date instead (faster). offset/nextOffset " +
    "count sevDesk rows, not matches: pass nextOffset while hasMore is true. Account ids: " +
    "sevdesk_bank_accounts_list. Use detail=summary to browse/find; sevdesk_transaction_get or detail=full for details.",
  toolset: "banking",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    ...listDetailInputShape,
    checkAccountId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Payment account (Zahlungskonto) id."),
    ...dateRangeInputShape,
    dateField: z
      .enum(TRANSACTION_DATE_FIELDS)
      .default("value")
      .describe(
        "Date that from/to apply to: value (Wertstellung, default; filtered here) or entry " +
          "(the second date, see entryDate; sevDesk filters it itself).",
      ),
    status: z
      .array(z.enum(TRANSACTION_STATUS_KEYS))
      .min(1)
      .max(TRANSACTION_STATUS_KEYS.length)
      .optional()
      .describe("Statuses to include, e.g. ['created'] for unbooked transactions."),
    direction: z
      .enum(DIRECTIONS)
      .optional()
      .describe("in = incoming (positive), out = outgoing (negative)."),
    ...pagingInputShape({ limit: 25, max: 100 }),
  }),
  output,
  handler: async (args, ctx) => {
    const result = await listTransactions(
      ctx.client,
      {
        checkAccountId: args.checkAccountId,
        from: args.from,
        to: args.to,
        dateField: args.dateField,
        statuses: args.status,
        direction: args.direction,
        limit: args.limit,
        offset: args.offset,
      },
      {
        signal: ctx.signal,
        onProgress: (scanned, total) =>
          ctx.progress(scanned, total, `Examined ${scanned} transactions.`),
      },
    );
    return {
      data: {
        items: args.detail === "summary" ? result.items.map(transactionSummary) : [...result.items],
        ...(result.filteredLocally || result.rowsTotal === undefined
          ? {}
          : { total: result.rowsTotal }),
        offset: args.offset,
        limit: args.limit,
        hasMore: result.hasMore,
        ...(result.hasMore ? { nextOffset: result.nextOffset } : {}),
        rowsScanned: result.rowsScanned,
        ...(result.rowsTotal === undefined ? {} : { rowsTotal: result.rowsTotal }),
        filteredLocally: result.filteredLocally,
      },
      summary: summarize(args.offset, result),
    };
  },
});

function summarize(offset: number, result: TransactionListResult): string {
  const { items, rowsScanned, rowsTotal, hasMore, nextOffset } = result;
  if (rowsScanned === 0) {
    return offset === 0 ? "No transactions found." : `No more transactions after offset ${offset}.`;
  }
  const matches = `${items.length} ${items.length === 1 ? "transaction" : "transactions"}`;
  const of = rowsTotal === undefined ? "" : ` of ${rowsTotal}`;
  const rows = `sevDesk rows ${offset + 1}–${nextOffset}${of}`;
  const more = hasMore ? `; more may follow (nextOffset ${nextOffset})` : "";
  const capped = result.scanCapped
    ? ` Stopped after examining ${MAX_SCAN_ROWS} rows; continue with nextOffset.`
    : "";
  return `${matches} in ${rows}${more}.${capped}`;
}
