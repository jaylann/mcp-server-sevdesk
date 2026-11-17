# FAQ

Short answers to the questions people ask before and while using the server, each with a link
to the page that explains it in full.

## General

### Is this an official sevDesk product?

No. mcp-server-sevdesk is an unofficial open-source project and not affiliated with, endorsed by or
supported by sevdesk GmbH. It uses the public sevDesk API with your own API token.

### What does it cost?

Nothing; the code is under the [MIT license](../LICENSE). You need a sevDesk plan with API access
(Buchhaltung Pro; the free trial includes it) and an AI client that supports MCP. What your model
provider charges is between you and them.

### Which AI clients work?

Any MCP client: Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex, Zed and others over
stdio; claude.ai and the Claude mobile apps through a server you host in remote mode. Each client
has its own setup page, listed in [Clients](clients.md#client-pages).

### Does it replace my tax advisor?

No. Reports such as the VAT summary and the profit and loss are estimates built from your sevDesk
data, and are marked as such. The server helps you record, check and prepare; binding answers come
from your Steuerberater. Nothing it says is tax advice.

## Data and privacy

### Does the AI see my API token?

No. The token is in the server's configuration (or your keychain), never given to the model, and
redacted from every log line, error and audit entry. Because it has full access to the account,
create it for a dedicated sevDesk user.

### Where does my data go?

The server runs on your computer (or on your own server in remote mode) and talks only to the
sevDesk API. There are three exceptions: the DATEV export, which sevDesk delivers as a download
from its own storage (on Amazon S3), the VAT-ID check with VIES, the European Commission's
service, only if you switch it on with `SEVDESK_VIES_CHECK`, and a remote server in OAuth mode,
which fetches a connecting client's metadata document from the client's host. Results go to your
MCP client, and from there to your model provider: invoices,
contacts and bank transactions are then part of your conversation, under that provider's terms.
Accounting data contains personal data of your customers, so check your provider's
data-processing terms before you connect a live account.

The project runs no service and collects no telemetry. Details: [Privacy](../PRIVACY.md).

### Can the AI finalize or send invoices without me?

No. By default the server only reads. Finalizing, booking, cancelling and enshrining (`commit`)
and sending (`external`) must be enabled first, and then each call asks you, in the client or on
an approval page in your browser. The model cannot give that confirmation itself
([Permissions](permissions.md)).

### What happens if something goes wrong?

Every write is checked before anything is sent (status, amounts, tax rule and rate, booking
accounts, duplicates), never retried automatically, and read back from sevDesk afterwards. A dry
run shows what would happen without sending anything, and the optional audit log on your computer
records every step ([How a write runs](permissions.md#how-a-write-runs),
[Audit log](permissions/audit-log.md)). Finalized and enshrined documents cannot simply be deleted
in sevDesk, which is why those steps need your confirmation.

### Why is there no hosted version?

A hosted service would hold the API tokens of every user, and each token can do everything in its
account, with no scopes and no expiry. It would also see every user's accounting data and become
their data processor under the GDPR. Running the server yourself keeps your data between you,
sevDesk and your model provider. For claude.ai or a team you can host it yourself in
[remote mode](remote.md): on a small VM, a platform such as Fly.io, or your own machine.

### Can I use several sevDesk accounts?

Yes. Over stdio, add the server once per account under different names, or keep the accounts in a
profiles file and pick one with `SEVDESK_PROFILE`
([Profiles](configuration/profiles.md#profiles)). In OAuth remote mode one server serves every account you list in `SEVDESK_OAUTH_ACCOUNTS`.

## sevDesk features

### Which sevDesk plan do I need?

A plan with API access: sevDesk includes the API in Buchhaltung Pro, and the free trial has it.

### Does it support sevDesk Update 2.0?

Yes, and it is built for it. Update 2.0 replaced tax types with tax rules (Steuerregeln) and booking
accounts with DATEV accounts. The server detects the bookkeeping system per account, writes the
tax fields the account expects, and checks every tax rule × rate (and, for receipts, every booking
account) before anything is sent, because sevDesk itself accepts combinations it later refuses to
finalize.

Accounts still on the older system 1.0 can read everything and draft invoices, orders and credit
notes; voucher (Beleg) writes need Update 2.0.

### Does it work for Kleinunternehmer?

Yes. The server reads your VAT regulation from sevDesk. On a Kleinunternehmer account (§19 UStG)
new documents default to the small-business tax rule without VAT, and tax rules for regular VAT are
refused before anything is saved, because sevDesk would not finalize such documents.
`sevdesk_account_info` tells the assistant which regime applies.

### Can it give a discount on the whole invoice?

Yes, on invoice, offer, order confirmation and credit note drafts: a percentage of the net total or
a fixed net amount in EUR, with its text, set, replaced or removed with the draft tools
([A discount on the whole invoice](guides/invoices.md#a-discount-on-the-whole-invoice)). For now
only on net prices with a single tax rate and not on e-invoices, the cases verified against sevDesk.
Whatever discount a draft carries is shown in the approval before you finalize or send it, and an
invoice made from an offer takes over the offer's discount.

### Can it write an English invoice or use another letterhead?

Yes, on drafts of invoices, orders and credit notes: `sevdesk_document_set_layout` sets the
language (eight, among them English), the template (Vorlage) and the letterhead (Briefpapier)
([An English invoice on another letterhead](guides/invoices.md#an-english-invoice-on-another-letterhead)).
It needs the `commit` tier and your confirmation, because sevDesk uses the same request to change
finalized documents. Head and foot texts can come from your text templates (Textvorlagen) by name;
creating or deleting text templates stays in sevDesk. The approval before you finalize or send a
draft shows its language, template and letterhead.

### Can it handle e-invoices (E-Rechnung)?

Yes, both directions. Received XRechnung (UBL and CII) and ZUGFeRD / Factur-X files are parsed
locally, checked and imported as voucher drafts with the original file attached
([Import an e-invoice](guides/receipts.md#import-an-e-invoice)). Outgoing invoices can be checked
for e-invoice readiness before you finalize them, and the XML sevDesk generates can be fetched
([E-invoice readiness](guides/invoices.md#e-invoice-readiness)). Over stdio the files come from a
folder you allow (`SEVDESK_FILE_DIRS`); in remote mode you upload them through a page on your
server.

### Can sevDesk's own receipt recognition fill in a voucher?

Yes, for expense and revenue receipts. `sevdesk_voucher_recognize_receipt` sends the file to
sevDesk's receipt recognition (Belegerkennung), which creates a voucher draft and fills in date,
number, sums and a supplier text within seconds. Those values are unchecked, and the positions and
tax rates can be wrong even when the total is right (a receipt with two rates came back as one
position). The draft has no tax rule and no booking account yet: the assistant completes it with
the normal draft update before it can be finalized
([Let sevDesk read the receipt](guides/receipts.md#let-sevdesk-read-the-receipt)).

### Can it export to DATEV?

Yes. [`sevdesk_datev_export`](tools.md#sevdesk_datev_export) lets sevDesk build the DATEV
Buchungsstapel (CSV files in a ZIP) for a month, quarter, year or date range, saved in your output
folder or offered as a download link in remote mode. It never enshrines (festschreiben) the
documents and needs the DATEV settings in sevDesk (Beraternummer, Mandantennummer, start of the
fiscal year), which [`sevdesk_datev_settings_update`](tools.md#sevdesk_datev_settings_update) sets
after you confirm. With `format: "xml"` it exports the documents as DATEV XML with their receipt
images instead. [`sevdesk_csv_export`](tools.md#sevdesk_csv_export) saves sevDesk's CSV exports, for
example for Excel.

### Can I get all invoice or receipt PDFs at once, for the tax adviser or a tax audit?

Yes. [`sevdesk_archive_export`](tools.md#sevdesk_archive_export) lets sevDesk put the invoice PDFs
or the voucher receipts of a period into one ZIP, at most 500 documents by default (up to 1,000)
and 100 MiB per file, and changes nothing on the documents. sevDesk includes drafts (the result counts them so you can take
them out) and leaves out vouchers without a receipt file. A large archive takes minutes; a shorter
period is the remedy. Details: [Reports and exports](guides/evaluations.md#invoice-and-receipt-archive).

### How far can I rely on the VAT summary and the profit and loss?

They are estimates for checking, computed by the server from your documents; they are not
sevDesk's own reports and not a filing. Each result says what it left out. What they cover and
what they leave to you is in [Reports and exports](guides/evaluations.md#how-far-you-can-rely-on-them).

### Can it find receipts booked twice or bills that are missing?

Yes, as hints. `sevdesk_records_audit` with `check: duplicates` looks for vouchers booked twice
(the same supplier and document number, the same receipt file, or the same amount within a few
days) and for drafts left open for three weeks or more; `check: recurring_gaps` learns which
suppliers bill every month, quarter or year and names the periods without a bill, which usually
means a lost receipt. Both read your records only and change nothing. What they flag and what they
leave out on purpose is in [Reports and exports](guides/evaluations.md#audits).

### Can it tell which receipts in my folder were never booked?

Yes, when the server may read that folder (`SEVDESK_FILE_DIRS`: not on a remote server with
OAuth; in bearer mode only for folders on the server). `sevdesk_receipt_folder_check` compares
the SHA-256 checksums of the PDF, PNG, JPEG and XML files in the folder with those of the receipt
files attached to your vouchers, for a month, quarter or year. A file no voucher carries was
probably never booked; it is a hint, not proof, because the
same receipt as another file (a scan, a photo from the app) has another checksum, and a receipt
that sevDesk's recognition created from an upload has no checksum at all (the result counts those
and names any of the same size as a weak hint). The check reads no file content into the
conversation and uploads nothing
([Reports and exports](guides/evaluations.md#receipts-in-a-folder-that-were-never-booked)).

### Does it support sevDesk in Austria?

Not in 1.0. Tax rules, the VAT summary (UStVA boxes), the e-invoice checks and the bookkeeping
skill follow German law, and the server is tested only against German accounts. Reads may work on
an Austrian account, but nothing is verified there. Support for Austria is tracked for a later 1.x
release.

### Can it set up recurring invoices (Abo-Rechnungen)?

Yes. [`sevdesk_invoice_create_recurring`](tools.md#sevdesk_invoice_create_recurring) (`commit`
tier, you confirm) saves a recurring invoice template, monthly, quarterly, half-yearly or yearly,
with automatic generation on unless you ask for it off
([Recurring](guides/invoices.md#recurring)). sevDesk then creates a draft invoice from it on every
run date by itself, within about a minute: not finalized, not sent, with a provisional number that
becomes final when the draft is finalized. You check each draft and finalize and send it with the
usual invoice tools. The server never switches on sevDesk's automatic sending, which would finalize,
e-mail and enshrine every generated invoice before anyone sees it.
[`sevdesk_invoice_update_recurring`](tools.md#sevdesk_invoice_update_recurring) changes a template
(also its automatic generation),
[`sevdesk_invoice_end_recurring`](tools.md#sevdesk_invoice_end_recurring) ends one and
[`sevdesk_invoice_reactivate_recurring`](tools.md#sevdesk_invoice_reactivate_recurring) starts it
again, each `commit` tier with your confirmation. A template with automatic sending on is only
ended here; changing or reactivating it is left to the sevDesk web app. A template is deleted only
in the sevDesk web app.

### Can it handle offers, order confirmations and delivery notes?

Yes. Besides drafting offers (Angebote), it records the customer's answer (accepted or rejected,
`commit`), creates the order confirmation from an offer (`commit`, because sevDesk marks the offer
as accepted in that step) and a delivery note from a confirmation (`write`), and then the invoice
from the order ([Invoices](guides/invoices.md#offers-accept-confirm-deliver)). There is no special
filter for stale offers; ask for sent offers in a date range.

### Can it send letters by post?

Not in 1.0. Documents can be sent by email (`external` tier), and finalizing records how a document
was sent (for example by post), but the server does not use sevDesk's letter service.

### Does it cover stock (Lagerbestand)?

Yes. `sevdesk_part_get` reports the current stock when stock tracking is on, `sevdesk_parts_list`
and `sevdesk_part_get` show `stock` and `stockEnabled`, and `sevdesk_part_create` and
`sevdesk_part_update` set them. The sevDesk API has no other stock endpoints.

### Does it handle custom contact fields (Zusatzfelder)?

Yes, their values. `sevdesk_contact_get` shows a contact's custom fields with their names,
`sevdesk_contact_create` and `sevdesk_contact_update` set them (`customFields`, by the field's id
or name), `sevdesk_contact_update` removes a value (`remove` with kind `customField`), and
`sevdesk_contacts_search` finds contacts by a value (`customField`; the whole value, any case).
`sevdesk_reference_lookup` with kind `contact_custom_fields` lists the fields of your account.
The fields themselves are defined in the sevDesk web app: deleting a field there deletes its value
on every contact, so the server never creates, renames or deletes one.

### Can it group documents by project or customer (tags)?

Yes, with sevDesk's tags. `sevdesk_tags_list` lists the tags and how many invoices, credit notes,
orders and vouchers carry each. `sevdesk_invoices_list`, `sevdesk_credit_notes_list`,
`sevdesk_orders_list` and `sevdesk_vouchers_list` take a `tag` name and show only the documents
with that tag; an unknown name is refused instead of listing everything.
`sevdesk_document_tag` (`write` tier) adds a tag to one document or removes it, one document per
call. Tags are named, not numbered, and sevDesk compares names ignoring case and accents
("Café" is "cafe"): a name sevDesk does not know yet creates the tag, and removing a tag from its
last document deletes the tag in sevDesk; the preview says both.

### Can it book invoices and receipts on a cost centre (Kostenstelle)?

Yes. The create and update draft tools of invoices, vouchers and credit notes
(`sevdesk_invoice_create_draft`, `sevdesk_invoice_update_draft`, `sevdesk_voucher_create_draft`,
`sevdesk_voucher_update_draft`, `sevdesk_credit_note_create_draft`,
`sevdesk_credit_note_update_draft`) take a `costCentre`: its id, or its number or name as text,
compared ignoring case and accents. `sevdesk_reference_lookup` with kind `cost_centres` lists the
account's cost centres. An unknown name, or one that fits several cost centres, is refused before
anything is saved. `sevdesk_invoices_list`, `sevdesk_vouchers_list` and
`sevdesk_credit_notes_list` filter by cost centre
("this month's expenses on cost centre Munich"), the get tools show it, and the finalize approval
lists it. Orders take none: sevDesk accepts a cost centre on an order but does not keep it. An
update without `costCentre` keeps the stored one, and `removeCostCentre: true` on the three
update tools takes it off a draft. Managing the cost centres themselves is done in sevDesk.

### What did project X cost?

Ask for it: "What did project Website Relaunch cost this year?" or "Show this month's expenses for
cost centre Munich". `sevdesk_records_summarize` and `sevdesk_profit_and_loss` take a `tag` or a
`costCentre` and count only those documents; `groupBy` `tag` or `cost_centre` shows every project
or cost centre side by side. A name the account does not have is refused instead of answered with
the totals of all documents. A document with several tags counts for each of them, so tag groups
add up to more than the total, and the answer says so; cost centres, one per document, add up.
Details: [Reports and exports](guides/evaluations.md#by-project-tag-or-cost-centre).

## Support

### Where do I get help?

- **The server does not start, or a tool fails:** [Troubleshooting](troubleshooting.md), and
  [Troubleshooting remote mode](remote/troubleshooting.md) for a server you host.
- **Questions and setup help:** [GitHub Discussions](https://github.com/jaylann/mcp-server-sevdesk/discussions/categories/q-a).
- **Bugs and feature requests:** the [issue forms](https://github.com/jaylann/mcp-server-sevdesk/issues/new/choose).
  Include the server version (`npx -y mcp-server-sevdesk --version`), your client and the error
  text, never your token or real customer data.
- **Security issues:** report them privately, as described in the [Security policy](../SECURITY.md).
- **Your sevDesk account** (plans, tokens, data in sevDesk): sevDesk's own support.
- **Tax questions:** your Steuerberater.

Support is given by volunteers, on a best-effort basis.
