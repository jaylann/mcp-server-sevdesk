# ADR 0008: File transfer over HTTP

- **Status:** Accepted; the pages' look, language and policy amended by
  [ADR 0010](0010-server-pages-in-two-languages.md); upload release and configurable count amended
  2026-11-12 ([#35](https://github.com/jaylann/mcp-server-sevdesk/issues/35)); batch uploads amended
  2026-11-12 ([#34](https://github.com/jaylann/mcp-server-sevdesk/issues/34)); files from an https
  link amended 2026-11-16 ([#96](https://github.com/jaylann/mcp-server-sevdesk/issues/96))
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
  file type is checked by content, the name is cleaned and never used as a path. The tool stays in
  the read tier (it changes nothing in sevDesk) but declares `readOnlyHint: false`: every call
  opens a ticket on this server, and an account holds only a few at a time, so a client must not
  treat it as free of effects (the same rule as for the read-tier tools that create a download
  link).
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

**Bounded.** An upload page lives 15 minutes and takes 1–10 files, each at most 20 MiB; uploads and links
live `SEVDESK_HTTP_FILES_TTL` (30 minutes); a link serves 5 downloads. Per account 5 open pages, 10
live records by default (`SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`, whole numbers 1–1000) and a quarter
of `SEVDESK_HTTP_FILES_MAX_MB` (at least one 20 MiB upload, at most half); room for one upload stays free for accounts that hold nothing yet. Nothing is evicted, new
records are refused. Upload bodies: 2 at once on the server and 1 per account, each within 90 s,
without a 10 s pause and at 16 KB/s on average after 10 s, so a trickled body cannot hold a slot.
Node's own request timeout is set above the longest body window of any route (the 90 s plus 30 s
for the headers and the checks before the body), so it never cuts an upload the route still
allows; with a fixed 30 s it did. A download is written in slices of 64 KiB, and the connection
is dropped when the client takes no slice for a minute: that timer measures a client that stopped
reading, not the size of the file. (Written as one piece, every download that took longer than a
minute was cut, however steadily the client read; review 2026-11, round 3.)
Logs and audit lines carry the reference, kind, size and SHA-256, never ids or file names.

**Release after successful attachment (2026-11-12, #35).** Keeping used receipts for the full
30-minute lifetime limited an ordinary bookkeeping session to ten receipts. Create/update draft
and e-invoice import now release an upload immediately after the save and read-back succeed and
the read-back confirms an attached document. For updates, the document id must differ from the
attachment rechecked immediately before the save (or follow an explicitly absent attachment).
An unchanged id or unknown previous attachment state is ambiguous, so the upload is retained;
the preview's earlier attachment identity may already be stale. This also conservatively retains
a receipt if sevDesk replaces its contents under the same document id (review follow-up, 2026-11-13).
`FileAccess.release(ref)` delegates to the
owner-scoped, idempotent `TransferStore.releaseUpload(owner, id)`: it removes only an uploaded
ticket of the same grant and account and schedules its blob for deletion through the existing
expiry cleanup. Pending/receiving tickets, download links and local files are untouched. Reads,
e-invoice parsing, dry runs, failed writes and failed or uncertain attachment read-backs keep the
upload until expiry. No grace period: retries of failed calls keep their file; a new use after a
successful attachment needs a new upload. Blob deletion follows the existing best-effort expiry
contract, so a storage cleanup failure cannot turn a completed sevDesk write into a failed call.

The count setting changes only live records per account (tickets, uploads and links together).
The five pending pages, 1,000 global records, byte shares, global byte budget and reserve for empty
accounts remain unchanged. Count refusals name the earliest known expiry of the requesting
account only, including pending tickets and links. Receiving tickets and download reservations
have no fixed expiry yet and are excluded; with no known expiry the message says to retry once
older files expire or transfers finish. Global refusals never disclose another account's expiries. An expiry is a retry
time, not a reservation: using an upload or exhausting a link may release a slot sooner, while
another request may claim it first.

**Batch uploads (2026-11-12, #34).** `sevdesk_upload_request` accepts optional integer `count`
(1–10). Absent or `1` preserves the exact single-file response. For `count > 1` it returns
`batchId`, `count` and one URL, replacing the singular `uploadId`. The read-tier,
read-only `sevdesk_uploads_list(batchId)` resolves that connection's batch into file slots with
`uploadId`, status, and (once uploaded) cleaned name, kind, size, SHA-256 and individual expiry.
No bytes travel through the model. Names remain untrusted data, never trusted instructions or
log fields. Duplicate cleaned names are kept as separate slots; the model must clarify an
ambiguous match rather than guess. This adds one read tool: preallocated per-slot IDs alone
cannot tell the model which cleaned name the human selected for which slot without a manual
mapping step or adding polling parameters to the allocating tool. Reads and allocation remain
separate.

Creation reserves all N records synchronously, or none, against both the account record limit
(including download reservations) and the global record limit. A refusal reports remaining
account room and reuses the account-only earliest-expiry information above. Pending pages are
counted by batch, so a ten-file batch uses one of the five pages and ten record slots. Every file
still passes content sniffing, per-file size, byte quotas, session and CSRF checks, encrypted
storage and grant/account ownership. Successful attachment releases only that file's slot.

The native `multiple` input submits repeated `file` parts beside exactly one `csrf` part and one
`slots` part, without script. The latter binds the form to the ordered pending slot IDs shown
when it was rendered. A stale binding is refused with 409 before any files are stored, so replaying
a successful or partially successful submission cannot fill new slots with duplicate files.
Successful batch POSTs redirect with 303 to the GET progress page, making refresh safe. The raw
multipart delimiter cap becomes remaining slots + 3 before parsing; excess parts are refused.
Before body reading, the declared and actual body are capped to the smaller of the
remaining slots times the per-file size limit and the account's remaining byte share, plus 64 KiB
of framing, never above 200 MiB plus framing. The same two global / one per-account body slots,
90-second deadline and pace limits apply per submission. Parsed bodies can take about three
times that allowance in memory, so operators must size memory and proxy limits for batches.

Files are stored sequentially, with quotas and expiry checked for each. Earlier successful files
survive a later validation, storage or expiry failure; the page shows exactly those successes
and which slots remain. The same link accepts further submissions for pending slots until the
original deadline. A file claimed for storage before its ticket expires finishes under the
existing receiving-ticket rule; later files may expire while it is written. Each successful
file gets its own file TTL. Batch metadata exists only while at least one slot has a live ticket
or file, bounding metadata by the record cap; completed or fully expired batches become unknown.

**Files from an https link (2026-11-16, #96).** Receipts often already live at a URL (a supplier
portal, a download link, cloud storage), and downloading them only to upload them again costs the
user a round trip through the browser. The `file` argument therefore also takes an https link, in
every mode, stdio included, when the operator lists hosts in `SEVDESK_FILE_URL_HOSTS` (empty by
default: every link is refused, naming the setting, before any network I/O). The argument stays
one string, the third form next to a path and `upload:<id>` (anything that starts like a URL is a
link; a local file named like one is passed as `./https:…`), so schemas stay static and
`tools/list` stable, as above. The link comes from the model, so the download is fenced in like
the client metadata fetch of OAuth mode, whose guard moved to `src/safety/public-address.ts` and
`src/safety/pinned-https.ts` for both: https only, the default port, no user info, a host name on
the list (exact, or `*.example.com` for its subdomains), resolved once per download to public
addresses only, the connection pinned to the checked address; no cookies, credentials or sevDesk
token; 200 only, uncompressed, a content type that fits the content (checked on the headers before
the body is read), no web page where XML is expected, the caller's size limit (20 MiB) on
`Content-Length` and while streaming, 60 seconds in total, two downloads at once per account and
four in the process. **Redirects are followed**, at most three, each target checked by the same
rules including the list; a host keeps the address of its first resolution within one download.
Cloud storage and portals hand out links that redirect (to a storage or CDN host), and refusing
them would make the feature useless for them; the list still bounds every host a request reaches,
and a redirect off it is refused without naming the target. **Nothing is kept**: the bytes live in
the tool call, like a local file's, so `FileAccess.release` has nothing to release, and the real
call downloads the file again after a dry run. The previews of every file show its full SHA-256
as a fact of its own (a link's also the host), the results add `sha256` (every source) and
`downloadedFrom`. The file's name is the link's last path segment only when that is a file name
of at most 64 characters ending in `.pdf`, `.png`, `.jpg`, `.jpeg` or `.xml`, else
`download.<ext>`: a capability link may carry its token in the path, and the name is shown and
stored in sevDesk. Messages, previews and results show nothing else of a link, and the audit log
records a link argument as its scheme and host only (`https://host/…?[redacted]`). The tools that
take a file declare `openWorldHint: true` (their tiers stay), and `sevdesk_einvoice_parse`,
`sevdesk_voucher_import_einvoice` and `sevdesk_voucher_recognize_receipt` are offered with link
hosts alone too.
`sevdesk_receipt_folder_check` takes no file and never a link, only a folder inside
`SEVDESK_FILE_DIRS`, so it stays closed-world (`openWorldHint: false`), and link hosts alone
(`SEVDESK_FILE_URL_HOSTS`) do not offer it; `test/integration/metadata-lint.test.ts` checks both.

**Binding the real call to the checked bytes (2026-11-17, review of #101).** A dry run and the
real call read the file separately: a link is downloaded again, an upload or a local file can be
replaced in between, so the real call may attach other bytes than the preview a human checked.
Every tool that takes `file` therefore also takes an optional `fileSha256` (64 hex characters, any
case). When it is given, the call computes the SHA-256 of the bytes it is about to use, in a dry
run as in the real call, and refuses before anything reaches sevDesk when they differ; the message
names both hashes, shortened, and nothing of the file or its reference. The full SHA-256 to pass
comes from the dry run's preview (or `sevdesk_einvoice_parse`'s `file.sha256`). Without
`fileSha256` nothing changes.

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
  while parsed, hence two uploads at once at most. One per account keeps a single account from
  taking both; two accounts together can still keep others waiting for up to 90 s per upload.
- Bad: uploads over a very slow connection (under 16 KB/s, or with a 10 s stall) fail with 408.
- Bad: a download that stalls (under 64 KiB in a minute) is cut and still counts as one of the
  link's 5. A client that reads just fast enough can keep a connection, and the file in memory,
  for a long time (a 20 MiB file for hours); the request's slot is freed at the 120 s deadline
  all the same, and connections are capped per client address.
- Bad: reverse proxies must pass batch bodies up to 200 MiB plus framing and `Content-Length` (nginx needs
  `client_max_body_size`).
- Bad: as with the inbox, an agent that drives a signed-in browser could upload or download on its
  own.
- Bad: with `SEVDESK_OAUTH_ACCOUNTS=any` the server briefly holds other people's receipts and
  exports, and a few accounts together (3 with the in-memory default, 4 with 256 MiB on disk) can
  fill the space for everyone until their files expire (startup warns).
- Good (links): a receipt that is already online needs no round trip through the browser, and the
  same argument works over stdio and HTTP.
- Bad (links): the server reaches hosts beyond sevDesk at the model's request. The list bounds
  them, but a host on it that serves files anyone can upload (a shared storage domain, especially
  under `*.`) lets the model attach such a file. Slow downloads keep others waiting up to a
  minute: two per account, so in OAuth mode two accounts together can still fill the four slots
  of the process.
- Bad (links): the real call downloads the file again, so without `fileSha256` it may attach
  other bytes than the dry run showed.

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
- **`file: {url}`, an object** (the issue's first sketch). Rejected for the reason of the separate
  `uploadId` field: a union in every file argument; the scheme is as unambiguous as `upload:`.
- **Links without redirects.** Rejected: most storage links redirect; checking every hop against
  the same rules keeps the guarantee.
- **Any host, guarded only by the public-address check.** Rejected: the server would fetch from
  wherever a prompt injection points it, and the model would attach whatever it found there.
