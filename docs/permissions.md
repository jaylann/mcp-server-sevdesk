# Permissions and confirmation

A sevDesk API token can do everything its user can, on the whole account: there are no scopes, no
read-only tokens and no expiry. sevDesk also has no sandbox, so every write changes your real
books. The server therefore brings its own least privilege: permission tiers you choose, a human
confirmation for every binding step, dry runs, and a local audit log. This page explains each of
them. The threat model behind them is in [SECURITY.md](../SECURITY.md).

## Tiers

Every tool belongs to exactly one tier. Reads and writes never share a tool.

| Tier       | What it allows                                                                                                                                                                                 | Confirmation |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `read`     | List, get, search, reports, PDF previews (which never mark a document as sent), parsing e-invoices. Always on.                                                                                 | no           |
| `write`    | Contacts, parts, drafts of invoices, credit notes, orders and vouchers, dunning reminders, the DATEV export. Reversible or harmless.                                                           | no           |
| `commit`   | Finalize, book payments, book bank transactions, mark transactions as private, cancel (Storno), enshrine (festschreiben, GoBD), reset, delete voucher drafts. Legally binding or hard to undo. | **yes**      |
| `external` | Send invoices, credit notes and orders by email. Reaches third parties.                                                                                                                        | **yes**      |

Choose the tiers with `SEVDESK_ALLOW`, for example `SEVDESK_ALLOW=write` or
`SEVDESK_ALLOW=write,commit`; `all` enables every tier. `SEVDESK_READ_ONLY=1` turns everything but
`read` off, whatever `SEVDESK_ALLOW` says. The [tool reference](tools.md) lists the tier of every
tool.

A sensible order: start with `read`, add `write` with a [dry run](#dry-run), and enable `commit`
and `external` once you trust the drafts and your client shows confirmations
([Clients](clients.md#confirmations-by-client)).

## What the model sees

- **Only the tools of the enabled tiers.** Tools above them are not registered at all: they are
  not in `tools/list`, so the model cannot see or call them.
- **What is disabled and who can change it.** The server's instructions name the enabled and
  disabled tiers and tell the model that you, not it, enable more, and that it must not work
  around a missing tool. `sevdesk_account_info` reports the tiers, toolsets, read-only, dry-run
  and confirmation mode, so the model knows before it tries.
- **Prompts that fit.** A [prompt](../README.md#prompts) appears only when the tools it needs are
  enabled; a step whose tools are disabled is replaced by a note naming the setting that enables
  it.
- **Never a way to approve.** No tool argument approves anything. A `confirm: true` the model
  sets is not accepted as a confirmation.

The tier is enforced three times: when tools are registered, again on every call, and in the HTTP
client, which knows the minimum tier of every sevDesk endpoint (for example `bookAmount` and
`enshrine` need `commit`, `sendViaEmail` needs `external`) and refuses a request from a tool whose
tier is too low. In OAuth remote mode each connection gets the tiers ticked on the consent page,
capped by `SEVDESK_ALLOW` ([remote.md](remote.md#tiers-per-grant)).

## How a write runs

1. **Check the arguments.** Unknown parameters are refused by name. Text with characters a human
   would not see (zero-width, bidi and other control characters) is refused before anything is
   read, so nothing hidden reaches sevDesk.
2. **Prepare.** The tool reads what it needs with a client that cannot write, checks the call
   locally (status, amounts, tax rule × rate, booking accounts, duplicates, open amounts) and
   builds a preview: the action in one sentence, warnings, and the key facts such as amounts,
   recipients and the full email text. Most mistakes are refused here, before anything is sent.
3. **Dry run?** Then the preview is the result (status `dry_run`) and the call ends.
4. **Confirm.** For `commit` and `external`, you see the preview and approve or decline
   ([Confirmation modes](#confirmation-modes)). The server then prepares again; if the record
   changed in the meantime, it asks again instead of executing.
5. **Execute.** The audit log records `executing` (if that line cannot be written, nothing is
   sent), then the tool sends the request with a client limited to its tier. Writes are never
   retried, so a timeout cannot create a duplicate.
6. **Read back.** The result is read back from sevDesk and returned (status `done`). A multi-step
   write that fails half-way reports the records it already changed.

A write tool answers with one of four statuses: `done`, `dry_run`, `approval_pending` (waiting for
your decision in the browser) or `declined`.

## Dry run

A dry run runs every check of a write and returns its preview, without sending anything to sevDesk
and without asking anyone. Reads still happen, so the preview reflects the current data.

- Per call: the model passes `dryRun: true`. You can simply ask for it ("show me what you would do
  first").
- For everything: `SEVDESK_DRY_RUN=1`. Every write tool then returns its preview only. A good
  setting for the first sessions with a new tier.

## Confirmation modes

`SEVDESK_CONFIRM` decides how you confirm `commit` and `external` calls. `write` calls need no
confirmation.

### elicit

The default. The client shows the preview and an "Approve this action" switch, off by default,
through MCP elicitation. Decline, cancel or an unchecked switch return `declined`: nothing changes.
The pending confirmation is signed by the server and bound to the tool, the arguments and the
preview, valid for 10 minutes and usable once.

Not every client supports elicitation ([Clients](clients.md#confirmations-by-client)). A client
that cannot be asked gets an error that says so, and nothing is sent; switch to `browser` then.

### browser

The call returns `approval_pending` with a short reference code. You approve on a web page, then
ask the assistant to try again with the same arguments.

- **Over stdio** the server serves the page itself on `127.0.0.1` and opens it in your default
  browser. With `SEVDESK_CONFIRM_OPEN=0` it only writes the link to its log (stderr). The link is
  a secret: it never reaches the model, the tool result or the audit log.
- **In remote mode** approvals wait in the server's approval inbox (`/approvals`), which you open
  after signing in ([remote.md](remote.md#the-approval-inbox)).

Each approval is bound to the tool, the arguments and the preview, expires after 10 minutes and is
used once; at most five wait at a time. The page shows the same reference code as the tool result,
so you can match them.

The limit of this mode: an agent that can read the server's log or drive your browser (browser
automation, a computer-use tool) could approve on its own. `browser` protects against a model that
only talks, for example one steered by text hidden in sevDesk data. Prefer `elicit` in agentic
clients that can run commands.

### off

No confirmation. Accepted only together with `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`, and not
recommended: the model alone then decides when an invoice is finalized, booked, cancelled or
emailed. The Claude Desktop extension does not offer it.

## Audit log

With `SEVDESK_AUDIT_LOG=<path>` the server appends one JSON line per event of every write call to
that file. It answers "what did the assistant do in my books, and who approved it?".

| Event                    | When                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `dry_run`                | A dry run returned its preview.                                                                                                         |
| `confirmation_requested` | A confirmation was asked for, with the preview (and in browser mode the reference code).                                                |
| `confirmation_refused`   | A retry presented a confirmation that was replayed, expired or made for other arguments.                                                |
| `approval_decided`       | Approve or Reject was pressed on an approval page.                                                                                      |
| `declined`               | You declined in the client.                                                                                                             |
| `executing`              | The action is about to be sent, with how it was approved: `elicit`, `browser`, `confirmation_off` or `not_required` (the `write` tier). |
| `executed`               | The action ran; with the records it changed.                                                                                            |
| `failed`                 | The action failed; with the error kind and any records an earlier step already changed.                                                 |

Every line starts with `ts` (the time, ISO 8601) and `v`, the version of the line format (`1`),
followed by `event`, a `callId` shared by the lines of one action, the `tool`, its `tier`, a hash of
the arguments (`argsHash`), the arguments themselves (token redacted, hidden characters written as
visible `\u{…}` escapes, strings up to 20,000 characters) and the hash of the preview that was
shown and approved (`previewHash`). In remote mode each line also names the `account` and the
`grant`. For example (shortened):

```json
{
  "ts": "2026-11-09T14:03:12.481Z",
  "v": 1,
  "event": "executed",
  "callId": "6f1c…",
  "tool": "sevdesk_invoice_finalize",
  "tier": "commit",
  "argsHash": "9b2e…",
  "args": { "id": 1042, "sentVia": "email" },
  "affected": [{ "objectName": "Invoice", "id": "1042" }]
}
```

The file is created with mode 0600, opened append-only and never through a symbolic link. If the
`executing` line cannot be written, the action is not run. The log is local and not tamper-proof:
it records what this server did, for you, and is no defense against someone who controls the
machine. `v` changes only when a field changes its meaning or is removed; new fields can appear
without it ([Compatibility](compatibility.md)).

## Files

Tools read and write local files only where you allow it:

- **Reading** (receipts, e-invoices) only inside the folders of `SEVDESK_FILE_DIRS`: real paths are
  checked, symbolic links may not lead outside, the file type is recognized by its content and the
  size is capped.
- **Writing** (PDFs, e-invoice XML, CSV and DATEV exports) only into `SEVDESK_OUTPUT_DIR`: new files
  only, mode 0600, never overwriting.

Without these settings no tool touches your disk. In remote mode files travel through upload
pages and download links in your browser instead, which need a browser session of your sevDesk
account ([remote.md](remote.md#files-uploads-and-download-links)).

## Recommendations

- **Use a dedicated sevDesk user** for the token, so you can reset its token without touching your
  own login.
- **Start with `read`.** Add `write` with `SEVDESK_DRY_RUN=1` for the first sessions, then
  `commit` and `external` only when you need them, and in a client that shows confirmations.
- **Keep `elicit`** where the client supports it; use `browser` where it does not, and never
  `off` for an account with real data.
- **Set `SEVDESK_AUDIT_LOG`** as soon as you enable a write tier.
- **Keep the token out of configuration files**: the OS keychain, a token file, or the Claude
  Desktop extension ([Configuration](configuration.md#keep-the-token-in-the-os-keychain)).
- **Allow narrow folders**: a receipts folder for `SEVDESK_FILE_DIRS`, an empty export folder for
  `SEVDESK_OUTPUT_DIR`, not your home directory.
- **Load only the toolsets you need** (`SEVDESK_TOOLSETS`); leave `advanced` off unless a task
  needs it.
- Check the preview before you approve. It is built from what the tool just read, not from what
  the model says.
