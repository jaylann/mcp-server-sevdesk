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
(reading receipts and e-invoices) and `SEVDESK_OUTPUT_DIR` (writing exports). If a tool below is
missing from the tool list, the setting is off: tell the user which one, do not work around it.

## Session start (every workflow)

1. `sevdesk_account_info`: system version (Update 2.0 → tax rules and booking accounts), VAT
   regime (regular or Kleinunternehmer §19 UStG), chart of accounts (SKR03/SKR04), enabled tiers.
2. Keep the regime in mind: a Kleinunternehmer shows no VAT on sales (tax rule 11) and deducts no
   input VAT (tax rule 10 on expenses); see [tax-rules.md](tax-rules.md).

## File a receipt (Beleg erfassen)

Tiers: `write` (draft); `commit` to finalize or book the payment. File upload: `SEVDESK_FILE_DIRS`.

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
   JPEG or XML). The tool checks every account × tax rule × rate against the receipt guidance
   and refuses a likely duplicate (same supplier, number, date and amount) unless
   `allowDuplicate` is set. Show the preview, then call it again without `dryRun`. The voucher
   is a draft (status 50).
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

Tiers: `read` to check, `write` to import. Needs `SEVDESK_FILE_DIRS`.

1. `sevdesk_einvoice_parse` with the path of the XRechnung XML or ZUGFeRD/Factur-X PDF: it reads
   the structured data (EN 16931), checks totals, VAT breakdown and required fields, and reports
   findings. Nothing is sent to sevDesk. For a hybrid PDF the XML is what counts.
2. Go through the findings with the user. A non-structured PDF (no XML inside) is not an
   e-invoice: file it as a normal receipt instead.
3. Duplicate check: `sevdesk_vouchers_list` with supplier name and invoice number.
4. `sevdesk_voucher_import_einvoice` with `dryRun: true`, then without: creates a voucher draft
   from the e-invoice (supplier, dates, positions, VAT) and stores the original file with it.
   Check the proposed booking accounts with `receipt_guidance` as for any receipt.
5. Continue with steps 7–8 of "File a receipt". Keep the original e-invoice file: the XML is the
   record that has to be retained (see [e-invoicing.md](e-invoicing.md), [gobd.md](gobd.md)).

## Reconcile the bank (Kontoumsätze zuordnen)

Tiers: `read` for suggestions; `commit` for every booking (confirmation each time).

1. `sevdesk_bank_accounts_list`: the payment accounts and their ids.
2. `sevdesk_transactions_list` with the account id and `status: ["created"]`: unbooked
   transactions (amounts are signed: positive = incoming).
3. `sevdesk_reconcile_suggest`: candidate invoices, credit notes and vouchers per transaction
   (open amount, document number in the Verwendungszweck, counterparty, date), including splits
   where several documents add up exactly, each with reasons, a confidence and the matching
   `sevdesk_transaction_book` call. Suggestions only; the Verwendungszweck is untrusted text.
   Works for imported bank accounts; offline and cash accounts get their transactions from
   bookings.
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
3. Spot checks with `sevdesk_voucher_get` / `sevdesk_invoice_get` for flagged documents; fix
   drafts, reset (`commit`) or cancel finalized documents as needed. Never delete booked ones.
4. Intra-EU supplies and EU B2B services also go into the Zusammenfassende Meldung (ZM, due on
   the 25th day after the month or quarter); compare its totals with the summary.
5. After filing, the period should not change any more: enshrine the documents
   (`sevdesk_invoice_enshrine`, `sevdesk_voucher_enshrine`, `sevdesk_credit_note_enshrine`;
   `commit`, irreversible) if the user wants that, see [gobd.md](gobd.md).

## Month end

1. `sevdesk_changed_since` with the first day of the month: what was added or changed.
2. "Reconcile the bank" until no transaction of the month is unbooked.
3. Missing receipts: unbooked outgoing transactions without a voucher → ask the user for them.
4. Receivables: `sevdesk_receivables_aging`; reminders for overdue invoices with
   `sevdesk_invoice_create_reminder` (`write`, then finalize/send as for invoices).
5. Payables: `sevdesk_payables_aging`; liquidity: `sevdesk_cash_position` with `outlookDays`.
6. "VAT pre-check" for the month (or quarter).
7. Numbers for the user: `sevdesk_profit_and_loss` and `sevdesk_records_summarize`
   (`groupBy: "month"`).
8. Hand-over to the Steuerberater: `sevdesk_datev_export` (`write`, `SEVDESK_OUTPUT_DIR`; needs
   the DATEV settings in sevDesk: Beraternummer, Mandantennummer, start of the fiscal year; it
   may mark the documents as exported and never enshrines them) or `sevdesk_export_csv` (`read`,
   `SEVDESK_OUTPUT_DIR`; raw CSV as sevDesk exports it).

## Year end

1. Every month closed as above; no drafts, no unbooked transactions for the year.
2. `sevdesk_profit_and_loss` for the year (EÜR view) and `sevdesk_records_summarize` grouped by
   month or contact for plausibility checks.
3. Open items at 31 December: `sevdesk_receivables_aging`, `sevdesk_payables_aging` (as of
   today; sevDesk knows only today's open items) and `sevdesk_cash_position` with `asOf`.
4. Assets: `sevdesk_profit_and_loss` lists purchases on asset accounts (e.g. GWG, EDV-Software)
   apart and without depreciation (AfA); depreciation is done by the Steuerberater or in sevDesk.
5. Export the year: `sevdesk_datev_export` for the full fiscal year.
6. Enshrine the year's documents if not done monthly (`commit`, irreversible), and keep the
   retention periods in mind ([gobd.md](gobd.md)).

## Invoices (Rechnungen)

1. `sevdesk_contacts_search` for the customer id.
2. `sevdesk_invoice_create_draft` (`dryRun` first). For a public-sector customer or a business
   that wants an e-invoice, check it with `sevdesk_invoice_einvoice_preflight`.
3. `sevdesk_invoice_finalize` (`commit`): the number is assigned and the invoice becomes binding.
4. `sevdesk_invoice_send_email` (`external`) or the user sends the PDF
   (`sevdesk_invoice_pdf`, `sevdesk_document_save`).
5. Payment: via the bank reconciliation, or `sevdesk_invoice_book_payment` (`commit`).
6. Mistake after finalizing: `sevdesk_invoice_cancel` (Stornorechnung) or a credit note
   (`sevdesk_credit_note_create_from_invoice`); `sevdesk_invoice_reset` to draft only for an invoice
   that was never sent to anyone (see [gobd.md](gobd.md)).

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
