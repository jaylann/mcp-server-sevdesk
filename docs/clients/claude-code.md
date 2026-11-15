# Claude Code

This page sets up the server in Claude Code: as a local server, as the `sevdesk` plugin with its
bookkeeping skill, or connected to a server you host. For the other clients, see
[Clients](../clients.md).

## What works

- **Tools and prompts.** The server's [prompts](../../README.md#prompts) appear in the
  `/` menu as `/sevdesk:month_end_close (MCP)`; typing `/mcp__sevdesk__month_end_close 2026-10`
  runs one with an argument. Run `/mcp` to see the server and its tools.
- **Confirmations** appear as a dialog in interactive sessions, with the default
  `SEVDESK_CONFIRM=elicit` ([Confirmation modes](../permissions.md#confirmation-modes)). In print
  mode (`claude -p`) nobody can answer one: use [dry runs](../permissions.md#dry-run) or
  `SEVDESK_CONFIRM=browser`.
- **Remote:** OAuth and bearer mode both work ([Remote setup](#remote-setup)).

## Local setup

Claude Code needs Node.js 22.12 or later for `npx`. Add the server for all your projects
(`--scope user`), with the token from the keychain:

```bash
npx -y mcp-server-sevdesk token set work
claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
```

More settings are more `--env NAME=value` options before `--scope`. Everything after `--` is the
command Claude Code runs. The keychain is explained in
[Profiles and keychain](../configuration/profiles.md#keep-the-token-in-the-os-keychain).

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

### The plugin

The repository is also a Claude Code plugin marketplace. The `sevdesk` plugin starts this server
and adds a bookkeeping skill: German tax rules and their sevDesk tax rules (including §13b reverse
charge and §19 Kleinunternehmer), common SKR03 and SKR04 accounts, GoBD, the e-invoice
obligations, and step-by-step workflows for receipts, e-invoices, bank reconciliation, the VAT
pre-check, month and year end.

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

On Claude Code 2.1.275 or later, one step is enough:
`/plugin install sevdesk --marketplace jaylann/mcp-server-sevdesk`.

The plugin starts the release it belongs to (`npx -y mcp-server-sevdesk@<version>`), so a new
npm version never runs before you update the plugin. It passes the `SEVDESK_*` variables of the
environment Claude Code was started in, for example from your shell profile. It needs at least a
token variable and stays read-only unless you set `SEVDESK_ALLOW`:

```bash
export SEVDESK_API_TOKEN_KEYCHAIN=work   # or SEVDESK_API_TOKEN / SEVDESK_API_TOKEN_FILE
export SEVDESK_ALLOW=write               # optional; read-only without it
```

The plugin passes every variable, so the ones you don't use arrive empty; an empty value counts as
unset ([Configuration](../configuration.md)).

## Remote setup

Connect Claude Code to a server you host in [remote mode](../remote.md). The MCP endpoint is
always `<public URL>/mcp`.

With OAuth:

```bash
claude mcp add --transport http sevdesk https://<host>/mcp
```

Then run `/mcp` in Claude Code and choose to authenticate: the consent page opens in your browser
and sends you back to Claude Code. Claude Code identifies itself with its own metadata document,
served from `claude.ai` like claude.ai's (so the default `SEVDESK_OAUTH_CLIENTS` covers it), and a
loopback redirect, which the consent page points out.

With a bearer secret (read it from a file or your password manager instead of typing it):

```bash
claude mcp add --transport http sevdesk https://<host>/mcp \
  --header "Authorization: Bearer $MCP_BEARER_SECRET"
```

Which mode to choose: [Bearer or OAuth](../remote.md#bearer-or-oauth). Over HTTP, a confirmation
in the chat also needs a client that speaks the 2026-07-28 protocol with form elicitation;
otherwise set `SEVDESK_CONFIRM=browser` on the server and approve in its
[approval inbox](../remote/approvals.md).

## Gotchas

- **Shell history.** Avoid `--env SEVDESK_API_TOKEN=<token>` on the command line: it stays in your
  shell history. Use the keychain or a token file.
- **Print mode** cannot answer confirmations (see [What works](#what-works)).
- **Plugin settings** come from the environment Claude Code was started in, not from a
  configuration file: restart Claude Code after changing your shell profile.
