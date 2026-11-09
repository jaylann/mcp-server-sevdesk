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
  your client (MCP elicitation), or on an approval page in your browser. The model cannot approve
  itself.
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

All settings are environment variables: in your MCP client's server config over stdio, or in the
server's environment in [remote mode](#remote-mode-http). Over stdio only the token is required;
everything else defaults to the safest option.

| Variable                    | Default                        | Meaning                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_API_TOKEN`         | (required)                     | Your sevDesk API token (Settings → Users → API token). Use a dedicated user. Required over stdio and in bearer mode; not used in OAuth mode, where every user pastes their own on the consent page.                                                                                                                                                                       |
| `SEVDESK_API_TOKEN_FILE`    |                                | Read the token from a file instead (Docker/Kubernetes secrets).                                                                                                                                                                                                                                                                                                           |
| `SEVDESK_ALLOW`             | `read`                         | Tiers to enable: comma list of `read`, `write`, `commit`, `external`, or `all`.                                                                                                                                                                                                                                                                                           |
| `SEVDESK_READ_ONLY`         | `0`                            | `1` forces read-only, overriding `SEVDESK_ALLOW`.                                                                                                                                                                                                                                                                                                                         |
| `SEVDESK_DRY_RUN`           | `0`                            | `1` turns every write into a dry run: write tools check the call and return a preview (status `dry_run`); nothing is sent and nobody is asked. Per call: `dryRun: true`.                                                                                                                                                                                                  |
| `SEVDESK_CONFIRM`           | `elicit`                       | Human confirmation for `commit`/`external` tools: `elicit` (a prompt in your client), `browser` (an approval page: over stdio a local page on 127.0.0.1, for clients without elicitation, weaker, see [SECURITY.md](SECURITY.md); in remote mode the server's [approval inbox](#approvals-in-remote-mode)), or `off` (also requires `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`). |
| `SEVDESK_CONFIRM_OPEN`      | `1` (HTTP: `0`)                | Browser mode over stdio: open the approval page in your default browser. `0` only writes its link to the server log (stderr). The link is never shown to the model. No effect in remote mode, where `1` is refused unless the server binds to loopback.                                                                                                                   |
| `SEVDESK_TOOLSETS`          | `default`                      | Comma list of `meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`, `banking`, `parts`, `reports`, `advanced`, or `default`/`all`. `default` is everything except `advanced`.                                                                                                                                                                             |
| `SEVDESK_STRUCTURED_OUTPUT` | `auto`                         | `on`/`off`/`auto`: typed `structuredContent` output (auto = only for clients that support it well).                                                                                                                                                                                                                                                                       |
| `SEVDESK_AUDIT_LOG`         |                                | Path of an append-only JSON Lines log (file mode 0600) of every write: previews, confirmations, executions and failures. If it is set but cannot be written, writes are refused.                                                                                                                                                                                          |
| `SEVDESK_OUTPUT_DIR`        |                                | Directory where `sevdesk_document_save`, `sevdesk_export_csv` and `sevdesk_datev_export` may write files (PDFs, e-invoice XML, CSV and DATEV exports). These tools are only offered when it is set; they never overwrite files.                                                                                                                                           |
| `SEVDESK_FILE_DIRS`         |                                | Absolute directories (separated like `PATH`) that receipts and e-invoices may be read from, for voucher uploads, `sevdesk_einvoice_parse` and `sevdesk_voucher_import_einvoice`. Symbolic links must stay inside; nothing else on your disk can be read.                                                                                                                  |
| `SEVDESK_RATE_LIMIT`        | `4`                            | Requests per second (sevDesk publishes no limit).                                                                                                                                                                                                                                                                                                                         |
| `SEVDESK_TIMEOUT_MS`        | `30000`                        | Per-request timeout.                                                                                                                                                                                                                                                                                                                                                      |
| `SEVDESK_BASE_URL`          | `https://my.sevdesk.de/api/v1` | API base URL (https only).                                                                                                                                                                                                                                                                                                                                                |

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

## Remote mode (HTTP)

Over stdio the server runs on your computer, started by your MCP client. With `--http` it runs as
a web service instead. Use it to connect claude.ai (custom connectors, which the Claude desktop and
mobile apps share), Claude Code or an editor on another machine, or a small team to one server.
You host it yourself: on a VM with Docker Compose and Caddy, on Fly.io, Render or Railway, or on
your own machine. There is no hosted instance. The full guide (deployment, every setting,
operations, troubleshooting) is [docs/remote.md](docs/remote.md).

HTTP refuses to start without authentication (`SEVDESK_HTTP_AUTH`):

- **`bearer`**: one shared secret protects one sevDesk account, the server's `SEVDESK_API_TOKEN`.
  For clients you configure yourself, such as Claude Code, Cursor or VS Code.
- **`oauth`**: the server is its own OAuth 2.1 authorization server. Each user connects through a
  consent page on your server, chooses the tiers for that connection and pastes their sevDesk token
  once. The token is sealed into the tokens the client holds; the server stores none. Only the
  sevDesk accounts you list can connect. claude.ai needs this mode.

The server binds to 127.0.0.1 by default and needs a public URL for any other address. It checks
`Host` and `Origin`, rate-limits, and logs no secrets. Run one instance; see
[SECURITY.md](SECURITY.md#remote-mode) for the threat model.

### Quick start with Docker (bearer)

```bash
docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret   # a client secret

umask 077
cat > ~/sevdesk-mcp.env <<'EOF'
SEVDESK_HTTP_AUTH=bearer
SEVDESK_HTTP_PUBLIC_URL=http://localhost:8080
SEVDESK_HTTP_BEARER_TOKEN=<the generated secret>
SEVDESK_API_TOKEN=<your sevDesk API token>
EOF

docker run --rm --read-only -p 127.0.0.1:8080:8080 --env-file ~/sevdesk-mcp.env \
  -v sevdesk-mcp-data:/data ghcr.io/jaylann/mcp-server-sevdesk:latest
```

The MCP endpoint is `http://localhost:8080/mcp`, with the header
`Authorization: Bearer <the generated secret>`. This is for a quick test on your own machine: keep
the port published on `127.0.0.1` only, and remember that browsers share cookies across the ports
of `localhost`, so another local web server could reach the approval inbox. Anything longer runs
behind https, with a pinned version instead of `latest`.

### claude.ai custom connector (OAuth)

claude.ai connects from the internet, so the server needs a public https URL (a domain behind
Caddy, a platform, or a tunnel for a test). Configure it with:

```bash
SEVDESK_HTTP_AUTH=oauth
SEVDESK_HTTP_PUBLIC_URL=https://mcp.example.com
# 32 random bytes from `mcp-server-sevdesk generate-secret`, kept in a secret store.
SEVDESK_HTTP_SECRET_FILE=/run/secrets/sevdesk_http_secret
# Your account id, from `mcp-server-sevdesk account-id`.
SEVDESK_OAUTH_ACCOUNTS=<account id>
# The most any connection may get; each one chooses on the consent page.
SEVDESK_ALLOW=read,write,commit
SEVDESK_CONFIRM=browser
SEVDESK_HTTP_TRUST_PROXY=1
```

Then, in claude.ai: Settings → Connectors → Add custom connector, with the URL
`https://mcp.example.com/mcp`. The consent page on your server shows which client asks, lets you
tick the tiers, and asks for your sevDesk token once.

### Approvals in remote mode

claude.ai cannot be asked for a confirmation inside the chat (at the time of writing), so set
`SEVDESK_CONFIRM=browser` when you enable `commit` or `external`. A binding call then returns a
reference code and the address of the server's **approval inbox** (`https://<host>/approvals`). Open
it, check the preview, approve, and ask Claude to try again. The inbox only shows anything to a
browser that proved it may act for the account: the browser that completed the consent page is
signed in for 12 hours, and any other signs in by pasting the sevDesk token. Approvals belong to the
connection that asked and are used once. Details:
[docs/remote.md](docs/remote.md#the-approval-inbox).

### HTTP configuration

These variables apply with `--http`, in addition to the ones above. The three secrets
(`SEVDESK_HTTP_BEARER_TOKEN`, `SEVDESK_HTTP_SECRET`, `SEVDESK_HTTP_SECRET_PREVIOUS`) can also be
read from a file (`…_FILE`). OAuth mode refuses `SEVDESK_FILE_DIRS` and
`SEVDESK_OUTPUT_DIR`: the server's disk would be shared by every connection. All rules:
[docs/remote.md](docs/remote.md#configuration-reference).

| Variable                                                        | Default                              | Meaning                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_HTTP_AUTH`                                             | (required)                           | `bearer` or `oauth`.                                                                                                                                                                      |
| `SEVDESK_HTTP_PUBLIC_URL`                                       |                                      | The origin clients use, e.g. `https://mcp.example.com`; https unless the host is loopback. Required for OAuth and for any bind other than loopback. The MCP endpoint is `<origin>/mcp`.   |
| `SEVDESK_HTTP_HOST`                                             | `127.0.0.1` (image: `0.0.0.0`)       | Bind address.                                                                                                                                                                             |
| `SEVDESK_HTTP_PORT`                                             | `$PORT`, else `8080` (image: `8080`) | Bind port.                                                                                                                                                                                |
| `SEVDESK_HTTP_BEARER_TOKEN`                                     |                                      | Bearer mode: the client secret, or two comma-separated secrets while you rotate. At least 32 characters, not the sevDesk token.                                                           |
| `SEVDESK_HTTP_SECRET`                                           |                                      | OAuth: the server secret every token is sealed with (`generate-secret`). Optional in bearer mode, where it keeps inbox sign-ins across restarts.                                          |
| `SEVDESK_HTTP_SECRET_PREVIOUS`                                  |                                      | The previous server secret, still accepted while you rotate.                                                                                                                              |
| `SEVDESK_HTTP_STATE_DIR`                                        | memory (image: `/data`)              | Where grants and inbox sessions are kept (no tokens). Without it a restart signs every client out.                                                                                        |
| `SEVDESK_OAUTH_ACCOUNTS`                                        |                                      | OAuth: the sevDesk account ids that may connect (`account-id` prints yours), or `any`.                                                                                                    |
| `SEVDESK_OAUTH_CLIENTS`                                         | `claude.ai`                          | Hosts allowed to serve a client's metadata document (its `client_id`), or `any`.                                                                                                          |
| `SEVDESK_OAUTH_ACCESS_TTL` / `_REFRESH_IDLE_TTL` / `_GRANT_TTL` | `1h` / `14d` / `90d`                 | Lifetime of access tokens, of unused refresh tokens, and of a grant from consent.                                                                                                         |
| `SEVDESK_HTTP_ALLOWED_HOSTS` / `_ORIGINS`                       | from the public URL                  | More `Host` names, and more `Origin` values for `/mcp`, to accept, comma-separated. `/mcp` has no CORS support, so MCP clients running in a web page on another origin are not supported. |
| `SEVDESK_HTTP_TRUST_PROXY`                                      | `0`                                  | How many reverse proxies are in front, for the client IP in rate limits and logs.                                                                                                         |

### Connecting clients

The endpoint is always `<public URL>/mcp`.

- **claude.ai and Claude Desktop** (OAuth): Settings → Connectors → Add custom connector, URL
  `https://<host>/mcp`.
- **Claude Code**, OAuth (then run `/mcp` to sign in) or bearer:

  ```bash
  claude mcp add --transport http sevdesk https://<host>/mcp
  claude mcp add --transport http sevdesk https://<host>/mcp \
    --header "Authorization: Bearer $SEVDESK_MCP_BEARER"
  ```

- **Cursor** (bearer), in `~/.cursor/mcp.json`:

  ```json
  {
    "mcpServers": {
      "sevdesk": {
        "url": "https://<host>/mcp",
        "headers": { "Authorization": "Bearer ${env:SEVDESK_MCP_BEARER}" }
      }
    }
  }
  ```

- **VS Code** (bearer), in `.vscode/mcp.json`, asking for the secret once:

  ```json
  {
    "inputs": [
      {
        "type": "promptString",
        "id": "sevdesk-mcp-bearer",
        "description": "Bearer secret of your sevDesk MCP server",
        "password": true
      }
    ],
    "servers": {
      "sevdesk": {
        "type": "http",
        "url": "https://<host>/mcp",
        "headers": { "Authorization": "Bearer ${input:sevdesk-mcp-bearer}" }
      }
    }
  }
  ```

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

| Milestone | Scope                                                                                       | Status  |
| --------- | ------------------------------------------------------------------------------------------- | ------- |
| M0        | Repository, tooling, CI, security and release pipeline                                      | done    |
| M1        | Core client, safety framework, contacts and account info (read)                             | done    |
| M2        | All read tools, PDFs/XML as resources, reports and aggregates                               | done    |
| M3        | Full invoice lifecycle with tiers and human confirmation                                    | done    |
| M4        | Receipt and e-invoice (XRechnung/ZUGFeRD) intake, bank reconciliation, VAT summary, DATEV   | done    |
| M5        | Remote mode: Streamable HTTP with OAuth 2.1, approval inbox, Docker image, deploy templates | done    |
| M6        | 1.0 release                                                                                 | planned |

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please report
security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Justin Lanfermann
