# Receipts and vouchers

This guide covers the money going out (and income without an invoice of your own): filing a
receipt or supplier invoice as a voucher (Beleg), importing an e-invoice, finalizing and paying
it. It is for anyone who does their own bookkeeping in sevDesk. Each step names what you ask, the
tool, the [tier](../permissions.md#tiers) and whether you confirm.

## Overview

| Step                                                                | Tool                                                                                                                                                   | Tier              | You confirm     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------- |
| [Make the file available](#make-the-file-available)                 | `SEVDESK_FILE_DIRS`, or [`sevdesk_upload_request`](../tools.md#sevdesk_upload_request) on a remote server                                              | `read`            | no              |
| [Check for duplicates](#check-for-duplicates)                       | [`sevdesk_vouchers_list`](../tools.md#sevdesk_vouchers_list)                                                                                           | `read`            | no              |
| [Pick account and tax rule](#pick-the-booking-account-and-tax-rule) | [`sevdesk_reference_lookup`](../tools.md#sevdesk_reference_lookup) (`receipt_guidance`)                                                                | `read`            | no              |
| [Create the voucher draft](#create-the-voucher-draft)               | [`sevdesk_voucher_create_draft`](../tools.md#sevdesk_voucher_create_draft)                                                                             | `write`           | no              |
| [Or import an e-invoice](#import-an-e-invoice)                      | [`sevdesk_einvoice_parse`](../tools.md#sevdesk_einvoice_parse), [`sevdesk_voucher_import_einvoice`](../tools.md#sevdesk_voucher_import_einvoice)       | `read`, `write`   | no              |
| [Correct the draft](#correct-a-draft)                               | [`sevdesk_voucher_update_draft`](../tools.md#sevdesk_voucher_update_draft), [`sevdesk_voucher_delete_draft`](../tools.md#sevdesk_voucher_delete_draft) | `write`, `commit` | delete: **yes** |
| [Finalize](#finalize)                                               | [`sevdesk_voucher_finalize`](../tools.md#sevdesk_voucher_finalize)                                                                                     | `commit`          | **yes**         |
| [Book the payment](#book-the-payment)                               | [`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment)                                                                             | `commit`          | **yes**         |
| [Enshrine](#enshrine)                                               | [`sevdesk_voucher_enshrine`](../tools.md#sevdesk_voucher_enshrine)                                                                                     | `commit`          | **yes**         |

The [`receipt_intake`](../tools.md#receipt_intake) prompt runs these steps in order, with a dry
run before each change.

> [!IMPORTANT]
> Voucher writes need sevDesk Update 2.0. Accounts on the older bookkeeping system 1.0 can list and
> read vouchers, but not create or change them.

## Make the file available

The voucher tools never read your disk on their own:

- **Over stdio** they read receipts (PDF, PNG, JPEG) and e-invoices (XRechnung XML, ZUGFeRD or
  Factur-X PDF) only from the folders in `SEVDESK_FILE_DIRS`, up to 20 MiB per file
  ([Configuration](../configuration.md)). Without that setting a voucher draft can still be
  created, just without a file, and the two e-invoice tools are not offered.
- **On a remote server** you upload the file in your browser: the assistant calls
  [`sevdesk_upload_request`](../tools.md#sevdesk_upload_request), gives you a link, and passes the
  upload on once you say it is done. Up to 10 files fit on one page; see
  [Files over HTTP](../remote/files.md).

> File the receipt Belege/2026-11/tankstelle-shell.pdf.

## Check for duplicates

> Is there already a voucher from Hetzner with number R-88231?

[`sevdesk_vouchers_list`](../tools.md#sevdesk_vouchers_list) (`read`) filters by supplier,
Belegnummer, date range and status. The draft tools check again on their own: a voucher with the
same supplier, number, date and gross amount is refused unless you say it is really a second one.

## Pick the booking account and tax rule

> Which booking account and tax rule fit a software subscription invoiced from Ireland without VAT?

Every voucher position is booked on an account (Buchungskonto) with a tax rule (Steuerregel), and
sevDesk only accepts certain combinations. [`sevdesk_reference_lookup`](../tools.md#sevdesk_reference_lookup)
with `kind: receipt_guidance` (`read`) lists which account allows which tax rules and rates, for
expense or revenue receipts. Unless told otherwise, an expense uses tax rule 9 (input VAT
deductible), or 10 on a Kleinunternehmer account. Earlier vouchers of the same supplier, read with
[`sevdesk_voucher_get`](../tools.md#sevdesk_voucher_get), show how it was booked before.

Which account and rule apply to a purchase is your decision, or your Steuerberater's; the tools
only check that sevDesk will accept the combination.

## Create the voucher draft

> Book this petrol receipt: Shell, 14 November, 78.40 EUR gross at 19 %, paid by card.

[`sevdesk_voucher_create_draft`](../tools.md#sevdesk_voucher_create_draft) (`write`, no
confirmation) creates a draft voucher: expense (Ausgabe, the default) or revenue (Einnahme), the
supplier as a contact or just a name, Belegnummer, dates, and one position per booking account and
rate, gross by default. Every account × tax rule × rate is checked against the receipt guidance
before anything is saved, and the file, if given, is uploaded and attached. The voucher stays a
draft: nothing is booked yet.

> Book it on cost centre MCP1.

A voucher can carry a cost centre (Kostenstelle), named by its id, number or name
([`sevdesk_reference_lookup`](../tools.md#sevdesk_reference_lookup), kind `cost_centres`); an
unknown or ambiguous one is refused. `sevdesk_vouchers_list` filters by it, and the finalize
approval shows it. `sevdesk_voucher_update_draft` with `removeCostCentre` takes it off a draft.

Foreign currencies work with an exchange rate or a rate date, but such drafts cannot be finalized
through the server. The rules for updating them are in the
[tool reference](../tools.md#sevdesk_voucher_update_draft).

## Import an e-invoice

> Check the e-invoice Rechnungen/RE-4711.xml before I import it.

[`sevdesk_einvoice_parse`](../tools.md#sevdesk_einvoice_parse) (`read`) reads an XRechnung (UBL or
CII) or a ZUGFeRD / Factur-X PDF, checks sums, VAT breakdown and a subset of the EN 16931 and
XRechnung rules, and suggests a voucher: direction, matching contact (by VAT ID, IBAN or exact
name), tax rule and one position per VAT rate. Nothing is sent to sevDesk, and no contact is
created. A plain PDF without embedded XML is not an e-invoice and is refused; file it as a normal
receipt instead.

> Import it as a voucher on account 4930 for all rates.

[`sevdesk_voucher_import_einvoice`](../tools.md#sevdesk_voucher_import_einvoice) (`write`, no
confirmation) creates the draft voucher from the e-invoice with the original file attached. You
supply the booking account, one for all rates or one per rate. It refuses sums or VAT breakdowns
it cannot rely on and account and tax rule combinations sevDesk would reject. Keep the original
file: for an e-invoice the XML is the record to retain.

## Correct a draft

> The receipt recognition got the date wrong on voucher 5521. Save the receipt file so we can compare.

> Set the date of voucher 5521 to 3 November and the amount to 249.90 EUR gross.

[`sevdesk_voucher_receipt_save`](../tools.md#sevdesk_voucher_receipt_save) (`read`) saves the file
attached to a voucher into `SEVDESK_OUTPUT_DIR` (on a remote server: a download link), for example
to check what sevDesk's own receipt recognition read.
[`sevdesk_voucher_update_draft`](../tools.md#sevdesk_voucher_update_draft) (`write`, no
confirmation) changes supplier, dates, tax rule, positions or the file of a draft; new positions
replace all stored ones.

> Delete voucher draft 5530, it is a duplicate.

[`sevdesk_voucher_delete_draft`](../tools.md#sevdesk_voucher_delete_draft) (`commit`, **you
confirm**) deletes a draft that is not enshrined. Booked vouchers are never deleted.

> [!WARNING]
> Deleting a draft cannot be undone, and an attached receipt may go with it.

## Finalize

> Finalize the Shell voucher.

[`sevdesk_voucher_finalize`](../tools.md#sevdesk_voucher_finalize) (`commit`, **you confirm**)
books the voucher (Beleg verbuchen): from draft to open, so it counts in the profit and loss and
the VAT return from now on. It first checks what sevDesk would otherwise refuse late: a tax rule
that fits your VAT regulation, at least one position, and every account × rule × rate. While it is
not enshrined, [`sevdesk_voucher_reset`](../tools.md#sevdesk_voucher_reset) (`commit`, you
confirm) turns it back into a draft.

## Book the payment

> The Hetzner invoice was paid from the business account on 5 November. Book it.

[`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment) (`commit`, **you
confirm**) books a gross amount on a payment account: money out for an expense, money in for a
revenue voucher. For an account fed by a bank import the assistant links the imported transaction,
so it is not counted twice. Skonto and bank fees settle the voucher with less; more than the open
amount is refused unless you say the difference is intended. Only open or partially paid vouchers
can be paid; finalize a draft first. A wrong payment is undone with `sevdesk_voucher_reset` to
`open`.

From the bank side, the [`bank_reconciliation`](../tools.md#bank_reconciliation) prompt matches
unbooked transactions to vouchers by Belegnummer and amount and books each match you agree to with
[`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book) (`commit`). A bank fee with no
receipt yet gets a voucher first, then the transaction is booked to it.

## Enshrine

> Enshrine the vouchers of the third quarter.

[`sevdesk_voucher_enshrine`](../tools.md#sevdesk_voucher_enshrine) (`commit`, **you confirm**)
locks one finalized voucher permanently (festschreiben, GoBD), one confirmation per voucher. After
that it can never be changed, reset or deleted; a correction needs a new voucher.

> [!WARNING]
> Enshrining is irreversible. Decide with your Steuerberater when a period is locked.

## Related

- [Invoices](invoices.md): the outgoing side, from draft to payment.
- [Reports and exports](evaluations.md): payables aging, VAT summary, DATEV export with receipts.
- [Glossary](../glossary.md): Beleg, Steuerregel, Buchungskonto and the other German terms.
