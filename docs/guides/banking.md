# Banking and cash

This guide covers the money on your payment accounts (Zahlungskonten): which account takes what,
recording a cash sale or expense on the cash register (Kasse), entering a bank transaction by hand,
booking transactions to documents, deleting or locking (enshrining) a transaction, and the rules
that mark transactions private. Each step names what you ask, the tool, the
[tier](../permissions.md#tiers) and whether you confirm.

## Overview

| Step                                                            | Tool                                                                                                                                                                                               | Tier             | You confirm      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| [See accounts and balances](#which-account-takes-what)          | [`sevdesk_bank_accounts_list`](../tools.md#sevdesk_bank_accounts_list), [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position)                                                               | `read`           | no               |
| [Create an account](#which-account-takes-what)                  | [`sevdesk_bank_account_create`](../tools.md#sevdesk_bank_account_create)                                                                                                                           | `write`          | no               |
| [Record a cash sale or expense](#record-a-cash-sale-or-expense) | [`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment), [`sevdesk_invoice_book_payment`](../tools.md#sevdesk_invoice_book_payment)                                             | `commit`         | **yes**          |
| [Enter a transaction by hand](#enter-a-transaction-by-hand)     | [`sevdesk_transaction_create`](../tools.md#sevdesk_transaction_create)                                                                                                                             | `commit`         | **yes**          |
| [Book transactions to documents](#book-transactions)            | [`sevdesk_reconcile_suggest`](../tools.md#sevdesk_reconcile_suggest), [`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book)                                                           | `read`, `commit` | booking: **yes** |
| [Delete a transaction](#delete-a-transaction)                   | [`sevdesk_transaction_delete`](../tools.md#sevdesk_transaction_delete)                                                                                                                             | `commit`         | **yes**          |
| [Enshrine a transaction](#enshrine-a-transaction)               | [`sevdesk_transaction_enshrine`](../tools.md#sevdesk_transaction_enshrine)                                                                                                                         | `commit`         | **yes**          |
| [See the private-transaction rules](#private-transaction-rules) | [`sevdesk_private_transaction_rules_list`](../tools.md#sevdesk_private_transaction_rules_list)                                                                                                     | `read`           | no               |
| [Create or delete a rule](#private-transaction-rules)           | [`sevdesk_private_transaction_rule_create`](../tools.md#sevdesk_private_transaction_rule_create), [`sevdesk_private_transaction_rule_delete`](../tools.md#sevdesk_private_transaction_rule_delete) | `commit`         | **yes**          |

The [`bank_reconciliation`](../tools.md#bank_reconciliation) prompt walks through the booking
steps, with a dry run before each change.

## Which account takes what

> Which payment accounts do I have, and what is on them?

[`sevdesk_bank_accounts_list`](../tools.md#sevdesk_bank_accounts_list) lists every account with
its balance; [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position) adds the totals per
currency. Where the transactions of an account come from depends on its kind:

| Account                                                     | Its transactions come from                                    | Entered by hand                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Bank account connected to a bank or PayPal                  | the bank: sevDesk imports them                                | no                                                            |
| File-import account (Dateiimport-Konto, `fileImport: true`) | CSV files you import, or entered by hand                      | yes, `sevdesk_transaction_create`                             |
| Clearing account (Verrechnungskonto)                        | payments booked on documents: sevDesk creates the transaction | no: book the payment on the document                          |
| Cash register (Kasse)                                       | payments booked on documents: sevDesk creates the cash entry  | no: [book it on the document](#record-a-cash-sale-or-expense) |

[`sevdesk_bank_account_create`](../tools.md#sevdesk_bank_account_create) (`write`) creates a
file-import or a clearing account. A cash register is set up in the sevDesk web app; the API cannot
create one.

## Record a cash sale or expense

> I sold goods for 23.80 EUR in cash today. The revenue voucher is 2101.

sevDesk takes no hand-made transaction on a cash register. A cash sale or a cash expense is a
payment booked on its document against the register:

1. File the receipt as a voucher (revenue or expense) and finalize it, as in the
   [Receipts guide](receipts.md); for a sale with an invoice, use the invoice.
2. Book the payment with [`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment)
   (or [`sevdesk_invoice_book_payment`](../tools.md#sevdesk_invoice_book_payment)), with the cash
   register as `checkAccountId` and without `transactionId`.

sevDesk then adds the entry to the cash book (Kassenbuch) itself, signed by the document's
direction, and the register's balance moves: on the trial account it went from 500.00 to 511.90
after a cash sale of 23.80 and a cash expense of 11.90.
[`sevdesk_cash_position`](../tools.md#sevdesk_cash_position) shows the new balance.

To undo a cash payment, reset the document to open
([`sevdesk_voucher_reset`](../tools.md#sevdesk_voucher_reset)). On a cash register the entry is not
deleted: sevDesk books a counter-entry with the opposite amount, dated the day of the reset, so
the cash book shows both and the balance returns. The previews say so.

## Enter a transaction by hand

> Enter yesterday's transfer of 119.00 EUR from Musterfirma GmbH, purpose RE-1001, on my
> import account, and book it to invoice RE-1001.

[`sevdesk_transaction_create`](../tools.md#sevdesk_transaction_create) (`commit`) enters a
transaction on a file-import account: the date (default today), the amount with its direction
(`in` or `out`), the counterparty and the purpose (Verwendungszweck). With `allocations` it books
the new row to documents in the same confirmation, with the same guards as
[`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book).

- Every other account is refused before anything is sent, with what to do instead: on a cash
  register or a clearing account book the payment on the document; a bank-connected account gets
  its rows from the bank.
- The preview names rows of the same account and day with the same amount and purpose, so a
  transaction is not entered twice by mistake.
- If the booking fails after the row was created, the result names the new transaction (and any
  document booked before the failure); book the rest with `sevdesk_transaction_book` instead of
  calling the tool again.

## Book transactions

> Which open invoices could the transactions of last week pay?

[`sevdesk_reconcile_suggest`](../tools.md#sevdesk_reconcile_suggest) (`read`) ranks matches by
amount, the invoice number in the purpose, the counterparty and splits.
[`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book) (`commit`) books a transaction
to one or more documents. [`sevdesk_transaction_mark_private`](../tools.md#sevdesk_transaction_mark_private)
marks it as a Privatentnahme or Privateinlage, and
[`sevdesk_transaction_reset`](../tools.md#sevdesk_transaction_reset) undoes either.
[`sevdesk_transaction_get`](../tools.md#sevdesk_transaction_get) shows what a transaction is booked
to and what is left.

## Delete a transaction

> Delete transaction 5401, I entered it twice.

[`sevdesk_transaction_delete`](../tools.md#sevdesk_transaction_delete) (`commit`) deletes an
unbooked transaction (status 100) of a file-import account. A booked one needs
`sevdesk_transaction_reset` first, and so does a private one. An entry of a cash register or a
clearing account comes from a payment: undo the payment by resetting the document instead.

sevDesk only marks a deleted transaction: it leaves the transaction lists and the balance but
stays readable by its id. [`sevdesk_transaction_get`](../tools.md#sevdesk_transaction_get) then
reports it as deleted (`deleted: true`), and no tool books, changes or locks it any more. A delete
cannot be undone: if the transaction was needed after all, enter it again.

## Enshrine a transaction

> Enshrine transaction 5101.

[`sevdesk_transaction_enshrine`](../tools.md#sevdesk_transaction_enshrine) (`commit`) locks a
linked or booked transaction (status 200 or higher) for good (festschreiben, GoBD). It cannot be
undone: sevDesk then refuses every change to the transaction (no status change, no deletion, no
reset), and the documents it pays can no longer be reset to open, so their payment stays. The
documents themselves are not enshrined by it; their own enshrine tools do that. If a reset meets an
enshrined payment, the reset tools say so in their own words.

## Private-transaction rules

> Mark the payments to my landlord as private from now on.

sevDesk can mark bank transactions as private (Privatentnahme, Privateinlage) on its own, by a
rule: a text that a transaction's counterparty (Auftraggeber/Empfänger) or purpose
(Verwendungszweck) matches.
[`sevdesk_private_transaction_rules_list`](../tools.md#sevdesk_private_transaction_rules_list)
(`read`) lists the rules with their texts.
[`sevdesk_private_transaction_rule_create`](../tools.md#sevdesk_private_transaction_rule_create)
(`commit`) creates a rule with one text, `counterparty` or `purpose`, and
[`sevdesk_private_transaction_rule_delete`](../tools.md#sevdesk_private_transaction_rule_delete)
(`commit`) deletes one. Both are `commit` because a rule is meant to do on its own what
[`sevdesk_transaction_mark_private`](../tools.md#sevdesk_transaction_mark_private) does by hand.

**Where rules act, and what could not be tested.** sevDesk is expected to apply a rule when it
imports transactions from the bank. A trial account imports nothing: there, two rules changed none
of the existing open transactions, not even one entered by hand after the rules were created, and
deleting the rules changed nothing either. So how sevDesk matches a rule (the whole text or a part
of it, upper and lower case), and whether a CSV file import applies rules too, is not known.

**The estimate in the preview.** The create preview lists open transactions that look like what
the rule is meant for: up to ten of at most 500 open (unbooked) transactions whose counterparty or
purpose contains the text, ignoring case. It is the server's own estimate, labelled as one, not
sevDesk's matching, and creating the rule changes none of them. To mark one of them private now,
use `sevdesk_transaction_mark_private`.

The create tool refuses, before anything is sent:

- a rule with both texts: whether sevDesk then needs both to match or only one was not tested.
  Create one rule per text if either should mark a transaction private;
- a text with fewer than four letters or digits: a short text such as "AG" or "dm" occurs in a
  great many unrelated counterparties and purposes, and sevDesk is expected to mark every import
  a rule matches;
- a text that an existing rule already has (upper and lower case and extra spaces ignored); the
  refusal names that rule.

Deleting a rule leaves transactions that are already private as they are;
[`sevdesk_transaction_reset`](../tools.md#sevdesk_transaction_reset) sets one back. A rule cannot be
changed in place: delete it and create a new one. A corporation (GmbH, UG, AG) has no private
withdrawals or deposits, so such a rule does not belong in its books.

## Limits

- Bank-connected accounts could not be tested (a trial account has none): entering and deleting
  their transactions is refused.
- Private-transaction rules could not be tested where they act, on bank imports (see
  [above](#private-transaction-rules)).
- Renaming and archiving accounts are not covered yet.
