<!-- Width only: with a height as well, GitHub draws a tinted box behind the image. -->
<p align="center"><img src="https://raw.githubusercontent.com/jaylann/mcp-server-sevdesk/main/assets/logo.svg" alt="" width="96"></p>

# mcp-server-sevdesk

[![npm](https://img.shields.io/npm/v/mcp-server-sevdesk)](https://www.npmjs.com/package/mcp-server-sevdesk)
[![CI](https://github.com/jaylann/mcp-server-sevdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/jaylann/mcp-server-sevdesk/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/jaylann/mcp-server-sevdesk/badge)](https://scorecard.dev/viewer/?uri=github.com/jaylann/mcp-server-sevdesk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**A safety-first [Model Context Protocol](https://modelcontextprotocol.io) server for the
[sevDesk](https://sevdesk.de) accounting API.** It lets AI assistants (Claude, Cursor, VS Code,
Codex, …) read and work with your invoices, receipts, bank transactions and reports, with
permissions you control and a human confirmation step for anything that is legally binding.

**[Documentation](https://sevdeskmcp.lanfermann.dev)** · [Quick start](#quick-start) ·
[Tool reference](docs/tools.md) · [Releases](https://github.com/jaylann/mcp-server-sevdesk/releases) ·
🇩🇪 [Deutsch](README.de.md)

> [!NOTE]
> This is an **unofficial** community project. It is not affiliated with, endorsed by or
> supported by sevdesk GmbH. "sevDesk" is a trademark of its owner.

## Highlights

A sevDesk API token has **full access to the whole account**, and sevDesk has no sandbox. This
server is built around that fact:

- **Read-only by default.** Writes are opt-in tiers (`write` → `commit` → `external`); tools above
  your tier are never shown to the model.
- **Real human confirmation.** Finalizing, booking, cancelling or emailing asks _you_, in your
  client or on an approval page in your browser. The model cannot approve itself.
- **No surprise side effects.** Previewing a PDF never marks an invoice as sent, writes are never
  retried, and every write is read back and can go to a local audit log.
- **Correct for sevDesk Update 2.0.** Tax rules and booking accounts are validated before anything
  is sent.
- **Compact, typed output.** Aggregations run on the server, so the model doesn't page through
  hundreds of records; the fields are described in the [tool reference](docs/tools.md).

## Quick start

You need a sevDesk plan with API access (Buchhaltung Pro; the free trial includes it), the API
token of a sevDesk user (Settings → Users → API token; ideally a user just for the assistant) and,
except for the Claude Desktop extension, Node.js 22.12 or later.

- **Claude Desktop:** download `mcp-server-sevdesk-<version>.mcpb` from the
  [latest release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest), open it and
  paste your token ([details](docs/clients/claude-desktop.md)).
- **Claude Code:** store the token in the OS keychain, then add the server, or install the
  [plugin](#claude-code-plugin):

  ```bash
  npx -y mcp-server-sevdesk token set work
  claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
  ```

- **Cursor, VS Code, Windsurf, Codex, Zed and others** start `npx -y mcp-server-sevdesk` with the
  token in the environment; [Clients](docs/clients.md) has the exact file for each.
- **claude.ai and the Claude mobile apps** connect to a server you host in
  [remote mode](#remote-mode).

Then ask _"What is my sevDesk account set up like?"_. The server starts read-only; the
[quickstart guide](docs/quickstart.md) continues with enabling writes, a dry run first, and keeping
the token safe.

## What it can do

81 tools across 10 toolsets. The 42 read tools fill the first column; with the write tiers
enabled, 39 more tools create and change data.

| Area                               | Read                                                                                                                                                                                                               | Write (`write`, `commit`, `external`)                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**                        | Account overview and reference data: tax rules, booking accounts, units, countries                                                                                                                                 |                                                                                                                                                                                                                                                                   |
| **Invoices, credit notes, orders** | List and get; PDFs and e-invoice XML as MCP resources; an **e-invoice readiness check** for outgoing invoices                                                                                                      | Drafts, including orders (Angebot, Auftragsbestätigung, Lieferschein), invoices from orders, credit notes from invoices and dunning reminders (Mahnungen). Finalize, book payments, enshrine (festschreiben, irreversible), reset, cancel (Storno). Send by email |
| **Vouchers (Belege)**              | List and get; **parse received e-invoices** locally (XRechnung UBL/CII, ZUGFeRD/Factur-X)                                                                                                                          | Drafts with the receipt file attached, **imports from an e-invoice**. Finalize, book payments, enshrine, reset, delete drafts                                                                                                                                     |
| **Banking**                        | Accounts and transactions; **reconciliation suggestions** from the amount, the invoice number in the purpose, the counterparty and splits                                                                          | Book a transaction against one or more documents (split payments, guarded against over-booking), mark it as private (Privatentnahme/-einlage), undo an assignment                                                                                                 |
| **Reports**                        | Summaries, receivables and payables aging, cash position, changes since a date, a **VAT summary** (UStVA boxes, ZM, OSS), an **EÜR-style profit and loss**, a **tax-rule helper** for sales and a **VAT-ID check** | The **DATEV export** (Buchungsstapel ZIP or XML with receipt images, never enshrined) and its settings; invoice or voucher **PDF archives** as one ZIP                                                                                                            |
| **Contacts and parts**             | Search and get, parts with their stock (Lagerbestand)                                                                                                                                                              | Create and update, including a part's `stock` and `stockEnabled`                                                                                                                                                                                                  |
| **Advanced** (off by default)      | `sevdesk_api_get`: a read-only GET of any sevDesk endpoint no other tool covers, such as text templates. It refuses everything that could change data, return files or start jobs                                  |                                                                                                                                                                                                                                                                   |

The VAT summary is clearly marked as an estimate (accrual or cash basis). The **audits**
(`sevdesk_records_audit`) answer "what is wrong?": foreign suppliers and customers whose VAT
treatment does not fit, the §13b base by tax rule, vouchers booked twice and stuck drafts, and
missing bills of suppliers that bill every month, quarter or year, each finding with its
documents, its legal basis and what to check; they are hints, not tax advice. Where the server
reads a local folder (`SEVDESK_FILE_DIRS`), `sevdesk_receipt_folder_check` compares its receipt
files with those attached to the vouchers in sevDesk by checksum and names the files probably
never booked. Every write tool accepts
`dryRun: true` and then only returns exactly what it would do. Voucher drafts can be in a foreign
currency, with an exchange rate or a rate date; such drafts cannot be finalized through the server
([Receipts](docs/guides/receipts.md)). The full generated reference is
[docs/tools.md](docs/tools.md).

## Prompts

Ready-made workflows as MCP prompts. Clients list them next to the tools; in Claude Code they are
slash commands such as `/mcp__sevdesk__month_end_close`.

| Prompt                | What it does                                                                                                              | Arguments                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `month_end_close`     | Monatsabschluss: changes, unbooked transactions, drafts, receivables and payables, VAT pre-check, profit, DATEV hand-over | `month` (YYYY-MM, default: previous month)                         |
| `receipt_intake`      | Beleg erfassen, E-Rechnung importieren: duplicate check, booking account and tax rule, voucher draft, finalize, payment   | `file` (optional)                                                  |
| `dunning_run`         | Mahnlauf: overdue invoices, unbooked incoming payments, reminder drafts                                                   | `contact` (name/id), `minDaysOverdue` (0–3650 days); both optional |
| `vat_precheck`        | UStVA-Vorprüfung: unbooked transactions and drafts, VAT summary (Kennzahlen), ZM                                          | `period` (YYYY-MM or YYYY-Qn)                                      |
| `bank_reconciliation` | Kontoabgleich: suggestions, bookings, private transactions, corrections                                                   | `checkAccount` (name/id), `month` (YYYY-MM); both optional         |

A prompt appears only when the tools it needs are enabled; steps that need a disabled tier,
toolset or folder are listed with the setting that enables them. Prompts only produce text for the
assistant: every change still goes through the tools, with a dry run first and your confirmation
for binding steps. Not tax advice.

Clients that support argument completion suggest values while you type: months and quarters,
recent ones first, and the names of your contacts and payment accounts. The names are read from
sevDesk (read-only, cached for a minute) and only when the contact or bank account tools are
enabled.

## Permissions and configuration

The server only reads until you enable more with `SEVDESK_ALLOW`: `write` (drafts, contacts,
parts, DATEV export), `commit` (finalize, book, cancel, enshrine) and `external` (send by email).
Before anything binding is sent, the server shows you exactly what will happen (amounts,
recipients, the full email text) and waits for your approval; if the record changes before you
approve, it asks again ([Permissions](docs/permissions.md);
[which clients can ask in the chat](docs/clients.md#confirmations-by-client)). All settings are
environment variables in your client's server configuration; only a token is required, and
everything else defaults to the safest option ([Configuration](docs/configuration.md)).

## Remote mode

With `--http` the server runs as a web service you host yourself (there is no hosted instance), for
claude.ai and the Claude apps, an editor on another machine, or a small team. It refuses to start
without authentication: OAuth, where each user connects through a consent page and the server
stores no sevDesk token, or a shared bearer secret for one account. [Remote mode](docs/remote.md)
has the quick starts, deployment, configuration and operations.

## Claude Code plugin

The repository is also a Claude Code plugin marketplace: the `sevdesk` plugin starts this server
and adds a bookkeeping skill for German tax rules, SKR03/SKR04, GoBD and e-invoices. Installing
and configuring it: [The plugin](docs/clients/claude-code.md#the-plugin).

## Documentation

- **Start:** [Quickstart](docs/quickstart.md) · [Troubleshooting](docs/troubleshooting.md) ·
  [FAQ](docs/faq.md) · [Glossary](docs/glossary.md)
- **Clients:** [Overview](docs/clients.md) · [Claude Desktop](docs/clients/claude-desktop.md) ·
  [Claude Code](docs/clients/claude-code.md) · [claude.ai](docs/clients/claude-ai.md) ·
  [Cursor](docs/clients/cursor.md) · [VS Code](docs/clients/vscode.md) ·
  [Windsurf](docs/clients/windsurf.md) · [Codex](docs/clients/codex.md) ·
  [Zed](docs/clients/zed.md)
- **Guides:** [Invoices](docs/guides/invoices.md) · [Receipts](docs/guides/receipts.md) ·
  [Reports](docs/guides/evaluations.md)
- **Reference:** [Permissions](docs/permissions.md) · [Audit log](docs/permissions/audit-log.md) ·
  [Configuration](docs/configuration.md) · [Profiles](docs/configuration/profiles.md) ·
  [Tools](docs/tools.md) · [Compatibility](docs/compatibility.md)
- **Remote mode:** [Overview](docs/remote.md) · [Deployment](docs/remote/deployment.md) ·
  [Configuration](docs/remote/configuration.md) · [Approvals](docs/remote/approvals.md) ·
  [Files](docs/remote/files.md) · [Operations](docs/remote/operations.md) ·
  [Troubleshooting](docs/remote/troubleshooting.md)
- **Security:** [Policy](SECURITY.md) · [Confirmation](docs/security/confirmation.md) ·
  [Local](docs/security/local.md) · [Remote](docs/security/remote.md) ·
  [Supply chain](docs/security/supply-chain.md) · [Privacy](PRIVACY.md)
- **Project:** [Architecture](docs/architecture.md) · [Safety](docs/architecture/safety.md) ·
  [Transports](docs/architecture/transports.md) ·
  [Build and test](docs/architecture/build-and-test.md) · [ADRs](docs/adr/README.md) ·
  [Contributing](CONTRIBUTING.md) ·
  [Changes](docs/contributing/changes.md) · [Testing](docs/contributing/testing.md) ·
  [Recording session](docs/recording-session.md)

**What's next** in 1.x: sending letters by post and sevDesk accounts in Austria.
The [changelog](CHANGELOG.md) lists every release.

## Contributing

Contributions are welcome. Start with [Contributing](CONTRIBUTING.md), and please report
security issues privately as described in the [Security policy](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Justin Lanfermann
