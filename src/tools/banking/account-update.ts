/**
 * `sevdesk_bank_account_update`: rename a payment account or change its booking account, IBAN,
 * BIC or automatic assignment (`PUT /CheckAccount/{id}`, every field read back). Checks, previews,
 * request and read-back: `src/domain/bank-account-update.ts`.
 *
 * Tier `commit`: the name and booking account are what every list, booking and export shows for
 * the account, and a human confirms the change against the account as stored.
 */
import { z } from "zod";

import { ACCOUNTING_NUMBER_MAX, BANK_ACCOUNT_NAME_MAX } from "../../domain/bank-account-create.js";
import {
  bicInput,
  executeBankAccountUpdate,
  ibanInput,
  planBankAccountUpdate,
} from "../../domain/bank-account-update.js";
import { bankAccountDtoSchema, maskIban } from "../../domain/banking.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_BOOKINGS, ACCOUNT_CHECK_ACCOUNTS, type SevdeskObjectRef } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

/** The account id argument of the account tools. */
export const accountIdInput = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Payment account id, from sevdesk_bank_accounts_list.");

/** The account as a changed record and lock key. */
export function accountRef(id: number): SevdeskObjectRef {
  return { objectName: "CheckAccount", id: String(id) };
}

export const bankAccountUpdateTool = defineWriteTool({
  name: "sevdesk_bank_account_update",
  title: "Rename or change a sevDesk payment account",
  description:
    "Rename a payment account (Zahlungskonto umbenennen): a file-import account " +
    "(Dateiimport-Konto), clearing account (Verrechnungskonto) or cash register (Kasse). On a " +
    "file-import account also its booking account (Buchungskonto), IBAN/BIC and automatic " +
    "assignment of imported transactions. Give only what changes. Refuses bank-connected " +
    "(online banking) and archived accounts, a name or booking account another account has, and " +
    "a new booking account on an account with booked transactions. Commit tier: asks a human to " +
    "confirm the preview; dryRun only previews. Ids: sevdesk_bank_accounts_list.",
  toolset: "banking",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    // Stored values are overwritten.
    destructiveHint: true,
    // The same change again changes nothing (it is refused as unchanged).
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    id: accountIdInput,
    name: z
      .string()
      .trim()
      .min(1)
      .max(BANK_ACCOUNT_NAME_MAX)
      .optional()
      .describe("New account name; no other active payment account may have it."),
    accountingNumber: z
      .number()
      .int()
      .positive()
      .max(ACCOUNTING_NUMBER_MAX)
      .optional()
      .describe(
        "New booking account (Buchungskonto) number, unused by other payment accounts; " +
          "file-import accounts without booked transactions only. Ask the tax consultant.",
      ),
    iban: ibanInput.optional().describe("New IBAN (file-import accounts only)."),
    bic: bicInput.optional().describe("New BIC (file-import accounts only)."),
    autoMapTransactions: z
      .boolean()
      .optional()
      .describe(
        "Whether sevDesk assigns imported transactions to matching invoices and vouchers by " +
          "itself (file-import accounts only).",
      ),
    ...dryRunInputShape,
  }),
  output: z.object({
    account: bankAccountDtoSchema.describe("The account as read back after the change."),
  }),
  // "No other account has this name or number" and "nothing is booked" are checked, then the
  // account is changed: a create, a rename or a booking at the same time would pass the check.
  locks: (args) => [
    ACCOUNT_CHECK_ACCOUNTS,
    ...(args.accountingNumber === undefined ? [] : [ACCOUNT_BOOKINGS]),
    accountRef(args.id),
  ],
  // The audit log keeps the IBAN masked like the previews: last four characters only.
  auditArgs: (args) => (args.iban === undefined ? args : { ...args, iban: maskIban(args.iban) }),
  prepare: (args, ctx) =>
    planBankAccountUpdate(
      ctx.client,
      {
        id: args.id,
        name: args.name,
        accountingNumber: args.accountingNumber,
        iban: args.iban,
        bic: args.bic,
        autoMapTransactions: args.autoMapTransactions,
      },
      ctx.signal,
    ),
  execute: async (args, plan, ctx) => {
    const account = await executeBankAccountUpdate(ctx.client, plan.state, ctx.signal);
    return {
      data: { account },
      summary: `Payment account ${String(args.id)} changed; read back as sent.`,
      affected: [accountRef(args.id)],
    };
  },
});
