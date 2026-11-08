# mcp-server-sevdesk

**A safety-first [Model Context Protocol](https://modelcontextprotocol.io) server for the
[sevDesk](https://sevdesk.de) accounting API.** It lets AI assistants (Claude, ChatGPT, Cursor,
VS Code, …) read and work with your invoices, receipts, bank transactions and reports, with
permissions you control and a human confirmation step for anything that is legally binding.

> [!WARNING]
> **Pre-release, under active development.** Nothing is published yet. See the
> [roadmap](#roadmap) for what's coming.

> [!NOTE]
> This is an **unofficial** community project. It is not affiliated with, endorsed by or
> supported by sevdesk GmbH. "sevDesk" is a trademark of its owner.

🇩🇪 [Deutsche Kurzanleitung](README.de.md)

## Why this server

A sevDesk API token has **full access to the whole account** and sevDesk has no sandbox. This
server is designed around that fact:

- **Read-only by default.** Writes are opt-in tiers (`write` → `commit` → `external`). Tools above
  your tier are never even shown to the model.
- **Real human confirmation.** Finalizing, booking, cancelling or emailing an invoice asks _you_ in
  your client (MCP elicitation), or on a local approval page. The model cannot approve itself.
- **No surprise side effects.** Previewing a PDF never marks an invoice as sent; writes are never
  retried; every write is read back and can be written to a local audit log.
- **Correct for sevDesk-Update 2.0.** Tax rules and booking accounts are validated before anything
  is sent.
- **Compact, typed output.** Aggregations run on the server, so the model doesn't page through
  hundreds of records.

## Tools

71 tools across 10 toolsets. The 34 read tools cover account info and reference data, contacts,
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
  **imported from an e-invoice**; the **DATEV export** (Buchungsstapel ZIP
  saved to `SEVDESK_OUTPUT_DIR`, never enshrined).
- **Lifecycle** (`commit`, asks you first): finalize, book payments (optionally linked to a bank
  transaction), cancel (Storno), enshrine (festschreiben, irreversible), reset to draft or open —
  for invoices, credit notes and vouchers; delete voucher drafts; **book a bank transaction
  against one or more documents** (split payments, guarded against over-booking), mark a
  transaction as private (Privatentnahme/-einlage) and undo an assignment.
- **Email** (`external`, asks you first): send invoices, credit notes and orders by email.

Every write tool accepts `dryRun: true` and then only returns exactly what it would do. The full
generated reference is in [docs/tools.md](docs/tools.md).

## Configuration

All settings are environment variables, set in your MCP client's server config. Only the token is
required; everything else defaults to the safest option.

| Variable                    | Default                        | Meaning                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_API_TOKEN`         | (required)                     | Your sevDesk API token (Settings → Users → API token). Use a dedicated user.                                                                                                                                                                                                 |
| `SEVDESK_API_TOKEN_FILE`    |                                | Read the token from a file instead (Docker/Kubernetes secrets).                                                                                                                                                                                                              |
| `SEVDESK_ALLOW`             | `read`                         | Tiers to enable: comma list of `read`, `write`, `commit`, `external`, or `all`.                                                                                                                                                                                              |
| `SEVDESK_READ_ONLY`         | `0`                            | `1` forces read-only, overriding `SEVDESK_ALLOW`.                                                                                                                                                                                                                            |
| `SEVDESK_DRY_RUN`           | `0`                            | `1` turns every write into a dry run: write tools check the call and return a preview (status `dry_run`); nothing is sent and nobody is asked. Per call: `dryRun: true`.                                                                                                     |
| `SEVDESK_CONFIRM`           | `elicit`                       | Human confirmation for `commit`/`external` tools: `elicit` (a prompt in your client), `browser` (a local approval page on 127.0.0.1, for clients without elicitation; weaker, see [SECURITY.md](SECURITY.md)), or `off` (also requires `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`). |
| `SEVDESK_CONFIRM_OPEN`      | `1`                            | Browser mode only: open the approval page in your default browser. `0` only writes its link to the server log (stderr). The link is never shown to the model.                                                                                                                |
| `SEVDESK_TOOLSETS`          | `default`                      | Comma list of `meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`, `banking`, `parts`, `reports`, `advanced`, or `default`/`all`. `default` is everything except `advanced`.                                                                                |
| `SEVDESK_STRUCTURED_OUTPUT` | `auto`                         | `on`/`off`/`auto`: typed `structuredContent` output (auto = only for clients that support it well).                                                                                                                                                                          |
| `SEVDESK_AUDIT_LOG`         |                                | Path of an append-only JSON Lines log (file mode 0600) of every write: previews, confirmations, executions and failures. If it is set but cannot be written, writes are refused.                                                                                             |
| `SEVDESK_OUTPUT_DIR`        |                                | Directory where `sevdesk_document_save`, `sevdesk_export_csv` and `sevdesk_datev_export` may write files (PDFs, e-invoice XML, CSV and DATEV exports). These tools are only offered when it is set; they never overwrite files.                                              |
| `SEVDESK_FILE_DIRS`         |                                | Absolute directories (separated like `PATH`) that receipts and e-invoices may be read from, for voucher uploads, `sevdesk_einvoice_parse` and `sevdesk_voucher_import_einvoice`. Symbolic links must stay inside; nothing else on your disk can be read.                     |
| `SEVDESK_RATE_LIMIT`        | `4`                            | Requests per second (sevDesk publishes no limit).                                                                                                                                                                                                                            |
| `SEVDESK_TIMEOUT_MS`        | `30000`                        | Per-request timeout.                                                                                                                                                                                                                                                         |
| `SEVDESK_BASE_URL`          | `https://my.sevdesk.de/api/v1` | API base URL (https only).                                                                                                                                                                                                                                                   |

### Permission tiers

| Tier       | What it allows                                                                                                       | Confirmation |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------ |
| `read`     | List, get, search, reports, PDF previews                                                                             | no           |
| `write`    | Contacts, parts, drafts of invoices, credit notes, orders and vouchers, dunning reminders, DATEV export              | no           |
| `commit`   | Finalize, book payments, reconcile bank transactions, cancel (Storno), enshrine (GoBD), reset, delete voucher drafts | **yes**      |
| `external` | Send documents by email                                                                                              | **yes**      |

How a write runs: the server first reads what it needs and checks the call locally (status,
amounts, tax rule × rate), so most mistakes are refused before anything is sent. For `commit` and
`external` it then shows you exactly what will happen (amounts, recipients, the full email text)
and waits for your approval; if the record changes before you approve, it asks again. Writes are
never retried, every result is read back from sevDesk, and with `SEVDESK_AUDIT_LOG` every step is
logged locally.

## Claude Code plugin

The repository is also a Claude Code plugin marketplace. The `sevdesk` plugin starts this server
(`npx -y mcp-server-sevdesk@<version>`, pinned to the release the plugin belongs to, so a new npm
version never runs before the plugin is updated) and adds a bookkeeping skill: German tax rules and their sevDesk
tax rules (incl. §13b reverse charge and §19 Kleinunternehmer), common SKR03/SKR04 accounts, GoBD,
the e-invoice obligations, and step-by-step workflows (file a receipt, import an e-invoice,
reconcile the bank, VAT pre-check, month and year end).

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

On Claude Code 2.1.275 or later this also works in one step:
`/plugin install sevdesk --marketplace jaylann/mcp-server-sevdesk`. The plugin passes the
`SEVDESK_*` variables from the environment Claude Code was started in (at least
`SEVDESK_API_TOKEN`; it stays read-only unless you set `SEVDESK_ALLOW`).

## Roadmap

| Milestone | Scope                                                                                     | Status  |
| --------- | ----------------------------------------------------------------------------------------- | ------- |
| M0        | Repository, tooling, CI, security and release pipeline                                    | done    |
| M1        | Core client, safety framework, contacts and account info (read)                           | done    |
| M2        | All read tools, PDFs/XML as resources, reports and aggregates                             | done    |
| M3        | Full invoice lifecycle with tiers and human confirmation                                  | done    |
| M4        | Receipt and e-invoice (XRechnung/ZUGFeRD) intake, bank reconciliation, VAT summary, DATEV | done    |
| M5        | Remote mode: Streamable HTTP with OAuth 2.1, Docker                                       | planned |
| M6        | 1.0 release                                                                               | planned |

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please report
security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Justin Lanfermann
