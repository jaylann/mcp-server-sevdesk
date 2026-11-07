import { z } from "zod";

import {
  bankAccountDtoSchema,
  listBankAccounts,
  MAX_BALANCE_ACCOUNTS,
} from "../../domain/banking.js";
import { berlinDateOf, isIsoDate } from "../../sevdesk/dates.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  items: z.array(bankAccountDtoSchema),
  balanceDate: z.string().describe("Day the balances refer to, YYYY-MM-DD (Berlin)."),
  archivedHidden: z
    .number()
    .int()
    .describe("Archived accounts left out; pass includeArchived=true to see them."),
});

/** `sevdesk_bank_accounts_list`: payment accounts with their balance. */
export const bankAccountsListTool = defineTool({
  name: "sevdesk_bank_accounts_list",
  title: "List sevDesk bank accounts",
  description:
    "List the payment accounts (Zahlungskonten): bank accounts (Bankkonten), clearing accounts " +
    "(Verrechnungskonten) and cash registers (Kasse), each with its balance (Saldo) at a day, " +
    "today in Berlin by default. The balance is sevDesk's sum of the transactions it knows, " +
    "not necessarily the bank's figure. IBANs show only their last four characters. " +
    `Balances are fetched for at most ${MAX_BALANCE_ACCOUNTS} accounts per call. Use an ` +
    "account id with sevdesk_transactions_list to see its transactions (Umsätze).",
  toolset: "banking",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    balanceDate: z
      .string()
      .refine(isIsoDate, { message: "expected a calendar date as YYYY-MM-DD" })
      .optional()
      .describe("Balance at the end of this day, YYYY-MM-DD; default today (Berlin)."),
    includeArchived: z
      .boolean()
      .default(false)
      .describe("Also list archived (archiviert) accounts."),
  }),
  output,
  handler: async (args, ctx) => {
    const balanceDate = args.balanceDate ?? berlinDateOf(Date.now());
    const result = await listBankAccounts(
      ctx.client,
      { balanceDate, includeArchived: args.includeArchived },
      ctx.signal,
    );
    const count = result.items.length;
    const notes = [
      result.archivedHidden > 0
        ? `${result.archivedHidden} archived hidden (includeArchived=true shows them)`
        : undefined,
      countMissing(
        result.items,
        "account_cap",
        `balances omitted (cap of ${MAX_BALANCE_ACCOUNTS} accounts per call)`,
      ),
      countMissing(result.items, "sevdesk_error", "balances refused by sevDesk"),
      result.complete ? undefined : "sevDesk returned only the first 1000 accounts",
    ].filter((note): note is string => note !== undefined);
    const summary =
      count === 0
        ? "No payment accounts found."
        : `${count} payment ${count === 1 ? "account" : "accounts"}, balances at ${balanceDate}.`;
    return {
      data: { items: [...result.items], balanceDate, archivedHidden: result.archivedHidden },
      summary: notes.length === 0 ? summary : `${summary} Note: ${notes.join("; ")}.`,
    };
  },
});

function countMissing(
  items: readonly { readonly balanceMissing?: string | undefined }[],
  reason: string,
  text: string,
): string | undefined {
  const count = items.filter((item) => item.balanceMissing === reason).length;
  return count === 0 ? undefined : `${count} ${text}`;
}
