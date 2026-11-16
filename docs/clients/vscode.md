# VS Code

This page sets up the server in VS Code with GitHub Copilot: started locally, or connected to a
server you host. For the other clients, see [Clients](../clients.md).

## What works

- **Tools and prompts** of the local server, started by VS Code over stdio. Prompts run as
  `/sevdesk.month_end_close` in the chat.
- **Confirmations** appear in the chat with the default `SEVDESK_CONFIRM=elicit`
  ([Confirmation modes](../permissions.md#confirmation-modes)).
- **Remote:** bearer mode ([Remote setup](#remote-setup)).

## Local setup

VS Code needs Node.js 22.12 or later for `npx`. Put the server in `.vscode/mcp.json` in a
workspace, or in your user configuration (Command Palette: **MCP: Open User Configuration**). The
`inputs` entry asks for the token once, hidden, and VS Code stores it securely:

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

Every other setting goes into the same `env` block ([Configuration](../configuration.md)); without
any, the server is read-only.

## Remote setup

Connect VS Code to a server you host in [remote mode](../remote.md) with a bearer secret. In
`.vscode/mcp.json`, with a password prompt so the secret stays out of the file:

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

Over HTTP, a confirmation in the chat also needs a client that speaks the 2026-07-28 protocol with
form elicitation; otherwise set `SEVDESK_CONFIRM=browser` on the server and approve in its
[approval inbox](../remote/approvals.md).

## Gotchas

- **The JSON shape differs.** VS Code uses `servers` with a `type` (`stdio` or `http`), not the
  `mcpServers` of most other clients.
- **Node.js not found.** Started from a desktop icon, VS Code may not see the `PATH` of your shell;
  then give the full path of `npx` as the command.
