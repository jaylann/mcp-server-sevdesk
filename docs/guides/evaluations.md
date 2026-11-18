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

| Question                                      | Tool                                                                       | Tier    |
| --------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| Revenue per month, costs per supplier, totals | [`sevdesk_records_summarize`](../tools.md#sevdesk_records_summarize)       | `read`  |
| Who owes us what, and since when              | [`sevdesk_receivables_aging`](../tools.md#sevdesk_receivables_aging)       | `read`  |
| What we owe, and when it is due               | [`sevdesk_payables_aging`](../tools.md#sevdesk_payables_aging)             | `read`  |
| How much money we have, and will have         | [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position)               | `read`  |
| What changed since a date                     | [`sevdesk_changed_since`](../tools.md#sevdesk_changed_since)               | `read`  |
| What the VAT return will roughly say          | [`sevdesk_vat_summary`](../tools.md#sevdesk_vat_summary)                   | `read`  |
| Profit for a month, quarter or year           | [`sevdesk_profit_and_loss`](../tools.md#sevdesk_profit_and_loss)           | `read`  |
| What looks wrong: VAT, §13b, duplicates, gaps | [`sevdesk_records_audit`](../tools.md#sevdesk_records_audit)               | `read`  |
| Which receipts in my folder are not booked    | [`sevdesk_receipt_folder_check`](../tools.md#sevdesk_receipt_folder_check) | `read`  |
| A CSV file for Excel or the tax adviser       | [`sevdesk_csv_export`](../tools.md#sevdesk_csv_export)                     | `read`  |
| The DATEV booking data for the tax adviser    | [`sevdesk_datev_export`](../tools.md#sevdesk_datev_export)                 | `write` |
| All invoice or receipt PDFs of a period       | [`sevdesk_archive_export`](../tools.md#sevdesk_archive_export)             | `write` |

Three prompts combine them: [`vat_precheck`](../tools.md#vat_precheck) before the
Umsatzsteuer-Voranmeldung, [`month_end_close`](../tools.md#month_end_close) for a month-end close
up to the hand-over to the Steuerberater, and [`year_end_handoff`](../tools.md#year_end_handoff)
for the year: profit and loss, the audits, the open items, the DATEV export and the document
archive in parts small enough for its limits.

## Totals

> Summarize revenue per month for 2026.

> How much did we spend per supplier in the third quarter?

[`sevdesk_records_summarize`](../tools.md#sevdesk_records_summarize) counts and adds up invoices,
credit notes, vouchers or bank transactions: exact net, tax and gross per currency, grouped by
month, quarter, status, contact or account. It reads up to 10,000 rows and says when there were
more. Recurring templates and payment reminders are left out unless you ask for them. For single
records the list tools remain the way, for example
[`sevdesk_invoices_list`](../tools.md#sevdesk_invoices_list).

### By project tag or cost centre

> What did project Website Relaunch cost this year?

> Show this month's expenses for cost centre Munich.

Invoices, credit notes and vouchers can be limited to one tag (`tag`, by name) or one cost centre
(Kostenstelle, `costCentre`, by id, number or name), and grouped by `tag` or `cost_centre`. A name
the account does not have, or one that fits several tags or cost centres, is refused before
anything is counted: you never get the totals of all documents labelled as one project's.

- **Tags overlap.** A document can carry several tags, so it counts in each of its tag groups, and
  the tag groups add up to more than the totals. The result says so (`groupsOverlap`).
- **Cost centres split.** sevDesk keeps one cost centre per document, so the cost-centre groups add
  up to the totals. Voucher positions read back from sevDesk without a cost centre of their own
  (one sent with a position is dropped), so the whole document counts for the cost centre on its
  head.
- **None.** Documents without a tag or without a cost centre form their own group, `none`.
- **Incomplete reads.** The tags come from the account's tag assignments, read up to 10,000. With
  more, or when the row cap stops reading, the breakdown is marked incomplete
  (`groupsComplete: false`) instead of passing partial sums off as final. The tag names are read
  up to 10,000 tags as well; beyond that a group shows only its tag id, and the result says so.

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

> What was the profit of cost centre Munich in the third quarter?

With `costCentre` or `tag` it counts only the documents on that cost centre or with that tag, on
both bases; the result names the filter (`filters`). `groupBy: "cost_centre"` or `"tag"` adds the
income, expenses and result of each cost centre or tag (`breakdown`). The cost-centre groups,
`none` included, add up to the totals; tag groups overlap when a document has several tags, and
the breakdown says so. A group's document count includes documents without income or expenses,
such as a VAT payment to the Finanzamt, so a group can hold documents and show no income or
expenses. Unknown or ambiguous names are refused, as in the summary.

## Audits

> Check the VAT treatment of our purchases and sales in the third quarter.

> What is our §13b base for October, by tax rule?

> Did we book any receipt twice in the third quarter, and which drafts are still open?

> Is a monthly bill missing this year?

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
[`sevdesk_vat_id_check`](../tools.md#sevdesk_vat_id_check) checks it. Greek VAT IDs start with
EL, so a number stored with the prefix GR counts as a VAT ID in the wrong format for its state
(the finding says so), never as one from outside the EU; for where a supplier is established, GR
still means Greece. Documents are taken by document date; sales are checked on invoices.

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

### Vouchers booked twice and stuck drafts (`duplicates`)

The check compares the vouchers (Belege) of each supplier, expenses and revenue apart. The
supplier is the voucher's contact, or the supplier name on the voucher when it has no contact; a
voucher with neither is not compared and the notes count it. A pair that involves a draft is also
found across suppliers, by the same number and gross amount: sevDesk's receipt recognition fills
in a receipt's invoice number and amount, but not the supplier's contact, so the same PDF reaching
sevDesk twice can stand under two suppliers or none. A pair counts in the period of its later
voucher; vouchers up to 31 days before the period are read for the earlier one.

| Code                    | Means                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `voucher_number_twice`  | Booked vouchers with the same document number, at most 21 days apart (`warning`). Case, spaces and `-_/.#` do not count; a number needs a digit, so "Miete" typed as the description is not one                          |
| `voucher_receipt_twice` | A same-amount pair whose receipt files have the same SHA-256 checksum: the same file uploaded twice (`warning`)                                                                                                          |
| `voucher_amount_twice`  | Booked vouchers with the same gross amount and currency, at most 5 days apart, not told apart by two different numbers (`check`)                                                                                         |
| `draft_repeats_voucher` | A draft with the same number as a booked voucher, at most 21 days apart, and the same supplier or the same amount (any supplier); or the same supplier and amount within 5 days (`check`): delete it rather than book it |
| `draft_twice`           | Two drafts paired by the same rules (`check`): usually the same receipt uploaded twice; book one, delete the other                                                                                                       |
| `voucher_draft_stuck`   | A voucher dated in the period that is still a draft 21 days or more after it was created in sevDesk (`check`)                                                                                                            |
| `sales_draft_stuck`     | The same for an invoice or credit note: the customer has not been billed (`check`)                                                                                                                                       |

Not flagged on purpose: purchases of the same amount a week apart, two receipts with different
numbers, the same number on vouchers more than 21 days apart (a description such as "Miete 2026"
repeated on every monthly bill), a voucher and its reversal (+x and −x), the same number from
another supplier or in the other direction between booked vouchers, drafts under different
suppliers with another amount or without a number, a gross amount of 0, and a draft created less
than 21 days ago, however old its document date. Sales invoices are checked for stuck drafts only:
their numbers come from sevDesk's own number range, and an invoice issued twice is corrected with
a cancellation invoice. To find those drafts the check lists every invoice and credit note dated in
the period (one request per 1,000): sevDesk's lists declare a status filter, but no recording shows
that it returns only drafts, so it is not used.

To confirm a same-amount pair the check compares the SHA-256 checksums of the vouchers' receipt
files, which sevDesk sends with the voucher list (no extra read per voucher). sevDesk stores no
checksum for some receipts (one its recognition created from an uploaded file has none), so
`voucher_receipt_twice` can only be found for receipts with one. Different checksums,
or a receipt without one, prove nothing, since the same paper scanned twice gives two files, so
such a pair stays a `check`.

### Missing bills of regular suppliers (`recurring_gaps`)

The check learns from the expense vouchers which suppliers bill every month, quarter or year, and
reports a period inside the audit without any voucher of that supplier: usually a lost or unbooked
receipt. It reads the vouchers (drafts included) from 24 months before the period to 12 months
after it, but not after today. The finding names the missing months (`missing`) and lists the
supplier's bills before and after each gap.

A supplier counts as regular when its bills fall on about the same day (within 7 days) at least
three times in four, one bill (or its usual number of bills) per period as a rule, with at most one
period in four empty; quarterly and yearly bills must fall in the same month of the quarter or
year. A period counts as missing only with at least three months (quarterly and yearly: two
periods) with bills before it and one after it. The rhythm is learned for each month of the audit
from the supplier's bills of the 12 months before and after it (yearly bills: 24 months before),
so a supplier that went from monthly to quarterly bills is judged by its quarterly bills from then
on. A bill is expected on the supplier's usual day, or on the month's last day when the month is
shorter: a bill of the 31st is expected on 30 June.

| Code                     | Means                                                         |
| ------------------------ | ------------------------------------------------------------- |
| `monthly_bill_missing`   | A month without a bill from a supplier that bills monthly     |
| `quarterly_bill_missing` | A quarter without a bill from a supplier that bills quarterly |
| `yearly_bill_missing`    | A year without a bill from a supplier that bills yearly       |

Not flagged on purpose: a change of amount (amounts are not compared), a bill that moved a few days
across a month end, two bills in one month next to a month without one (the bill came late or
early), a supplier that stopped billing, the latest period while the supplier's next bill has not
come yet, and a bill booked without the supplier's contact but under its name (it counts for the
one contact whose vouchers carry that name). sevDesk's recurring voucher templates (RV) are not
bills and are not read; the vouchers booked from them count like any other. When the listing stops
at its cap the check reports no gaps at all, since a voucher not read would look like one. A
shorter period does not help then: the range read always spans about three years, so the account
has more vouchers in that time than the check can read.

The checks `vat` and `reverse_charge` read the period's documents and, where the rates decide,
their positions; `vat` also reads the contact and address lists once each. `duplicates` and
`recurring_gaps` read document lists only, up to 10,000 rows; `recurring_gaps` always reads about
three years, whatever the period. Like the other reports they say what they left out
(`coverage.truncated`, `coverage.documentsLeftOut`), and over HTTP they stop reading document by
document after about 90 seconds: ask for a month when a quarter is too much (this does not shorten
what `recurring_gaps` reads).

### Receipts in a folder that were never booked

> Which receipts in my folder for March 2026 are not booked in sevDesk?

[`sevdesk_receipt_folder_check`](../tools.md#sevdesk_receipt_folder_check) compares the receipt
files of a folder on your computer with the receipt files attached to the vouchers in sevDesk. It
is a tool of its own, because it exists only where the server can read local folders: it is
offered only with `SEVDESK_FILE_DIRS` ([Configuration](../configuration.md)), so not on a remote
server with OAuth, where an upload carries a single file, and in bearer mode only for folders on
the server ([Files over HTTP](../remote/files.md)).

It reads only inside `SEVDESK_FILE_DIRS`: the folder you name, or all of them, with subfolders up
to three levels deep only when you ask. It takes PDF, PNG, JPEG and XML files (recognized by their
content) of up to 20 MB, at most 500 files and 1 GB per call, and computes each file's SHA-256
checksum. Hidden files, symbolic links and other file types are skipped and counted; when a limit
is reached the result says that the folder was cut. No file content leaves the server and nothing
is uploaded: the result holds paths, sizes, modification dates and checksums. sevDesk stores a
checksum for receipts uploaded through the API's upload (not for those its recognition created),
and the voucher list carries it, so the voucher list of the period, 62 days before and after it,
drafts included, is all the check reads from sevDesk.

| Code                         | Means                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `receipt_file_booked_twice`  | Two or more booked vouchers carry the file (`warning`)                                       |
| `receipt_file_not_booked`    | No voucher read carries the file: probably never booked (`check`)                            |
| `receipt_file_before_period` | The same, but the file was last changed before the vouchers read: an older receipt (`check`) |
| `receipt_file_only_on_draft` | Only a draft carries the file: not booked yet (`check`)                                      |
| `receipt_file_draft_repeats` | A booked voucher and a draft carry the file: delete the draft rather than book it (`check`)  |

Like the audits, every result says in English and German that its findings are hints, not tax
advice (`caveat`), and what a match proves (`matching`).

Every file that matches is listed with its vouchers and their status (`matched`). A match proves
that exactly this file is attached to that voucher. No match is a hint, not proof: the same
receipt as another file (a scan or photo of the paper, a copy converted or compressed by sevDesk
or another program, a receipt that reached sevDesk by e-mail or through its app) has another
checksum, and a voucher dated outside the range read is not compared. Amounts, dates and
suppliers are not compared, since that would need the file's content. Two weak hints help: the
day the file was last changed (`modified`, not the receipt date), and vouchers whose document
number appears in the file name (`possibleVouchers`). An unmatched file last changed after the
range read stays `receipt_file_not_booked`, since a receipt of the period may have been saved
late; a note counts such files, which may belong to a later period. To book a file that is
missing, create a draft with
[`sevdesk_voucher_create_draft`](../tools.md#sevdesk_voucher_create_draft), the file as `file` and
its `sha256` as `fileSha256`, so the draft gets exactly the bytes the check saw (needs `write`).

Not every receipt in sevDesk has a checksum: one that sevDesk's recognition created from an
uploaded file has none, so no file can ever match it. The result counts such receipts in the range
read (`withoutChecksum`, with a note in English and German). While there are any, an unmatched
file is reported as having no receipt with its checksum, not as unbooked, and a receipt without a
checksum whose size in bytes and extension equal the file's is named as a third weak hint
(`sameSizeVouchers`), never as a match.

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
