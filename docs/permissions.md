# Permissions and confirmation

A sevDesk API token can do everything its user can, on the whole account: there are no scopes, no
read-only tokens and no expiry. sevDesk also has no sandbox, so every write changes your real
books. The server therefore brings its own least privilege: permission tiers you choose, a human
confirmation for every binding step, dry runs, and a local audit log. This page explains how to
use each of them; the guarantees behind confirmations are in
[Human confirmation](security/confirmation.md), the threat model in the [Security policy](../SECURITY.md).

## Tiers

Every tool belongs to exactly one tier. Reads and writes never share a tool.

| Tier       | What it allows                                                                                                                                                                                                                                                                                                                                                                                                                    | Confirmation |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `read`     | List, get, search, reports, PDF previews (which never mark a document as sent), parsing e-invoices, saving document files and CSV exports into `SEVDESK_OUTPUT_DIR` (or as download links). Always on.                                                                                                                                                                                                                            | no           |
| `write`    | Contacts (also removing single addresses or communication ways), parts, payment accounts, drafts of invoices, credit notes, orders and vouchers, dunning reminders, the DATEV export, document archives. Reversible or harmless.                                                                                                                                                                                                  | no           |
| `commit`   | Finalize, book payments; book, enter, delete and mark private bank transactions, also by rule; cancel (Storno), reset, delete drafts and contacts (an organisation with its contact persons), set the language, template and letterhead of a draft (the request sevDesk uses for this also changes finalized documents), Abo-Rechnungen; enshrine documents and bank transactions (festschreiben, GoBD). Binding or hard to undo. | **yes**      |
| `external` | Send invoices, credit notes and orders by email. Reaches third parties.                                                                                                                                                                                                                                                                                                                                                           | **yes**      |

Orders follow the same line: an offer's delivery note is a `write` draft, while accepting or
rejecting an offer is `commit`, and so is creating its order confirmation, because sevDesk marks
the offer as accepted in the same step.

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

The tier is enforced again on every call and in the HTTP client, which refuses a request to a
sevDesk endpoint above the calling tool's tier ([Safety model](architecture/safety.md#enforcement-in-three-places)). In OAuth remote
mode each connection gets the tiers ticked on the consent page, capped by `SEVDESK_ALLOW`
([Remote mode (HTTP)](remote.md#tiers-per-grant)).

## How a write runs

1. **Check the arguments.** Unknown parameters are refused by name, and so is text with characters
   a human would not see ([hidden characters](security/confirmation.md#hidden-characters-in-arguments)).
2. **Prepare.** The tool reads what it needs with a client that cannot write, checks the call
   locally (status, amounts, tax rule × rate, booking accounts, duplicates, open amounts) and
   builds a preview: the action in one sentence, warnings, and the key facts such as amounts,
   recipients and the full email text. Most mistakes are refused here, before anything is sent.
3. **Dry run?** Then the preview is the result (status `dry_run`) and the call ends.
4. **Confirm.** For `commit` and `external`, you see the preview and approve or decline
   ([Confirmation modes](#confirmation-modes)). The server then prepares again; if the record
   changed in the meantime, it asks again instead of executing.
5. **Execute.** The [audit log](permissions/audit-log.md) records `executing` (if that line cannot
   be written, nothing is sent), then the tool sends the request with a client limited to its tier.
   Writes are never retried, so a timeout cannot create a duplicate.
6. **Read back.** The result is read back from sevDesk and returned (status `done`). A multi-step
   write that fails half-way reports the records it already changed.

A write tool answers with one of four statuses: `done`, `dry_run`, `approval_pending` (waiting for
your decision in the browser) or `declined`.

## Dry run

A dry run runs every check of a write and returns its preview, without sending anything to sevDesk
and without asking anyone. Reads still happen, so the preview reflects the current data.

- Per call: the model passes `dryRun: true`. You can simply ask for it:

  > Show me what you would do first, as a dry run.

- For everything: `SEVDESK_DRY_RUN=1`. Every write tool then returns its preview only. A good
  setting for the first sessions with a new tier.

## Confirmation modes

`SEVDESK_CONFIRM` decides how you confirm `commit` and `external` calls. `write` calls need no
confirmation. Whatever the mode, a confirmation is valid for 10 minutes, is used once and covers
exactly the call and the preview you saw ([what an approval
binds](security/confirmation.md#what-an-approval-binds)).

### elicit

The default. The client shows the preview and an "Approve this action" switch, off by default,
through MCP elicitation. Decline, cancel or an unchecked switch return `declined`: nothing changes.

Not every client supports elicitation ([Clients](clients.md#confirmations-by-client)). A client
that cannot be asked gets an error that says so, and nothing is sent; switch to `browser` then.
Elicitation trusts the client application to show the form honestly
([what elicitation trusts](security/confirmation.md#what-elicitation-trusts)).

### browser

The call returns `approval_pending` with a short reference code. You approve on a web page, then
ask the assistant to try again with the same arguments.

- **Over stdio** the server serves the page itself on `127.0.0.1` and opens it in your default
  browser. With `SEVDESK_CONFIRM_OPEN=0` it only writes the link to its log (stderr). The link is
  a secret and never reaches the model ([the local approval
  page](security/confirmation.md#the-local-approval-page)).
- **In remote mode** approvals wait in the server's approval inbox (`/approvals`), which you open
  after signing in ([Approvals](remote/approvals.md)).

At most five approvals wait at a time. The page shows the same reference code as the tool result,
so you can match them.

The page comes in German and English and follows your browser's language. In German the preview
is German too (the action, the facts, the warnings, with amounts and dates in German notation),
while the assistant, dry runs and the audit log keep the English text of the same request: match
the two by the reference code. The page shows how long the request is still valid and takes the
buttons away when it has expired. It runs no script and loads nothing from other servers.

Prefer `elicit` in agentic clients that can run commands: an agent that can read the server's log
or drive your browser could approve on its own
([limits](security/confirmation.md#limits-of-the-browser-mode)).

### off

No confirmation. Accepted only together with `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`, and not
recommended: the model alone then decides when an invoice is finalized, booked, cancelled or
emailed. The Claude Desktop extension does not offer it.

## Audit log

With `SEVDESK_AUDIT_LOG=<path>` the server appends one JSON line per event of every write call:
previews, confirmations, executions and failures. Events, fields and the file's guarantees are in
[Audit log](permissions/audit-log.md).

## Files

Tools read and write local files only where you allow it:

- **Reading** (receipts, e-invoices) only inside the folders of `SEVDESK_FILE_DIRS`.
- **Writing** (PDFs, e-invoice XML, CSV and DATEV exports) only into `SEVDESK_OUTPUT_DIR`: new files
  only, never overwriting.

Without these settings no tool touches your disk. How paths and file contents are checked is in
[Local files](security/local.md#local-files). In remote mode files travel through upload pages and
download links in your browser instead, which need a browser session of your sevDesk account
([Files](remote/files.md)).

## Recommendations

- **Use a dedicated sevDesk user** for the token, so you can reset its token without touching your
  own login.
- **Start with `read`.** Add `write` with `SEVDESK_DRY_RUN=1` for the first sessions, then
  `commit` and `external` only when you need them, and in a client that shows confirmations.
- **Keep `elicit`** where the client supports it; use `browser` where it does not, and never
  `off` for an account with real data.
- **Set `SEVDESK_AUDIT_LOG`** as soon as you enable a write tier.
- **Keep the token out of configuration files**: the OS keychain, a token file, or the Claude
  Desktop extension ([Profiles](configuration/profiles.md)).
- **Allow narrow folders**: a receipts folder for `SEVDESK_FILE_DIRS`, an empty export folder for
  `SEVDESK_OUTPUT_DIR`, not your home directory.
- **Load only the toolsets you need** (`SEVDESK_TOOLSETS`); leave `advanced` off unless a task
  needs it.
- **Check the preview before you approve.** It is built from what the tool just read, not from what
  the model says. Before you finalize, email or enshrine a document, read its address, texts and
  positions in the preview: a draft can be changed without a confirmation, so the foot text you
  see there (the bank details, for example) is the one that becomes binding. A warning in the
  preview names what it does not show, such as the PDF layout
  ([Previews of binding documents](security/confirmation.md#previews-of-binding-documents)).
