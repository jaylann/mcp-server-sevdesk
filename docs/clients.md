# Clients

Every MCP client that can start a local program runs this server the same way: the command
`npx -y mcp-server-sevdesk`, with your sevDesk API token in the environment. This page shows the
exact format for each client. Clients that cannot start a program, such as claude.ai and the
Claude mobile apps, connect to a server you host in [remote mode](remote.md).

Before you start:

- **Node.js 22.12 or later** for `npx`. The [Claude Desktop extension](#the-extension) and
  [Docker](#docker-instead-of-npx) need none.
- **A sevDesk API token**, ideally of a dedicated user ([Quickstart](quickstart.md#before-you-start)).

The examples put the token itself into the configuration as `SEVDESK_API_TOKEN`. To keep it out of
the file, replace that line with `"SEVDESK_API_TOKEN_KEYCHAIN": "<label>"` after storing the token
with `npx -y mcp-server-sevdesk token set <label>` (macOS, Linux and Windows), or with
`"SEVDESK_API_TOKEN_FILE": "/absolute/path/to/token"`
([Configuration](configuration.md#keep-the-token-in-the-os-keychain)). Every other setting goes
into the same `env` block; without any, the server is read-only.

## Confirmations by client

`commit` and `external` tools (finalize, book, cancel, send) ask you first
([Permissions](permissions.md#confirmation-modes)). With the default `SEVDESK_CONFIRM=elicit`
the client shows the question in the chat, which needs MCP elicitation. Clients without it need
`SEVDESK_CONFIRM=browser`, an approval page in your browser.

| Client                                      | Confirmation in the chat     | Set                                     |
| ------------------------------------------- | ---------------------------- | --------------------------------------- |
| Claude Code                                 | yes, in interactive sessions | `elicit` (default)                      |
| Cursor                                      | yes                          | `elicit` (default)                      |
| VS Code (GitHub Copilot)                    | yes                          | `elicit` (default)                      |
| Claude Desktop                              | no (checked November 2026)   | `browser` (the extension's default)     |
| Codex                                       | not documented               | `browser`                               |
| Windsurf                                    | not documented               | `browser`                               |
| Zed                                         | no                           | `browser`                               |
| claude.ai and the Claude apps (remote mode) | no, at the time of writing   | `browser` (the server's approval inbox) |

Client features change often; this table reflects their documentation in November 2026. Nothing
goes wrong silently: when a client cannot be asked, the tool answers with an error that says so,
and nothing is sent to sevDesk. `write` tools and dry runs need no confirmation in any client.

## Claude Desktop

### The extension

The `.mcpb` extension bundles the server with everything it needs and runs on Claude Desktop's
built-in Node.js. It is the easiest way to install on macOS and Windows.

1. Download `mcp-server-sevdesk-<version>.mcpb` from the
   [latest release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest).
2. Double-click it, or drag it into the Claude Desktop window, or choose **Settings → Extensions →
   Advanced settings → Install Extension…** and select the file.
3. Paste your sevDesk API token and enable the extension. Everything else is optional: the
   extension starts read-only.

Claude Desktop keeps the token in your operating system's secure storage (Keychain on macOS,
Credential Manager on Windows). Change the settings later under **Settings → Extensions → sevDesk**:

| Setting           | Variable             | Meaning                                                                                                                                                                |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sevDesk API token | `SEVDESK_API_TOKEN`  | Required.                                                                                                                                                              |
| Permission tiers  | `SEVDESK_ALLOW`      | `read` (default), `write`, `commit`, `external` or `all`, comma-separated.                                                                                             |
| Read only         | `SEVDESK_READ_ONLY`  | Only read tools, whatever the tiers say.                                                                                                                               |
| Dry run           | `SEVDESK_DRY_RUN`    | Write tools only return a preview.                                                                                                                                     |
| Confirmation      | `SEVDESK_CONFIRM`    | `browser` (default: an approval page opens in your browser) or `elicit` (Claude Desktop shows no dialog for it). Confirmation cannot be switched off in the extension. |
| Toolsets          | `SEVDESK_TOOLSETS`   | Empty loads all except `advanced`.                                                                                                                                     |
| Receipt folder    | `SEVDESK_FILE_DIRS`  | A folder receipts and e-invoices may be read from.                                                                                                                     |
| Output folder     | `SEVDESK_OUTPUT_DIR` | A folder where PDFs and exports may be saved.                                                                                                                          |
| Audit log         | `SEVDESK_AUDIT_LOG`  | Path of a local, append-only JSON Lines log of write calls, with secrets redacted. Empty: no audit log. If the file cannot be written, writes are refused.             |

To verify a download before you install it:
`gh attestation verify mcp-server-sevdesk-<version>.mcpb --owner jaylann`. A newer release is
installed the same way, over the old one.

### The configuration file

Without the extension, Claude Desktop starts the server from its configuration file. Open it with
**Settings → Developer → Edit Config**; it is at

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

Quit Claude Desktop completely and start it again. The server's log is in
`~/Library/Logs/Claude/mcp-server-sevdesk.log` on macOS and `%APPDATA%\Claude\logs` on Windows.

## Claude Code

Add the server for all your projects (`--scope user`), with the token from the keychain:

```bash
npx -y mcp-server-sevdesk token set work
claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
```

More settings are more `--env NAME=value` options before `--scope`. Everything after `--` is the
command Claude Code runs. Avoid `--env SEVDESK_API_TOKEN=<token>` on the command line: it stays in
your shell history. Run `/mcp` in Claude Code to see the server and its tools.

For a project's shared `.mcp.json`, never commit a token. Reference a variable instead, which
Claude Code expands from the environment it was started in; each person then exports the label of
their own keychain entry:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": { "SEVDESK_API_TOKEN_KEYCHAIN": "${SEVDESK_API_TOKEN_KEYCHAIN}" }
    }
  }
}
```

The server's [prompts](../README.md#prompts) appear in the `/` menu as
`/sevdesk:month_end_close (MCP)`; typing `/mcp__sevdesk__month_end_close 2026-10` runs one with
an argument. Confirmations appear as a dialog in interactive sessions; in print mode
(`claude -p`) use dry runs or `SEVDESK_CONFIRM=browser`.

### The plugin

The repository is also a Claude Code plugin marketplace. The `sevdesk` plugin starts this server
and adds a bookkeeping skill: German tax rules and their sevDesk tax rules (including §13b reverse
charge and §19 Kleinunternehmer), common SKR03 and SKR04 accounts, GoBD, the e-invoice
obligations, and step-by-step workflows.

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

The plugin starts the release it belongs to (`npx -y mcp-server-sevdesk@<version>`), so a new
npm version never runs before you update the plugin. It passes the `SEVDESK_*` variables of the
environment Claude Code was started in, for example from your shell profile:

```bash
export SEVDESK_API_TOKEN_KEYCHAIN=work   # or SEVDESK_API_TOKEN / SEVDESK_API_TOKEN_FILE
export SEVDESK_ALLOW=write               # optional; read-only without it
```

## claude.ai and the Claude apps

claude.ai cannot start a program on your computer, so it connects to a server you host in remote
mode, with OAuth: on a VM, a platform such as Fly.io, or your own machine behind a tunnel. The
[remote mode guide](remote.md#quick-start-oauth-with-a-claudeai-custom-connector) walks through
it. Then, in claude.ai: **Settings → Connectors → Add custom connector**, with the URL
`https://<your host>/mcp`. The connector is also available in Claude Desktop and the mobile apps
signed in to the same account.

claude.ai cannot show confirmations in the chat at the time of writing, so set
`SEVDESK_CONFIRM=browser` on the server when you enable `commit` or `external`: you then approve
in the server's approval inbox. Receipts are uploaded and exports downloaded through pages on your
server, opened from links in the chat ([remote.md](remote.md#files-uploads-and-download-links)).

## Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project:

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

Keep a token out of a project file that is committed: use `SEVDESK_API_TOKEN_KEYCHAIN`, or
`"${env:SEVDESK_API_TOKEN}"` to read it from the environment Cursor was started in.

## VS Code

In `.vscode/mcp.json` in a workspace, or in your user configuration (Command Palette: **MCP: Open
User Configuration**). The `inputs` entry asks for the token once, hidden, and VS Code stores it
securely:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "sevdesk-token",
      "description": "sevDesk API token",
      "password": true
    }
  ],
  "servers": {
    "sevdesk": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "${input:sevdesk-token}"
      }
    }
  }
}
```

Prompts run as `/sevdesk.month_end_close` in the chat.

## Windsurf

Windsurf keeps its MCP servers in `mcp_config.json`; open it from Cascade's MCP settings (its
location has changed between versions). Add:

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

`"${env:SEVDESK_API_TOKEN}"` reads the token from the environment instead. Refresh the server list
in the MCP settings, or restart Windsurf.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.sevdesk]
command = "npx"
args = ["-y", "mcp-server-sevdesk"]

[mcp_servers.sevdesk.env]
SEVDESK_API_TOKEN_KEYCHAIN = "work"
```

Or with the command line:
`codex mcp add sevdesk --env SEVDESK_API_TOKEN_KEYCHAIN=work -- npx -y mcp-server-sevdesk`. To
pass variables from the environment Codex runs in instead, list them:
`env_vars = ["SEVDESK_API_TOKEN"]`.

## Zed

In Zed's `settings.json` (or **Settings → AI → MCP Servers → Add Server → Add Local Server**):

```json
{
  "context_servers": {
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

Zed supports tools and prompts, not elicitation: set `SEVDESK_CONFIRM=browser` before you enable
`commit` or `external`.

## Docker instead of npx

The container image runs the same server without Node.js on your computer. `--stdio` replaces the
image's default `--http`:

<!-- x-release-please-start-version -->

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--read-only",
        "-e",
        "SEVDESK_API_TOKEN",
        "ghcr.io/jaylann/mcp-server-sevdesk:1.5.0",
        "--stdio"
      ],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>"
      }
    }
  }
}
```

<!-- x-release-please-end -->

- `-e NAME` without a value hands the variable from `env` to the container. Add one `-e` per
  setting, for example `"-e", "SEVDESK_ALLOW"`.
- Folders must be mounted and named by their path inside the container, for example
  `"-v", "/Users/me/Belege:/belege:ro", "-e", "SEVDESK_FILE_DIRS=/belege"`.
- The OS keychain is not reachable from a container; pass the token, or mount a token file and
  set `SEVDESK_API_TOKEN_FILE`.
- `SEVDESK_CONFIRM=browser` does not work this way: the approval page would listen inside the
  container. Use a client with elicitation.
- The tag names one release, the one this page was published with: the image changes only when
  you change the tag. Only the latest release gets security fixes, so move the tag when a new
  release appears. The image also has a tag for the minor line (major and minor number only),
  which moves to each new patch release, and `latest`; Docker fetches a moved tag again only on
  `docker pull`. Verify the image first ([SECURITY.md](../SECURITY.md#supply-chain)).

## Other clients

Any client that can start a local MCP server over stdio works: command `npx`, arguments
`-y mcp-server-sevdesk`, the token in the environment. Check two things:

- **Confirmations.** If the client does not support MCP elicitation, set `SEVDESK_CONFIRM=browser`
  before you enable `commit` or `external`.
- **Node.js.** `npx` must find Node.js 22.12 or later. Clients started from a desktop icon may not
  see the `PATH` of your shell; then give the full path of `npx` as the command.

Clients on another machine, or shared by a team, connect to a server in remote mode with a bearer
secret or OAuth: see [Connecting clients](remote.md#connecting-clients).
