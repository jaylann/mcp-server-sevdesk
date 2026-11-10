# mcp-server-sevdesk

[![npm](https://img.shields.io/npm/v/mcp-server-sevdesk)](https://www.npmjs.com/package/mcp-server-sevdesk)
[![CI](https://github.com/jaylann/mcp-server-sevdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/jaylann/mcp-server-sevdesk/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/jaylann/mcp-server-sevdesk/badge)](https://scorecard.dev/viewer/?uri=github.com/jaylann/mcp-server-sevdesk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**A safety-first [Model Context Protocol](https://modelcontextprotocol.io) server for the
[sevDesk](https://sevdesk.de) accounting API.** It lets AI assistants (Claude, Cursor, VS Code,
Codex, …) read and work with your invoices, receipts, bank transactions and reports, with
permissions you control and a human confirmation step for anything that is legally binding.

> [!NOTE]
> This is an **unofficial** community project. It is not affiliated with, endorsed by or
> supported by sevdesk GmbH. "sevDesk" is a trademark of its owner.

🇩🇪 [Deutsche Anleitung](README.de.md) · Documentation: <https://sevdeskmcp.lanfermann.dev>

## Install

You need a sevDesk plan with API access (Buchhaltung Pro; the free trial includes it), the API
token of a sevDesk user (Settings → Users → API token; ideally a user just for the assistant) and,
except for the Claude Desktop extension, Node.js 22.12 or later.

**Claude Desktop:** download `mcp-server-sevdesk-<version>.mcpb` from the
[latest release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest), open it, paste
your token. The extension needs no Node.js and keeps the token in your system's secure storage.

**Claude Code:**

```bash
npx -y mcp-server-sevdesk token set work   # stores the token in the OS keychain (macOS, Linux)
claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
```

**Any other MCP client** (Cursor, VS Code, Windsurf, Codex, Zed, …) starts the server like this;
[docs/clients.md](docs/clients.md) has the exact file and format for each:

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

Then ask _"What is my sevDesk account set up like?"_. The server starts read-only. The
[quickstart](docs/quickstart.md) continues with enabling writes, a dry run first, and keeping the
token safe. claude.ai and the Claude mobile apps connect to a server you host in
[remote mode](#remote-mode-http).

## Why this server

A sevDesk API token has **full access to the whole account** and sevDesk has no sandbox. This
server is designed around that fact:

- **Read-only by default.** Writes are opt-in tiers (`write` → `commit` → `external`). Tools above
  your tier are never even shown to the model.
- **Real human confirmation.** Finalizing, booking, cancelling or emailing an invoice asks _you_ in
  your client (MCP elicitation), or on an approval page in your browser. The model cannot approve
  itself.
- **No surprise side effects.** Previewing a PDF never marks an invoice as sent; writes are never
  retried; every write is read back and can be written to a local audit log.
- **Correct for sevDesk Update 2.0.** Tax rules and booking accounts are validated before anything
  is sent.
- **Compact, typed output.** Aggregations run on the server, so the model doesn't page through
  hundreds of records.

## Tools

73 tools across 10 toolsets. The 36 read tools cover account info and reference data, contacts,
invoices, credit notes, orders, vouchers (Belege), banking, parts, PDFs and e-invoice XML (as MCP
resources), and server-side reports: summaries, receivables and payables aging, cash position,
changes since a date, a **VAT summary** (Umsatzsteuer-Voranmeldung boxes, Zusammenfassende Meldung
and OSS, accrual or cash basis, clearly marked as an estimate) and an **EÜR-style profit and loss**.
They also **parse received e-invoices** (XRechnung UBL/CII, ZUGFeRD/Factur-X) locally, **check
outgoing invoices for e-invoice readiness**, and **suggest bank reconciliation matches** (amount,
invoice number in the purpose, counterparty, splits). With the write tiers enabled, 37 more tools
create and change data:

- **Drafts** (`write`): invoices, credit notes and orders (Angebot, Auftragsbestätigung,
  Lieferschein), invoices from orders, credit notes from invoices, dunning reminders (Mahnungen),
  contacts and parts; **vouchers (Belege)** with the receipt file attached, and vouchers
  **imported from an e-invoice**; the **DATEV export** (Buchungsstapel ZIP, never enshrined).
- **Lifecycle** (`commit`, asks you first): finalize, book payments (optionally linked to a bank
  transaction), enshrine (festschreiben, irreversible) and reset to draft or open, for invoices,
  credit notes and vouchers; cancel invoices (Storno); finalize orders; delete voucher drafts;
  **book a bank transaction against one or more documents** (split payments, guarded against
  over-booking), mark a transaction as private (Privatentnahme/-einlage) and undo an assignment.
- **Email** (`external`, asks you first): send invoices, credit notes and orders by email.

Parts include their stock (Lagerbestand): `sevdesk_part_get` reports the current stock, and
`sevdesk_part_update` sets `stock` and `stockEnabled`. The `advanced` toolset (off by default) adds
`sevdesk_api_get`, a read-only GET of any sevDesk endpoint no other tool covers, such as text
templates; it refuses everything that could change data, return files or start jobs.

Every write tool accepts `dryRun: true` and then only returns exactly what it would do. The full
generated reference is [docs/tools.md](docs/tools.md).

## Prompts

The server also offers ready-made workflows as MCP prompts. Clients list them next to the tools;
in Claude Code they are slash commands such as `/mcp__sevdesk__month_end_close`.

| Prompt                | What it does                                                                                                              | Arguments                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `month_end_close`     | Monatsabschluss: changes, unbooked transactions, drafts, receivables and payables, VAT pre-check, profit, DATEV hand-over | `month` (YYYY-MM, default: previous month) |
| `receipt_intake`      | Beleg erfassen, E-Rechnung importieren: duplicate check, booking account and tax rule, voucher draft, finalize, payment   | `file` (optional)                          |
| `dunning_run`         | Mahnlauf: overdue invoices, unbooked incoming payments, reminder drafts                                                   | none                                       |
| `vat_precheck`        | UStVA-Vorprüfung: unbooked transactions and drafts, VAT summary (Kennzahlen), ZM                                          | `period` (YYYY-MM or YYYY-Qn)              |
| `bank_reconciliation` | Kontoabgleich: suggestions, bookings, private transactions, corrections                                                   | none                                       |

Prompts follow your settings: a prompt appears only when the tools it needs are enabled, and steps
that need a disabled tier, toolset or folder are listed with the setting that enables them.
Prompts only produce text for the assistant; every change still goes through the tools, with a dry
run first and your confirmation for binding steps. Not tax advice.

## Permissions

| Tier       | What it allows                                                                                                                                     | Confirmation |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `read`     | List, get, search, reports, PDF previews, saving document files and CSV exports to the output folder (or as download links)                        | no           |
| `write`    | Contacts, parts, drafts of invoices, credit notes, orders and vouchers, dunning reminders, DATEV export                                            | no           |
| `commit`   | Finalize, book payments, reconcile bank transactions, mark transactions as private, cancel (Storno), enshrine (GoBD), reset, delete voucher drafts | **yes**      |
| `external` | Send documents by email                                                                                                                            | **yes**      |

Enable tiers with `SEVDESK_ALLOW` (for example `write,commit`). Before anything binding is sent,
the server shows you exactly what will happen (amounts, recipients, the full email text) and
waits for your approval; if the record changes before you approve, it asks again. Writes are never
retried, every result is read back from sevDesk, and with `SEVDESK_AUDIT_LOG` every step is
logged locally. [docs/permissions.md](docs/permissions.md) explains the tiers, the confirmation
modes, dry runs and the audit log; [docs/clients.md](docs/clients.md#confirmations-by-client)
shows which clients can ask you in the chat.

## Configuration

All settings are environment variables in your MCP client's server configuration. Only a token
is required; everything else defaults to the safest option. The most common ones:

- `SEVDESK_ALLOW`: the tiers (`read` by default). `SEVDESK_DRY_RUN=1`: previews only.
- `SEVDESK_CONFIRM`: `elicit` (default, in the client) or `browser` (an approval page).
- `SEVDESK_TOOLSETS`: load only the toolsets you need; `advanced` is off by default.
- `SEVDESK_FILE_DIRS`, `SEVDESK_OUTPUT_DIR`: folders the server may read receipts from and save
  PDFs and exports to. Without them, it touches no local files.
- `SEVDESK_AUDIT_LOG`: a local JSON Lines log of every write.
- **Token:** `SEVDESK_API_TOKEN`, a file (`SEVDESK_API_TOKEN_FILE`) or the OS keychain
  (`SEVDESK_API_TOKEN_KEYCHAIN`, stored with `mcp-server-sevdesk token set <label>`).
- **Profiles:** several accounts or setups in one file, picked with `SEVDESK_PROFILE`.

Every variable, toolsets, profiles, limits and the command line:
[docs/configuration.md](docs/configuration.md).

## Remote mode (HTTP)

Over stdio the server runs on your computer, started by your MCP client. With `--http` it runs as
a web service instead. Use it to connect claude.ai (custom connectors, which the Claude desktop and
mobile apps share), Claude Code or an editor on another machine, or a small team to one server.
You host it yourself: on a VM with Docker Compose and Caddy, on Fly.io, Render or Railway, or on
your own machine. There is no hosted instance.

HTTP refuses to start without authentication (`SEVDESK_HTTP_AUTH`):

- **`bearer`**: one shared secret protects one sevDesk account, the server's `SEVDESK_API_TOKEN`.
  For clients you configure yourself, such as Claude Code, Cursor or VS Code.
- **`oauth`**: the server is its own OAuth 2.1 authorization server. Each user connects through a
  consent page on your server, chooses the tiers for that connection and pastes their sevDesk token
  once. The token is sealed into the tokens the client holds; the server stores none. Only the
  sevDesk accounts you list can connect. claude.ai needs this mode.

claude.ai cannot ask for confirmations in the chat (at the time of writing), so binding steps are
approved in the server's approval inbox (`SEVDESK_CONFIRM=browser`). Receipts and e-invoices are
uploaded, and PDFs and exports downloaded, through pages on your server that the assistant links
to. Connect Claude Code with:

```bash
claude mcp add --transport http sevdesk https://<host>/mcp                     # OAuth: then /mcp to sign in
claude mcp add --transport http sevdesk https://<host>/mcp \
  --header "Authorization: Bearer $MCP_BEARER_SECRET"                          # bearer
```

The guide, with a Docker quick start, deployment templates, every HTTP setting, the approval
inbox, file transfer and operations, is [docs/remote.md](docs/remote.md); the threat model is in
[SECURITY.md](SECURITY.md#remote-mode).

## Claude Code plugin

The repository is also a Claude Code plugin marketplace. The `sevdesk` plugin starts this server
(pinned to the release the plugin belongs to, so a new npm version never runs before the plugin is
updated) and adds a bookkeeping skill: German tax rules and their sevDesk tax rules (incl. §13b
reverse charge and §19 Kleinunternehmer), common SKR03/SKR04 accounts, GoBD, the e-invoice
obligations, and step-by-step workflows (file a receipt, import an e-invoice, reconcile the bank,
VAT pre-check, month and year end).

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

On Claude Code 2.1.275 or later this also works in one step:
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

## Roadmap

| Milestone | Scope                                                                                                   | Status |
| --------- | ------------------------------------------------------------------------------------------------------- | ------ |
| M0        | Repository, tooling, CI, security and release pipeline                                                  | done   |
| M1        | Core client, safety framework, contacts and account info (read)                                         | done   |
| M2        | All read tools, PDFs/XML as resources, reports and aggregates                                           | done   |
| M3        | Full invoice lifecycle with tiers and human confirmation                                                | done   |
| M4        | Receipt and e-invoice (XRechnung/ZUGFeRD) intake, bank reconciliation, VAT summary, DATEV               | done   |
| M5        | Remote mode: Streamable HTTP with OAuth 2.1, approval inbox, Docker image, deploy templates             | done   |
| M6        | 1.0: Claude Desktop extension, prompts, profiles and keychain, remote file transfer, generic read, docs | done   |

Next, in 1.x: sending letters by post, sevDesk accounts in Austria, the Windows credential store.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please report
security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Justin Lanfermann
