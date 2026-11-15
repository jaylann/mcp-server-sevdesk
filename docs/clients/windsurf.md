# Windsurf

This page sets up the server in Windsurf: started locally, or connected to a server you host. For
the other clients, see [Clients](../clients.md).

## What works

- **Tools** of the local server, started by Windsurf over stdio.
- **Confirmations:** whether Windsurf shows confirmations in the chat (MCP elicitation) is not
  documented. Set `SEVDESK_CONFIRM=browser`, an approval page in your browser, before you enable
  `commit` or `external` ([Confirmation modes](../permissions.md#confirmation-modes)). When a
  client cannot be asked, the tool answers with an error that says so, and nothing is sent to
  sevDesk.

## Local setup

Windsurf needs Node.js 22.12 or later for `npx`. It keeps its MCP servers in `mcp_config.json`;
open it from Cascade's MCP settings (its location has changed between versions). Add:

```json
{
  "mcpServers": {
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

`"${env:SEVDESK_API_TOKEN}"` reads the token from the environment instead. Refresh the server list
in the MCP settings, or restart Windsurf. Every other setting goes into the same `env` block
([Configuration](../configuration.md)).

## Remote setup

A server you host in [remote mode](../remote.md) works with any client that speaks Streamable
HTTP and can send a header, in bearer mode: the URL is `https://<host>/mcp` and the header
`Authorization: Bearer <secret>`. This documentation has no tested Windsurf entry for it; take
the format for a remote server from Windsurf's own documentation. On the server, set
`SEVDESK_CONFIRM=browser` and approve in its [approval inbox](../remote/approvals.md).

## Gotchas

- **The file moves.** The location of `mcp_config.json` has changed between Windsurf versions;
  open it from the MCP settings rather than by path.
- **Node.js not found.** Started from a desktop icon, Windsurf may not see the `PATH` of your
  shell; then give the full path of `npx` as the command.
