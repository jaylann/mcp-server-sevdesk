/**
 * `sevdesk_transaction_enshrine`: lock a booked bank transaction for good (festschreiben, GoBD)
 * with `PUT /CheckAccountTransaction/{id}/enshrine`. Irreversible: afterwards sevDesk refuses
 * every change to the row and the reset to open of the document it pays (spec/deviations.md
 * D-098). Checks and the read-back: `src/domain/reconciliation/manual-transactions.ts`.
 */
import { z } from "zod";

import { transactionDtoSchema } from "../../domain/banking.js";
import {
  bothPreviews,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../../domain/preview-text.js";
import { transactionObject } from "../../domain/reconciliation/allocate.js";
import {
  executeTransactionEnshrine,
  paidDocumentText,
  planTransactionEnshrine,
  type TransactionEnshrinePlan,
} from "../../domain/reconciliation/manual-transactions.js";
import { TRANSACTION_STATUS } from "../../domain/reconciliation/transaction-log.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { COMMIT_ANNOTATIONS, transactionFacts, transactionIdInput } from "./reconcile-shared.js";

/** What locking means for the row and for the documents it pays. */
const ENSHRINE_WARNINGS: readonly Phrase[] = [
  phrase(
    "Irreversible (GoBD): sevDesk never changes this bank transaction again: no status change, " +
      "no deletion, and its bookings can no longer be undone (sevdesk_transaction_reset).",
    "Nicht umkehrbar (GoBD): sevDesk ändert diesen Kontoumsatz danach nie wieder: kein " +
      "Statuswechsel, kein Löschen, und seine Buchungen lassen sich nicht mehr rückgängig " +
      "machen (sevdesk_transaction_reset).",
  ),
  phrase(
    "The documents it pays can no longer be reset to open: their payment from this " +
      "transaction stays for good, so a correction needs a new document (for an invoice a " +
      "cancellation or a credit note).",
    "Die Dokumente, die er bezahlt, lassen sich nicht mehr auf offen zurücksetzen: Die " +
      "Zahlung aus diesem Umsatz bleibt dauerhaft bestehen; eine Korrektur braucht dann ein " +
      "neues Dokument (bei einer Rechnung ein Storno oder eine Gutschrift).",
  ),
  phrase(
    "The documents themselves are not enshrined by this; their own enshrine tools do that " +
      "(sevdesk_invoice_enshrine, sevdesk_voucher_enshrine, sevdesk_credit_note_enshrine).",
    "Die Dokumente selbst werden dadurch nicht festgeschrieben; das tun ihre eigenen " +
      "Werkzeuge (sevdesk_invoice_enshrine, sevdesk_voucher_enshrine, " +
      "sevdesk_credit_note_enshrine).",
  ),
];

/** Locking a partly linked row: what sevDesk then does with its rest was not recorded. */
const PARTLY_LINKED_WARNING = phrase(
  "Part of this transaction is still unassigned (status 200). Whether sevDesk still books the " +
    "rest after locking is not known; book it fully first if it should be.",
  "Ein Teil dieses Umsatzes ist noch nicht zugeordnet (Status 200). Ob sevDesk den Rest nach " +
    "dem Festschreiben noch bucht, ist nicht bekannt; buche ihn vorher vollständig, wenn das " +
    "nötig ist.",
);

export const transactionEnshrineTool = defineWriteTool({
  name: "sevdesk_transaction_enshrine",
  title: "Enshrine a sevDesk bank transaction",
  description:
    "Enshrine a bank transaction (Kontoumsatz festschreiben, GoBD): lock a linked or booked row " +
    "(status 200 or higher) for good. Irreversible: sevDesk then refuses every change to it (no " +
    "status change, no deletion, no sevdesk_transaction_reset), and the documents it pays can " +
    "no longer be reset to open. The documents themselves are not enshrined by it. Commit tier: " +
    "asks a human to confirm the preview, with an irreversibility warning; dryRun only " +
    "previews. Before: sevdesk_transaction_get (check its bookings).",
  toolset: "banking",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({ id: transactionIdInput, ...dryRunInputShape }),
  output: z.object({
    transaction: transactionDtoSchema.describe("The row as read back: enshrined is true."),
  }),
  // Serialized with every booking and its undo: a transaction reset checks that the row is not
  // enshrined and then resets the documents it pays.
  locks: (args) => [
    ACCOUNT_BOOKINGS,
    { objectName: "CheckAccountTransaction", id: String(args.id) },
  ],
  prepare: async (args, ctx) => {
    const plan = await planTransactionEnshrine(ctx.client, args.id, ctx.signal);
    const warnings = [...ENSHRINE_WARNINGS];
    if (plan.transaction.status?.code === TRANSACTION_STATUS.linked) {
      warnings.push(PARTLY_LINKED_WARNING);
    }
    const id = String(plan.transaction.id);
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `Kontoumsatz ${id} festschreiben (GoBD): dauerhaft sperren.`
            : `Enshrine bank transaction ${id} (festschreiben, GoBD): lock it permanently.`,
        facts: [
          ...transactionFacts(plan.transaction, lang),
          {
            label: lang === "de" ? "Gebucht auf" : "Booked to",
            value: documentsText(plan, lang),
          },
        ],
        warnings: warnings.map((warning) => warning[lang]),
        irreversible: true,
      })),
      state: {},
    };
  },
  execute: async (args, _plan, ctx) => {
    const transaction = await executeTransactionEnshrine(ctx.client, args.id, ctx.signal);
    return {
      data: { transaction },
      summary: `Bank transaction ${String(args.id)} enshrined (festgeschrieben).`,
      affected: [transactionObject(args.id)],
    };
  },
});

/** The documents the row pays, from its booking log, as a fact value. */
function documentsText(plan: TransactionEnshrinePlan, lang: PreviewLanguage): string {
  const german = lang === "de";
  const listed = plan.documents.map((document) => paidDocumentText(document, lang)).join(", ");
  const none =
    plan.transaction.status?.code === TRANSACTION_STATUS.private
      ? german
        ? "kein Dokument (privat)"
        : "no document (private)"
      : german
        ? "kein Dokument laut Buchungsprotokoll"
        : "no document in its booking log";
  const text = listed === "" ? none : listed;
  if (plan.logComplete) return text;
  return german
    ? `${text}; das Buchungsprotokoll war nicht vollständig lesbar`
    : `${text}; its booking log could not be read completely`;
}
