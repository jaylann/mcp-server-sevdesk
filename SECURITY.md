# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/jaylann/mcp-server-sevdesk/security/advisories/new).
You will get an acknowledgement within 72 hours and a fix or mitigation plan within 14 days for
confirmed issues. Credit is given in the advisory unless you prefer otherwise.

Only the latest released version receives security fixes.

## Threat model

This server sits between an AI model and a sevDesk account. The design assumes:

1. **The sevDesk API token is all-powerful.** sevDesk tokens have no scopes and never expire; they
   can do everything their user can, on the whole account. The server therefore enforces its own
   least privilege: tools are grouped into tiers (`read`, `write`, `commit`, `external`), only
   `read` is enabled by default, and tools above the allowed tiers are never registered. The tier
   is enforced again in the dispatcher and in the HTTP client, which also knows the minimum tier of
   each endpoint (for example `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice` need `commit`;
   `sendViaEmail` needs `external`) and refuses a request from a tool whose tier is too low.
2. **The model can be manipulated.** Text stored in sevDesk (contact names, invoice and voucher
   descriptions, bank transfer purposes, e-invoice contents) can be written by third parties and
   may contain prompt injection. Such text is treated as untrusted data: it is fenced in output,
   stripped of invisible Unicode, and never placed in error messages. Legally binding or external
   actions (`commit`, `external`) require **human confirmation** outside the model's control
   (MCP elicitation or a local approval page, see below); a model-supplied `confirm` flag is
   never accepted as approval.
3. **There is no sandbox.** Every write is real. Writes are never retried automatically (to avoid
   duplicates), are read back to verify, can be dry-run (`dryRun: true` or `SEVDESK_DRY_RUN=1`:
   the tool reads, checks and returns its preview, sends nothing and asks nobody), and can be
   recorded in a local audit log.
4. **Secrets must not leak.** The token is read from the environment, a file or the OS keychain;
   it is never logged, echoed, or included in errors. Logs go to stderr only.
5. **Remote mode is single-tenant by default.** The HTTP transport refuses to start without
   authentication, validates Origin/Host, and in OAuth mode stores no tokens server-side (the
   sevDesk token is encrypted into the grant).

Out of scope: vulnerabilities in sevDesk itself (report those to sevdesk GmbH), and attacks that
require control of the machine running the server.

## Human confirmation

Every `commit` and `external` call shows the human a preview built by the tool from what it just
read: the action in one sentence, then the warnings and "This cannot be undone." for irreversible
actions, then the key facts (record, customer, amounts, dates, recipients, texts). Values are stripped of
invisible, bidi and control characters, so stored text cannot hide anything from the human. Fact
values are shown in full with their line breaks (an email text, for example), each line indented
under its label so that no line of a value can pose as a label or a warning; a value longer than
12,000 characters ends with "[… N more characters not shown; open the dry run to see everything]"
instead of being cut silently, and the dry run returns it whole. The approval binds a hash of the
complete preview, not of what fit on the screen. Only the human's answer counts: no tool argument
can approve anything.

The other way round, text the human cannot see must not reach sevDesk either. Before anything is
read or sent, every write tool (dry runs included) refuses arguments that contain characters a
human would not see as they are: control and format characters (zero-width, bidi), other
default-ignorable code points (variation selectors, U+034F, Hangul fillers), carriage returns, the
line and paragraph separators, and tabs. The error names the argument and the code points; line
breaks are allowed.

**`SEVDESK_CONFIRM=elicit` (default).** The call answers with an MCP elicitation through the
2026-07-28 multi-round-trip flow (`input_required`): a form with a single "Approve this action"
switch, off by default. The pending state travels through the client as `requestState`, signed
with HMAC-SHA256 (the SDK's request-state codec, a random 256-bit key per server process, valid for
10 minutes, bound to the method and, in HTTP mode, to the OAuth client). It binds the tool name,
a SHA-256 of the arguments (without `dryRun`), a SHA-256 of the preview and a single-use nonce. On
the retry the server refuses a state for other arguments or another tool, refuses a replayed
approval (the nonce is consumed once), prepares the action again and, if the preview changed in the
meantime (the record was edited), asks again instead of executing. Decline, cancel or an unchecked
switch return `declined`: nothing changes. For 2025-era clients the SDK's legacy shim sends a
real `elicitation/create` request on the same connection, so the same checks apply. Clients that
do not declare form elicitation, and 2025-era clients over stateless HTTP (which cannot receive
server-to-client requests), get an error telling the user to switch to `browser`; nothing is sent.

**`SEVDESK_CONFIRM=browser`.** For clients without elicitation, the server creates an approval
page, served by itself on `127.0.0.1` and an ephemeral port only, and opens it in the user's
browser with the operating system's opener (`open`, `xdg-open` or `cmd /c start`, spawned with an
argument array, no shell). `SEVDESK_CONFIRM_OPEN=0` turns the opening off. The page's link is a
secret: it goes to the server log (stderr, one line per approval) and to the opener, never to the
model, the tool result or the audit log. The call returns `approval_pending` with a short,
non-secret reference code (also shown on the page, so the user can match them), the expiry and
whether the page was opened. Each approval binds tool, argument hash and preview hash, has a random
256-bit id, expires after 10 minutes and is used once; when the model calls the tool again with the
same arguments after the human approved, the server prepares again and runs the action only if the
preview is unchanged. The page is static HTML with every value escaped, under a strict Content
Security Policy (no scripts, no framing, forms only to itself). Approve and Reject are POST forms
that must carry a per-approval CSRF token from the page, a per-approval `SameSite=Strict` cookie
set when the page was loaded, `Host: 127.0.0.1:<port>` (every request is checked for the Host,
against DNS rebinding) and come from the page itself: `Origin: http://127.0.0.1:<port>`, or, from
clients that send no `Origin`, the browser-set `Sec-Fetch-Site: same-origin`. `Origin: null` is
refused; the page uses the `same-origin` referrer policy, under which browsers send the real
origin (under `no-referrer` they would send `null`). At most five approvals wait for a decision at
a time; beyond that, calls are refused until the user decides or the requests expire, so a looping
assistant cannot flood the browser with tabs.

**Limit of the browser mode.** The model never sees the link, but the link is still a
capability. An agent that can read the server's stderr log (for example a client that shows MCP
logs to the model, or shell access to the log file) or that can drive the user's browser (an open
page, browser automation) can still approve on its own. The browser mode therefore protects against
a model that only talks (for example one steered by prompt injection in sevDesk data), not against
an agent with such access. `elicit` stays the recommended mode, especially in agentic clients
that can run commands.

**`SEVDESK_CONFIRM=off`** is accepted only together with `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`.

## Audit log

With `SEVDESK_AUDIT_LOG=<path>` every write call appends JSON Lines to that file: `dry_run`,
`confirmation_requested` (with the preview and, in browser mode, the reference code),
`confirmation_refused` (a replayed, expired or mismatched confirmation), `approval_decided`
(Approve or Reject pressed on the approval page, with the reference code), `declined`,
`executing` (with how it was approved: `elicit`, `browser`, `confirmation_off` or `not_required`
for the `write` tier), `executed` (with the records changed) and `failed` (with the error kind
and any records an earlier step already changed). Each line has a timestamp, a call id shared by
the request, the decision and the execution, the tool, its tier, the argument hash, the hash of
the preview that was shown and approved, and the arguments (token redacted, hidden characters
written as visible `\u{…}` escapes, strings up to 20,000 characters, longer ones marked). The
file is created with mode 0600 (and tightened to 0600 if it already exists), opened append-only and
never through a symlink. If the `executing` line cannot be written, the action is not run and
nothing is sent (fail closed). The log is local and not tamper-proof: it records what this server
did, for the user, and is no defense against someone who controls the machine.

## Supply chain

Releases are published from CI with npm provenance (trusted publishing, no long-lived tokens),
GitHub Actions are pinned by commit SHA, and the repository is scanned by CodeQL, dependency
review and OpenSSF Scorecard.
