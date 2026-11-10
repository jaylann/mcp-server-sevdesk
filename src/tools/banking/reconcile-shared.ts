/**
 * What the reconciliation tools share: the document kinds as tools name them, the transaction
 * id argument, compact document and assignment schemas, the preview facts of a transaction, and
 * the read-back after a write.
 */
import { z } from "zod";

import { getTransaction, type TransactionDto } from "../../domain/banking.js";
import { moneySchema, statusDtoSchema } from "../../domain/common.js";
import { type LifecycleDocument, type PaymentKind } from "../../domain/lifecycle/documents.js";
import { type Fact, formatMoney, transactionStatusText } from "../../domain/lifecycle/preview.js";
import { DEFAULT_CURRENCY, money } from "../../domain/money.js";
import { dateText, type PreviewLanguage } from "../../domain/preview-text.js";
import { SevdeskError, withCompletedWrites } from "../../sevdesk/errors.js";
import type { SevdeskObjectRef, ToolAnnotationSet, ToolContext } from "../types.js";

/** Document kinds in tool arguments and output (snake case, like the toolset names). */
export const DOCUMENT_KINDS = ["invoice", "credit_note", "voucher"] as const;
export type DocumentKindArg = (typeof DOCUMENT_KINDS)[number];

const KIND_BY_ARG: Readonly<Record<DocumentKindArg, PaymentKind>> = {
  invoice: "invoice",
  credit_note: "creditNote",
  voucher: "voucher",
};

const ARG_BY_KIND: Readonly<Record<PaymentKind, DocumentKindArg>> = {
  invoice: "invoice",
  creditNote: "credit_note",
  voucher: "voucher",
};

export function kindOfArg(kind: DocumentKindArg): PaymentKind {
  return KIND_BY_ARG[kind];
}

export function argOfKind(kind: PaymentKind): DocumentKindArg {
  return ARG_BY_KIND[kind];
}

/** Commit actions: change bookkeeping state that only a further action reverts, never idempotent. */
export const COMMIT_ANNOTATIONS: ToolAnnotationSet = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const READ_ANNOTATIONS: ToolAnnotationSet = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** The bank transaction id argument. */
export const transactionIdInput = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Bank transaction (Umsatz) id, from sevdesk_transactions_list.");

/** A document as the reconciliation tools show it. */
export const documentSummarySchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  id: z.number().int(),
  number: z
    .string()
    .optional()
    .describe("Rechnungs-/Gutschriftsnummer, or a voucher's Belegnummer."),
  status: statusDtoSchema.optional(),
  contact: z
    .object({ id: z.number().int().optional(), name: z.string().optional() })
    .optional()
    .describe("Customer, or a voucher's supplier."),
  gross: moneySchema.optional(),
  paid: moneySchema
    .optional()
    .describe("Paid so far, as sevDesk reports it (EUR documents only; credit notes report none)."),
});

export type DocumentSummary = z.output<typeof documentSummarySchema>;

/** The compact summary of a lifecycle snapshot (upstream text already cleaned by the mappers). */
export function documentSummary(doc: LifecycleDocument<PaymentKind>): DocumentSummary {
  const contact =
    doc.contact !== undefined
      ? {
          id: doc.contact.id,
          ...(doc.contact.name === undefined ? {} : { name: doc.contact.name }),
        }
      : doc.partyName === undefined
        ? undefined
        : { name: doc.partyName };
  return {
    kind: argOfKind(doc.kind),
    id: doc.id,
    ...(doc.number === undefined ? {} : { number: doc.number }),
    status: { code: doc.status, label: doc.statusLabel },
    ...(contact === undefined ? {} : { contact }),
    ...(doc.totals.gross === undefined ? {} : { gross: doc.totals.gross }),
    ...(doc.paidAmount === undefined || doc.currency !== DEFAULT_CURRENCY
      ? {}
      : { paid: money(doc.paidAmount, doc.currency) }),
  };
}

/** The fact labels and fixed values of a transaction, per language. */
const TRANSACTION_TEXT = {
  en: {
    transaction: "Bank transaction (Umsatz)",
    id: "id",
    in: "incoming",
    out: "outgoing",
    zero: "zero",
    valueDate: "Value date",
    account: "Check account",
    status: "Status",
    counterparty: "Counterparty",
    purpose: "Purpose (Verwendungszweck)",
  },
  de: {
    transaction: "Kontoumsatz",
    id: "ID",
    in: "Eingang",
    out: "Ausgang",
    zero: "Nullbetrag",
    valueDate: "Wertstellung",
    account: "Zahlungskonto",
    status: "Status",
    counterparty: "Auftraggeber/Empfänger",
    purpose: "Verwendungszweck",
  },
} as const;

/**
 * The transaction as preview facts (purpose and counterparty: cleaned upstream text), in the
 * preview language. Both languages give the same facts in the same order.
 */
export function transactionFacts(
  transaction: TransactionDto,
  lang: PreviewLanguage = "en",
): Fact[] {
  const t = TRANSACTION_TEXT[lang];
  const direction =
    transaction.direction === "in" ? t.in : transaction.direction === "out" ? t.out : t.zero;
  const facts: Fact[] = [
    {
      label: t.transaction,
      value:
        `${t.id} ${String(transaction.id)}, ${formatMoney(transaction.amount, lang)} ` +
        `(${direction})`,
    },
  ];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) facts.push({ label, value });
  };
  add(
    t.valueDate,
    transaction.valueDate === undefined ? undefined : dateText(transaction.valueDate, lang),
  );
  add(
    t.account,
    transaction.account === undefined
      ? undefined
      : transaction.account.name === undefined
        ? `${t.id} ${String(transaction.account.id)}`
        : `${transaction.account.name} (${t.id} ${String(transaction.account.id)})`,
  );
  add(
    t.status,
    transaction.status === undefined ? undefined : transactionStatusText(transaction.status, lang),
  );
  add(t.counterparty, transaction.counterparty);
  add(t.purpose, transaction.purpose);
  return facts;
}

/**
 * Reads something back after a write; a failure is rethrown with `completed` attached, so the
 * user learns what changed and does not repeat the call.
 */
export async function readBackOrReport<T>(
  read: () => Promise<T>,
  completed: readonly SevdeskObjectRef[],
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SevdeskError) throw withCompletedWrites(error, completed);
    throw error;
  }
}

/** Reads the transaction back after a write (see {@link readBackOrReport}). */
export function readBackTransaction(
  ctx: ToolContext,
  id: number,
  completed: readonly SevdeskObjectRef[],
): Promise<TransactionDto> {
  return readBackOrReport(() => getTransaction(ctx.client, id, ctx.signal), completed);
}
