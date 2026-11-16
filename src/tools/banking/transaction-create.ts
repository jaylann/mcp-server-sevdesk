/**
 * `sevdesk_transaction_create`: enter a bank transaction by hand on a file-import account
 * (`POST /CheckAccountTransaction`), optionally booked to documents in the same confirmation
 * (`bookAmount` per document, linked to the new row, as `sevdesk_transaction_book` does). Every
 * other account is refused before anything is sent. Checks, the duplicate check and the request:
 * `src/domain/reconciliation/manual-transactions.ts`; the booking guards: `allocate.ts`.
 */
import { z } from "zod";

import { DIRECTIONS, transactionDtoSchema } from "../../domain/banking.js";
import { amountInput, isoDateInput, moneySchema } from "../../domain/common.js";
import { documentTitle, type Fact, formatMoney } from "../../domain/lifecycle/preview.js";
import { compare } from "../../domain/money.js";
import {
  bothPreviews,
  dateText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../../domain/preview-text.js";
import {
  MAX_ALLOCATIONS,
  planAllocations,
  type PlannedAllocations,
} from "../../domain/reconciliation/allocate.js";
import {
  COUNTERPARTY_MAX,
  executeTransactionCreate,
  planTransactionCreate,
  PURPOSE_MAX,
  type TransactionCreatePlan,
  type TransactionCreateState,
} from "../../domain/reconciliation/manual-transactions.js";
import { berlinDateOf } from "../../sevdesk/dates.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { COMMIT_ANNOTATIONS, readBackTransaction } from "./reconcile-shared.js";
import {
  allocationFacts,
  allocationInput,
  allocationLocks,
  allocationRequests,
  bookingSchema,
  type PlannedBooking,
  plannedBookings,
  readBackBookings,
  remainingAfterBooking,
  UNDO_WARNING,
} from "./transaction-book.js";

const output = z.object({
  transaction: transactionDtoSchema.describe("The new transaction as read back."),
  bookings: z
    .array(bookingSchema)
    .describe("The documents it was booked to (empty without allocations)."),
  remaining: moneySchema
    .optional()
    .describe(
      "With allocations: left unassigned on the new transaction, from its booking log read " +
        "afterwards.",
    ),
  remainingNote: z
    .string()
    .optional()
    .describe(
      "Set when the log could not be read afterwards: remaining is then the planned value.",
    ),
});

interface CreateState extends TransactionCreateState {
  readonly bookings: readonly PlannedBooking[];
  /** Planned rest after the bookings (positive decimal); `undefined` without allocations. */
  readonly remainingAfter: string | undefined;
}

/** The fact labels and fixed wording of a new transaction, per language. */
const CREATE_TEXT = {
  en: {
    account: "Check account",
    fileImport: "file-import account",
    date: "Value date",
    amount: "Amount",
    in: "incoming",
    out: "outgoing",
    counterparty: "Counterparty",
    purpose: "Purpose (Verwendungszweck)",
    none: "none",
    status: "Status afterwards",
    unbooked: "unbooked (100)",
    booked: "booked (400)",
    partly: "partly linked (200)",
  },
  de: {
    account: "Zahlungskonto",
    fileImport: "Dateiimport-Konto",
    date: "Wertstellung",
    amount: "Betrag",
    in: "Eingang",
    out: "Ausgang",
    counterparty: "Auftraggeber/Empfänger",
    purpose: "Verwendungszweck",
    none: "keiner",
    status: "Status danach",
    unbooked: "ungebucht (100)",
    booked: "gebucht (400)",
    partly: "teilweise verknüpft (200)",
  },
} as const;

/** How the booking guards and warnings name the row before it exists. */
const NEW_TRANSACTION = phrase("the new bank transaction", "dem neuen Kontoumsatz");

export const transactionCreateTool = defineWriteTool({
  name: "sevdesk_transaction_create",
  title: "Enter a sevDesk bank transaction by hand",
  description:
    "Enter a bank transaction (Kontoumsatz) by hand on a file-import account (Dateiimport-Konto, " +
    "fileImport in sevdesk_bank_accounts_list): date, amount with direction (in = Eingang, " +
    "out = Ausgang), counterparty and purpose (Verwendungszweck). sevDesk takes such rows on no " +
    "other account: on a cash register (Kasse) or clearing account book the payment on the " +
    "document instead (sevdesk_voucher_book_payment, sevdesk_invoice_book_payment without " +
    "transactionId; sevDesk creates the row), and a bank-connected account gets its rows from " +
    "the bank. Optional allocations book the new row to documents in the same step, as " +
    "sevdesk_transaction_book does. The preview names rows of that day with the same amount and " +
    "purpose, against entering one twice. Commit tier: changes the account balance; asks a " +
    "human to confirm the preview; dryRun only previews. Undo: sevdesk_transaction_delete while " +
    "unbooked.",
  toolset: "banking",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({
    checkAccountId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .describe("File-import account (fileImport true in sevdesk_bank_accounts_list)."),
    date: isoDateInput
      .optional()
      .describe("Value date (Wertstellung), YYYY-MM-DD; defaults to today (Berlin)."),
    amount: amountInput({ allowZero: false }).describe(
      'Amount, positive, in the account\'s currency, e.g. "23.80"; direction gives the sign.',
    ),
    direction: z
      .enum(DIRECTIONS)
      .describe("in: money received (Eingang); out: money paid (Ausgang)."),
    counterparty: z
      .string()
      .trim()
      .min(1)
      .max(COUNTERPARTY_MAX)
      .describe("Payer or payee (Auftraggeber/Empfänger)."),
    purpose: z
      .string()
      .trim()
      .min(1)
      .max(PURPOSE_MAX)
      .optional()
      .describe("Verwendungszweck, e.g. the invoice number."),
    allocations: z
      .array(allocationInput)
      .min(1)
      .max(MAX_ALLOCATIONS)
      .optional()
      .describe(
        "Documents to book the new transaction to right away, in this order (as in " +
          "sevdesk_transaction_book).",
      ),
    ...dryRunInputShape,
  }),
  output,
  // The account's rows of the day are checked for a duplicate, then the row is created (and
  // booked: each document's open amount is checked first).
  locks: (args) => [
    ACCOUNT_BOOKINGS,
    { objectName: "CheckAccount", id: String(args.checkAccountId) },
    ...allocationLocks(args.allocations ?? []),
  ],
  prepare: async (args, ctx) => {
    const today = berlinDateOf(Date.now());
    const date = args.date ?? today;
    const plan = await planTransactionCreate(
      ctx.client,
      {
        checkAccountId: args.checkAccountId,
        date,
        amount: args.amount,
        direction: args.direction,
        counterparty: args.counterparty,
        purpose: args.purpose,
      },
      ctx.signal,
    );
    const planned =
      args.allocations === undefined
        ? undefined
        : await planAllocations(
            ctx.client,
            {
              transactionId: undefined,
              amount: plan.amount,
              account: plan.account,
              bookingDate: date,
              remainingBefore: args.amount,
              name: NEW_TRANSACTION,
            },
            allocationRequests(args.allocations),
            { signal: ctx.signal, cacheOwner: ctx.config },
          );
    const warnings: Phrase[] = [...plan.warnings];
    if (date > today) {
      warnings.push(
        phrase(
          `The value date ${date} lies in the future.`,
          `Die Wertstellung ${dateText(date, "de")} liegt in der Zukunft.`,
        ),
      );
    }
    if (planned !== undefined) warnings.push(...planned.warnings, UNDO_WARNING);
    const state: CreateState = {
      payload: plan.payload,
      bookings: planned === undefined ? [] : plannedBookings(planned),
      remainingAfter: planned?.remainingAfter,
    };
    return {
      ...bothPreviews((lang) => ({
        action: actionText(plan, date, planned, lang),
        facts: createFacts(plan, date, planned, lang),
        warnings: warnings.map((warning) => warning[lang]),
        irreversible: false,
      })),
      state,
    };
  },
  execute: async (_args, plan, ctx) => {
    const { state } = plan;
    const { id, changed } = await executeTransactionCreate(ctx.client, state, ctx.signal);
    const transaction = await readBackTransaction(ctx, id, changed);
    if (state.bookings.length === 0 || state.remainingAfter === undefined) {
      return {
        data: { transaction, bookings: [] },
        summary:
          `Bank transaction ${String(id)} created: ${formatMoney(transaction.amount)}, status ` +
          `${transaction.status?.label ?? "unknown"} (${String(transaction.status?.code ?? "?")}).`,
        affected: changed,
      };
    }
    const bookings = await readBackBookings(ctx, state.bookings, changed);
    const after = await remainingAfterBooking(ctx, transaction, state.remainingAfter);
    return {
      data: {
        transaction,
        bookings,
        remaining: after.remaining,
        ...(after.note === undefined ? {} : { remainingNote: after.note }),
      },
      summary:
        `Bank transaction ${String(id)} created and booked to ${String(bookings.length)} ` +
        `${bookings.length === 1 ? "document" : "documents"}; ` +
        `${after.remaining.amount} ${after.remaining.currency} left unassigned` +
        (after.note === undefined ? "." : " (planned; the booking log could not be read)."),
      affected: changed,
    };
  },
});

function actionText(
  plan: TransactionCreatePlan,
  date: string,
  planned: PlannedAllocations | undefined,
  lang: PreviewLanguage,
): string {
  const t = CREATE_TEXT[lang];
  const direction = compare(plan.amount.amount, 0) < 0 ? t.out : t.in;
  const account = `${plan.account.name} (${lang === "de" ? "ID" : "id"} ${String(plan.account.id)})`;
  const docs = planned?.allocations.map(({ doc }) => documentTitle(doc, lang)) ?? [];
  const and = lang === "de" ? "und" : "and";
  const list =
    docs.length <= 1
      ? (docs[0] ?? "")
      : `${docs.slice(0, -1).join(", ")} ${and} ${docs.at(-1) ?? ""}`;
  if (lang === "de") {
    return (
      `Kontoumsatz über ${formatMoney(plan.amount, lang)} (${direction}) vom ` +
      `${dateText(date, lang)} auf dem ${t.fileImport} ${account} anlegen` +
      (list === "" ? "." : ` und zuordnen zu ${list}.`)
    );
  }
  return (
    `Enter a bank transaction of ${formatMoney(plan.amount)} (${direction}) dated ${date} on ` +
    `${t.fileImport} ${account}` +
    (list === "" ? "." : `, and book it to ${list}.`)
  );
}

function createFacts(
  plan: TransactionCreatePlan,
  date: string,
  planned: PlannedAllocations | undefined,
  lang: PreviewLanguage,
): Fact[] {
  const t = CREATE_TEXT[lang];
  const { account, amount } = plan;
  const status =
    planned === undefined
      ? t.unbooked
      : compare(planned.remainingAfter, 0) === 0
        ? t.booked
        : t.partly;
  const facts: Fact[] = [
    {
      label: t.account,
      value:
        `${account.name} (${lang === "de" ? "ID" : "id"} ${String(account.id)}, ` +
        `${t.fileImport}${account.importType === undefined ? "" : ` ${account.importType}`})`,
    },
    { label: t.date, value: dateText(date, lang) },
    {
      label: t.amount,
      value: `${formatMoney(amount, lang)} (${compare(amount.amount, 0) < 0 ? t.out : t.in})`,
    },
    { label: t.counterparty, value: plan.counterparty },
    { label: t.purpose, value: plan.purpose ?? t.none },
    { label: t.status, value: status },
  ];
  if (planned !== undefined) {
    facts.push(...allocationFacts(planned, amount.currency, lang));
  }
  return facts;
}
