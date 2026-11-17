# Workflows

Concrete tool sequences for common bookkeeping jobs in sevDesk. Every changing step runs twice:
first with `dryRun: true` (the tool checks everything and returns a preview, nothing is sent),
then, after the user agreed, without it. `commit` and `external` steps additionally ask the user
in a confirmation prompt; never ask them to "just approve" without showing the preview.

> **Not tax advice.** The sequences show how to record what happened in sevDesk. Whether a cost
> is deductible, which tax rule applies or when to file is the user's (or their Steuerberater's)
> decision. See the reference files for the sources.

Tiers needed (`SEVDESK_ALLOW`): `read` is always on; `write` for drafts; `commit` for finalizing,
booking, resetting and enshrining; `external` for email. Local files need `SEVDESK_FILE_DIRS`
(reading receipts and e-invoices) and `SEVDESK_OUTPUT_DIR` (writing exports). A receipt or
e-invoice that is online can be passed as an https link instead of a path when its host is in
`SEVDESK_FILE_URL_HOSTS`; the server downloads it during the call. If a tool below is missing from
the tool list, the setting is off: tell the user which one, do not work around it.

## Session start (every workflow)

1. `sevdesk_account_info`: system version (Update 2.0 → tax rules and booking accounts), VAT
   regime (regular or Kleinunternehmer §19 UStG), chart of accounts (SKR03/SKR04), enabled tiers.
2. Keep the regime in mind: a Kleinunternehmer shows no VAT on sales (tax rule 11) and deducts no
   input VAT (tax rule 10 on expenses); see [tax-rules.md](tax-rules.md).

## File a receipt (Beleg erfassen)

Tiers: `write` (draft); `commit` to finalize or book the payment. Receipt file: `SEVDESK_FILE_DIRS`,
or an https link to a host in `SEVDESK_FILE_URL_HOSTS`.

1. Read the receipt with the user: supplier, date, Belegnummer, gross amount, VAT rate(s), what
   was bought, whether it is already paid.
2. Duplicate check: `sevdesk_vouchers_list` with the supplier name, Belegnummer (`description`)
   and a date range around the receipt date.
3. Supplier: `sevdesk_contacts_search`; create one only if the user wants it
   (`sevdesk_contact_create`, `write`), otherwise the supplier name alone is enough.
4. Booking account and tax rule: `sevdesk_reference_lookup` with `kind: "receipt_guidance"`,
   `receiptType: "expense"` and the tax rule (usually 9 for a domestic receipt with VAT, 10 on a
   Kleinunternehmer account, 14 for a service from an EU business with reverse charge). Pick the
   account with the user; [accounts-skr03-skr04.md](accounts-skr03-skr04.md) lists typical ones.
   The account must allow the tax rule and every rate on the receipt, or sevDesk refuses it.
5. `sevdesk_voucher_create_draft` with `dryRun: true`: kind (expense by default), supplier
   (`supplierId` or `supplierName`), Belegnummer (`number`), Belegdatum (`date`), positions with
   booking account, amount and rate, the tax rule (defaults to 9, or 10 on a Kleinunternehmer
   account) and, if there is a scan, its path as `file` (inside `SEVDESK_FILE_DIRS`; PDF, PNG,
   JPEG or XML), or its https link (a host in `SEVDESK_FILE_URL_HOSTS`; the preview also shows
   the host). The tool checks every account × tax rule × rate against the receipt guidance
   and refuses a likely duplicate (same supplier, number, date and amount) unless
   `allowDuplicate` is set. Show the preview, then call it again without `dryRun`, with the
   preview's SHA-256 as `fileSha256`: the file is read again (a link downloaded again), and other
   bytes than the user saw are refused. The voucher is a draft (status 50).
6. Corrections while it is a draft: `sevdesk_voucher_update_draft` (changes only what is given;
   `positions` replaces all positions); a wrong duplicate draft: `sevdesk_voucher_delete_draft`.
7. `sevdesk_voucher_finalize` (`commit`, confirmation): draft → open (status 100); from now on
   it counts in the EÜR and the VAT return.
8. Paid? Either reconcile it against the bank transaction (see "Reconcile the bank"), or
   `sevdesk_voucher_book_payment` (`commit`, confirmation) with the payment account
   (`checkAccountId` from `sevdesk_bank_accounts_list`) and, for accounts fed by a bank import,
   the transaction (`transactionId`), so the payment is linked instead of counted twice.
   Skonto and bank fees are payment types there.

## Import an e-invoice (E-Rechnung)

Tiers: `read` to check, `write` to import. Needs `SEVDESK_FILE_DIRS`, or `SEVDESK_FILE_URL_HOSTS`
for a file passed as an https link.

1. `sevdesk_einvoice_parse` with the path (or https link) of the XRechnung XML or
   ZUGFeRD/Factur-X PDF: it reads
   the structured data (EN 16931), checks totals, VAT breakdown and required fields, and reports
   findings. Nothing is sent to sevDesk. For a hybrid PDF the XML is what counts.
2. Go through the findings with the user. A non-structured PDF (no XML inside) is not an
   e-invoice: file it as a normal receipt instead.
3. Duplicate check: `sevdesk_vouchers_list` with supplier name and invoice number.
4. `sevdesk_voucher_import_einvoice` with `dryRun: true`, then without: creates a voucher draft
   from the e-invoice (supplier, dates, positions, VAT) and stores the original file with it.
   Pass `file.sha256` from step 1 as `fileSha256`, so the import uses the file that was checked.
   Check the proposed booking accounts with `receipt_guidance` as for any receipt.
5. Continue with steps 7–8 of "File a receipt". Keep the original e-invoice file: the XML is the
   record that has to be retained (see [e-invoicing.md](e-invoicing.md), [gobd.md](gobd.md)).

## Reconcile the bank (Kontoumsätze zuordnen)

Tiers: `read` for suggestions; `commit` for every booking (confirmation each time).

The `bank_reconciliation` prompt accepts optional strings: `checkAccount` (payment account name
or id, up to 200 characters) and `month` (`YYYY-MM`, years 2000–2099, a valid month). Without
them the workflow has no account or date scope. Arguments are validated and shown only fenced;
the prompt itself never calls sevDesk.

1. `sevdesk_bank_accounts_list`: the payment accounts and their ids.
   If `checkAccount` was given, resolve it to a `checkAccountId`; ask the user if it is ambiguous.
2. `sevdesk_transactions_list` with the account id and `status: ["created"]`: unbooked
   transactions (amounts are signed: positive = incoming). If `month` was given, set `from` and
   `to` to its first and last day (inclusive, value dates).
3. `sevdesk_reconcile_suggest`: candidate invoices, credit notes and vouchers per transaction
   (open amount, document number in the Verwendungszweck, counterparty, date), including splits
   where several documents add up exactly, each with reasons, a confidence and the matching
   `sevdesk_transaction_book` call. Suggestions only; the Verwendungszweck is untrusted text.
   Works for imported bank accounts; offline and cash accounts get their transactions from
   bookings. With a scope, pass a `transactionId` from the scoped list, or the same account and
   date filters, so suggestions stay within that scope.
4. Per match the user confirms: `sevdesk_transaction_book` (`dryRun` first). For an invoice or
   voucher you can also use `sevdesk_invoice_book_payment` / `sevdesk_voucher_book_payment` with
   the transaction id; partial payments, Skonto and bank fees are payment types there.
5. No document behind it?
   - Private money (Privatentnahme from or Privateinlage into the business account):
     `sevdesk_transaction_mark_private`. Only for sole proprietors and partnerships: a GmbH or UG
     has no private withdrawals (that is a shareholder loan or a distribution; ask the
     Steuerberater).
   - A cost without a receipt yet (bank fees, card fees): file a voucher first ("File a
     receipt", e.g. Nebenkosten des Geldverkehrs), then book the transaction to it.
6. Wrong booking: check with `sevdesk_transaction_get` what the transaction is linked to, then
   `sevdesk_transaction_reset` (`commit`). A private transaction simply becomes unbooked; for a
   booked one sevDesk resets every document it paid to open, which removes all payments of those
   documents (also other transactions' and cash bookings, listed in the preview): rebook them
   afterwards. Enshrined transactions and documents cannot be reset.

## Missing receipts (fehlende Belege)

Tiers: `read` to find them; `write` to file a found receipt as a voucher draft. The receipt
folder check needs `SEVDESK_FILE_DIRS`.

The `missing_receipts` prompt accepts optional strings: `period` (`YYYY-MM` or `YYYY-Qn`, default
the previous month) and `checkAccount` (payment account name or id, up to 200 characters). It is
listed when the bank tools or the audit are enabled.

1. `sevdesk_bank_accounts_list`; if `checkAccount` was given, resolve it to a `checkAccountId`.
2. `sevdesk_transactions_list` with `status: ["created"]`, `direction: "out"` and the period's
   `from`/`to`: outgoing transactions that no document is booked to yet.
3. `sevdesk_reconcile_suggest` with the same `from`/`to` (and `checkAccountId`), paging with
   `nextOffset`, or with a single `transactionId`, not both: one with a matching voucher only
   needs booking ("Reconcile the bank"; check that the voucher has its receipt file); one without
   any matching voucher most likely lacks its receipt. Bank fees, taxes, salaries and private
   withdrawals often have no supplier receipt: ask the user.
4. `sevdesk_records_audit` with `check: recurring_gaps` (regular suppliers without a bill in the
   period) and `check: duplicates` (receipts booked twice, drafts left open). Hints, not tax
   advice.
5. `sevdesk_vouchers_list` with `status: "draft"`: receipts captured but never finalized.
6. With `SEVDESK_FILE_DIRS`: `sevdesk_receipt_folder_check` on the user's folder for the period:
   files no voucher carries, files only on a draft, files on two vouchers (a hint, not proof).
7. File each receipt that turns up as in "File a receipt": on a remote server the user uploads it
   first (`sevdesk_upload_request`, then the uploadId as `file`); the booking account and tax
   rule come from `sevdesk_reference_lookup` (`kind: "receipt_guidance"`);
   `sevdesk_voucher_create_draft` with the file as `file`, `dryRun` first, and its SHA-256 (from
   the folder check or the preview) as `fileSha256`. An XRechnung or ZUGFeRD file goes through
   `sevdesk_voucher_import_einvoice`.
8. Then `sevdesk_voucher_finalize` and book the bank transaction to the voucher with
   `sevdesk_transaction_book` (both `commit`, confirmation).

## Dunning run (Mahnlauf)

Tiers: `read` to list overdue invoices; `write` for reminder drafts; `commit` to finalize and
`external` to email them (confirmation each time).

The `dunning_run` prompt accepts optional strings: `contact` (customer name or id, up to 200
characters) and `minDaysOverdue` (1–4 digits, 0–3650 days, inclusive). Without them it considers
all customers and all overdue invoices. Arguments are validated and shown only fenced; the
prompt itself never calls sevDesk.

1. `sevdesk_receivables_aging`: an overview of open receivables and the largest debtors.
2. If `contact` was given, resolve it to a contact id with the available list or search tools;
   ask the user if it is ambiguous. `sevdesk_invoices_list` with `overdueOnly: true`, paging with
   `nextOffset`, then with `type: "reminder"` for earlier reminders. Use the resolved `contactId`
   for both lists. If `minDaysOverdue` was given, include only invoices at least that many days
   overdue, calculated from their due dates as of the run date; zero still means overdue only.
3. Rule out incoming payments that are not booked yet: `sevdesk_transactions_list` with
   `status: ["created"]` and `direction: "in"`, then `sevdesk_reconcile_suggest`.
4. Show the scoped invoices with customer, invoice number, due date, days overdue, open amount
   and earlier reminders. Ask which ones should get a reminder.
5. `sevdesk_invoice_create_reminder` for each selected invoice (`dryRun` first). It creates a
   draft and refuses if an unsent reminder draft already exists.
6. `sevdesk_invoice_send_email` (`dryRun` first, each email confirmed), or
   `sevdesk_invoice_finalize` (`dryRun` first) and `sevdesk_invoice_pdf` if the user sends it.
7. Summarize which invoices were reminded, which were left out and why, and when to follow up.

## VAT pre-check before the Umsatzsteuer-Voranmeldung (UStVA)

Tiers: `read`. The server does not file the UStVA; it is filed from sevDesk (ELSTER) or by the
Steuerberater. Deadline: the 10th day after the month or quarter, one month later with a
Dauerfristverlängerung (details in [tax-rules.md](tax-rules.md)). Kleinunternehmer normally file
no pre-returns.

1. Completeness for the period:
   - `sevdesk_transactions_list` with `status: ["created"]` for the period: unbooked
     transactions often mean missing receipts or unpaid-looking invoices.
   - `sevdesk_vouchers_list` and `sevdesk_invoices_list` with `status: "draft"`: drafts do not
     count for VAT.
2. `sevdesk_vat_summary` for the month or quarter: the UStVA lines (Kennzahlen) with base and
   tax, the expected payment (Kz 83), the ZM per buyer VAT ID, OSS sales per country and the
   amounts it cannot place. `basis` is accrual (Soll, the default) or cash (Ist): use the one the
   account files with. It is an estimate to check, not a filing.
   [tax-rules.md](tax-rules.md) explains which tax rule lands in which field.
3. Audits for the same period (`sevdesk_records_audit`, hints, not tax advice): `check: vat`
   (tax rule against where the supplier or customer is established), `check: reverse_charge` (the
   §13b base by rule; against the accrual-basis summary the bases should match Kz 46, 84 (rules
   12 and 13 together), 60 and 21 and the tax amounts (Kz 47, 85, 67) up to a cent, not on the
   cash basis), `check: duplicates` (input VAT counted twice) and `check: recurring_gaps` (missing
   bills, input VAT not claimed). With `SEVDESK_FILE_DIRS`: `sevdesk_receipt_folder_check` on the
   folder with the period's receipts (files no voucher carries were probably never booked; a hint,
   not proof).
4. Spot checks with `sevdesk_voucher_get` / `sevdesk_invoice_get` for flagged documents; fix
   drafts, reset (`commit`) or cancel finalized documents as needed. Never delete booked ones.
5. Intra-EU supplies and EU B2B services also go into the Zusammenfassende Meldung (ZM, due on
   the 25th day after the month or quarter); compare its totals with the summary.
6. After filing, the period should not change any more: enshrine the documents
   (`sevdesk_invoice_enshrine`, `sevdesk_voucher_enshrine`, `sevdesk_credit_note_enshrine`;
   `commit`, irreversible) if the user wants that, see [gobd.md](gobd.md).

## Month end

1. `sevdesk_changed_since` with the first day of the month: what was added or changed.
2. "Reconcile the bank" until no transaction of the month is unbooked.
3. Missing receipts: unbooked outgoing transactions without a voucher → ask the user for them.
   `sevdesk_records_audit` with `check: duplicates` (vouchers booked twice, stuck drafts) and
   `check: recurring_gaps` (a regular supplier without a bill this month); with
   `SEVDESK_FILE_DIRS`, `sevdesk_receipt_folder_check` on the user's receipt folder.
4. Receivables: `sevdesk_receivables_aging`; reminders for overdue invoices with
   `sevdesk_invoice_create_reminder` (`write`, then finalize/send as for invoices).
5. Payables: `sevdesk_payables_aging`; liquidity: `sevdesk_cash_position` with `outlookDays`.
6. "VAT pre-check" for the month (or quarter).
7. Numbers for the user: `sevdesk_profit_and_loss` and `sevdesk_records_summarize`
   (`groupBy: "month"`).
8. Hand-over to the Steuerberater: `sevdesk_datev_export` (`write`, `SEVDESK_OUTPUT_DIR`; needs
   the DATEV settings in sevDesk: Beraternummer, Mandantennummer, start of the fiscal year; it
   may mark the documents as exported and never enshrines them) or `sevdesk_csv_export` (`read`,
   `SEVDESK_OUTPUT_DIR`; raw CSV as sevDesk exports it).

## Year end: handoff to the Steuerberater

Tiers: `read` for the checks and numbers; `write` and `SEVDESK_OUTPUT_DIR` (on a remote server:
download links) for the DATEV export and the archive; `commit` to set the DATEV settings.

The `year_end_handoff` prompt accepts an optional `year` (`YYYY`, default the previous year). For a
fiscal year that does not start on 1 January, use its `from`/`to` instead of `year`.

1. Every month closed as above; no drafts, no unbooked transactions for the year
   (`sevdesk_transactions_list` with `status: ["created"]`, `sevdesk_vouchers_list` and
   `sevdesk_invoices_list` with `status: "draft"`).
2. `sevdesk_profit_and_loss` for the year (EÜR view, cash basis by default) and
   `sevdesk_records_summarize` grouped by month for plausibility checks and to size the archive
   parts. Purchases on asset accounts (e.g. GWG, EDV-Software) are listed apart and without
   depreciation (AfA); depreciation is done by the Steuerberater or in sevDesk. The profit and
   loss reads positions of up to 1,500 documents: if it reports `truncated`, run it per quarter.
3. `sevdesk_records_audit` for the year: `vat`, `reverse_charge`, `duplicates`, `recurring_gaps`
   (hints, not tax advice; `vat` and `reverse_charge` read up to 1,500 documents, so per quarter
   for more). With `SEVDESK_FILE_DIRS`: `sevdesk_receipt_folder_check` (500 files per call).
4. Open items: `sevdesk_receivables_aging`, `sevdesk_payables_aging` (as of today; sevDesk knows
   only today's open items), the open and partially paid invoices and vouchers of the year from
   the list tools, and `sevdesk_cash_position` with `asOf` for the balances on 31 December.
5. `sevdesk_datev_export` for the year (`dryRun` first; CSV Buchungsstapel or `format: "xml"`, as
   the Steuerberater imports). Missing or wrong DATEV settings: `sevdesk_datev_settings_update`
   (`commit`, confirmation) with the numbers from the Steuerberater, never guessed.
6. `sevdesk_archive_export` for `invoices` and `vouchers` (`dryRun` first), in parts: one call
   holds 500 documents by default (`limit` up to 1,000), stops after 5 minutes (on a remote server
   after 120 s, and a download link must fit the account's file space) and saves at most 100 MiB.
   On a local server by quarter, or by month where the counts are large or a part fails; on a
   remote server by month, or by one or two weeks where a month has many invoices.
7. Enshrine the year's documents if not done monthly (`commit`, irreversible), after the
   Steuerberater's review, and keep the retention periods in mind ([gobd.md](gobd.md)).

## Offer follow-up (Angebote nachfassen)

Tiers: `read` to list; `commit` to record the customer's answer or create an order confirmation;
`write` for delivery notes and invoices from an order (each with confirmation where the tier
asks for it).

The `offer_follow_up` prompt accepts optional strings: `minAgeDays` (1–4 digits, 0–3650, default 14) and `contact` (customer name or id, up to 200 characters).

1. `sevdesk_orders_list` with `type: "offer"`, `status: "sent"` and `to` set to today minus the
   age: open offers the customer has not answered. `sevdesk_order_get` for details and the
   documents already created from one.
2. Per offer, what the customer said:
   - yes or no: `sevdesk_order_set_offer_status` (`accept` / `reject`; `commit`, confirmation);
     it sends nothing to the customer.
   - yes, with an order confirmation: `sevdesk_order_create_confirmation` (`commit`,
     confirmation); sevDesk marks the offer as accepted in the same request.
   - goods to deliver: `sevdesk_order_create_delivery_note` (`write`) from the sent or accepted
     offer or its confirmation.
   - ready to bill: `sevdesk_invoice_create_from_order` (`write`), whole order, partial or
     advance invoice; then finalize as for invoices.
   - no answer: a follow-up message the user sends; nothing is sent from sevDesk.

## Invoices (Rechnungen)

1. `sevdesk_contacts_search` for the customer id.
2. Tax rule, unless it is a plain domestic sale: `sevdesk_tax_rule_suggest` with the contact and
   goods or services gives the rule, the rate and the note the invoice must carry
   ([tax-rules.md](tax-rules.md)); when the answer depends on a threshold or a special service, ask
   the user. For an EU business customer check the USt-IdNr. with `sevdesk_vat_id_check`.
3. `sevdesk_invoice_create_draft` (`dryRun` first), with the note in `footText`. The preview warns
   when the rule is not the usual one for the customer. For a public-sector customer or a business
   that wants an e-invoice, check it with `sevdesk_invoice_einvoice_preflight`.
4. `sevdesk_invoice_finalize` (`commit`): the number is assigned and the invoice becomes binding.
5. `sevdesk_invoice_send_email` (`external`) or the user sends the PDF
   (`sevdesk_invoice_pdf`, `sevdesk_document_save`).
6. Payment: via the bank reconciliation, or `sevdesk_invoice_book_payment` (`commit`).
7. Mistake after finalizing: `sevdesk_invoice_cancel` (Stornorechnung) or a credit note
   (`sevdesk_credit_note_create_from_invoice`); `sevdesk_invoice_reset` to draft only for an invoice
   that was never sent to anyone (see [gobd.md](gobd.md)). A credit note draft is corrected with
   `sevdesk_credit_note_update_draft` (`dryRun` first; positions replace all stored ones and keep
   the invoice's tax rates) before `sevdesk_credit_note_finalize` (`commit`).

## Sources

- sevDesk API: Update 2.0 tax rules
  ([api.sevdesk.de](https://api.sevdesk.de/#section/sevdesk-Update-2.0/Tax-Rules)),
  ReceiptGuidance ([forAllAccounts](https://api.sevdesk.de/#tag/Voucher/operation/forAllAccounts))
- Tool reference of this server:
  [docs/tools.md](https://github.com/jaylann/mcp-server-sevdesk/blob/main/docs/tools.md)
- sevDesk help: [Automatische Transaktionszuordnung](https://hilfe.sevdesk.de/de/articles/9382118-automatische-transaktionszuordnung),
  [Privatentnahmen](https://hilfe.sevdesk.de/de/articles/9881023-privatentnahmen),
  [Privateinlagen](https://hilfe.sevdesk.de/de/articles/9947647-privateinlagen),
  [Export (DATEV)](https://hilfe.sevdesk.de/de/articles/9373838-export),
  [Umsatzsteuervoranmeldung](https://hilfe.sevdesk.de/de/articles/9310598-umsatzsteuervoranmeldung-ustva)
- § 18 UStG (Voranmeldung), § 18a UStG (Zusammenfassende Meldung):
  [§ 18](https://www.gesetze-im-internet.de/ustg_1980/__18.html),
  [§ 18a](https://www.gesetze-im-internet.de/ustg_1980/__18a.html); § 46 UStDV
  (Dauerfristverlängerung): [§ 46](https://www.gesetze-im-internet.de/ustdv_1980/__46.html)
