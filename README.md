<img src="https://raw.githubusercontent.com/jaylann/mcp-server-sevdesk/main/assets/icon.svg" alt="" width="96" height="96" align="right">

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
  hundreds of records.

## Quick start

You need a sevDesk plan with API access (Buchhaltung Pro; the free trial includes it), the API
token of a sevDesk user (Settings → Users → API token; ideally a user just for the assistant) and,
except for the Claude Desktop extension, Node.js 22.12 or later.

### Claude Desktop

Download `mcp-server-sevdesk-<version>.mcpb` from the
[latest release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest), open it and paste
your token. The extension needs no Node.js and keeps the token in your system's secure storage.

### Claude Code

```bash
npx -y mcp-server-sevdesk token set work   # stores the token in the OS keychain (macOS, Linux, Windows)
claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
```

Or install the [Claude Code plugin](#claude-code-plugin), which adds a bookkeeping skill.

### Cursor, VS Code, Windsurf, Codex, Zed and others

Every client starts the server like this; [docs/clients.md](docs/clients.md) has the exact file
and format for each:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": { "SEVDESK_API_TOKEN": "<your sevDesk API token>" }
    }
  }
}
```

### First steps

Ask _"What is my sevDesk account set up like?"_. The server starts read-only; the
[quickstart guide](docs/quickstart.md) continues with enabling writes, a dry run first, and keeping
the token safe. claude.ai and the Claude mobile apps connect to a server you host in
[remote mode](#remote-mode).

## What it can do

74 tools across 10 toolsets. The 37 read tools fill the first column; with the write tiers
enabled, 37 more tools create and change data.

| Area                               | Read                                                                                                                                                                              | Write (`write`, `commit`, `external`)                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**                        | Account overview and reference data: tax rules, booking accounts, units, countries                                                                                                |                                                                                                                                                                                                                                                                   |
| **Invoices, credit notes, orders** | List and get; PDFs and e-invoice XML as MCP resources; an **e-invoice readiness check** for outgoing invoices                                                                     | Drafts, including orders (Angebot, Auftragsbestätigung, Lieferschein), invoices from orders, credit notes from invoices and dunning reminders (Mahnungen). Finalize, book payments, enshrine (festschreiben, irreversible), reset, cancel (Storno). Send by email |
| **Vouchers (Belege)**              | List and get; **parse received e-invoices** locally (XRechnung UBL/CII, ZUGFeRD/Factur-X)                                                                                         | Drafts with the receipt file attached, **imports from an e-invoice**. Finalize, book payments, enshrine, reset, delete drafts                                                                                                                                     |
| **Banking**                        | Accounts and transactions; **reconciliation suggestions** from the amount, the invoice number in the purpose, the counterparty and splits                                         | Book a transaction against one or more documents (split payments, guarded against over-booking), mark it as private (Privatentnahme/-einlage), undo an assignment                                                                                                 |
| **Reports**                        | Summaries, receivables and payables aging, cash position, changes since a date, a **VAT summary** (UStVA boxes, ZM, OSS) and an **EÜR-style profit and loss**                     | The **DATEV export** (Buchungsstapel ZIP, never enshrined)                                                                                                                                                                                                        |
| **Contacts and parts**             | Search and get, parts with their stock (Lagerbestand)                                                                                                                             | Create and update, including a part's `stock` and `stockEnabled`                                                                                                                                                                                                  |
| **Advanced** (off by default)      | `sevdesk_api_get`: a read-only GET of any sevDesk endpoint no other tool covers, such as text templates. It refuses everything that could change data, return files or start jobs |                                                                                                                                                                                                                                                                   |

The VAT summary is clearly marked as an estimate (accrual or cash basis). Every write tool accepts
`dryRun: true` and then only returns exactly what it would do. The full generated reference is
[docs/tools.md](docs/tools.md).

## Prompts

Ready-made workflows as MCP prompts. Clients list them next to the tools; in Claude Code they are
slash commands such as `/mcp__sevdesk__month_end_close`.

| Prompt                | What it does                                                                                                              | Arguments                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `month_end_close`     | Monatsabschluss: changes, unbooked transactions, drafts, receivables and payables, VAT pre-check, profit, DATEV hand-over | `month` (YYYY-MM, default: previous month) |
| `receipt_intake`      | Beleg erfassen, E-Rechnung importieren: duplicate check, booking account and tax rule, voucher draft, finalize, payment   | `file` (optional)                          |
| `dunning_run`         | Mahnlauf: overdue invoices, unbooked incoming payments, reminder drafts                                                   | none                                       |
| `vat_precheck`        | UStVA-Vorprüfung: unbooked transactions and drafts, VAT summary (Kennzahlen), ZM                                          | `period` (YYYY-MM or YYYY-Qn)              |
| `bank_reconciliation` | Kontoabgleich: suggestions, bookings, private transactions, corrections                                                   | none                                       |

A prompt appears only when the tools it needs are enabled; steps that need a disabled tier,
toolset or folder are listed with the setting that enables them. Prompts only produce text for the
assistant: every change still goes through the tools, with a dry run first and your confirmation
for binding steps. Not tax advice.

## Permissions

| Tier       | What it allows                                                                                                                                     | Confirmation |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `read`     | List, get, search, reports, PDF previews, saving document files and CSV exports to the output folder (or as download links)                        | no           |
| `write`    | Contacts, parts, drafts of invoices, credit notes, orders and vouchers, dunning reminders, DATEV export                                            | no           |
| `commit`   | Finalize, book payments, reconcile bank transactions, mark transactions as private, cancel (Storno), enshrine (GoBD), reset, delete voucher drafts | **yes**      |
| `external` | Send documents by email                                                                                                                            | **yes**      |

Enable tiers with `SEVDESK_ALLOW` (for example `write,commit`). Before anything binding is sent,
the server shows you exactly what will happen (amounts, recipients, the full email text) and waits
for your approval; if the record changes before you approve, it asks again.
[docs/permissions.md](docs/permissions.md) explains the tiers, confirmation modes, dry runs and
the audit log; [docs/clients.md](docs/clients.md#confirmations-by-client) shows which clients can
ask you in the chat.

## Configuration

All settings are environment variables in your MCP client's server configuration. Only a token is
required; everything else defaults to the safest option.

| Variable                                  | Purpose                                                                                           | Default   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| `SEVDESK_API_TOKEN`                       | The token. Or from a file (`SEVDESK_API_TOKEN_FILE`) or the OS keychain (`…_KEYCHAIN`)            | required  |
| `SEVDESK_ALLOW`                           | The tiers: `write`, `commit`, `external` or `all`                                                 | `read`    |
| `SEVDESK_DRY_RUN`                         | `1`: every write only returns a preview                                                           | `0`       |
| `SEVDESK_CONFIRM`                         | `elicit` (in the client) or `browser` (an approval page)                                          | `elicit`  |
| `SEVDESK_TOOLSETS`                        | Load only the toolsets you need; `advanced` is off by default                                     | `default` |
| `SEVDESK_FILE_DIRS`, `SEVDESK_OUTPUT_DIR` | Folders to read receipts from and save PDFs and exports to. Without them, no local files are used |           |
| `SEVDESK_AUDIT_LOG`                       | A local JSON Lines log of every write                                                             |           |
| `SEVDESK_PROFILE`                         | Pick one of several accounts or setups from a profiles file                                       |           |

Every variable, the toolsets, profiles, limits and the command line:
[docs/configuration.md](docs/configuration.md).

## Remote mode

Over stdio the server runs on your computer, started by your MCP client. With `--http` it runs as
a web service you host yourself (a VM with Docker Compose and Caddy, Fly.io, Render, Railway or
your own machine; there is no hosted instance), to connect claude.ai and the Claude apps, an editor
on another machine, or a small team. It refuses to start without authentication
(`SEVDESK_HTTP_AUTH`):

- **`oauth`**: the server is its own OAuth 2.1 authorization server. Each user connects through a
  consent page, chooses the tiers for that connection and pastes their sevDesk token once; the
  token is sealed into the tokens the client holds, and the server stores none. Only the sevDesk
  accounts you list can connect. claude.ai needs this mode.
- **`bearer`**: one shared secret protects one sevDesk account, the server's `SEVDESK_API_TOKEN`.
  For clients you configure yourself, such as Claude Code, Cursor or VS Code.

claude.ai cannot ask for confirmations in the chat (at the time of writing), so binding steps are
approved in the server's approval inbox (`SEVDESK_CONFIRM=browser`). Receipts and e-invoices are
uploaded, and PDFs and exports downloaded, through pages on your server that the assistant links
to. Connect Claude Code with:

```bash
claude mcp add --transport http sevdesk https://<host>/mcp                     # OAuth: then /mcp to sign in
claude mcp add --transport http sevdesk https://<host>/mcp \
  --header "Authorization: Bearer $MCP_BEARER_SECRET"                          # bearer
```

The full guide, with a Docker quick start, deployment templates and operations, is
[docs/remote.md](docs/remote.md); the threat model is in [SECURITY.md](SECURITY.md#remote-mode).

## Claude Code plugin

The repository is also a Claude Code plugin marketplace. The `sevdesk` plugin starts this server,
pinned to the release the plugin belongs to (a new npm version never runs before the plugin is
updated), and adds a bookkeeping skill: German tax rules and
their sevDesk tax rules (incl. §13b reverse charge and §19 Kleinunternehmer), common SKR03/SKR04
accounts, GoBD, the e-invoice obligations, and step-by-step workflows for receipts, e-invoices,
bank reconciliation, the VAT pre-check, month and year end.

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

On Claude Code 2.1.275 or later, one step is enough:
`/plugin install sevdesk --marketplace jaylann/mcp-server-sevdesk`. The plugin passes the
`SEVDESK_*` variables from the environment Claude Code was started in (at least a token variable;
it stays read-only unless you set `SEVDESK_ALLOW`).

## Documentation

| Page                                           | For                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| [Quickstart](docs/quickstart.md)               | From a sevDesk account to a first answer, then writes and token safety     |
| [Clients](docs/clients.md)                     | Setup for Claude Desktop, Claude Code, claude.ai, Cursor, VS Code and more |
| [Permissions](docs/permissions.md)             | Tiers, confirmation modes, dry runs, the audit log                         |
| [Configuration](docs/configuration.md)         | Every setting, toolsets, profiles, the keychain, the command line          |
| [Tool reference](docs/tools.md)                | Every tool and prompt with its arguments (generated)                       |
| [Remote mode](docs/remote.md)                  | Hosting the server over HTTP: OAuth, bearer, deployment, operations        |
| [FAQ](docs/faq.md)                             | Data and privacy, Update 2.0, e-invoices, DATEV, support                   |
| [Compatibility](docs/compatibility.md)         | What 1.0 keeps stable, and the deprecation policy                          |
| [Architecture](docs/architecture.md)           | How the server is built, and the [decision records](docs/adr/README.md)    |
| [Security](SECURITY.md), [Privacy](PRIVACY.md) | Threat model, reporting vulnerabilities, what is stored where              |

**What's next** in 1.x: sending letters by post and sevDesk accounts in Austria.
The [changelog](CHANGELOG.md) lists every release.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please report
security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Justin Lanfermann
