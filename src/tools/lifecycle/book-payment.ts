/**
 * `sevdesk_{invoice,credit_note,voucher}_book_payment`: book a payment (Zahlung buchen) on an open
 * or partially paid invoice, credit note or voucher (`PUT /{Invoice|CreditNote|Voucher}/{id}/
 * bookAmount`), optionally linked to an imported bank transaction (B7: link the existing
 * transaction instead of letting sevDesk create a second one). Over-booking is refused (see
 * `planPayment`). Payload, sign and date format: `src/domain/lifecycle/payments.ts`; a voucher's
 * sign follows its own direction (expense: money out, negative; revenue: in, D-041).
 */
import { z } from "zod";

import {
  type BankAccountDto,
  getBankAccount,
  getTransaction,
  type TransactionDto,
} from "../../domain/banking.js";
import { amountInput, isoDateInput, moneySchema } from "../../domain/common.js";
import {
  KINDS,
  type LifecycleDocument,
  type PaymentKind,
  readLifecycleDocument,
} from "../../domain/lifecycle/documents.js";
import {
  type BookAmountPayload,
  type BookingType,
  checkPaymentAccount,
  checkPaymentTransaction,
  CREDIT_NOTE_PAYMENT_TYPES,
  PAYMENT_TYPES,
  paymentDirection,
  type PaymentPlan,
  paymentSign,
  paymentTypeOf,
  planPayment,
} from "../../domain/lifecycle/payments.js";
import {
  documentFacts,
  documentTitle,
  type Fact,
  formatMoney,
} from "../../domain/lifecycle/preview.js";
import { assertBookable, refuse } from "../../domain/lifecycle/transitions.js";
import { add, money, toDecimalString } from "../../domain/money.js";
import {
  bothPreviews,
  dateText,
  numberText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../../domain/preview-text.js";
import { entryShare, readTransactionLog } from "../../domain/reconciliation/transaction-log.js";
import { berlinDateOf } from "../../sevdesk/dates.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS, type SevdeskObjectRef } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import {
  capitalize,
  COMMIT_ANNOTATIONS,
  documentObject,
  documentOutput,
  documentOutputSchema,
  idInput,
  KIND_TOOLS,
  readBack,
} from "./shared.js";

const DESCRIPTIONS: Readonly<Record<PaymentKind, string>> = {
  invoice:
    "Book a payment on an invoice (Zahlung buchen, Zahlungseingang): amount (gross, positive), " +
    "date (default today), check account (Zahlungskonto, sevdesk_bank_accounts_list) and, for " +
    "an imported bank payment, its transactionId (sevdesk_transactions_list, status created) so " +
    "the transaction is linked instead of counted twice. Bank accounts fed by imports need it. " +
    "Refuses more than the open amount (gross minus paid) unless paymentType reminder_charges or " +
    "other_difference says the extra is intended; cash_discount (Skonto) and bank_fees settle " +
    "the invoice with less. Open or partially paid invoices only. Commit tier: asks a human to " +
    "confirm the preview; dryRun only previews. Undo: sevdesk_invoice_reset to open.",
  creditNote:
    "Book a payout on a credit note (Gutschrift auszahlen, Zahlungsausgang): amount (gross, " +
    "positive; sent to sevDesk as money out), date (default today), check account " +
    "(Zahlungskonto, sevdesk_bank_accounts_list) and, for an imported bank payment, its " +
    "transactionId (sevdesk_transactions_list, status created) so the transaction is linked " +
    "instead of counted twice. Bank accounts fed by imports need it. Refuses more than the open " +
    "amount unless paymentType other_difference says the extra is intended. Open credit notes " +
    "only (sevDesk reports no paid amount for partially paid ones). Commit tier: asks a human " +
    "to confirm the preview; dryRun only previews. Undo: sevdesk_credit_note_reset to open.",
  voucher:
    "Book a payment on a voucher (Beleg bezahlen, Zahlung buchen): amount (gross, positive; " +
    "sent to sevDesk signed as the money moves: an expense voucher (Ausgabe) as money out, a " +
    "revenue voucher (Einnahme) as money in), date (default today), check account " +
    "(Zahlungskonto, sevdesk_bank_accounts_list) and, for an imported bank payment, its " +
    "transactionId (Kontoumsatz, sevdesk_transactions_list, status created, same direction) so " +
    "the transaction is linked instead of counted twice. Bank accounts fed by imports need it. " +
    "Refuses more than the open amount unless paymentType other_difference says the extra is " +
    "intended; cash_discount (Skonto) and bank_fees settle it with less. Open or partially paid " +
    "vouchers only (finalize a draft first: sevdesk_voucher_finalize). Commit tier: asks a human " +
    "to confirm the preview; dryRun only previews. Undo: sevdesk_voucher_reset to open.",
};

/** How the amount argument describes the money, per kind. */
const AMOUNT_VERB: Readonly<Record<PaymentKind, string>> = {
  invoice: "received",
  creditNote: "paid out",
  voucher: "paid (expense voucher) or received (revenue voucher)",
};

const PAYMENT_TYPE_HELP =
  "payment (default): all of the open amount or a part of it. cash_discount: less than the " +
  "open amount, the rest is written off as Skonto. bank_fees: less, the rest written off as " +
  "bank fees (Geldverkehrskosten). other_difference: more or less than the open amount for " +
  "another reason; the document is settled.";

const BOOKING_TYPE_TEXT: Readonly<Record<BookingType, Phrase>> = {
  FULL_PAYMENT: phrase("full payment (FULL_PAYMENT)", "vollständige Zahlung (FULL_PAYMENT)"),
  N: phrase("partial payment (N)", "Teilzahlung (N)"),
  CB: phrase("payment less cash discount (Skonto, CB)", "Zahlung abzüglich Skonto (CB)"),
  MTC: phrase("payment less bank fees (MTC)", "Zahlung abzüglich Kosten des Geldverkehrs (MTC)"),
  O: phrase(
    "payment with a difference for other reasons (O)",
    "Zahlung mit Differenz aus sonstigen Gründen (O)",
  ),
  OF: phrase("payment plus reminder charges (OF)", "Zahlung zuzüglich Mahngebühren (OF)"),
};

/** The account types as the preview names them in German (English: the DTO's own value). */
const ACCOUNT_TYPE_DE: Readonly<Record<BankAccountDto["type"], string>> = {
  bank: "Bankkonto",
  clearing: "Verrechnungskonto",
  cash: "Kasse",
  unknown: "unbekannter Typ",
};

/** The fact labels and fixed values of a payment, per language. */
const PAYMENT_TEXT = {
  en: {
    open: "Open amount",
    received: "Payment received",
    payout: "Payout",
    date: "Booking date",
    account: "Check account",
    transaction: "Linked bank transaction",
    after: "Open after booking",
    settled: "settled",
    sentAs: "Sent to sevDesk as",
    amount: "amount",
    leaving: "money leaving the account",
  },
  de: {
    open: "Offener Betrag",
    received: "Zahlungseingang",
    payout: "Auszahlung",
    date: "Buchungsdatum",
    account: "Zahlungskonto",
    transaction: "Verknüpfter Kontoumsatz",
    after: "Offen nach der Buchung",
    settled: "ausgeglichen",
    sentAs: "An sevDesk gesendet als",
    amount: "Betrag",
    leaving: "Geld verlässt das Konto",
  },
} as const;

const paymentOutputSchema = z.object({
  amount: moneySchema.describe(
    "Amount booked, positive: received for an invoice, paid out for a credit note.",
  ),
  date: z.string().describe("Booking date, YYYY-MM-DD."),
  paymentType: z
    .enum(PAYMENT_TYPES)
    .describe(
      "How it was booked, as the paymentType input names it: payment (full or partial), " +
        "cash_discount, bank_fees, other_difference, reminder_charges.",
    ),
  checkAccountId: z.number().int(),
  transactionId: z.number().int().optional().describe("The linked bank transaction, if any."),
});

interface BookPaymentState {
  readonly payload: BookAmountPayload;
  readonly plan: Pick<PaymentPlan, "amount" | "bookingType">;
  readonly date: string;
}

/** Reads a record a payment refers to; an unknown id becomes a trusted validation error. */
async function lookup<T>(read: () => Promise<T>, missing: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") refuse(missing);
    throw error;
  }
}

/**
 * What the booking log of a transaction at status 100 or 200 already assigns to documents,
 * positive (`readTransactionLog`, m4-reconcile). A partly assigned transaction (200; also what
 * resetting one document of a split leaves, M4 probe run 4) is bookable for the rest; at 100 the
 * shares are subtracted defensively. Other statuses are refused by `checkPaymentTransaction`, so
 * their log is not read. An incomplete log, a 200 without entries or an entry whose share is
 * unclear is refused: the free amount would be a guess.
 */
async function assignedShare(
  client: SevdeskClient,
  transaction: TransactionDto,
  signal: AbortSignal | undefined,
): Promise<string> {
  const status = transaction.status?.code;
  if (status !== 100 && status !== 200) return "0";
  const ref = `Bank transaction ${String(transaction.id)}`;
  const log = await readTransactionLog(client, transaction.id, signal);
  if (status === 200 && log.complete && log.entries.length === 0) {
    refuse(
      `${ref} is partly assigned (status 200), but its booking log has no entries, so how much ` +
        "of it is free is unknown. Book it in the sevDesk web app.",
    );
  }
  if (!log.complete) {
    refuse(
      `The booking log of ${ref.toLowerCase()} could not be read completely, so how much of it ` +
        "is free is unknown. Book it in the sevDesk web app.",
    );
  }
  let assigned = "0";
  for (const entry of log.entries) {
    const share = entryShare(entry, transaction.amount.amount);
    if ("problem" in share) {
      refuse(
        `${ref} is ${status === 200 ? "partly assigned (status 200)" : "marked unbooked (status 100)"}` +
          `, but ${share.problem}, so how much of it is free is unknown. Check it in the sevDesk ` +
          "web app.",
      );
    }
    assigned = toDecimalString(add(assigned, share.share));
  }
  return assigned;
}

function accountText(account: BankAccountDto, lang: PreviewLanguage): string {
  return lang === "de"
    ? `${account.name} (ID ${String(account.id)}, ${account.currency}, ` +
        `${ACCOUNT_TYPE_DE[account.type]})`
    : `${account.name} (id ${String(account.id)}, ${account.currency}, ${account.type})`;
}

function transactionText(transaction: TransactionDto, lang: PreviewLanguage): string {
  const parts = [
    `${lang === "de" ? "ID" : "id"} ${String(transaction.id)}`,
    formatMoney(transaction.amount, lang),
    transaction.valueDate === undefined ? undefined : dateText(transaction.valueDate, lang),
    transaction.counterparty,
    transaction.purpose,
  ].filter((part): part is string => part !== undefined);
  return parts.join(", ");
}

function paymentFacts(
  doc: LifecycleDocument<PaymentKind>,
  plan: PaymentPlan,
  date: string,
  account: BankAccountDto,
  transaction: TransactionDto | undefined,
  lang: PreviewLanguage,
): Fact[] {
  const t = PAYMENT_TEXT[lang];
  const facts: Fact[] = [
    { label: t.open, value: formatMoney(money(plan.open.open, doc.currency), lang) },
    {
      label: paymentDirection(doc) === "in" ? t.received : t.payout,
      value: `${formatMoney(plan.amount, lang)}, ${BOOKING_TYPE_TEXT[plan.bookingType][lang]}`,
    },
    { label: t.date, value: dateText(date, lang) },
    { label: t.account, value: accountText(account, lang) },
  ];
  if (transaction !== undefined) {
    facts.push({ label: t.transaction, value: transactionText(transaction, lang) });
  }
  facts.push({
    label: t.after,
    value:
      plan.remaining === undefined
        ? `${formatMoney(money(0, doc.currency), lang)} (${t.settled})`
        : formatMoney(plan.remaining, lang),
  });
  if (paymentSign(doc) < 0) {
    facts.push({
      label: t.sentAs,
      value: `${t.amount} ${numberText(String(plan.payload.amount), lang)} (${t.leaving})`,
    });
  }
  return facts;
}

/** Builds the book-payment tool of invoices, credit notes or vouchers. */
export function bookPaymentTool(kind: PaymentKind) {
  const info = KINDS[kind];
  const names = KIND_TOOLS[kind];
  const types = kind === "invoice" ? PAYMENT_TYPES : CREDIT_NOTE_PAYMENT_TYPES;
  return defineWriteTool({
    name: `${info.toolPrefix}_book_payment`,
    title: `Book a payment on a sevDesk ${names.title}`,
    description: DESCRIPTIONS[kind],
    toolset: names.toolset,
    tier: "commit",
    annotations: COMMIT_ANNOTATIONS,
    input: z.strictObject({
      id: idInput(kind),
      amount: amountInput({ allowZero: false }).describe(
        `Amount ${AMOUNT_VERB[kind]}, gross, positive, in the ${info.noun}'s currency, e.g. ` +
          `"119.00" (at most 2 decimals).`,
      ),
      date: isoDateInput
        .optional()
        .describe("Booking date (Zahlungsdatum), YYYY-MM-DD; defaults to today (Berlin)."),
      checkAccountId: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .describe(
          "Check account (Zahlungskonto) the money moved on, from sevdesk_bank_accounts_list.",
        ),
      transactionId: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe(
          "Imported bank transaction (Umsatz) to link, from sevdesk_transactions_list (status " +
            "created, same account). Without it sevDesk creates a new transaction (offline and " +
            "cash accounts only).",
        ),
      paymentType: z
        .enum(types)
        .optional()
        .describe(
          kind === "invoice"
            ? `${PAYMENT_TYPE_HELP} reminder_charges: more than the open amount, the extra ` +
                "booked as reminder charges (Mahngebühren)."
            : PAYMENT_TYPE_HELP,
        ),
      ...dryRunInputShape,
    }),
    output: documentOutputSchema(kind, { payment: paymentOutputSchema }),
    // The document's open amount (and a linked transaction's state) is checked, then booked.
    locks: (args) => [
      ACCOUNT_BOOKINGS,
      documentObject(kind, args.id),
      ...(args.transactionId === undefined
        ? []
        : [{ objectName: "CheckAccountTransaction", id: String(args.transactionId) }]),
    ],
    prepare: async (args, ctx) => {
      const doc = await readLifecycleDocument(ctx.client, kind, args.id, ctx.signal);
      assertBookable(doc);
      const today = berlinDateOf(Date.now());
      const date = args.date ?? today;
      const request = {
        amount: args.amount,
        paymentType: args.paymentType ?? "payment",
        date,
        checkAccountId: args.checkAccountId,
        transactionId: args.transactionId,
      } as const;
      // Planned before any further read, so an impossible payment is refused first.
      let plan = planPayment(doc, request);
      const account = await lookup(
        () => getBankAccount(ctx.client, args.checkAccountId, ctx.signal),
        `Check account ${String(args.checkAccountId)} does not exist; list the accounts with ` +
          `sevdesk_bank_accounts_list.`,
      );
      const warnings = [
        ...plan.warnings,
        ...checkPaymentAccount(doc, account, args.transactionId !== undefined),
      ];
      let transaction: TransactionDto | undefined;
      if (args.transactionId !== undefined) {
        const transactionId = args.transactionId;
        transaction = await lookup(
          () => getTransaction(ctx.client, transactionId, ctx.signal),
          `Bank transaction ${String(transactionId)} does not exist; find it with ` +
            `sevdesk_transactions_list.`,
        );
        const assigned = await assignedShare(ctx.client, transaction, ctx.signal);
        warnings.push(
          ...checkPaymentTransaction(doc, args.checkAccountId, transaction, args.amount, assigned),
        );
        // A payment that uses part of the transaction goes out as N (see transactionBookingType).
        const amount = transaction.amount.amount;
        plan = planPayment(doc, {
          ...request,
          transactionAmount: amount.startsWith("-") ? amount.slice(1) : amount,
        });
      }
      if (date > today) {
        warnings.push(
          phrase(
            `The booking date ${date} lies in the future.`,
            `Das Buchungsdatum ${dateText(date, "de")} liegt in der Zukunft.`,
          ),
        );
      }
      const incoming = paymentDirection(doc) === "in";
      const booked = plan;
      const linked = transaction;
      const state: BookPaymentState = {
        payload: plan.payload,
        plan: { amount: plan.amount, bookingType: plan.bookingType },
        date,
      };
      const action = phrase(
        `Book a ${incoming ? "payment received" : "payout"} of ${formatMoney(booked.amount)} ` +
          `on ${documentTitle(doc)} (${BOOKING_TYPE_TEXT[booked.bookingType].en}) via check ` +
          `account ${account.name}` +
          (linked === undefined ? "." : `, linked to bank transaction ${String(linked.id)}.`),
        `${incoming ? "Zahlungseingang" : "Auszahlung"} von ` +
          `${formatMoney(booked.amount, "de")} auf ${documentTitle(doc, "de")} buchen ` +
          `(${BOOKING_TYPE_TEXT[booked.bookingType].de}), über das Zahlungskonto ${account.name}` +
          (linked === undefined ? "." : `, verknüpft mit dem Kontoumsatz ${String(linked.id)}.`),
      );
      return {
        ...bothPreviews((lang) => ({
          action: action[lang],
          facts: [
            ...documentFacts(doc, lang),
            ...paymentFacts(doc, booked, date, account, linked, lang),
          ],
          warnings: warnings.map((warning) => warning[lang]),
          irreversible: false,
        })),
        state,
      };
    },
    execute: async (args, plan, ctx) => {
      await ctx.client.request({
        method: "PUT",
        path: sevdeskPath(info.objectName, args.id, "bookAmount"),
        body: plan.state.payload,
        signal: ctx.signal,
      });
      const changed: SevdeskObjectRef[] = [documentObject(kind, args.id)];
      if (args.transactionId !== undefined) {
        changed.push({ objectName: "CheckAccountTransaction", id: String(args.transactionId) });
      }
      const after = await readBack(ctx, kind, args.id, changed);
      const { state } = plan;
      return {
        data: documentOutput(kind, after.dto, {
          payment: {
            amount: state.plan.amount,
            date: state.date,
            paymentType: paymentTypeOf(state.plan.bookingType),
            checkAccountId: args.checkAccountId,
            ...(args.transactionId === undefined ? {} : { transactionId: args.transactionId }),
          },
        }),
        summary:
          `${capitalize(info.noun)} ${String(args.id)}: ${state.plan.bookingType} booking of ` +
          `${formatMoney(state.plan.amount)} done; status ${after.statusLabel} ` +
          `(${String(after.status)}).`,
        affected: changed,
      };
    },
  });
}
