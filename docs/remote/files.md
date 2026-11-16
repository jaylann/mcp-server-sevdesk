# Files: uploads and download links

A remote server cannot read files on your computer, and the files it creates cannot land there by
themselves. With `SEVDESK_HTTP_FILES=on` (the default) files travel through pages of the server
that you open in your browser. This page explains those pages, their limits and what a proxy needs
for them. The model never sees or sends the bytes of those files. (Document PDFs and XML that a
client asks for as `sevdesk://` resources are a different path: they go to the client over MCP.)

## Uploading a receipt or an e-invoice

1. The model calls `sevdesk_upload_request` (purpose `receipt` or `einvoice`) and gives you a link,
   `<public URL>/uploads/<id>`, with a short reference code and an expiry.
2. You open the link. The page shows only what the server knows: what it accepts, the largest
   file, until when it is valid, the account and the reference code. The model cannot put text on
   it.
3. You choose the file and press Upload. The server checks the file type by its content, not its
   name, and keeps a cleaned name (letters, digits, `.`, `_`, `-`; umlauts spelled out; at most 100
   characters; the extension from the content).
4. You tell the model the upload is done. It passes the `uploadId` it got (`upload:<id>`) as
   `file` to `sevdesk_voucher_create_draft`, `sevdesk_voucher_update_draft`,
   `sevdesk_voucher_recognize_receipt`, `sevdesk_einvoice_parse` or
   `sevdesk_voucher_import_einvoice`. Only the connection that asked for the upload can use it.

Once a create, update, recognition or import succeeds and sevDesk's read-back confirms an
attachment, the server releases the upload and deletes its stored file, freeing the slot
immediately. Parsing, dry runs, failed calls and a missing or uncertain attachment in the read-back
keep the upload until expiry for another attempt. On an update, the attachment ID must change from the state checked immediately
before saving (or follow an explicitly absent attachment); if it stays the same or the previous
state is unknown, the upload remains available until expiry. To use a successfully attached file
again after its upload was released, request a new upload.

## Several files on one page

`sevdesk_upload_request` takes an optional `count` (1–10, default 1). With `count` above 1 it
returns a `batchId`, the `count` and one page URL instead of an `uploadId`, and the user selects
all the files on that page and sends them at once.
The model then calls `sevdesk_uploads_list` with `batchId`: each slot has an `uploadId` and status;
uploaded slots also have their cleaned name, kind, size, SHA-256 and individual expiry. The model
matches these names to the intended drafts, using only slots with status `uploaded`. Two files
with the same cleaned name stay separate; when size and SHA-256 cannot tell them apart, the model
asks the user which is which.
The lookup is read-only and visible only to the connection that requested the batch.

- The whole batch reserves one record per file up front. If it cannot fit the remaining account or
  global record allowance, no slots are created; the refusal names the next known expiry for that
  account. A batch counts as one of the five pending pages.
- You may upload fewer files and return to the same page for the rest before its original 15-minute
  deadline. If a later file fails, earlier successful uploads stay available and the page lists
  what remains; select only the missing files on retry. Replaying an older form cannot fill the
  remaining slots: the page shows the current list and asks you to choose the missing files again.
- Successful batch uploads redirect to the progress page, so refreshing it does not resend files.
- Expiry of unused slots does not expire already uploaded files. Once every slot is used or
  expired, the batch lookup and page are removed.

With `count` absent or `1`, the single-file result and workflow are unchanged.

## Downloading

`sevdesk_document_save`, `sevdesk_voucher_receipt_save`, `sevdesk_csv_export` and
`sevdesk_datev_export` return a download link, `<public URL>/files/<id>`, instead of a file path.
The server fetched the file from sevDesk during the tool call; opening the link sends nothing to
sevDesk. The browser saves the file as a download; it is never displayed on the server's page.

## What needs a browser session

Every upload page and download link. The links are not secrets: without a session they show only
the sign-in form, and a link of another account looks exactly like one that does not exist. The
session is the one of the [approval inbox](approvals.md#signing-in):

- the browser that completed the OAuth consent is signed in for 12 hours, also when the inbox is
  off;
- any other browser signs in on the form with the sevDesk API token of the account (OAuth mode:
  checked with sevDesk and against `SEVDESK_OAUTH_ACCOUNTS`; bearer mode: the server's
  `SEVDESK_API_TOKEN`, never the bearer secret), and lands back on the page it came from.

The form posts to `/approvals/login` even when the approval inbox is off. Signed in to an account,
a browser sees the upload pages and links of every connection of that account; the tools only use
the uploads of their own connection.

**On the phone**, the Claude apps may open a link in a browser that does not share the cookies of
the one you consented in: you then see the sign-in form. Sign in with the sevDesk API token there,
or open the link in the browser where you consented.

## Limits and lifetimes

| What                | Limit                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload page         | Valid 15 minutes, takes 1–10 files as requested; unused slots expire together.                                                                                                                                                |
| Accepted files      | Receipts: PDF, PNG or JPEG. E-invoices: XML (XRechnung) or PDF (ZUGFeRD, Factur-X). Checked by content.                                                                                                                       |
| One upload          | 20 MiB, or half of `SEVDESK_HTTP_FILES_MAX_MB` if that is less.                                                                                                                                                               |
| Uploaded file, link | Valid for at most `SEVDESK_HTTP_FILES_TTL` (30 minutes); an upload is released after a confirmed attachment. A link serves at most 5 downloads.                                                                               |
| Per account         | 5 upload pages waiting for a file; `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` reserved file slots, uploads and links together (default 10, range 1–1000); a quarter of `SEVDESK_HTTP_FILES_MAX_MB` (at least 20 MiB, at most half). |
| All accounts        | `SEVDESK_HTTP_FILES_MAX_MB` (256 MiB with a state directory, 64 MiB without), 1,000 uploads and links. Room for one upload is kept for accounts that hold no files yet.                                                       |
| Requests per client | 60 a minute to the upload and download pages together; 10 uploads a minute and 60 an hour (IPv6 per /64 network).                                                                                                             |
| Uploads at once     | 2 for the whole server, 1 per account; another gets "Server busy" or "Upload in progress" (503): try again in a moment.                                                                                                       |
| Upload speed        | The file must arrive within 90 seconds, without a 10-second pause, and at 16 KB/s or more on average after the first 10 seconds; else 408.                                                                                    |
| Download speed      | The browser must keep taking the file: a download from which it takes less than 64 KiB within a minute is cut, and still counts as one of the link's 5.                                                                       |
| A restart           | Voids every upload page, upload and link. The model asks for a new one.                                                                                                                                                       |

Nothing is pushed out to make room: when a limit is reached, new uploads and links are refused
until older ones expire or are released. A count-limit refusal names the earliest known expiry of
the requesting account, never another account's timestamps; transfers still being stored have no
fixed expiry yet, and the refusal says so when none is known. To allow more simultaneous records,
raise `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`; this does not change any byte quota.

Download links count against the same space as uploads, so a large DATEV export may not fit (with
64 MiB in memory, one account has 20 MiB). The tool then says that sevDesk has started the export,
and you download it in sevDesk instead; or raise `SEVDESK_HTTP_FILES_MAX_MB`, best with a state
directory, so the files go to disk.

## Memory

Files are kept in memory without a state directory. While an upload arrives it is held about three
times over, which is why at most two bodies are received at once. A batch body is capped before
reading at the smaller of its remaining slots times the per-file limit and the account's remaining
byte share, plus 64 KiB of multipart framing (absolute ceiling: 200 MiB plus framing). At the
256 MiB storage default an empty account has 64 MiB for a batch; without a state directory the
default share is 20 MiB. Allow memory for parsing these bodies as well as retained files,
especially when raising the storage limit. Files are stored sequentially, rechecking byte quotas
and expiry for each; a concurrent download reservation can still cause a partial failure.

## Reverse proxies

An upload body must arrive within 90 seconds without a 10-second pause and must carry
`Content-Length`; a chunked upload without it is refused with 411. Set the proxy body limit for the
batch size you allow plus framing: for example, nginx `client_max_body_size 65m;` for the 64 MiB
account share at the disk-backed default, or `201m` for the absolute 200 MiB ceiling. Its default
of 1 MB refuses most receipts; its default request buffering sends `Content-Length`. Caddy, as in
the [Compose template](deployment.md#docker-compose-with-caddy-deploycompose), needs nothing. Each
file still has the 20 MiB limit; a large selection may need several submissions through the same
link.

## Turning it off

`SEVDESK_HTTP_FILES=off` removes `sevdesk_upload_request`, `sevdesk_uploads_list` and the pages. In
OAuth mode the tools that need a file to read or a place to save one are not offered then
(`sevdesk_einvoice_parse`, `sevdesk_voucher_import_einvoice`,
`sevdesk_voucher_recognize_receipt`, `sevdesk_document_save`, `sevdesk_voucher_receipt_save`,
`sevdesk_csv_export`, `sevdesk_datev_export`), and the `file` argument of the voucher draft tools
is refused; bearer mode still uses `SEVDESK_FILE_DIRS` and `SEVDESK_OUTPUT_DIR` if they are set.
The PDF and XML tools and the `sevdesk://` resources are not affected: a client reads document
files through them over MCP.

## Limits of the design

An agent that can drive your signed-in browser could upload or download on its own, as it could
approve in the inbox. A downloaded file is whatever sevDesk returned; open it like any document
from your bookkeeping. On a plain-http `localhost` setup, other local web servers receive the
session cookie too. How links, uploads, downloads and storage are hardened is in
[Security in remote mode](../security/remote.md#files); the design is
[ADR 0008](../adr/0008-file-transfer-over-http.md).
