/**
 * What the reconciliation tools share: the document kinds as tools name them, the transaction
 * id argument, compact document and assignment schemas, the preview facts of a transaction, and
 * the read-back after a write.
 */
import { z } from "zod";

import { getTransaction, type TransactionDto } from "../../domain/banking.js";
import { moneySchema, statusDtoSchema } from "../../domain/common.js";
import { type LifecycleDocument, type PaymentKind } from "../../domain/lifecycle/documents.js";
import { type Fact, formatMoney } from "../../domain/lifecycle/preview.js";
import { DEFAULT_CURRENCY, money } from "../../domain/money.js";
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

/** The transaction as preview facts (purpose and counterparty: cleaned upstream text). */
export function transactionFacts(transaction: TransactionDto): Fact[] {
  const facts: Fact[] = [
    {
      label: "Bank transaction (Umsatz)",
      value: `id ${String(transaction.id)}, ${formatMoney(transaction.amount)} (${
        transaction.direction === "in"
          ? "incoming"
          : transaction.direction === "out"
            ? "outgoing"
            : "zero"
      })`,
    },
  ];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) facts.push({ label, value });
  };
  add("Value date", transaction.valueDate);
  add(
    "Check account",
    transaction.account === undefined
      ? undefined
      : transaction.account.name === undefined
        ? `id ${String(transaction.account.id)}`
        : `${transaction.account.name} (id ${String(transaction.account.id)})`,
  );
  add(
    "Status",
    transaction.status === undefined
      ? undefined
      : `${transaction.status.label} (${String(transaction.status.code)})`,
  );
  add("Counterparty", transaction.counterparty);
  add("Purpose (Verwendungszweck)", transaction.purpose);
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
