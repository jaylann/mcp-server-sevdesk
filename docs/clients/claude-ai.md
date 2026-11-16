# claude.ai and the Claude apps

This page connects claude.ai, and with it Claude Desktop and the Claude mobile apps signed in to
the same account, to a server you host. For the other clients, see [Clients](../clients.md).

## What works

- **Tools**, through a custom connector to your server in remote mode.
- **Confirmations:** claude.ai cannot show confirmations in the chat at the time of writing. Set
  `SEVDESK_CONFIRM=browser` on the server when you enable `commit` or `external`: you then approve
  in the server's [approval inbox](../remote/approvals.md).
- **Files:** receipts are uploaded and exports downloaded through pages on your server, opened from
  links in the chat ([Files over HTTP](../remote/files.md)).
- **Every app on the account:** the connector is also available in Claude Desktop and the mobile
  apps signed in to the same account.

## Local setup

There is none: claude.ai cannot start a program on your computer. For Claude Desktop on your own
computer, a [local server](claude-desktop.md) is the simpler choice.

## Remote setup

claude.ai connects to a server you host in remote mode with OAuth (`SEVDESK_HTTP_AUTH=oauth`): on
a VM, a platform such as Fly.io, or your own machine behind a tunnel. There is no hosted instance.

1. Run the server. The
   [remote mode quick start](../remote.md#quick-start-oauth-with-a-claudeai-custom-connector)
   walks through it; the [deployment guide](../remote/deployment.md) has templates.
2. In claude.ai: **Settings → Connectors → Add custom connector**, with the URL
   `https://<your host>/mcp`. The MCP endpoint is always `<public URL>/mcp`.
3. claude.ai opens the consent page on your server. Choose the tiers for this connection and paste
   your sevDesk API token once.

The connector is then available in the Claude apps signed in to the same account.

To end the connection, remove the connector in claude.ai, which drops its tokens there;
[revoking the grant](../remote/operations.md#revoking-access) also ends it on the server.

## Gotchas

- **OAuth only.** claude.ai custom connectors need OAuth mode; bearer mode is for clients you
  configure yourself ([Bearer or OAuth](../remote.md#bearer-or-oauth)).
- **Only listed accounts.** In OAuth mode only the sevDesk accounts in `SEVDESK_OAUTH_ACCOUNTS` can
  connect; a refused user sees their own account id on the consent page
  ([Remote configuration](../remote/configuration.md)).
- **Startup warning.** The server warns at startup when the default `SEVDESK_CONFIRM=elicit` is
  combined with `commit` or `external`, because claude.ai cannot be asked over stateless HTTP.
- **Long reports.** Over HTTP a report stops reading documents after about 90 seconds and says so;
  ask for a month instead of a quarter or a year.
