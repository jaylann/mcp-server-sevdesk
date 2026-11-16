# Codex

This page sets up the server in Codex: started locally, or connected to a server you host. For the
other clients, see [Clients](../clients.md).

## What works

- **Tools** of the local server, started by Codex over stdio.
- **Confirmations:** whether Codex shows confirmations in the chat (MCP elicitation) is not
  documented. Set `SEVDESK_CONFIRM=browser`, an approval page in your browser, before you enable
  `commit` or `external` ([Confirmation modes](../permissions.md#confirmation-modes)). When a
  client cannot be asked, the tool answers with an error that says so, and nothing is sent to
  sevDesk.

## Local setup

Codex needs Node.js 22.12 or later for `npx`. Store the token in the keychain
([Profiles and keychain](../configuration/profiles.md#keep-the-token-in-the-os-keychain)):

```bash
npx -y mcp-server-sevdesk token set work
```

Then, in `~/.codex/config.toml`:

```toml
[mcp_servers.sevdesk]
command = "npx"
args = ["-y", "mcp-server-sevdesk"]

[mcp_servers.sevdesk.env]
SEVDESK_API_TOKEN_KEYCHAIN = "work"
SEVDESK_CONFIRM = "browser"
```

Or with the command line:

```bash
codex mcp add sevdesk --env SEVDESK_API_TOKEN_KEYCHAIN=work -- npx -y mcp-server-sevdesk
```

To pass variables from the environment Codex runs in instead, list them:
`env_vars = ["SEVDESK_API_TOKEN"]`. Every other setting goes into the same `env` table
([Configuration](../configuration.md)).

## Remote setup

A server you host in [remote mode](../remote.md) works with any client that speaks Streamable
HTTP and can send a header, in bearer mode: the URL is `https://<host>/mcp` and the header
`Authorization: Bearer <secret>`. This documentation has no tested Codex entry for it; take the
format for a remote server from Codex's own documentation. On the server, set
`SEVDESK_CONFIRM=browser` and approve in its [approval inbox](../remote/approvals.md).

## Gotchas

- **`env` or `env_vars`.** `[mcp_servers.sevdesk.env]` sets values in the file; `env_vars` only
  names variables that Codex hands on from its own environment.
- **Node.js not found.** `npx` must find Node.js 22.12 or later; if Codex does not see the `PATH`
  of your shell, give the full path of `npx` as the command.
