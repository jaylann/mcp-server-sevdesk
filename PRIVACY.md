# Privacy

mcp-server-sevdesk is software you run yourself. The project does not operate any service and
collects **no telemetry**.

- **Data flow.** The server sends its requests to the sevDesk API
  (`https://my.sevdesk.de/api/v1`, or the `SEVDESK_BASE_URL` you set) with your token, and returns
  results to the MCP client you connected (for example Claude Desktop). What your client or model
  provider does with that data is governed by their terms. It contacts no other host, with two
  exceptions:
  - **DATEV export.** `sevdesk_datev_export` (`write` tier) downloads the finished ZIP from
    sevDesk's export storage on Amazon S3
    (`sevexport-filestorage-workload-prod.s3.eu-central-1.amazonaws.com`), through the presigned
    link sevDesk returns for the export. The request carries that link and no sevDesk token; the
    storage host sees the server's IP address and the time. A link to any other host is refused,
    and redirects are not followed.
  - **Client metadata in remote mode with OAuth**: see "Third parties" under
    [Remote mode](#remote-mode).
- **Confirmation page.** With `SEVDESK_CONFIRM=browser` (local use) the preview of an action is
  shown on a page the server serves on `127.0.0.1` and opens in your default browser through the
  operating system's opener; `SEVDESK_CONFIRM_OPEN=0` only writes the link to the server log. The
  page loads nothing from other hosts.
- **Local storage.** Nothing is stored unless you enable it: the optional audit log
  (`SEVDESK_AUDIT_LOG`) and output directory (`SEVDESK_OUTPUT_DIR`) are files on your machine.
- **Your token.** If you use `token set`, the token is stored in your operating system's keychain
  (macOS Keychain, the Linux Secret Service or Windows Credential Locker through `PasswordVault`)
  under the service `mcp-server-sevdesk`. On Windows, credentials can
  [synchronize between devices through your Microsoft account](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker).
  If the token must stay on this device, use `SEVDESK_API_TOKEN_FILE` with a file only your user
  can read, outside synchronized folders. A profiles file holds settings and where each token is
  kept (a keychain label, a file path or a variable name), never a token. The Claude Desktop
  extension's settings, including the token, are stored by Claude Desktop, the token in the
  operating system's secure storage.
- **Accounting data is personal data.** Invoices and contacts contain personal data of your
  customers. Review your model provider's data-processing terms before connecting a live account.

## Remote mode

If you self-host the HTTP transport ([docs/remote.md](docs/remote.md)), you are the operator and
responsible for the personal data processed there (GDPR). With `SEVDESK_OAUTH_ACCOUNTS=any` that
can include other people's accounts.

- **What the server stores.** In OAuth mode the state directory (`SEVDESK_HTTP_STATE_DIR`, or
  memory) holds, per connection, a random grant id, the sevDesk account id, the client's
  `client_id` URL and host, the granted tiers, timestamps and the status; per browser sign-in (the
  approval inbox and the upload and download pages), a random session id, the account id and the
  grant it came from. It holds **no tokens**: no sevDesk tokens, no access or refresh tokens, no
  cookies. The sevDesk token is encrypted into the tokens the client holds. In bearer mode the
  server's own environment holds the one sevDesk token.
- **Documents are held briefly, encrypted.** With file transfer (`SEVDESK_HTTP_FILES`, on by
  default) the server keeps the receipts and e-invoices users upload, and the PDFs and exports
  tools hand out as download links, for `SEVDESK_HTTP_FILES_TTL` (30 minutes by default, at most
  24 hours). They are encrypted under a key that exists only in the running process, kept in
  memory or in the state directory's `files/` folder, deleted when they expire and at shutdown,
  and the folder is emptied at every start: a restart voids them all. In memory the server also
  keeps who each file belongs to, its cleaned name, size, SHA-256 and expiry; the audit log notes
  each upload and download without name or content. Uploads and downloads need a browser session
  of the account. With `SEVDESK_OAUTH_ACCOUNTS=any` this covers the documents of every account
  that connects.
- **The audit log covers every account.** With `SEVDESK_AUDIT_LOG`, one file records the write
  calls of every connected account, with previews that contain customer names, amounts, e-mail
  texts and the names of receipt files, and names the account and the grant on each line.
- **Third parties.** When someone starts an OAuth connection, the server fetches the client's
  metadata document from the client's host (for claude.ai: `claude.ai`); that host sees the
  server's IP address and the time. Whoever terminates TLS in front of the server (a tunnel such
  as Cloudflare's, or a platform such as Fly.io, Render or Railway) processes all traffic,
  including tokens and accounting data, and is a processor you choose. The server's request log
  holds client IP addresses.
