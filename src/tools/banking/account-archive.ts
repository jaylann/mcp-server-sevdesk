/**
 * `sevdesk_bank_account_archive`: archive a payment account (`DELETE /CheckAccount/{id}`, which
 * archives, D-097). Checks, previews, request and read-back: `src/domain/bank-account-archive.ts`.
 *
 * Tier `commit`: archiving deletes the account's open transactions and cannot be undone through
 * the API (D-143); a human confirms it against the account as stored and its open transactions.
 */
import { z } from "zod";

import {
  executeBankAccountArchive,
  planBankAccountArchive,
} from "../../domain/bank-account-archive.js";
import { bankAccountDtoSchema } from "../../domain/banking.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS, ACCOUNT_CHECK_ACCOUNTS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";
import { accountIdInput, accountRef } from "./account-update.js";

export const bankAccountArchiveTool = defineWriteTool({
  name: "sevdesk_bank_account_archive",
  title: "Archive a sevDesk payment account",
  description:
    "Archive a payment account (Zahlungskonto archivieren; sevDesk's API calls it delete): a " +
    "file-import account (Dateiimport-Konto) or clearing account (Verrechnungskonto) without " +
    "booked transactions. It leaves the account lists but stays readable by id; its open " +
    "transactions are deleted with it and its IBAN is cleared. Cannot be undone through the " +
    "API. Refuses cash registers (Kasse), bank-connected (online banking) accounts and the " +
    "default account (Standardkonto). Commit tier: asks a human to confirm the preview; dryRun " +
    "only previews. Ids: sevdesk_bank_accounts_list.",
  toolset: "banking",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    // Archiving again changes nothing (an archived account is refused).
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({ id: accountIdInput, ...dryRunInputShape }),
  output: z.object({
    account: bankAccountDtoSchema.describe("The account as read back: status archived."),
    openTransactionsDeleted: z
      .number()
      .int()
      .describe("Open transactions sevDesk deleted with the account (counted before)."),
  }),
  // "Nothing is booked" is checked, then the account is archived: a booking or a new row at the
  // same time would pass the check (sevDesk's own refusal stays the backstop for bookings).
  locks: (args) => [ACCOUNT_CHECK_ACCOUNTS, ACCOUNT_BOOKINGS, accountRef(args.id)],
  prepare: (args, ctx) => planBankAccountArchive(ctx.client, args.id, ctx.signal),
  execute: async (args, plan, ctx) => {
    const account = await executeBankAccountArchive(ctx.client, plan.state, ctx.signal);
    const open = plan.state.openTransactions;
    const deleted =
      open === 0
        ? ""
        : ` ${String(open)} open ${open === 1 ? "transaction was" : "transactions were"} deleted ` +
          "with it.";
    return {
      data: { account, openTransactionsDeleted: open },
      summary:
        `Payment account ${String(args.id)} archived: it leaves the account lists and stays ` +
        `readable by id.${deleted}`,
      affected: [accountRef(args.id)],
    };
  },
});
