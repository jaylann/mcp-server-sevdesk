# Privacy

mcp-server-sevdesk is software you run yourself. The project does not operate any service and
collects **no telemetry**.

- **Data flow.** The server talks only to the sevDesk API (`https://my.sevdesk.de/api/v1`) with
  your token, and returns results to the MCP client you connected (for example Claude Desktop).
  What your client or model provider does with that data is governed by their terms.
- **Local storage.** Nothing is stored unless you enable it: the optional audit log
  (`SEVDESK_AUDIT_LOG`) and output directory (`SEVDESK_OUTPUT_DIR`) are files on your machine.
- **Accounting data is personal data.** Invoices and contacts contain personal data of your
  customers. Review your model provider's data-processing terms before connecting a live account.

## Remote mode

If you self-host the HTTP transport ([docs/remote.md](docs/remote.md)), you are the operator and
responsible for the personal data processed there (GDPR). With `SEVDESK_OAUTH_ACCOUNTS=any` that
can include other people's accounts.

- **What the server stores.** In OAuth mode the state directory (`SEVDESK_HTTP_STATE_DIR`, or
  memory) holds, per connection, a random grant id, the sevDesk account id, the client's
  `client_id` URL and host, the granted tiers, timestamps and the status; per approval-inbox
  sign-in, a random session id, the account id and the grant it came from. It holds **no tokens**:
  no sevDesk tokens, no access or refresh tokens, no cookies. The sevDesk token is encrypted into
  the tokens the client holds. In bearer mode the server's own environment holds the one sevDesk
  token.
- **The audit log covers every account.** With `SEVDESK_AUDIT_LOG`, one file records the write
  calls of every connected account, with previews that contain customer names, amounts and e-mail
  texts, and names the account and the grant on each line.
- **Third parties.** When someone starts an OAuth connection, the server fetches the client's
  metadata document from the client's host (for claude.ai: `claude.ai`); that host sees the
  server's IP address and the time. Whoever terminates TLS in front of the server (a tunnel such
  as Cloudflare's, or a platform such as Fly.io, Render or Railway) processes all traffic,
  including tokens and accounting data, and is a processor you choose. The server's request log
  holds client IP addresses.
