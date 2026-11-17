# Invoices: from draft to payment

This guide follows an outgoing invoice (Rechnung) through sevDesk with the assistant: draft, check,
finalize, send, book the payment, remind, and correct. It is for anyone who bills customers. Each
step names what you ask, the tool that runs, the [tier](../permissions.md#tiers) it needs and
whether you confirm it.

## Overview

| Step                                   | Tool                                                                                                                                                                     | Tier              | You confirm     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------- |
| [Find the customer](#before-you-start) | [`sevdesk_contacts_search`](../tools.md#sevdesk_contacts_search)                                                                                                         | `read`            | no              |
| [Create a draft](#create-a-draft)      | [`sevdesk_invoice_create_draft`](../tools.md#sevdesk_invoice_create_draft), [`sevdesk_invoice_create_from_order`](../tools.md#sevdesk_invoice_create_from_order)         | `write`           | no              |
| [Check it](#check-the-draft)           | [`sevdesk_invoice_get`](../tools.md#sevdesk_invoice_get), [`sevdesk_invoice_pdf`](../tools.md#sevdesk_invoice_pdf)                                                       | `read`            | no              |
| [Change it](#check-the-draft)          | [`sevdesk_invoice_update_draft`](../tools.md#sevdesk_invoice_update_draft)                                                                                               | `write`           | no              |
| [Delete it](#delete-a-draft)           | [`sevdesk_document_delete_draft`](../tools.md#sevdesk_document_delete_draft)                                                                                             | `commit`          | **yes**         |
| [Finalize](#finalize)                  | [`sevdesk_invoice_finalize`](../tools.md#sevdesk_invoice_finalize)                                                                                                       | `commit`          | **yes**         |
| [Send by email](#send-it)              | [`sevdesk_invoice_send_email`](../tools.md#sevdesk_invoice_send_email)                                                                                                   | `external`        | **yes**         |
| [Book the payment](#book-the-payment)  | [`sevdesk_invoice_book_payment`](../tools.md#sevdesk_invoice_book_payment)                                                                                               | `commit`          | **yes**         |
| [Remind](#remind-overdue-customers)    | [`sevdesk_invoice_create_reminder`](../tools.md#sevdesk_invoice_create_reminder)                                                                                         | `write`           | no              |
| [Correct](#cancel-or-correct)          | [`sevdesk_invoice_cancel`](../tools.md#sevdesk_invoice_cancel), [`sevdesk_credit_note_create_from_invoice`](../tools.md#sevdesk_credit_note_create_from_invoice)         | `commit`, `write` | cancel: **yes** |
| [Enshrine](#enshrine)                  | [`sevdesk_invoice_enshrine`](../tools.md#sevdesk_invoice_enshrine)                                                                                                       | `commit`          | **yes**         |
| [Bill on a schedule](#recurring)       | [`sevdesk_invoice_create_recurring`](../tools.md#sevdesk_invoice_create_recurring)                                                                                       | `commit`          | **yes**         |
| [Change a template](#recurring)        | [`sevdesk_invoice_update_recurring`](../tools.md#sevdesk_invoice_update_recurring)                                                                                       | `commit`          | **yes**         |
| [End or restart it](#recurring)        | [`sevdesk_invoice_end_recurring`](../tools.md#sevdesk_invoice_end_recurring), [`sevdesk_invoice_reactivate_recurring`](../tools.md#sevdesk_invoice_reactivate_recurring) | `commit`          | **yes**         |

```mermaid
flowchart TD
  D[Draft, no number yet] -->|finalize or send by email| O[Open: numbered and binding]
  O -->|payment booked| P[Paid]
  O -->|cancel, unpaid only| S[Cancellation invoice SR]
  O -->|past its due date| M[Reminder draft MA]
  P -->|correct or refund| C[Credit note draft]
  O -->|enshrine| E[Enshrined, locked for good]
```

## Before you start

- **Tiers.** Drafts need `write`; finalizing, payments, cancelling, enshrining and recurring
  templates need `commit`; email needs `external`. Set them with `SEVDESK_ALLOW` ([Permissions](../permissions.md#tiers)).
- **Confirmations.** `commit` and `external` calls show you a preview first. Check that your
  client can show it ([Clients](../clients.md#confirmations-by-client)).
- **Dry runs.** Every step that changes something can run as a [dry run](../permissions.md#dry-run)
  first. Ask for one whenever you want to see the result before it is saved.
- **The customer.** The assistant looks the contact up by name or customer number. If there is
  none, it can create one with [`sevdesk_contact_create`](../tools.md#sevdesk_contact_create)
  (`write`), which checks for duplicates first.

> Find the customer Musterfirma GmbH and show me their billing address.

## Create a draft

### From scratch

> Draft an invoice for Musterfirma GmbH: 8 hours of consulting at 95 EUR net per hour, payable within 14 days.

[`sevdesk_invoice_create_draft`](../tools.md#sevdesk_invoice_create_draft) (`write`, no
confirmation) saves a draft with its positions. Nothing is sent and no invoice number is assigned
yet; sevDesk numbers the invoice when it is finalized. Unless you say otherwise, the draft uses
today's date as invoice and delivery date, net prices, EUR, the contact's invoice address and the
tax rule that fits your account: 1 for regular VAT (rates 0, 7 and 19 %), 11 for a Kleinunternehmer
(0 %). A tax rule or rate that does not fit the account is refused before anything is saved, and
the preview warns about a possible duplicate. If the account has several sevDesk users, the
assistant has to name one as contact person.

> Which tax rule does an invoice for consulting to Wiener Muster GmbH in Vienna take?

For a customer abroad, or a sale that is not plain domestic,
[`sevdesk_tax_rule_suggest`](../tools.md#sevdesk_tax_rule_suggest) (`read`) suggests the tax rule
from the customer's country, whether it buys as a business, its VAT ID (USt-IdNr.) and whether you
sell goods or services: the rule, the rate (for One-Stop-Shop sales the customer country's
standard rate), the note the invoice must carry (for example "Steuerschuldnerschaft des
Leistungsempfängers") and the legal basis. When a threshold or a special kind of service decides,
it lists each option with its condition instead of guessing. Northern Ireland follows the EU rules
for goods (pass country `XI` or the customer's XI VAT ID), Monaco counts as France, and parts of
member states outside the EU VAT area, such as the Canary Islands, come as exceptions (Heligoland
and Büsingen, for a German customer, as a note). It is not tax advice.
[`sevdesk_vat_id_check`](../tools.md#sevdesk_vat_id_check) (`read`) checks a VAT ID's format; it
asks the European Commission's VIES service only if the server's operator switched that on
(`SEVDESK_VIES_CHECK`, see [Privacy](../../PRIVACY.md)). The draft preview also warns when the tax
rule is not the usual one for the customer; it never refuses the draft for that.

A position can link a part (Artikel) from [`sevdesk_parts_list`](../tools.md#sevdesk_parts_list),
but its name and price still come from the position.

> Put it on cost centre Munich.

The draft can carry a cost centre (Kostenstelle) of your account, named by its id, number or name;
[`sevdesk_reference_lookup`](../tools.md#sevdesk_reference_lookup) with kind `cost_centres` lists
them. A name or number the account does not have, or one that fits several cost centres, is
refused before anything is saved. An update that does not name a cost centre keeps the stored one;
`removeCostCentre` takes it off the draft again, and the preview names the one removed.

### A discount on the whole invoice

> Give Musterfirma 3 % off the whole invoice.

Besides a discount per position, a draft can carry one discount on the whole document (Rabatt auf
den Gesamtbetrag): a percentage of the net total or a fixed net amount in EUR, with the text
printed next to it ("Rabatt" unless you name another). The preview shows it and the total it
leads to; the result shows what sevDesk deducted. Offers, order confirmations and credit notes take
the same discount. For now the server sets one only on net prices with a single tax rate, and not
on an e-invoice: sevDesk's handling of the other cases is not verified yet, and the tools say so
instead of guessing. Changing the draft later keeps the discount unless you replace it or remove
it. A document with several discounts (sevDesk's totals then count only one of them) is left to
the sevDesk web app, and the get tools and the approval warn about it.

### An English invoice on another letterhead

> Make the Musterfirma invoice English and put it on our second letterhead.

[`sevdesk_document_set_layout`](../tools.md#sevdesk_document_set_layout) (`commit`, **you
confirm**) sets the language (Sprache), template (Vorlage) or letterhead (Briefpapier) of a draft
invoice, offer, order confirmation, delivery note or credit note. Languages: German (Germany,
Austria, Switzerland), English, Spanish, French, Italian and Greek, as `de_DE`, `de_AT`, `de_CH`,
`en_US`, `es_ES`, `fr_FR`, `it_IT`, `el_GR`. Templates and letterheads are named by id or name;
[`sevdesk_reference_lookup`](../tools.md#sevdesk_reference_lookup) lists them (`kind`
`templates` with `documentType`, `letterpapers`). The preview shows the current and the new
choice; a language, template or letterhead sevDesk does not offer for the document is refused
before anything is sent. Each choice goes to sevDesk on its own, and the result says what sevDesk
stored. Other print options (a payment QR code, fold lines and the like) stay as they are.

It asks you, although it only touches drafts, because sevDesk's endpoint for it would also change
a document that was already sent; the server keeps that endpoint at the `commit` tier. The finalize
and send approvals show the layout again.

Head and foot texts can come from your text templates (Textvorlagen): name one as
`headTextTemplate` or `footTextTemplate` of the draft tools. Invoices take the invoice templates,
offers, order confirmations and delivery notes the offer templates (sevDesk keeps no others for
orders); credit notes are not offered yet.

> Use our English foot text template for the invoice.

### Offers: accept, confirm, deliver

Before an offer (Angebot) is invoiced, the assistant can record the customer's answer and create
the documents that follow it:

> Musterfirma accepted offer AN-1042 by phone. Mark it as accepted.

> They declined AN-1043.

[`sevdesk_order_set_offer_status`](../tools.md#sevdesk_order_set_offer_status) (`commit`, **you
confirm**) marks a sent offer as accepted (angenommen) or rejected (abgelehnt), or sets an accepted
or rejected offer back to sent (`reopen`). It changes nothing but the status and sends nothing to
the customer. Offer drafts are refused (send them first: sevDesk would renumber a draft), and so are
order confirmations and delivery notes.

> Create the order confirmation for AN-1042.

[`sevdesk_order_create_confirmation`](../tools.md#sevdesk_order_create_confirmation) (`commit`,
**you confirm**) creates an order confirmation (Auftragsbestätigung, AB) draft with the offer's
contact, texts and positions, which the preview lists. sevDesk marks the offer as accepted in the
same step, which is why you confirm it. It takes sent and accepted offers only: a draft is refused
(it would accept an offer the customer never received), and a rejected offer must be reopened
first, so turning a rejection into an acceptance is always a step of its own.

> Create a delivery note for AB-1007.

[`sevdesk_order_create_delivery_note`](../tools.md#sevdesk_order_create_delivery_note) (`write`,
no confirmation) creates a delivery note (Lieferschein, LI) draft from an order confirmation (draft,
sent or accepted) or from an offer that was sent or accepted, and leaves the source as it is. Offer
drafts and rejected offers are refused.

The confirmation tool refuses a second confirmation from the same offer unless you ask for one. The
delivery note tool refuses only while an earlier delivery note from the same order is still a
draft, because a further delivery note can be a partial delivery; finalized ones are named in its
preview. The new draft is finalized with
[`sevdesk_order_finalize`](../tools.md#sevdesk_order_finalize). Both previews also list discounts
or surcharges on the whole source document; whether sevDesk takes them over has not been checked,
so compare the new draft's totals before finalizing it. sevDesk gives the new document the next
number of its range without moving the counter, so it can carry a number another confirmation or
delivery note already has; the result names any it finds. To find offers that are still open, ask
for sent offers in a date range ([`sevdesk_orders_list`](../tools.md#sevdesk_orders_list)). The
[`offer_follow_up`](../tools.md#offer_follow_up) prompt does that for offers older than a number
of days (14 by default) and goes through each with you: accepted or rejected, the order
confirmation, the delivery note, the invoice, or a follow-up message you send yourself.

### From an offer or order confirmation

> Turn offer AN-1042 into an invoice.

> Create a 30 % advance invoice for order confirmation AB-1007.

[`sevdesk_invoice_create_from_order`](../tools.md#sevdesk_invoice_create_from_order) (`write`, no
confirmation) copies the positions of an offer (Angebot) or order confirmation
(Auftragsbestätigung): the whole order, a partial invoice (Teilrechnung) or an advance invoice
(Abschlagsrechnung) for a percentage or an amount, net or gross. The order must be sent, accepted
or partially invoiced; partial and advance invoices need tax rule 1 or 11. sevDesk also copies the
order's discount on the whole document; the preview shows it, and the result shows the invoice's.
If a draft from the same order already exists, the tool refuses unless you ask for a second one.
Offers themselves are
drafted with [`sevdesk_order_create_draft`](../tools.md#sevdesk_order_create_draft).

## Check the draft

> Show me the draft invoice for Musterfirma with all positions and the total.

> Open the PDF of that draft.

[`sevdesk_invoice_get`](../tools.md#sevdesk_invoice_get) returns positions, a discount on the whole
invoice, totals, tax rule, address and payment terms;
[`sevdesk_invoice_pdf`](../tools.md#sevdesk_invoice_pdf) returns the
PDF as a preview that never marks the invoice as sent. Both are `read`. To keep a copy on disk,
[`sevdesk_document_save`](../tools.md#sevdesk_document_save) writes it into `SEVDESK_OUTPUT_DIR`
([Configuration](../configuration.md)).

> Change the payment term to 30 days and add a line for travel costs, 120 EUR net.

[`sevdesk_invoice_update_draft`](../tools.md#sevdesk_invoice_update_draft) (`write`, no
confirmation) changes only the fields you name. New positions replace all stored positions, so
the assistant passes the full list. A new discount replaces the stored one, and "remove the
discount" deletes it. Only drafts can be changed.

### Delete a draft

> Delete the draft invoice for Musterfirma, it went to the wrong customer.

[`sevdesk_document_delete_draft`](../tools.md#sevdesk_document_delete_draft) (`commit`, **you
confirm**) deletes a draft with its positions; the same tool deletes order and credit note drafts.
The preview names the document (number, customer, date, total); if the draft changes before you
approve, you are asked again. Only drafts (status 100) are deleted: a finalized invoice stays in
the books and is cancelled or corrected with a credit note instead, and recurring invoice
templates are not deleted here (they are [ended](#recurring)).

Mind the number range. Orders and credit notes take their number when the draft is saved; after
the deletion sevDesk gives that number to the next document only if it was the last one handed
out, otherwise the range keeps a gap. An invoice draft normally has no number yet. One that has
a number may be an invoice that was finalized and later reset to draft; if that number was
issued, deleting the draft leaves a gap in the invoice numbers, so the preview warns (more
strongly when sevDesk records the invoice as sent). An issued invoice is cancelled instead:
finalize it again, then cancel it with
[`sevdesk_invoice_cancel`](../tools.md#sevdesk_invoice_cancel). On accounts where sevDesk
enshrines documents when they are finalized (the setting "Automatische Festschreibung von
Dokumenten bei Fertigstellung"), an issued invoice cannot become a draft again: sevDesk refuses
to reset or delete an enshrined invoice.

> [!WARNING]
> A deletion cannot be undone.

### E-invoice readiness

> Can this invoice go out as an XRechnung? Check what is missing.

[`sevdesk_invoice_einvoice_preflight`](../tools.md#sevdesk_invoice_einvoice_preflight) (`read`)
checks your company data, the customer (address, e-mail, Leitweg-ID for public bodies, VAT ID
where the tax rule needs it), the delivery date, payment terms, units and tax rule, and names the
tool that fixes each problem. For a finalized invoice it also checks the XML sevDesk generated.

> [!NOTE]
> The server cannot turn an invoice into an e-invoice. sevDesk generates XRechnung and ZUGFeRD
> only for invoices created as e-invoices (E-Rechnung) in the sevDesk web app; the preflight says
> so when that is missing.

## Finalize

> Finalize the Musterfirma invoice; I'll send the PDF myself.

[`sevdesk_invoice_finalize`](../tools.md#sevdesk_invoice_finalize) (`commit`, **you confirm**)
turns the draft into an open invoice: sevDesk assigns the final number, books it and marks it as
sent. Nothing reaches the customer; the tool only records how you send it (PDF download by
default, or post, print, email outside sevDesk). Before you approve, the preview lists what the
invoice says as sevDesk stores it: address, head and foot text, every position, a discount on the
whole invoice, terms and dates, and its language, template and letterhead. If any of it changes
while you decide, you are asked again.

> [!WARNING]
> Finalizing makes the invoice legally binding under its number. Afterwards it can only be reset
> to a draft while it has no payments and is not enshrined, and an invoice the customer already
> received should be cancelled or corrected with a credit note instead.

## Send it

> Email the invoice to buchhaltung@musterfirma.de with a short thank-you note.

[`sevdesk_invoice_send_email`](../tools.md#sevdesk_invoice_send_email) (`external`, **you
confirm**) lets sevDesk send the PDF to one recipient, with up to 10 cc and 10 bcc, and marks the
invoice as sent. The preview shows every recipient, the subject and the full text. A draft is
finalized by sending it, which also needs the `commit` tier. For an e-invoice the assistant can
attach the XML instead of the PDF.

> [!WARNING]
> An email cannot be recalled. Check the recipient and the text in the preview before you approve.

To send it your own way, take the PDF ([`sevdesk_invoice_pdf`](../tools.md#sevdesk_invoice_pdf))
or, for an e-invoice, the XML ([`sevdesk_invoice_xml`](../tools.md#sevdesk_invoice_xml)), and
finalize with the matching send type. The server does not send letters by post.

## Book the payment

> Musterfirma paid RE-1001 yesterday; book it on the business account.

> RE-1003 was paid with 2 % Skonto. Book the payment and write off the rest.

[`sevdesk_invoice_book_payment`](../tools.md#sevdesk_invoice_book_payment) (`commit`, **you
confirm**) books a gross amount on a payment account. For an account fed by a bank import, the
assistant links the imported transaction, so the payment is not counted twice. It refuses more
than the open amount unless the extra is reminder charges or another intended difference; Skonto
and bank fees settle the invoice with less. A wrong booking is undone with
[`sevdesk_invoice_reset`](../tools.md#sevdesk_invoice_reset) to `open` (`commit`, you confirm).

Many payments are easier from the bank side: the
[`bank_reconciliation`](../tools.md#bank_reconciliation) prompt matches unbooked transactions to
open invoices with [`sevdesk_reconcile_suggest`](../tools.md#sevdesk_reconcile_suggest) and books
each match you agree to with [`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book)
(`commit`).

## Remind overdue customers

> Which invoices are overdue, and by how many days?

> Prepare payment reminders for the invoices more than 14 days overdue.

[`sevdesk_invoices_list`](../tools.md#sevdesk_invoices_list) with `overdueOnly` and
[`sevdesk_receivables_aging`](../tools.md#sevdesk_receivables_aging) find them (`read`).
[`sevdesk_invoice_create_reminder`](../tools.md#sevdesk_invoice_create_reminder) (`write`, no
confirmation) creates a reminder draft (Mahnung, type MA) for an open or partially paid invoice
past its due date, and refuses a second unsent one. On Update 2.0 it adds no reminder fee. The
reminder is then finalized (`commit`) or emailed (`external`) like an invoice, with your
confirmation. The [`dunning_run`](../tools.md#dunning_run) prompt walks through the whole run,
and first rules out payments that are not booked yet.

## Cancel or correct

> Cancel invoice RE-1004, it was issued to the wrong customer.

[`sevdesk_invoice_cancel`](../tools.md#sevdesk_invoice_cancel) (`commit`, **you confirm**) lets
sevDesk create a cancellation invoice (Stornorechnung, type SR) with negated amounts that offsets
the original; both stay in the books. Only open, unpaid invoices can be cancelled. Send the
cancellation to the customer with `sevdesk_invoice_send_email`.

> [!WARNING]
> A cancellation cannot be undone.

> Musterfirma already paid RE-1002 but one position was wrong. Create a credit note for it.

For a paid or partially paid invoice,
[`sevdesk_credit_note_create_from_invoice`](../tools.md#sevdesk_credit_note_create_from_invoice)
(`write`, no confirmation) creates a credit note draft (Gutschrift) with all its positions.

> In that credit note, keep only the wrong position and credit 40 EUR net for it.

[`sevdesk_credit_note_update_draft`](../tools.md#sevdesk_credit_note_update_draft) (`write`, no
confirmation) adjusts the draft like the invoice update: it changes only the fields you name, and
new positions replace all stored positions. The credit note keeps its number and the invoice it
reduces; its positions may only use that invoice's tax rates, and its contact and currency stay
the invoice's. A cost centre is set or removed as on an invoice (`costCentre`,
`removeCostCentre`). Only drafts can be changed. The credit note is finalized with
[`sevdesk_credit_note_finalize`](../tools.md#sevdesk_credit_note_finalize) or emailed with
[`sevdesk_credit_note_send_email`](../tools.md#sevdesk_credit_note_send_email), and a refund is
booked with [`sevdesk_credit_note_book_payment`](../tools.md#sevdesk_credit_note_book_payment), each
with your confirmation.

## Enshrine

> Enshrine all invoices of October; the VAT return is filed.

[`sevdesk_invoice_enshrine`](../tools.md#sevdesk_invoice_enshrine) (`commit`, **you confirm**)
locks one finalized invoice permanently (festschreiben, GoBD), so a batch means one confirmation
per invoice. Payments can still be booked, but the
invoice can never be changed, reset or deleted again; corrections then need a cancellation or a
credit note. When to enshrine is a question for you and your Steuerberater.

> [!WARNING]
> Enshrining is irreversible. The preview carries an irreversibility warning; approve it only for
> invoices you are sure about.

## Recurring

> Bill Musterfirma GmbH 500 EUR net for website maintenance every month, starting on 1 January.

[`sevdesk_invoice_create_recurring`](../tools.md#sevdesk_invoice_create_recurring) (`commit`,
**you confirm**) creates a recurring invoice template (Abo-Rechnung, type WKR) for retainers, rent
or subscriptions. Customer, positions, texts, payment term and tax rule work as for a draft and
pass the same checks; the template is in EUR, and its total must be above zero. The schedule has:

- an **interval**: monthly, quarterly, half-yearly or yearly;
- a **start date**, the first run: today or later, at most a year ahead, on day 1 to 28 of a
  month. Every later run falls on the same day of the month. Days 29 to 31 are refused, because
  how sevDesk moves a run into a shorter month is not recorded. A start in the past is refused too:
  sevDesk catches up and creates an invoice for every period since then, one a minute;
- an optional **end date**, at most ten years after the start. Without one, the template runs until
  it is ended.

**Automatic generation** (Automatische Generierung) decides whether anything happens on a run date,
not the template's status. The tool switches it on unless you ask for it off:

- **On** (the default): on every run date, within about a minute after midnight (Berlin time),
  sevDesk creates a **draft** invoice from the template by itself. The draft is dated the day it
  is created, has the run date as its delivery date and the billing period up to the day before the
  next run, and sevDesk adds a line naming that period to the head text. It is not finalized and
  not sent. Its number is provisional: several generated drafts can show the same number, and each
  gets its own when it is finalized. Check a generated draft, then finalize and send it like any
  other ([Finalize](#finalize), [Send it](#send-it)). A first run today is due at once: the first
  draft appears about a minute after saving.
- **Off**: sevDesk creates nothing by itself, until automatic generation is switched on for the
  template ([below](#change-end-or-restart-a-template), or in the sevDesk web app) or someone
  clicks "Rechnung erzeugen" in the web app.

The preview shows what every invoice will say: customer and address, each position with its text,
head and foot text, the total per invoice. It also shows the first run, the next three run dates,
the end with the number of runs up to it, whether automatic generation is on and what that means,
and a warning when the customer already has a template with the same total. After saving, the
assistant reads the template back and says where sevDesk stored another schedule or another
automatic generation than it sent.

> [!WARNING]
> sevDesk can also send generated invoices by itself: with **automatic sending** (Automatisches
> Versenden) on as well, it finalizes each one with its final number, e-mails it with the PDF to
> the customer and enshrines it within about two minutes of the run, before anyone has seen it.
> This server never switches automatic sending on, and its read-back tells you when a template has
> it. Switch it on in the web app only if that is what you want.

The web app's "Nachfällig" option (bill in arrears) is not set by this server either, and its
other intervals (7 or 14 days, 2 months, 2 to 5 years) are not offered.

Templates are listed with [`sevdesk_invoices_list`](../tools.md#sevdesk_invoices_list) and type
`recurring`. Each row, and [`sevdesk_invoice_get`](../tools.md#sevdesk_invoice_get), shows the
schedule as sevDesk stores it: interval (also one made in the web app, in words), start, next run,
end, last run, whether automatic generation and automatic sending are on, and whether the template
is ended.

### Change, end or restart a template

> Raise the Musterfirma maintenance to 550 EUR net from the next invoice on.

[`sevdesk_invoice_update_recurring`](../tools.md#sevdesk_invoice_update_recurring) (`commit`,
**you confirm**) changes a template: positions (given positions replace all of them), texts,
payment term, tax rule, customer or address, the schedule, and automatic generation
(`autoGenerate`). Only what you give changes. The preview shows each change as before → after, new
positions and texts in full, the total per invoice before and after, and the run dates after the
change. Every invoice sevDesk creates afterwards carries the change; invoices it already created
stay as they are. On a run day, the preview warns that a draft sevDesk already created that day
keeps the old content.

- A new **interval** keeps the next run date; the runs after it follow the new interval.
- A new **start date** becomes the next run as well, and sevDesk clears the template's last run.
  It must lie after today and, once the template has generated invoices, after the end of the
  period of the newest one; otherwise sevDesk would bill a period again. The assistant finds those
  invoices by their origin, the template, and refuses when one of them has no delivery date,
  since its period cannot be told.
- A new **end date** lies on or after the next run; `removeEndDate` lets the template run until it
  is ended. With automatic generation on and a next run before today and after the end date (a
  template that stopped at its end date), removing the end date or moving it is refused: sevDesk
  could catch up the missed periods. Give a new start date in the same call.
- Switching **automatic generation on** is refused while the next run lies before today: sevDesk
  would catch up and create one draft per missed period, a minute apart. Give a new start date in
  the same call. A next run today is due at once, or at its stored time of day for a template made
  in the web app.
- A **discount on the whole document** (Rabatt) on the template stays as it is; the change never
  sets one. With new positions the total per invoice counts it where that is recorded (one net
  discount, net prices, one tax rate), else sevDesk computes the total. Whether sevDesk keeps the
  discount when every position is replaced is not recorded, so the preview says so.

After saving, the assistant reads the template back and names every way sevDesk stored something
else, including a position whose change sevDesk ignored, a switch that did not take and a discount
that is no longer there.

> End the Musterfirma maintenance subscription.

[`sevdesk_invoice_end_recurring`](../tools.md#sevdesk_invoice_end_recurring) (`commit`, **you
confirm**) ends a template (status 50): sevDesk creates no further invoice from it, even with
automatic generation on. Invoices it already created stay as they are; a wrong one is cancelled
with [`sevdesk_invoice_cancel`](../tools.md#sevdesk_invoice_cancel). The template keeps its
positions, schedule and automatic generation, and
[`sevdesk_invoice_reactivate_recurring`](../tools.md#sevdesk_invoice_reactivate_recurring)
(`commit`, **you confirm**) starts it again. Its preview says what happens then: with automatic
generation on, sevDesk generates drafts again, the first at once if the next run is today (at its
stored time of day for a template made in the web app); with it
off, reactivating alone generates nothing. With it on, reactivating is refused while the next run
lies before today, because sevDesk would catch up the missed periods at once: give the template a
new start date first.

> [!WARNING]
> A template with **automatic sending** on is only ended through this server: ending stops the
> e-mails. Changing or reactivating it is refused, because sevDesk would finalize, e-mail and lock
> invoices from it with no further approval; manage such a template in the sevDesk web app. When
> sevDesk does not return its settings, changing and reactivating are refused as well.

Templates made in the web app work too, also with an interval this server does not offer (such as
weekly or every two months): they can be ended, and changed as long as the interval stays; where
their run dates cannot be computed, the preview says so.

A template is deleted only in the sevDesk web app (Abo-Rechnungen); ending it is the reversible
way. The other invoice tools refuse a template: it is never finalized, sent, paid, cancelled,
changed as a draft or deleted through them. An invoice sevDesk creates from a template is a
regular draft and is not refused because of its template.

## Related

- [Receipts and vouchers](receipts.md): the other direction, supplier invoices and receipts.
- [Reports and exports](evaluations.md): open receivables, the VAT summary, the DATEV export.
- [Glossary](../glossary.md): German terms such as Rechnung, Storno and Mahnung.
