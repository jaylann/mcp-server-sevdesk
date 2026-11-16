/**
 * `sevdesk_bank_account_create`: a new file-import or clearing account through sevDesk's account
 * factories (checks, payloads and the open questions: `src/domain/bank-account-create.ts`).
 */
import { z } from "zod";

import {
  ACCOUNTING_NUMBER_MAX,
  BANK_ACCOUNT_KINDS,
  BANK_ACCOUNT_NAME_MAX,
  executeBankAccountCreate,
  planBankAccountCreate,
} from "../../domain/bank-account-create.js";
import { bankAccountDtoSchema } from "../../domain/banking.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_CHECK_ACCOUNTS } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

export const bankAccountCreateTool = defineWriteTool({
  name: "sevdesk_bank_account_create",
  title: "Create a sevDesk payment account",
  description:
    "Create a payment account (Zahlungskonto anlegen). kind file_import: a file-import account " +
    "(Dateiimport-Konto), a bank account fed by CSV files instead of a bank connection; of the " +
    "accounts sevDesk lets the API create, the only one that accepts transactions entered by " +
    "hand. kind clearing: a clearing account (Verrechnungskonto) with no bank behind it, whose " +
    "transactions sevDesk creates when payments are booked on it. A cash register (Kasse) " +
    "cannot be created through the API: set it up in the sevDesk web app. Tier write. An " +
    "account cannot be deleted through the API, only archived, so an active account with the " +
    "same name is refused. Without accountingNumber sevDesk chooses the booking account " +
    "(Buchungskonto). dryRun previews. Before: sevdesk_bank_accounts_list (fileImport marks " +
    "file-import accounts).",
  toolset: "banking",
  tier: "write",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    kind: z
      .enum(BANK_ACCOUNT_KINDS)
      .describe(
        "file_import: bank account fed by CSV files (for transactions entered by hand); " +
          "clearing: Verrechnungskonto.",
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(BANK_ACCOUNT_NAME_MAX)
      .describe("Account name; no active payment account may have it."),
    accountingNumber: z
      .number()
      .int()
      .positive()
      .max(ACCOUNTING_NUMBER_MAX)
      .optional()
      .describe(
        "Booking account (Buchungskonto) number, unused by other payment accounts; default: " +
          "sevDesk chooses. Ask the tax consultant.",
      ),
    ...dryRunInputShape,
  }),
  output: z.object({ account: bankAccountDtoSchema }),
  // "No account has this name or booking account" is checked, then the account is created: two
  // calls at once would both pass, and the second account could not be deleted again.
  locks: () => [ACCOUNT_CHECK_ACCOUNTS],
  prepare: (args, ctx) => planBankAccountCreate(ctx.client, args, ctx.signal),
  execute: async (_args, plan, ctx) => {
    const { account, notes } = await executeBankAccountCreate(ctx.client, plan.state, ctx.signal);
    const booking =
      account.accountingNumber !== undefined && /^\d{1,10}$/.test(account.accountingNumber)
        ? ` (booking account ${account.accountingNumber})`
        : "";
    const created = account.fileImport
      ? "file-import account"
      : account.type === "clearing"
        ? "clearing account"
        : "payment account";
    const summary = `Created ${created} ${String(account.id)}${booking}.`;
    return {
      data: { account },
      summary: notes.length === 0 ? summary : `${summary} Note: ${notes.join(" ")}`,
      affected: [{ objectName: "CheckAccount", id: String(account.id) }],
    };
  },
});
