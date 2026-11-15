# Clients

Every MCP client that can start a local program runs this server the same way: the command
`npx -y mcp-server-sevdesk`, with your sevDesk API token in the environment. Clients that cannot
start a program, such as claude.ai and the Claude mobile apps, connect to a server you host in
[remote mode](remote.md). This page shows which clients work and how they ask you for
confirmations; each client has its own page with the exact setup, local and remote.

Before you start:

- **Node.js 22.12 or later** for `npx`. The
  [Claude Desktop extension](clients/claude-desktop.md#the-extension) and
  [Docker](#docker-instead-of-npx) need none.
- **A sevDesk API token**, ideally of a dedicated user ([Quickstart](quickstart.md#before-you-start)).

The examples put the token itself into the configuration as `SEVDESK_API_TOKEN`. To keep it out of
the file, replace that line with `"SEVDESK_API_TOKEN_KEYCHAIN": "<label>"` after storing the token
with `npx -y mcp-server-sevdesk token set <label>` (macOS, Linux and Windows), or with
`"SEVDESK_API_TOKEN_FILE": "/absolute/path/to/token"`
([Profiles and keychain](configuration/profiles.md#keep-the-token-in-the-os-keychain)). Every
other setting goes into the same `env` block ([Configuration](configuration.md)); without any, the
server is read-only.

## Client pages

| Client                                                | Local (stdio)                    | Remote (HTTP)                 |
| ----------------------------------------------------- | -------------------------------- | ----------------------------- |
| [Claude Desktop](clients/claude-desktop.md)           | extension or configuration file  | through a claude.ai connector |
| [Claude Code](clients/claude-code.md)                 | `claude mcp add`, or the plugin  | OAuth or bearer               |
| [claude.ai and the Claude apps](clients/claude-ai.md) | not possible                     | OAuth (custom connector)      |
| [Cursor](clients/cursor.md)                           | `mcp.json`                       | bearer                        |
| [VS Code](clients/vscode.md)                          | `mcp.json`                       | bearer                        |
| [Windsurf](clients/windsurf.md)                       | `mcp_config.json`                | bearer (generic)              |
| [Codex](clients/codex.md)                             | `config.toml` or `codex mcp add` | bearer (generic)              |
| [Zed](clients/zed.md)                                 | `settings.json`                  | bearer (generic)              |

"Generic" means that any client that speaks Streamable HTTP and can send a header works, but this
documentation has no tested entry for that client ([Other clients](#other-clients)).

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

Over HTTP, `elicit` also needs a client that speaks the 2026-07-28 protocol and supports form
elicitation; with any other client, set `SEVDESK_CONFIRM=browser` on the server and approve in its
[approval inbox](remote/approvals.md) ([Remote configuration](remote/configuration.md)).

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
  `docker pull`. Verify the image first
  ([Verifying the image](remote/deployment.md#verifying-the-image)).

## Other clients

### Local

Any client that can start a local MCP server over stdio works: command `npx`, arguments
`-y mcp-server-sevdesk`, the token in the environment. Check two things:

- **Confirmations.** If the client does not support MCP elicitation, set `SEVDESK_CONFIRM=browser`
  before you enable `commit` or `external`.
- **Node.js.** `npx` must find Node.js 22.12 or later. Clients started from a desktop icon may not
  see the `PATH` of your shell; then give the full path of `npx` as the command.

### Remote

Clients on another machine, or shared by a team, connect to a server in [remote mode](remote.md).
The MCP endpoint is always `<public URL>/mcp`, for example `https://mcp.example.com/mcp`.

- **Bearer mode:** any client that speaks Streamable HTTP and can send a header
  (`Authorization: Bearer <secret>`) works.
- **OAuth mode:** a client needs Client ID Metadata Documents; add the host of its `client_id` URL
  to `SEVDESK_OAUTH_CLIENTS`. A client that only supports Dynamic Client Registration cannot use
  OAuth mode; use bearer mode for it ([Bearer or OAuth](remote.md#bearer-or-oauth)).
