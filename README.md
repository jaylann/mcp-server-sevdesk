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

## Configuration

All settings are environment variables, set in your MCP client's server config. Only the token is
required; everything else defaults to the safest option.

| Variable                    | Default                        | Meaning                                                                                                                                                                                       |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_API_TOKEN`         | (required)                     | Your sevDesk API token (Settings → Users → API token). Use a dedicated user.                                                                                                                  |
| `SEVDESK_API_TOKEN_FILE`    |                                | Read the token from a file instead (Docker/Kubernetes secrets).                                                                                                                               |
| `SEVDESK_ALLOW`             | `read`                         | Tiers to enable: comma list of `read`, `write`, `commit`, `external`, or `all`.                                                                                                               |
| `SEVDESK_READ_ONLY`         | `0`                            | `1` forces read-only, overriding `SEVDESK_ALLOW`.                                                                                                                                             |
| `SEVDESK_DRY_RUN`           | `0`                            | `1` makes write tools return what they would send instead of sending it.                                                                                                                      |
| `SEVDESK_CONFIRM`           | `elicit`                       | Human confirmation for `commit`/`external` tools: `elicit` (in your client), `browser` (local approval page), or `off` (also requires `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`).                   |
| `SEVDESK_TOOLSETS`          | `default`                      | Comma list of `meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`, `banking`, `parts`, `reports`, `advanced`, or `default`/`all`. `default` is everything except `advanced`. |
| `SEVDESK_STRUCTURED_OUTPUT` | `auto`                         | `on`/`off`/`auto`: typed `structuredContent` output (auto = only for clients that support it well).                                                                                           |
| `SEVDESK_AUDIT_LOG`         |                                | Path of an append-only JSONL log of every write.                                                                                                                                              |
| `SEVDESK_OUTPUT_DIR`        |                                | Directory where PDFs and exports may be written.                                                                                                                                              |
| `SEVDESK_FILE_DIRS`         |                                | Directories receipts may be uploaded from (separated like `PATH`).                                                                                                                            |
| `SEVDESK_RATE_LIMIT`        | `4`                            | Requests per second (sevDesk publishes no limit).                                                                                                                                             |
| `SEVDESK_TIMEOUT_MS`        | `30000`                        | Per-request timeout.                                                                                                                                                                          |
| `SEVDESK_BASE_URL`          | `https://my.sevdesk.de/api/v1` | API base URL (https only).                                                                                                                                                                    |

### Permission tiers

| Tier       | What it allows                                                            | Confirmation |
| ---------- | ------------------------------------------------------------------------- | ------------ |
| `read`     | List, get, search, reports, PDF previews                                  | no           |
| `write`    | Contacts, parts, draft invoices/vouchers/offers, deleting drafts          | no           |
| `commit`   | Finalize, book payments, reconcile, cancel, credit notes, enshrine (GoBD) | **yes**      |
| `external` | Send invoices by email or letter                                          | **yes**      |

## Roadmap

| Milestone | Scope                                                                                     | Status  |
| --------- | ----------------------------------------------------------------------------------------- | ------- |
| M0        | Repository, tooling, CI, security and release pipeline                                    | done    |
| M1        | Core client, safety framework, contacts and account info (read)                           | done    |
| M2        | All read tools, PDFs/XML as resources, reports and aggregates                             | planned |
| M3        | Full invoice lifecycle with tiers and human confirmation                                  | planned |
| M4        | Receipt and e-invoice (XRechnung/ZUGFeRD) intake, bank reconciliation, VAT summary, DATEV | planned |
| M5        | Remote mode: Streamable HTTP with OAuth 2.1, Docker                                       | planned |
| M6        | 1.0 release                                                                               | planned |

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please report
security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Justin Lanfermann
