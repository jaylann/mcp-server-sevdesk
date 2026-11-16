# Zed

This page sets up the server in Zed: started locally, or connected to a server you host. For the
other clients, see [Clients](../clients.md).

## What works

- **Tools and prompts** of the local server, started by Zed over stdio.
- **Confirmations:** Zed does not support MCP elicitation, so it cannot show confirmations in the
  chat. Set `SEVDESK_CONFIRM=browser`, an approval page in your browser, before you enable `commit`
  or `external` ([Confirmation modes](../permissions.md#confirmation-modes)). When a client cannot
  be asked, the tool answers with an error that says so, and nothing is sent to sevDesk.

## Local setup

Zed needs Node.js 22.12 or later for `npx`. In Zed's `settings.json` (or **Settings → AI → MCP
Servers → Add Server → Add Local Server**):

```json
{
  "context_servers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>",
        "SEVDESK_CONFIRM": "browser"
      }
    }
  }
}
```

Every other setting goes into the same `env` block ([Configuration](../configuration.md)); without
any, the server is read-only. To keep the token out of the file, use `SEVDESK_API_TOKEN_KEYCHAIN`
or `SEVDESK_API_TOKEN_FILE`
([Profiles and keychain](../configuration/profiles.md#keep-the-token-in-the-os-keychain)).

## Remote setup

A server you host in [remote mode](../remote.md) works with any client that speaks Streamable
HTTP and can send a header, in bearer mode: the URL is `https://<host>/mcp` and the header
`Authorization: Bearer <secret>`. This documentation has no tested Zed entry for it; take the
format for a remote server from Zed's own documentation. On the server, set
`SEVDESK_CONFIRM=browser` and approve in its [approval inbox](../remote/approvals.md).

## Gotchas

- **`context_servers`, not `mcpServers`.** Zed names its MCP servers differently from most other
  clients.
- **Node.js not found.** Started from a desktop icon, Zed may not see the `PATH` of your shell;
  then give the full path of `npx` as the command.
