# Reports and exports

What the assistant can tell you about your books, and where its answers stop: totals, open items,
cash, the VAT summary, the profit and loss, the audits, and the exports for your tax adviser. It is
for anyone who wants numbers out of sevDesk, and for anyone deciding how far to trust them. Every
report here is `read`; the DATEV export and the document archive need `write`, setting the DATEV
settings needs `commit` ([Permissions](../permissions.md#tiers)).

> [!IMPORTANT]
> The reports are computed by this server from your sevDesk records. They are not sevDesk's own
> reports, not a tax return and not tax advice. Binding answers come from your Steuerberater.

## Which report answers what

| Question                                      | Tool                                                                 | Tier    |
| --------------------------------------------- | -------------------------------------------------------------------- | ------- |
| Revenue per month, costs per supplier, totals | [`sevdesk_records_summarize`](../tools.md#sevdesk_records_summarize) | `read`  |
| Who owes us what, and since when              | [`sevdesk_receivables_aging`](../tools.md#sevdesk_receivables_aging) | `read`  |
| What we owe, and when it is due               | [`sevdesk_payables_aging`](../tools.md#sevdesk_payables_aging)       | `read`  |
| How much money we have, and will have         | [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position)         | `read`  |
| What changed since a date                     | [`sevdesk_changed_since`](../tools.md#sevdesk_changed_since)         | `read`  |
| What the VAT return will roughly say          | [`sevdesk_vat_summary`](../tools.md#sevdesk_vat_summary)             | `read`  |
| Profit for a month, quarter or year           | [`sevdesk_profit_and_loss`](../tools.md#sevdesk_profit_and_loss)     | `read`  |
| What looks wrong: VAT treatment, §13b base    | [`sevdesk_records_audit`](../tools.md#sevdesk_records_audit)         | `read`  |
| A CSV file for Excel or the tax adviser       | [`sevdesk_csv_export`](../tools.md#sevdesk_csv_export)               | `read`  |
| The DATEV booking data for the tax adviser    | [`sevdesk_datev_export`](../tools.md#sevdesk_datev_export)           | `write` |
| All invoice or receipt PDFs of a period       | [`sevdesk_archive_export`](../tools.md#sevdesk_archive_export)       | `write` |

Two prompts combine them: [`vat_precheck`](../tools.md#vat_precheck) before the
Umsatzsteuer-Voranmeldung, and [`month_end_close`](../tools.md#month_end_close) for a month-end
close up to the hand-over to the Steuerberater.

## Totals

> Summarize revenue per month for 2026.

> How much did we spend per supplier in the third quarter?

[`sevdesk_records_summarize`](../tools.md#sevdesk_records_summarize) counts and adds up invoices,
credit notes, vouchers or bank transactions: exact net, tax and gross per currency, grouped by
month, quarter, status, contact or account. It reads up to 10,000 rows and says when there were
more. Recurring templates and payment reminders are left out unless you ask for them. For single
records the list tools remain the way, for example
[`sevdesk_invoices_list`](../tools.md#sevdesk_invoices_list).

## Open items and cash

> Who owes us money, and how much is more than 60 days overdue?

> Which supplier invoices are overdue, and whom do we owe the most?

[`sevdesk_receivables_aging`](../tools.md#sevdesk_receivables_aging) and
[`sevdesk_payables_aging`](../tools.md#sevdesk_payables_aging) sort today's open invoices and
expense vouchers into not due, 1–30, 31–60, 61–90 and over 90 days, with the largest customers or
suppliers. sevDesk only knows today's open items, so a reference day in the past is refused; a
later day ages today's items as of that day. Amounts without a usable paid figure are marked
approximate or unknown.

> What is our cash position, and what does the next 30 days look like?

[`sevdesk_cash_position`](../tools.md#sevdesk_cash_position) lists the balance of every payment
account as sevDesk computes it from the transactions it knows, which is not necessarily the bank's
figure. With an outlook it adds receivables and payables by due date and a projected balance,
labelled as expected, not booked.

## VAT summary

> Estimate the VAT return for October 2026.

[`sevdesk_vat_summary`](../tools.md#sevdesk_vat_summary) estimates the Umsatzsteuer-Voranmeldung
(UStVA) for a month, quarter or year: the form lines (Kennzahlen, 2026 form) with base and tax, the
expected payment or refund (Kz 83), the Zusammenfassende Meldung per buyer VAT ID, OSS sales per
country, and the amounts it cannot place. It reads the account's tax regime itself; a
Kleinunternehmer account gets no UStVA.

The basis is accrual (Sollversteuerung) unless you ask for cash (Istversteuerung). sevDesk's API
does not say which one your account files with, so name it if you file on the cash basis. The
server files nothing: the return goes to ELSTER from sevDesk or through your Steuerberater.

## Profit and loss

> What was our profit in the third quarter?

[`sevdesk_profit_and_loss`](../tools.md#sevdesk_profit_and_loss) builds an overview in the style of
an Einnahmenüberschussrechnung (EÜR): net income by tax rule, net expenses by booking account, the
result, and the VAT flows apart (VAT collected, input VAT paid, VAT paid to or refunded by the
Finanzamt). The basis is cash by default (the day the money moved, from the payments sevDesk links
to documents) or accrual (by document date).

## Audits

> Check the VAT treatment of our purchases and sales in the third quarter.

> What is our §13b base for October, by tax rule?

[`sevdesk_records_audit`](../tools.md#sevdesk_records_audit) answers "what is wrong?" instead of
"what are the numbers?". It runs one check per call for a month, quarter, year or date range and
returns findings. Each names its kind (`code`) and how sure it is (`severity`: `warning` when the
data points to a wrong booking, `check` when the answer depends on facts sevDesk does not hold),
gives a reason that cites the law and says what to check or do, with the contact and the documents
and their links into sevDesk. The documents of one kind and one contact form one finding. Findings
are hints, not tax advice, and every result says so in English and German. The tool changes
nothing.

### VAT treatment (`vat`)

The check compares each document's tax rule with where the other side is established, as far as
sevDesk knows it: the contact's VAT ID and the countries of its addresses. A German VAT ID or a
German address counts as registered or established in Germany, and Monaco counts as France. On
sales, a customer's VAT ID counts only in the valid format of its state, as
[`sevdesk_vat_id_check`](../tools.md#sevdesk_vat_id_check) checks it. Documents are taken by
document date; sales are checked on invoices.

| Code                                                                            | Means                                                                                                       |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `foreign_supplier_charged_german_vat`                                           | A supplier abroad charged German VAT, booked as input VAT (rule 9); usually you owe it instead (§ 13b UStG) |
| `foreign_vat_deducted`                                                          | VAT at a rate Germany does not charge, booked as input VAT (rule 9)                                         |
| `foreign_supplier_zero_rate`                                                    | A supplier abroad booked at 0 % (rule 9 or 10) without reverse charge or intra-EU acquisition               |
| `eu_reverse_charge_for_domestic_supplier`, `acquisition_from_domestic_supplier` | Rule 14 or 8 for a supplier with only German data                                                           |
| `eu_reverse_charge_for_non_eu_supplier`, `acquisition_from_non_eu_supplier`     | Rule 14 or 8 for a supplier outside the EU                                                                  |
| `eu_supplier_under_rule_12`                                                     | A service from another EU state under rule 12 instead of 14                                                 |
| `german_vat_to_eu_business`                                                     | German VAT on an invoice to a customer with a VAT ID of another EU state                                    |
| `intra_eu_supply_without_eu_vat_id`, `eu_service_without_eu_vat_id`             | Rule 3 or 21 without a valid VAT ID of the customer from another EU state                                   |

Not flagged on purpose: a foreign supplier with a German VAT ID or a German address (it may charge
German VAT), a supplier with only German data that charges no VAT (for example a Kleinunternehmer),
a supplier in the EU small-business scheme (VAT ID ending in EX), and import VAT on the import VAT
account. A contact without VAT ID and address cannot be placed: its documents are counted as not
judged (`coverage.notJudged`), so complete the contact to have them checked.

### §13b base (`reverse_charge`)

The check sums the §13b base of the period by tax rule: received (rules 12, 13 and 14, where you
owe the VAT as recipient, with the tax owed and the part deducted again as input VAT) and issued
(rule 5, Kz 60; rule 21, Kz 21). Each sum names its UStVA Kennzahlen and lists the documents
behind it. It uses the same tax points as `sevdesk_vat_summary`, so the bases match its Kz 46, 84,
60 and 21. The tax amounts (Kz 47, 85, 67) can differ by a cent, because the check rounds per tax
rule and the summary per form line (Kz 84/85 combine rules 12 and 13). It flags rule 13 (no input VAT deduction) on an account with regular
taxation (`reverse_charge_without_deduction`), and rules 12 and 14 (with deduction) on a
Kleinunternehmer account, which owes the tax but may not deduct it
(`reverse_charge_deduction_on_small_business`).

Both checks read the period's documents and, where the rates decide, their positions; `vat` also
reads the contact and address lists once each. Like the other reports they say what they left out
(`coverage.truncated`, `coverage.documentsLeftOut`), and over HTTP they stop reading after about 90
seconds: ask for a month when a quarter is too much.

## How far you can rely on them

`sevdesk_vat_summary` and `sevdesk_profit_and_loss` are estimates for checking. They are computed
from your documents and their positions, and each result says what it left out. What they do, and
what they leave to you:

- **Timing (accrual basis).** Revenue counts at the end of the supply. That also holds for services
  to businesses in other EU states (Kz 21 and the Zusammenfassende Meldung), which belong to the
  period in which they are performed. Intra-EU supplies of goods count by the invoice date, at the
  latest in the month after the supply. Documents are read by date with a margin of 62 days around
  the period; one whose tax point falls in the period but whose date lies further away is missed,
  and the notes say so.
- **Advance invoices (Abschlagsrechnungen).** Their VAT is due when the payment arrives. On the
  accrual basis the VAT summary does not compute that: it counts an advance invoice at its supply
  date like any invoice and lists the ones concerned (`coverage.advanceInvoices`, with a note), so
  you can check them by hand.
- **Cash basis.** Only payments reconciled in sevDesk count; a payment that is not booked against
  its document is missing. In the VAT summary only taxable revenue moves to the payment date; input
  VAT, § 13b and acquisition tax and tax-free supplies stay on accrual.
- **Import VAT (Einfuhrumsatzsteuer).** sevDesk books it as the amount of a position on the import
  VAT account (SKR04 1433, SKR03 1588) under tax rule 9. Such amounts go to Kz 62 and count as
  input VAT, not as an expense. Import VAT booked on another account is not recognized.
- **Not an Anlage EÜR.** The profit and loss works net, with the VAT flows shown apart; the official
  Anlage EÜR works gross, so its totals differ by those flows. Fixed assets are listed apart and not
  depreciated (no AfA), and private use and other adjustments are not computed.
- **Incomplete reads.** Both reports read positions document by document, up to 1,500 documents,
  which is slow for long periods. When a cap is reached, when a document's positions cannot all be
  read, or when a remote server runs out of time, the report says so (`coverage.truncated`, with a
  note) and the VAT summary gives no Kz 83 estimate. Over HTTP a report stops reading documents
  after about 90 seconds, because a request may take 120 ([remote limits](../remote/operations.md)).
  At the default request rate that is a few hundred documents: ask for a month instead of a quarter
  or a year.
- **German accounts only.** Tax rules and UStVA lines follow German law; Austrian accounts are not
  supported in 1.0.

Drafts never count, and unbooked bank transactions often mean missing receipts. The
[`vat_precheck`](../tools.md#vat_precheck) prompt checks both before it runs the summary.

## Exports

### DATEV

> Create the DATEV export for October 2026 for my tax adviser, with the receipt images.

[`sevdesk_datev_export`](../tools.md#sevdesk_datev_export) (`write`, no confirmation) lets sevDesk
build the DATEV booking data (Buchungsstapel, CSV files in a ZIP) for a month, quarter, year or
date range, and saves the ZIP in `SEVDESK_OUTPUT_DIR` (on a remote server: a download link). You
can limit it to earnings, expenditure, transactions, cash register or assets, keep only documents
paid in the period, and add the receipt images, which makes the file much larger. It takes up to a
few minutes.

With `format: "xml"` sevDesk exports the documents themselves as DATEV XML with their receipt
images (Belegbilder) instead of the booking batch, for an adviser who imports documents. It covers
earnings and expenditure only (transactions, cash register and assets are left out, and the
preview says so), and the receipt images are always included: about 5.6 MB for one month of a
small account. Keeping only the documents paid in the period (`exportByPaydate`) works with the
CSV export only: the XML export was recorded without it, so the tool refuses it there. Whether the
XML export includes enshrined (festgeschriebene) documents has not been recorded; the preview and
the result say so, so check the export in sevDesk when they must be in it. The CSV export stays
the default.

- It needs the DATEV settings in sevDesk (Beraternummer, Mandantennummer, start of the fiscal
  year) and refuses with guidance when they are missing; see
  [DATEV settings](#datev-settings) below.
- It never enshrines (festschreiben) the documents. A recorded XML export marked nothing as
  exported: a second export of the same period held the same documents.
- sevDesk delivers the file from its own storage on Amazon S3 ([Privacy](../../PRIVACY.md)).
- This server downloads at most 100 MiB. A larger export (a long period with receipt images) is not
  saved: export month by month, or download it in sevDesk.

### DATEV settings

> Set the DATEV client number to 54321; my tax adviser's Beraternummer is 1234567.

[`sevdesk_datev_settings_update`](../tools.md#sevdesk_datev_settings_update) (`commit`, asks you
to confirm) sets the accountant number (Beraternummer, 1001 to 9999999), the client number
(Mandantennummer, 1 to 99999) and the start of the fiscal year (Wirtschaftsjahresbeginn) that the
DATEV export needs. Give only what changes; the others keep their values in sevDesk, since
sevDesk takes all three at once. The confirmation shows every current value next to the new one
and warns when a number kept that way lies outside DATEV's range, or when the fiscal-year start
you give is more than a year away from today (it should be the first day of the current fiscal
year). Afterwards the tool reads the settings back and says what sevDesk stored.

The settings apply to the whole account: every later DATEV export carries them, and your tax
adviser's DATEV files the data under them. Take the numbers from your adviser; a wrong number puts
your booking data under another client or makes the import fail.

### Invoice and receipt archive

> Put all invoice PDFs of 2026 into one ZIP for the tax audit.

[`sevdesk_archive_export`](../tools.md#sevdesk_archive_export) (`write`, no confirmation) lets
sevDesk put every invoice PDF (`subject: "invoices"`) or every voucher receipt
(`subject: "vouchers"`) of a month, quarter, year or date range into one ZIP, one file per
document, and saves it like the DATEV export. Invoices can be narrowed to one customer, both to a
range of amounts (inclusive; for vouchers the gross amount).

- Nothing changes on any document: no status, no send date, nothing enshrined. It needs `write`
  because sevDesk renders every PDF on request.
- **sevDesk includes drafts.** Their file names carry "(Entwurf)" and no number; the result
  counts them (`draftEntries`) and says so. Remove them before you hand the archive on. Only that
  label counts: whether sevDesk marks other states the same way has not been seen, so take out
  nothing else on the tool's word.
- **The archive can hold fewer files than you have documents.** Vouchers without an uploaded
  receipt file are not in it (13 files for 53 vouchers on the test account), and an invoice archive
  held one invoice fewer than the invoice list. This is how sevDesk builds the archive, not an
  error; compare the counts with the lists when completeness matters.
- **It takes time.** sevDesk renders the whole ZIP before it answers: about 30 to 60 seconds for
  100 to 130 invoices (20 to 25 MB), about a second for a few receipts. The archive request gets
  up to 5 minutes, independent of `SEVDESK_TIMEOUT_MS`; beyond that it stops with nothing saved,
  and the remedy is a shorter period. On a remote server every request ends after 120 seconds
  ([Operations](../remote/operations.md)), and the download link must fit the account's share of
  the file space, 20 MiB without a state directory ([Files](../remote/files.md#limits-and-lifetimes)):
  export a week or two of invoices per call there.
- It asks sevDesk for at most 500 documents (`limit`, up to 1,000) and saves at most 100 MiB per
  ZIP (a rendered invoice is about 140 to 190 KB): 500 invoices fit the 5 minutes and the 100 MiB,
  1,000 do not. Export long periods in parts. When the ZIP holds close to `limit` files, the result
  says sevDesk may have stopped there (`mayBeTruncated`). That is a hint, not a count: vouchers
  without a receipt file are not in the ZIP, so a voucher archive can be cut while holding far
  fewer files than `limit`.
- When nothing matches, sevDesk sends a ZIP with only a note in it; the tool saves nothing and
  says that no document matched.

### CSV

> Export all vouchers of 2026 as CSV.

[`sevdesk_csv_export`](../tools.md#sevdesk_csv_export) (`read`) saves sevDesk's CSV export of
invoices, credit notes, vouchers, transactions or contacts exactly as sevDesk sends it (UTF-8 with
BOM, `;`-separated, German headers), at most 1,000 rows per file; the result says when more may
exist. It returns the path or link, never the content, and changes nothing in sevDesk. For totals,
`sevdesk_records_summarize` is the better tool.

The file exports are offered only when the server can deliver files: with `SEVDESK_OUTPUT_DIR` over
stdio ([Configuration](../configuration.md)), or through download links on a remote server
([Files over HTTP](../remote/files.md)). Every call creates a new file.

## Related

- [Invoices](invoices.md) and [Receipts and vouchers](receipts.md): getting the records right
  that these reports read.
- [Glossary](../glossary.md): UStVA, Kennzahl, ZM, EÜR and the other terms.
