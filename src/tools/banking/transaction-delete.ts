/**
 * `sevdesk_transaction_delete`: delete an unbooked bank transaction of a file-import account
 * (`DELETE /CheckAccountTransaction/{id}`). sevDesk only marks the row deleted (soft delete,
 * spec/deviations.md D-096), so success is `deletedAt` on the read-back. Checks and the read-back:
 * `src/domain/reconciliation/manual-transactions.ts`.
 */
import { z } from "zod";

import { transactionDtoSchema } from "../../domain/banking.js";
import { formatMoney } from "../../domain/lifecycle/preview.js";
import { money, negate } from "../../domain/money.js";
import { bothPreviews, phrase } from "../../domain/preview-text.js";
import { transactionObject } from "../../domain/reconciliation/allocate.js";
import {
  executeTransactionDelete,
  planTransactionDelete,
} from "../../domain/reconciliation/manual-transactions.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { COMMIT_ANNOTATIONS, transactionFacts, transactionIdInput } from "./reconcile-shared.js";

export const transactionDeleteTool = defineWriteTool({
  name: "sevdesk_transaction_delete",
  title: "Delete a sevDesk bank transaction",
  description:
    "Delete a bank transaction (Kontoumsatz löschen) of a file-import account, e.g. one entered " +
    "twice: only unbooked rows (status 100) that are not enshrined. A booked row needs " +
    "sevdesk_transaction_reset first, a private one too. Entries of a cash register (Kasse) or " +
    "clearing account come from payments: undo the payment with the document's reset tool " +
    "instead. sevDesk keeps the deleted row readable by id, but it leaves the transaction lists " +
    "and the balance. Cannot be undone (enter the row again if needed). Commit tier: asks a " +
    "human to confirm the preview; dryRun only previews. Check first with sevdesk_transaction_get.",
  toolset: "banking",
  tier: "commit",
  annotations: COMMIT_ANNOTATIONS,
  input: z.strictObject({ id: transactionIdInput, ...dryRunInputShape }),
  output: z.object({
    transaction: transactionDtoSchema.describe("The row as read back: deleted is true."),
  }),
  // The status is checked (only 100 is deleted), then the row is deleted.
  locks: (args) => [
    ACCOUNT_BOOKINGS,
    { objectName: "CheckAccountTransaction", id: String(args.id) },
  ],
  prepare: async (args, ctx) => {
    const { transaction } = await planTransactionDelete(ctx.client, args.id, ctx.signal);
    const change = money(negate(transaction.amount.amount), transaction.amount.currency);
    const warnings = [
      phrase(
        "The row leaves the transaction lists and the account balance (Saldo), which changes " +
          `by ${formatMoney(change)}. sevDesk keeps it readable by id, marked as deleted.`,
        "Der Umsatz verschwindet aus den Umsatzlisten und aus dem Saldo des Kontos, der sich um " +
          `${formatMoney(change, "de")} ändert. sevDesk hält ihn über seine ID weiter lesbar, ` +
          "als gelöscht markiert.",
      ),
      phrase(
        "No tool restores a deleted row; if it was needed, enter it again with " +
          "sevdesk_transaction_create.",
        "Kein Werkzeug stellt einen gelöschten Umsatz wieder her; wird er doch gebraucht, lege " +
          "ihn mit sevdesk_transaction_create neu an.",
      ),
    ];
    return {
      ...bothPreviews((lang) => ({
        action:
          lang === "de"
            ? `Kontoumsatz ${String(transaction.id)} (${formatMoney(transaction.amount, lang)}) ` +
              "löschen."
            : `Delete bank transaction ${String(transaction.id)} ` +
              `(${formatMoney(transaction.amount)}).`,
        facts: transactionFacts(transaction, lang),
        warnings: warnings.map((warning) => warning[lang]),
        // Nothing undeletes a row (as with a deleted voucher draft); entering it again makes a new one.
        irreversible: true,
      })),
      state: {},
    };
  },
  execute: async (args, _plan, ctx) => {
    const transaction = await executeTransactionDelete(ctx.client, args.id, ctx.signal);
    const on = transaction.deletedOn === undefined ? "" : ` on ${transaction.deletedOn}`;
    return {
      data: { transaction },
      summary:
        `Bank transaction ${String(args.id)} deleted${on}: it is no longer in the lists or the ` +
        "balance (sevDesk keeps it readable by id).",
      affected: [transactionObject(args.id)],
    };
  },
});
