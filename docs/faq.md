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
sevDesk API. There are two exceptions: the DATEV export, which sevDesk delivers as a download from
its own storage (on Amazon S3), and a remote server in OAuth mode, which fetches a connecting
client's metadata document from the client's host. Results go to your MCP client, and from there to your model provider: invoices,
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

### Can it handle e-invoices (E-Rechnung)?

Yes, both directions. Received XRechnung (UBL and CII) and ZUGFeRD / Factur-X files are parsed
locally, checked and imported as voucher drafts with the original file attached
([Import an e-invoice](guides/receipts.md#import-an-e-invoice)). Outgoing invoices can be checked
for e-invoice readiness before you finalize them, and the XML sevDesk generates can be fetched
([E-invoice readiness](guides/invoices.md#e-invoice-readiness)). Over stdio the files come from a
folder you allow (`SEVDESK_FILE_DIRS`); in remote mode you upload them through a page on your
server.

### Can it export to DATEV?

Yes. [`sevdesk_datev_export`](tools.md#sevdesk_datev_export) lets sevDesk build the DATEV
Buchungsstapel (CSV files in a ZIP) for a month, quarter, year or date range, saved in your output
folder or offered as a download link in remote mode. It never enshrines (festschreiben) the
documents and needs the DATEV settings in sevDesk (Beraternummer, Mandantennummer, start of the
fiscal year). [`sevdesk_csv_export`](tools.md#sevdesk_csv_export) saves sevDesk's CSV exports, for
example for Excel.

### Can it record cash takings (Kasse) and enter bank transactions by hand?

Yes. A cash sale or a cash expense is a payment booked on its invoice or voucher against the cash
register, without a bank transaction: sevDesk then adds the entry to the cash book itself, and
[`sevdesk_cash_position`](tools.md#sevdesk_cash_position) shows the new balance. sevDesk takes no
hand-made transactions on a cash register or a clearing account. On a file-import account
[`sevdesk_transaction_create`](tools.md#sevdesk_transaction_create) enters a transaction by hand,
and can book it on a document in the same step. Both are `commit` tools that you confirm; the
details are in [Banking and cash](guides/banking.md).

### Can it mark recurring private payments automatically?

Through sevDesk's private-transaction rules: a rule names a counterparty or purpose text, and
sevDesk marks matching transactions as private when it imports them from the bank. The server
lists, creates and deletes rules; creating and deleting are `commit` tools that you confirm. Where
rules act could not be tested, because a trial account imports no bank transactions, and there
they changed no existing transaction. The preview's list of open transactions the rule seems meant
for is the server's estimate, not sevDesk's matching. Details:
[Banking and cash](guides/banking.md#private-transaction-rules).

### How far can I rely on the VAT summary and the profit and loss?

They are estimates for checking, computed by the server from your documents; they are not
sevDesk's own reports and not a filing. Each result says what it left out. What they cover and
what they leave to you is in [Reports and exports](guides/evaluations.md#how-far-you-can-rely-on-them).

### Does it support sevDesk in Austria?

Not in 1.0. Tax rules, the VAT summary (UStVA boxes), the e-invoice checks and the bookkeeping
skill follow German law, and the server is tested only against German accounts. Reads may work on
an Austrian account, but nothing is verified there. Support for Austria is tracked for a later 1.x
release.

### Can it send letters by post?

Not in 1.0. Documents can be sent by email (`external` tier), and finalizing records how a document
was sent (for example by post), but the server does not use sevDesk's letter service.

### Does it cover stock (Lagerbestand)?

Yes. `sevdesk_part_get` reports the current stock when stock tracking is on, `sevdesk_parts_list`
and `sevdesk_part_get` show `stock` and `stockEnabled`, and `sevdesk_part_create` and
`sevdesk_part_update` set them. The sevDesk API has no other stock endpoints.

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
