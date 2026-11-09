# ADR 0008: File transfer over HTTP

- **Status:** Accepted
- **Date:** 2026-11-09
- **Amends:** [ADR 0007](0007-approval-inbox-over-http.md) (its browser session now also opens
  the upload and download pages)
- **Relates to:** [ADR 0006](0006-built-in-authorization-server-and-grant-store.md) (no sevDesk
  token outside an MCP request)

## Context

Several tools take or produce files: voucher drafts attach a receipt (Belegbild), the e-invoice
tools read an XRechnung or ZUGFeRD file, and `sevdesk_document_save`, `sevdesk_csv_export` and
`sevdesk_datev_export` hand out PDFs, XML, CSV and ZIP files. Over stdio these go through two
folders the user opts into, `SEVDESK_FILE_DIRS` and `SEVDESK_OUTPUT_DIR`. A remote server has
neither:

- the folders would be on the server, not on the user's computer, and in OAuth mode one disk
  would be shared by every connected account, so OAuth mode refused them;
- so claude.ai and the Claude apps, the main remote clients, could not attach a receipt to a
  voucher, import an e-invoice or get an export at all;
- the model cannot carry the bytes: MCP tool arguments are JSON the model writes, and a receipt
  of several megabytes as base64 in the context would be slow, costly and easy to corrupt;
- [ADR 0007](0007-approval-inbox-over-http.md) already rejected links the model sees as
  capabilities: a prompt-injected model can pass a link on;
- in OAuth mode the server holds no sevDesk token outside an MCP request
  ([ADR 0006](0006-built-in-authorization-server-and-grant-store.md)), so it cannot call sevDesk
  when someone opens a link later.

## Decision

**In HTTP mode, files travel through pages of the server in the user's browser**
(`SEVDESK_HTTP_FILES`, on by default; `src/http/transfer-routes.ts`):

- **Uploads.** A new read-tier tool, `sevdesk_upload_request` (purpose `receipt` or `einvoice`),
  opens an upload page `<public URL>/uploads/<id>` and returns its `uploadId` (`upload:<id>`), a
  reference code and the expiry. The user uploads one file there; the model then passes the
  `uploadId` as the existing `file` argument. The page shows only trusted values (purpose,
  accepted kinds, size limit, account, reference, expiry): the model cannot put text on it. The
  file type is checked by content, the name is cleaned and never used as a path.
- **Downloads.** The delivering tools return `download {url, reference, expiresAt}` instead of
  `savedTo`. The bytes are fetched from sevDesk **during the tool call** (PDFs still with
  `preventSendBy=true`) and kept; `GET /files/<id>` serves them and makes no sevDesk request.
  Downloads are always attachments (`Content-Disposition: attachment`) under
  `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` and no framing, so a file is
  never rendered on the server's origin.

**URLs are not capabilities; the browser proves the account.** Every page needs the browser
session of ADR 0007 for the record's account. Without one, it shows the sign-in form with a `next`
back to the page (only the server's own record paths pass, so it is no open redirect). A record of
another account answers exactly like an unknown id. The session is set at OAuth consent whenever
the inbox or file transfer is on, or by signing in with the account's sevDesk token; in bearer mode
the grant store opens for these sessions whenever file transfer is on. Uploads are POSTs with a
CSRF token bound to the session, from the page itself (`Origin`), and pass their checks (session,
open ticket of that account, declared `Content-Length` within the limit, at most two at once)
before the body is read.

**Tools use only their own connection's uploads; pages go by account.** An upload belongs to the
principal that asked (grant and account): another grant of the same account gets the same answer
as for an unknown id. The pages, like the inbox, serve every session of the account.

**Process-lifetime, encrypted storage.** Records live in memory (`src/safety/transfer-store.ts`);
the bytes go to `<stateDir>/files/` (or memory without a state directory), encrypted with
AES-256-GCM under a key drawn at random when the process starts and never written down, with the
blob id, account and kind as additional data (`src/safety/blob-store.ts`). The folder is emptied at
startup, after the grant store took its lock. A restart voids every upload page, upload and link,
as it voids approvals.

**One input field.** `file` takes a path or an `upload:<id>`, through a `FileAccess` the registry
builds per call (`src/safety/file-sources.ts`). The schemas stay static, so `tools/list` is stable
per configuration. Bearer mode keeps its folders: a plain path still reads `SEVDESK_FILE_DIRS`, and
`SEVDESK_OUTPUT_DIR` wins over links.

**Bounded.** An upload page lives 15 minutes and takes one file of at most 20 MB; uploads and links
live `SEVDESK_HTTP_FILES_TTL` (30 minutes); a link serves 5 downloads. Per account 5 open pages, 10
live records and half of `SEVDESK_HTTP_FILES_MAX_MB`; nothing is evicted, new records are refused.
Logs and audit lines carry the reference, kind, size and SHA-256, never ids or file names.

## Consequences

- Good: claude.ai and the Claude apps can attach receipts, import e-invoices and get PDFs and
  exports, with the same tools and arguments as over stdio.
- Good: a link the model passes on, or that ends up in a log or a screenshot, is useless without a
  session of the account.
- Good: nothing outlives the process: a stolen volume holds only ciphertext under a key that was
  never stored, and a restart is a full purge.
- Good: opening a link has no side effect in sevDesk.
- Bad: the user needs a browser session of the account. The Claude apps may open links in a
  browser without the consent's cookie; the user signs in with the sevDesk token there.
- Bad: a restart loses uploads and links, and the model has to ask again.
- Bad: download bytes are fetched even if nobody downloads them, and count against the same space
  as uploads: a large DATEV ZIP may not fit, after sevDesk has started the export (the tool says
  so and points to sevDesk).
- Bad: memory. Without a state directory files sit in memory; an upload is held about three times
  while parsed, hence two uploads at once at most.
- Bad: reverse proxies must pass bodies over 20 MB and `Content-Length` (nginx needs
  `client_max_body_size`).
- Bad: as with the inbox, an agent that drives a signed-in browser could upload or download on its
  own.
- Bad: with `SEVDESK_OAUTH_ACCOUNTS=any` the server briefly holds other people's receipts and
  exports (startup warns).

## Alternatives considered

- **Capability URLs** (a secret link per upload or download, no sign-in). Rejected for the reason
  of ADR 0007: the model sees the link, so a prompt injection could send an attacker a download or
  let them upload a forged receipt.
- **Fetch on click** (store only the document id, call sevDesk when the link is opened). Rejected:
  in OAuth mode the server has no sevDesk token outside an MCP request (ADR 0006), and a GET that
  calls sevDesk could have side effects and outlive the grant's tiers.
- **Persistent encrypted blobs** (a key derived from the server secret, kept across restarts).
  Rejected: leftover blobs would be readable by anyone with the secret and a copy of the volume,
  and it would need a persisted index of records. Short-lived files do not need to survive a
  restart.
- **A separate `uploadId` field** next to `file`. Rejected: two mutually exclusive fields on every
  file tool, and schemas that differ per mode would make `tools/list` unstable. The `upload:`
  prefix is unambiguous; a local file with that name is passed as `./upload:…`.
- **Bytes through the model** (base64 arguments, embedded resources in results). Rejected: size,
  cost and corruption, and claude.ai does not save embedded files for the user.
- **A server folder per account in OAuth mode.** Rejected: the files would still be on the server,
  not with the user, and the disk would need its own cleanup and access model.
