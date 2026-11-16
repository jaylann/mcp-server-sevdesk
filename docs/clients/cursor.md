# Cursor

This page sets up the server in Cursor: started locally, or connected to a server you host. For
the other clients, see [Clients](../clients.md).

## What works

- **Tools** of the local server, started by Cursor over stdio.
- **Confirmations** appear in the chat with the default `SEVDESK_CONFIRM=elicit`
  ([Confirmation modes](../permissions.md#confirmation-modes)).
- **Remote:** bearer mode ([Remote setup](#remote-setup)).

## Local setup

Cursor needs Node.js 22.12 or later for `npx`. In `~/.cursor/mcp.json` (all projects) or
`.cursor/mcp.json` in a project:

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

Every other setting goes into the same `env` block ([Configuration](../configuration.md)); without
any, the server is read-only.

## Remote setup

Connect Cursor to a server you host in [remote mode](../remote.md) with a bearer secret. In
`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "sevdesk": {
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer ${env:MCP_BEARER_SECRET}" }
    }
  }
}
```

`${env:MCP_BEARER_SECRET}` reads the secret from the environment Cursor was started in, so it stays
out of the file. Over HTTP, a confirmation in the chat also needs a client that speaks the
2026-07-28 protocol with form elicitation; otherwise set `SEVDESK_CONFIRM=browser` on the server
and approve in its [approval inbox](../remote/approvals.md).

## Gotchas

- **Committed project files.** Keep a token out of a `.cursor/mcp.json` that is committed: use
  `SEVDESK_API_TOKEN_KEYCHAIN`
  ([Profiles and keychain](../configuration/profiles.md#keep-the-token-in-the-os-keychain)), or
  `"${env:SEVDESK_API_TOKEN}"` to read it from the environment Cursor was started in.
- **Node.js not found.** Started from a desktop icon, Cursor may not see the `PATH` of your shell;
  then give the full path of `npx` as the command.
