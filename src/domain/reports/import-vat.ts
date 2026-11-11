/**
 * Import VAT (Einfuhrumsatzsteuer, EUSt) in the tax reports.
 *
 * sevDesk has no tax rule for import VAT. The customs notice is booked as an expense voucher
 * position on the import VAT account under tax rule 9 at 0 %: the recorded ReceiptGuidance
 * (`test/fixtures/recorded/2026-11-07/meta/receipt-guidance-all.json`) allows account 1433
 * "Einfuhrumsatzsteuer" (AccountDatev id 2624) only with rule 9 and rate ZERO. The position's
 * amount is therefore the tax itself, with `sumTax` 0. Read like any other rule 9 position it
 * gave no input VAT at all and an operating expense of the full amount (review 2026-11, round 3).
 * Here it is recognized by its booking account:
 * - VAT summary: deductible import VAT, Kz 62 (§ 15 Abs. 1 Satz 1 Nr. 2 UStG), part of the input
 *   VAT of the Kz 83 estimate;
 * - profit and loss: a VAT flow (`vatFlows.inputVat`), not an expense.
 *
 * Which account it is:
 * - AccountDatev id {@link IMPORT_VAT_ACCOUNT_DATEV_ID}, as recorded. The recorded `AccountDatev`
 *   rows carry no client and hold both numbers (`number` SKR04, `number03` SKR03, see
 *   `accounts-datev.ts`), which suggests one row per account for both charts; the row of 2624
 *   itself is not among the 100 rows `GET /AccountDatev` returned, so this is not proven.
 * - Any account of the connected account's chart with the import VAT number of that chart
 *   ("Bezahlte Einfuhrumsatzsteuer": 1433 in SKR04, 1588 in SKR03), when the caller passes the
 *   account list and the chart. This covers rows sevDesk versions by validity. Without a known
 *   chart no number is matched, because the same number means another account in the other chart.
 *
 * What it cannot tell: import VAT booked on any other account (e.g. together with customs duty)
 * and Update 1.0 positions (booking category instead of AccountDatev) are not recognized and
 * count as before.
 */
import type { AccountDatevList } from "../accounts-datev.js";
import type { DocumentHeader, PositionGroup } from "./positions-scan.js";

/** AccountDatev id of "Einfuhrumsatzsteuer" (SKR04 1433) in the recorded ReceiptGuidance. */
const IMPORT_VAT_ACCOUNT_DATEV_ID = 2624;

/** Number of the import VAT account per chart of accounts (`AccountSettings.chartOfAccounts`). */
const IMPORT_VAT_ACCOUNT_NUMBERS: Readonly<Record<string, string>> = {
  skr03: "1588",
  skr04: "1433",
};

/** The only tax rule sevDesk allows on the import VAT account: deductible expenses. */
const IMPORT_VAT_TAX_RULE = 9;

/** What the reports know about the connected account's chart (both optional). */
interface ImportVatSource {
  /** Booking accounts (`loadAccountsDatev`), to find the account by its number. */
  readonly accounts?: AccountDatevList | undefined;
  /** Lower-case chart code (`skr03`, `skr04`) from the account settings. */
  readonly chartOfAccounts?: string | undefined;
}

/** The AccountDatev ids that are the import VAT account for `source` (see the module doc). */
export function importVatAccountIds(source: ImportVatSource): ReadonlySet<number> {
  const ids = new Set<number>([IMPORT_VAT_ACCOUNT_DATEV_ID]);
  const number =
    source.chartOfAccounts === undefined
      ? undefined
      : IMPORT_VAT_ACCOUNT_NUMBERS[source.chartOfAccounts.trim().toLowerCase()];
  if (number !== undefined) {
    for (const account of source.accounts?.accounts ?? []) {
      if (account.number === number) ids.add(account.id);
    }
  }
  return ids;
}

/**
 * Whether `group` of `header` is import VAT: an expense under tax rule 9 booked on one of
 * `accountIds`. Other rules on that account are left to their own treatment (sevDesk does not
 * allow them there, so nothing is known about what such a booking means).
 */
export function isImportVat(
  header: DocumentHeader,
  group: PositionGroup,
  accountIds: ReadonlySet<number>,
): boolean {
  return (
    header.direction === "expense" &&
    header.taxRuleId === IMPORT_VAT_TAX_RULE &&
    group.accountDatevId !== undefined &&
    accountIds.has(group.accountDatevId)
  );
}
