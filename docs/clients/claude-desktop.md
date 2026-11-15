# Claude Desktop

This page sets up the server in Claude Desktop on macOS and Windows: with the extension, with the
configuration file, or as a connector to a server you host. For the other clients, see
[Clients](../clients.md).

## What works

- **Tools** of the local server, started by Claude Desktop over stdio.
- **Confirmations:** Claude Desktop shows no confirmation in the chat (checked November 2026). Use
  `SEVDESK_CONFIRM=browser`, an approval page in your browser; it is the extension's default
  ([Confirmation modes](../permissions.md#confirmation-modes)).
- **Remote:** a claude.ai custom connector is also available in Claude Desktop when it is signed in
  to the same account ([Remote setup](#remote-setup)).

## Local setup

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
installed the same way, over the old one. What the bundle contains and how the token is passed:
[Claude Desktop extension](../security/local.md#claude-desktop-extension).

### The configuration file

Without the extension, Claude Desktop starts the server from its configuration file, which needs
Node.js 22.12 or later. Open it with **Settings → Developer → Edit Config**; it is at

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

Quit Claude Desktop completely and start it again. To keep the token out of the file, use
`SEVDESK_API_TOKEN_KEYCHAIN` or `SEVDESK_API_TOKEN_FILE` instead
([Profiles and keychain](../configuration/profiles.md#keep-the-token-in-the-os-keychain)).

## Remote setup

To use a server you host in [remote mode](../remote.md), add it as a custom connector in claude.ai
(OAuth mode). The connector is then available in Claude Desktop signed in to the same account. The
steps, and what changes for confirmations and files, are on
[claude.ai and the Claude apps](claude-ai.md).

## Gotchas

- **Logs.** The server's log is in `~/Library/Logs/Claude/mcp-server-sevdesk.log` on macOS and
  `%APPDATA%\Claude\logs` on Windows.
- **"Server disconnected".** Claude Desktop hides the server's stderr. With an invalid
  configuration the server therefore still starts and names the problems through its one tool,
  `sevdesk_setup_problem`; ask the assistant which setting to fix
  ([Command line](../configuration.md#command-line)).
- **Node.js not found.** Claude Desktop, started from its icon, may not see the `PATH` of your
  shell. Give the full path of `npx` as the command, or use the extension.
- **Windows keychain.** `SEVDESK_API_TOKEN_KEYCHAIN` needs Windows PowerShell in FullLanguage mode.
  If it is missing or restricted, use the extension or `SEVDESK_API_TOKEN_FILE`.
