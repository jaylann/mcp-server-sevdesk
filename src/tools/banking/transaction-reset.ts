/**
 * `sevdesk_transaction_reset`: undo a bank transaction's bookings. Private → unbooked
 * (`PUT /CheckAccountTransaction/{id}` `{status: 100}`); linked or booked → every document it paid
 * is reset to open (`PUT /{Invoice|CreditNote|Voucher}/{id}/resetToOpen`), which removes ALL
 * payments of those documents (D-060). Plan, collateral and refusals:
 * `src/domain/reconciliation/transaction-status.ts`.
 */
import { z } from "zod";

import { getTransaction, transactionDtoSchema } from "../../domain/banking.js";
import { KINDS, readLifecycleDocument } from "../../domain/lifecycle/documents.js";
import {
  documentTitle,
  type Fact,
  formatMoney,
  statusText,
} from "../../domain/lifecycle/preview.js";
import { money } from "../../domain/money.js";
import { bothPreviews, type PreviewLanguage } from "../../domain/preview-text.js";
import { transactionObject } from "../../domain/reconciliation/allocate.js";
import {
  planTransactionReset,
  type ResetPlan,
  statusPayload,
} from "../../domain/reconciliation/transaction-status.js";
import {
  type DocumentToReset,
  executeTransactionReset,
  updateTransactionStatus,
} from "../../domain/reconciliation/transaction-writes.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import {
  COMMIT_ANNOTATIONS,
  documentFactParts,
  documentSummary,
  documentSummarySchema,
  readBackOrReport,
  transactionFacts,
  transactionIdInput,
} from "./reconcile-shared.js";

const output = z.object({
  transaction: transactionDtoSchema
    .optional()
    .describe("The transaction as read back; absent when sevDesk deleted it (see below)."),
  transactionDeleted: z
    .boolean()
    .optional()
    .describe(
      "True when the transaction no longer exists after the reset: sevDesk deletes transactions " +
        "it created itself for a payment booked without one.",
    ),
  documents: z.array(documentSummarySchema).describe("The documents reset to open, read back."),
});

type State =
  | { readonly mode: "private" }
  | { readonly mode: "linked"; readonly documents: readonly DocumentToReset[] };

export const transactionResetTool = defineWriteTool({
  name: "sevdesk_transaction_reset",
  title: "Undo the bookings of a sevDesk bank transaction",
  description:
    "Undo a bank transaction's bookings (Zuordnung aufheben). A private transaction " +
    "(Privatentnahme/-einlage) becomes unbooked again. A linked or booked one: every document " +
    "it paid (Rechnung, Gutschrift, Beleg) is reset to open, because sevDesk cannot unlink a " +
    "single transaction; that removes ALL payments of those documents, also other " +
    "transactions' and cash bookings, which the preview lists. Refuses enshrined " +
    "(festgeschrieben) transactions and documents. Check first with sevdesk_transaction_get. " +
    "Commit tier: asks a human to confirm the preview; dryRun only previews. Afterwards book " +
    "again with sevdesk_transaction_book.",
  toolset: "banking",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({ id: transactionIdInput, ...dryRunInputShape }),
  output,
  // Serialized with other calls on the same record (see WriteToolDefinition.locks).
  locks: (args) => [
    ACCOUNT_BOOKINGS,
    { objectName: "CheckAccountTransaction", id: String(args.id) },
  ],
  prepare: async (args, ctx) => {
    const plan = await planTransactionReset(ctx.client, args.id, ctx.signal, ctx.config);
    const state: State =
      plan.mode === "private"
        ? { mode: "private" }
        : {
            mode: "linked",
            documents: plan.documents.map(({ doc, otherTransactions }) => ({
              kind: doc.kind,
              id: doc.id,
              otherTransactionIds: otherTransactions.map(({ id }) => id),
            })),
          };
    return {
      ...bothPreviews((lang) => ({
        action: actionText(plan, lang),
        facts: resetFacts(plan, lang),
        warnings: plan.warnings.map((warning) => warning[lang]),
        irreversible: false,
      })),
      state,
    };
  },
  execute: async (args, plan, ctx) => {
    const { state } = plan;
    const transactionRef = transactionObject(args.id);
    if (state.mode === "private") {
      await updateTransactionStatus(ctx.client, args.id, statusPayload("created"), ctx.signal);
      const transaction = await readBackOrReport(
        () => getTransaction(ctx.client, args.id, ctx.signal),
        [transactionRef],
      );
      return {
        data: { transaction, documents: [] },
        summary: `Bank transaction ${String(args.id)} is no longer private.`,
        affected: [transactionRef],
      };
    }

    // The documents reset, this transaction, and the other transactions the resets unlinked.
    const changed = await executeTransactionReset(ctx.client, args.id, state.documents, ctx.signal);
    const transaction = await readBackOrReport(async () => {
      try {
        return await getTransaction(ctx.client, args.id, ctx.signal);
      } catch (error) {
        if (error instanceof SevdeskError && error.kind === "not_found") return undefined;
        throw error;
      }
    }, changed);
    const documents = [];
    for (const { kind, id } of state.documents) {
      const doc = await readBackOrReport(
        () => readLifecycleDocument(ctx.client, kind, id, ctx.signal, undefined, ctx.config),
        changed,
      );
      documents.push(documentSummary(doc));
    }
    return {
      data: {
        ...(transaction === undefined ? { transactionDeleted: true } : { transaction }),
        documents,
      },
      summary:
        `Reset ${String(documents.length)} ${documents.length === 1 ? "document" : "documents"} ` +
        `to open; bank transaction ${String(args.id)} ` +
        (transaction === undefined
          ? "was deleted by sevDesk (it had created it for a booking)."
          : `has status ${transaction.status?.label ?? "unknown"} (${String(transaction.status?.code ?? "?")}).`),
      affected: changed,
    };
  },
});

function actionText(plan: ResetPlan, lang: PreviewLanguage): string {
  const id = String(plan.transaction.id);
  const german = lang === "de";
  if (plan.mode === "private") {
    return german
      ? `Kontoumsatz ${id} von privat auf ungebucht zurücksetzen (Status 300 → 100).`
      : `Set bank transaction ${id} back from private to unbooked (status 300 → 100).`;
  }
  const titles = plan.documents.map(({ doc }) => documentTitle(doc, lang));
  const count = String(titles.length);
  return german
    ? `Buchungen des Kontoumsatzes ${id} rückgängig machen: ${count} ` +
        `${titles.length === 1 ? "Dokument" : "Dokumente"} auf offen zurücksetzen ` +
        `(${titles.join(", ")}) und dabei alle ihre Zahlungen entfernen.`
    : `Undo the bookings of bank transaction ${id}: reset ${count} ` +
        `${titles.length === 1 ? "document" : "documents"} to open (${titles.join(", ")}), ` +
        "removing all their payments.";
}

/** The fact labels and fixed wording of a reset, per language. */
const RESET_TEXT = {
  en: {
    document: "Document",
    status: "status",
    open: "open",
    paid: (share: string) => `this transaction paid ${share}`,
    others: "other payments removed too",
    seeLog: "see the booking log",
    unlinks: (list: string) => `; also unlinks bank transactions ${list}`,
    after: "This transaction after the reset",
    afterValue: "unbooked (status 100), or deleted if sevDesk created it for a booking",
    changed: "Other bank transactions changed",
    partly: "partly linked 200",
    unbooked: "unbooked 100",
  },
  de: {
    document: "Dokument",
    status: "Status",
    open: "offen",
    paid: (share: string) => `dieser Umsatz hat ${share} bezahlt`,
    others: "weitere entfernte Zahlungen",
    seeLog: "siehe Buchungsprotokoll",
    unlinks: (list: string) => `; löst auch die Kontoumsätze ${list}`,
    after: "Dieser Umsatz nach dem Zurücksetzen",
    afterValue:
      "ungebucht (Status 100) oder gelöscht, falls sevDesk ihn für eine Buchung angelegt hat",
    changed: "Weitere geänderte Kontoumsätze",
    partly: "teilweise verknüpft 200",
    unbooked: "ungebucht 100",
  },
} as const;

function resetFacts(plan: ResetPlan, lang: PreviewLanguage): Fact[] {
  const facts = transactionFacts(plan.transaction, lang);
  if (plan.mode === "private") return facts;
  const t = RESET_TEXT[lang];
  const currency = plan.transaction.amount.currency;
  plan.documents.forEach(({ doc, share, otherPayments, otherTransactions }, index) => {
    const open = KINDS[doc.kind].status.open;
    const unlinks = otherTransactions
      .map(({ id, amount }) =>
        amount === undefined
          ? String(id)
          : `${String(id)} (${formatMoney(money(amount, doc.currency), lang)})`,
      )
      .join(", ");
    // The label is trusted text: the document by id; its stored number opens the value.
    const named = documentFactParts(doc, lang);
    facts.push({
      label: `${t.document} ${String(index + 1)}: ${named.label}`,
      value:
        named.number +
        `${t.status} ${statusText(doc, lang)} → ${t.open} (${String(open)}); ` +
        `${t.paid(formatMoney(money(share, currency), lang))}; ${t.others}: ` +
        (otherPayments === undefined
          ? t.seeLog
          : formatMoney(money(otherPayments, doc.currency), lang)) +
        (unlinks === "" ? "" : t.unlinks(unlinks)),
    });
  });
  facts.push({ label: t.after, value: t.afterValue });
  const others = new Map<number, 100 | 200>();
  for (const { otherTransactions } of plan.documents) {
    for (const { id, statusAfter } of otherTransactions) others.set(id, statusAfter);
  }
  if (others.size > 0) {
    facts.push({
      label: t.changed,
      value: [...others.entries()]
        .sort(([a], [b]) => a - b)
        .map(([id, after]) => `${String(id)} (→ ${after === 200 ? t.partly : t.unbooked})`)
        .join(", "),
    });
  }
  return facts;
}
