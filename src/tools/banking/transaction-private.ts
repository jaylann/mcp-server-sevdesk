/**
 * `sevdesk_transaction_mark_private`: mark an unbooked bank transaction as private
 * (Privatentnahme for money out, Privateinlage for money in) with
 * `PUT /CheckAccountTransaction/{id}` `{status: 300}` (payload and its open assumption:
 * `src/domain/reconciliation/transaction-status.ts`).
 */
import { z } from "zod";

import { getTransaction, transactionDtoSchema } from "../../domain/banking.js";
import { bothPreviews, type Phrase, phrase } from "../../domain/preview-text.js";
import { lookup, transactionObject } from "../../domain/reconciliation/allocate.js";
import {
  assertMarkablePrivate,
  statusPayload,
  type TransactionStatusPayload,
} from "../../domain/reconciliation/transaction-status.js";
import { sevdeskPath } from "../../sevdesk/paths.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import {
  COMMIT_ANNOTATIONS,
  readBackTransaction,
  transactionFacts,
  transactionIdInput,
} from "./reconcile-shared.js";

const MEANING = {
  Privatentnahme: phrase(
    "Privatentnahme (private withdrawal): the owner took this money out of the business for " +
      "private purposes; it is no business expense.",
    "Privatentnahme: Der Inhaber hat dieses Geld für private Zwecke aus dem Unternehmen " +
      "entnommen; es ist keine Betriebsausgabe.",
  ),
  Privateinlage: phrase(
    "Privateinlage (private deposit): the owner put this money into the business from private " +
      "funds; it is no business income.",
    "Privateinlage: Der Inhaber hat dieses Geld aus privaten Mitteln in das Unternehmen " +
      "eingelegt; es ist keine Betriebseinnahme.",
  ),
} as const;

const PRIVATE_WARNINGS: readonly Phrase[] = [
  phrase(
    "The transaction is no longer open for matching to invoices or vouchers and leaves the " +
      "business income/expense figures. Undo with sevdesk_transaction_reset.",
    "Der Umsatz steht dann nicht mehr für die Zuordnung zu Rechnungen oder Belegen zur " +
      "Verfügung und zählt nicht mehr zu den betrieblichen Einnahmen und Ausgaben. Rückgängig " +
      "machen lässt sich das mit sevdesk_transaction_reset.",
  ),
  phrase(
    "Corporations (GmbH, UG, AG) have no private withdrawals or deposits; for them this is " +
      "wrong bookkeeping.",
    "Kapitalgesellschaften (GmbH, UG, AG) kennen keine Privatentnahmen oder Privateinlagen; " +
      "dort wäre das eine falsche Buchung.",
  ),
];

export const transactionMarkPrivateTool = defineWriteTool({
  name: "sevdesk_transaction_mark_private",
  title: "Mark a sevDesk bank transaction as private",
  description:
    "Mark an unbooked bank transaction (Kontoumsatz, status created) as private: outgoing " +
    "money becomes a Privatentnahme (owner's withdrawal), incoming a Privateinlage (owner's " +
    "deposit); it then counts as neither business expense nor income and is not matched to " +
    "documents. Only for sole proprietors and partnerships (Einzelunternehmen, GbR); a GmbH or " +
    "UG has no private withdrawals (book a shareholder loan or distribution instead). Commit " +
    "tier: asks a human to confirm the preview; dryRun only previews. Undo: " +
    "sevdesk_transaction_reset. Find transactions with sevdesk_transactions_list.",
  toolset: "banking",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({ id: transactionIdInput, ...dryRunInputShape }),
  output: z.object({ transaction: transactionDtoSchema }),
  // Serialized with other calls on the same record (see WriteToolDefinition.locks).
  locks: (args) => [
    ACCOUNT_BOOKINGS,
    { objectName: "CheckAccountTransaction", id: String(args.id) },
  ],
  prepare: async (args, ctx) => {
    const transaction = await lookup(
      () => getTransaction(ctx.client, args.id, ctx.signal),
      `Bank transaction ${String(args.id)} does not exist; find it with ` +
        "sevdesk_transactions_list.",
    );
    const term = assertMarkablePrivate(transaction);
    const state: { readonly payload: TransactionStatusPayload } = {
      payload: statusPayload("private"),
    };
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `Kontoumsatz ${String(transaction.id)} als privat markieren (${term}, Status ` +
              "100 → 300)."
            : `Mark bank transaction ${String(transaction.id)} as private (${term}, status ` +
              "100 → 300).",
        facts: [
          ...transactionFacts(transaction, lang),
          { label: lang === "de" ? "Wird zu" : "Becomes", value: MEANING[term][lang] },
        ],
        warnings: PRIVATE_WARNINGS.map((warning) => warning[lang]),
        irreversible: false,
      })),
      state,
    };
  },
  execute: async (args, plan, ctx) => {
    await ctx.client.request({
      method: "PUT",
      path: sevdeskPath("CheckAccountTransaction", args.id),
      body: plan.state.payload,
      signal: ctx.signal,
    });
    const changed = [transactionObject(args.id)];
    const transaction = await readBackTransaction(ctx, args.id, changed);
    return {
      data: { transaction },
      summary:
        `Bank transaction ${String(args.id)} marked private; status ` +
        `${transaction.status?.label ?? "unknown"} (${String(transaction.status?.code ?? "?")}).`,
      affected: changed,
    };
  },
});
