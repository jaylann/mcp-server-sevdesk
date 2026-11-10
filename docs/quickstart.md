# Quickstart

This page takes you from a sevDesk account to a first answer in about ten minutes. The server runs
on your computer, started by your MCP client (stdio). To connect claude.ai, the Claude mobile apps
or a team to one server instead, see [remote mode](remote.md).

## Before you start

- **sevDesk with API access.** The sevDesk API is part of the Buchhaltung Pro plan; sevDesk's free
  trial includes it.
- **A dedicated sevDesk user.** A sevDesk API token has full access to the whole account, with no
  scopes and no expiry. Create a user just for the assistant, so you can reset its token at any
  time without touching your own login.
- **Its API token.** In sevDesk, open Settings → Users, select that user and copy its API token
  (32 characters, digits and `a`–`f`). Treat it like a password.
- **Node.js 22.12 or later**, which provides `npx`. Check with `node --version`. Claude Desktop
  users can skip Node.js with the [extension](clients.md#the-extension).
- **An MCP client**, for example Claude Desktop, Claude Code, Cursor or VS Code. The
  [client guide](clients.md) has the exact format for each.

## 1. Add the server to your client

Your client starts the server with `npx -y mcp-server-sevdesk` and passes the token in its
environment. Most clients take this JSON (the file name differs per client, see
[Clients](clients.md)):

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>"
      }
    }
  }
}
```

In Claude Code it is one command (step 4 shows how to keep the token out of your shell history):

```bash
claude mcp add --env SEVDESK_API_TOKEN=<your sevDesk API token> --scope user sevdesk -- npx -y mcp-server-sevdesk
```

Restart the client. The first start downloads the package, which can take a few seconds. To stay on
1.x when 2.0 comes out, write `mcp-server-sevdesk@1` instead of `mcp-server-sevdesk`.

## 2. Ask a first question

Ask something like:

> What is my sevDesk account set up like?

The assistant calls `sevdesk_account_info`: the bookkeeping system version (sevDesk Update 2.0 or
the older 1.0), whether you are a Kleinunternehmer, the chart of accounts (SKR03 or SKR04), the
sevDesk users, and what the server allows. It should report that only the `read` tier is enabled.

Then try a few reads:

> Which invoices are overdue, and by how much?
>
> Summarize revenue and costs per month for this year.
>
> Welche Belege sind noch nicht bezahlt?

Nothing you ask in this setup can change your books: the server starts read-only, and tools that
write are not even shown to the model.

## 3. Enable writing, with a dry run first

Add two settings, so the `env` block reads as follows, and restart the client:

```json
{
  "SEVDESK_API_TOKEN": "<your sevDesk API token>",
  "SEVDESK_ALLOW": "write",
  "SEVDESK_DRY_RUN": "1"
}
```

`write` adds the tools that create and change drafts, contacts and parts. With `SEVDESK_DRY_RUN=1`
every write only returns a preview of exactly what it would send. Ask:

> Draft an invoice for <a customer> for 2 hours of consulting at 120 EUR per hour.

The answer has the status `dry_run` and shows the invoice the tool would create. When the previews
look right, remove `SEVDESK_DRY_RUN` (you can still ask for a dry run in any single request).

The next tiers are `commit` (finalize, book payments, cancel, enshrine) and `external` (send by
email). They ask you before every call. Your client must be able to show that question, or you
switch to approvals in the browser: check [Confirmations by client](clients.md#confirmations-by-client)
before you enable them, and read [Permissions](permissions.md).

## 4. Keep the token safe

The token in a configuration file ends up in backups, screenshots and sometimes repositories.
Better options:

- **The OS keychain** (macOS, Linux). Store the token once, then name only its label:

  ```bash
  npx -y mcp-server-sevdesk token set work
  ```

  and use `"SEVDESK_API_TOKEN_KEYCHAIN": "work"` instead of `SEVDESK_API_TOKEN`. In Claude Code:
  `claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk`.

- **A token file** only you can read: `"SEVDESK_API_TOKEN_FILE": "/absolute/path/to/token"`
  (works everywhere, also on Windows).
- **The Claude Desktop extension** keeps the token in the operating system's secure storage.
- **Profiles** keep several accounts or setups in one file, each with its token source, and pick
  one with `SEVDESK_PROFILE`.

Details: [Configuration](configuration.md#keep-the-token-in-the-os-keychain). If a token may have
leaked, reset it in sevDesk; the old one stops working at once.

## Next steps

- [Clients](clients.md): the setup for your client, and which clients show confirmations.
- [Permissions](permissions.md): tiers, confirmations, dry runs and the audit log.
- [Configuration](configuration.md): every setting, toolsets, profiles and the command line.
- [Tool reference](tools.md): every tool and prompt with its arguments.
- [Remote mode](remote.md): host the server for claude.ai, the mobile apps or a team.
- [FAQ](faq.md): data and privacy, Update 2.0, e-invoices, DATEV.
