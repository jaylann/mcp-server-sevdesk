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
   each endpoint (for example `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`, finalizing a
   voucher and changing a bank transaction need `commit`; `sendViaEmail` needs `external`) and
   refuses a request from a tool whose tier is too low.
2. **The model can be manipulated.** Text stored in sevDesk (contact names, invoice and voucher
   descriptions, bank transfer purposes, e-invoice contents) can be written by third parties and
   may contain prompt injection. Such text is treated as untrusted data: it is fenced in output,
   stripped of invisible Unicode, and never placed in error messages. Legally binding or external
   actions (`commit`, `external`) require **human confirmation** outside the model's control
   (MCP elicitation or an approval page, see below); a model-supplied `confirm` flag is never
   accepted as approval.
3. **There is no sandbox.** Every write is real. Writes are never retried automatically (to avoid
   duplicates), are read back to verify, can be dry-run (`dryRun: true` or `SEVDESK_DRY_RUN=1`:
   the tool reads, checks and returns its preview, sends nothing and asks nobody), and can be
   recorded in a local audit log.
4. **Secrets must not leak.** The token is read from the environment, a file or the OS keychain;
   it is never logged, echoed, or included in errors. Logs go to stderr only. In remote mode the
   same holds for the bearer and server secrets, sealed tokens, authorization codes and cookies.
5. **Local files are a boundary too.** The model names files, so the server must not become a way
   to read or write arbitrary files. Tools read only inside `SEVDESK_FILE_DIRS` (absolute folders;
   real paths are checked, symbolic links may not lead outside, the file is opened without
   following a link and checked by inode, its type is recognized by content, sizes are capped) and
   write only inside `SEVDESK_OUTPUT_DIR` (new files only, mode 0600, never overwriting). Without
   these settings, no tool reads or writes local files. Received e-invoices are hostile input:
   the XML parser refuses DOCTYPEs and entities, caps size and nesting depth and reads an element
   only in the namespace the invoice format defines for it; the PDF attachment reader caps
   decompressed sizes, the number of values it builds from a PDF (one million), the length of
   names, numbers and strings, and the parsing work per byte of the file; and every parsed text
   field is treated as untrusted. A PDF is still parsed inside the server process, so a hostile
   file at these limits can keep it busy for several seconds, but no longer. The DATEV export ZIP
   is fetched from a presigned link that sevDesk returns; the server accepts exactly one https
   host for it, follows no redirects, sends no credentials, caps the size and never shows the
   link to the model.
6. **Remote mode adds a network boundary.** The HTTP transport refuses to start without
   authentication, binds 127.0.0.1 by default (any other address needs a configured public URL), and
   validates Host and Origin. In OAuth mode it is single-tenant by default (only listed sevDesk
   accounts can connect, only allowlisted clients can ask), stores no sevDesk tokens (each user's
   token travels sealed inside the tokens their client holds), and scopes approvals, confirmations
   and caches to the account and grant of each request. See [Remote mode](#remote-mode).

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

Finalizing, sending and enshrining make a stored document binding, and everything printed on a
draft (texts, address, positions, terms) can be written with the `write` tier, which asks nobody.
So these previews list the document as sevDesk stores it, not only its number and totals:

- the address printed on the document, right after the customer (the two can differ); when the
  address text and the structured address fields are both stored and differ, both;
- title, delivery date or period, cash discount, tax rule and tax note, an order's payment and
  delivery terms, a credit note's booking category and the invoice it reduces;
- head text and foot text as stored, with their HTML tags, not shortened;
- every position: name, quantity × unit price (net or gross), tax rate, discount, line sums, and
  its text as stored. Up to 100 positions are listed, as many as the draft tools write; a longer
  list ends with a line that says how many are not listed and how many there are;
- for a voucher: service date or period, payment deadline, tax rule, every position with booking
  account, amount, tax rate, asset flag and its whole comment, and whether a receipt file is
  attached.

A fixed warning in each of these previews names what the facts do not show: the contact person,
the country of the address, the units and linked articles of the positions and the layout of the
PDF; for an enshrined voucher the names of the booking accounts and the content of the receipt
file. The facts and the approval's binding come from the same read: besides the preview, the
approval covers a hash of the whole record and all its positions as sevDesk sent them (texts,
address, payment terms, positions, the time of the last change). A document that is changed after
the human was asked, also in a part the preview does not show, is asked about again; a text that
was changed before the human was asked is in the preview they read.

The other way round, text the human cannot see must not reach sevDesk either. Before anything is
read or sent, every write tool (dry runs included) refuses arguments that contain characters a
human would not see as they are: control and format characters (zero-width, bidi), other
default-ignorable code points (variation selectors, U+034F, Hangul fillers), carriage returns, the
line and paragraph separators, and tabs. The error names the argument and the code points; line
breaks are allowed.

**`SEVDESK_CONFIRM=elicit` (default).** The call answers with an MCP elicitation through the
2026-07-28 multi-round-trip flow (`input_required`): a form with a single "Approve this action"
switch, off by default. The pending state travels through the client as `requestState`, signed with
HMAC-SHA256 (the SDK's request-state codec, a random 256-bit key per server process, valid for 10
minutes, bound to the method, the client and, in HTTP mode, the grant and the account). It binds the
tool name, a SHA-256 of the arguments (without `dryRun`), a SHA-256 of the preview and a single-use
nonce. On the retry the server refuses a state for other arguments or another tool, refuses a
replayed approval (the nonce is consumed once), prepares the action again and, if the preview
changed in the meantime (the record was edited), asks again instead of executing. Decline, cancel or
an unchecked switch return `declined`: nothing changes. For 2025-era clients the SDK's legacy shim
sends a real `elicitation/create` request on the same connection, so the same checks apply. Clients
that do not declare form elicitation, and 2025-era clients over stateless HTTP (which cannot receive
server-to-client requests), get an error telling the user to switch to `browser`; nothing is sent.

Elicitation trusts the MCP client application: the client shows the form and sends the answer
back, and the signed state proves only that the server asked, not that a human answered. A client
that is itself malicious or compromised (not a manipulated model inside an honest client) can
answer "approve" on its own. It stops prompt injection in the model, which cannot answer the form;
it does not stop a hostile client. With a client you do not trust, use `SEVDESK_CONFIRM=browser`
(over HTTP, the approvals inbox), where the human decides on a page the server itself serves.

**`SEVDESK_CONFIRM=browser`** over stdio. For clients without elicitation, the server creates an
approval page, served by itself on `127.0.0.1` and an ephemeral port only, and opens it in the user's
browser with the operating system's opener (`open`, `xdg-open` or `cmd /c start`, spawned with an
argument array, no shell). `SEVDESK_CONFIRM_OPEN=0` turns the opening off. The page's link is a
secret: it goes to the server log (stderr, one line per approval) and to the opener, never to the
model, the tool result or the audit log. The link is a launch link,
`http://127.0.0.1:<port>/open/<ticket>`, with a random 256-bit ticket that works once: its first
request sets a cookie for the approval page and redirects there. The page (`/approve/<id>`) and
the decision need that cookie; the page's address alone shows nothing and hands out no cookie.
The opener accepts no other kind of URL, so the page's address never appears on a command line.
The browser that used the link may open it again (the opener fired twice, the link clicked in
the log as well). When the link is presented a second time from anywhere else, the server
cannot tell which of the two is the user's browser: the request is withdrawn (an approval
already given there does not run), both see a page that says the link was used twice, and the
assistant has to ask again. A browser that loads the
link ahead of time (address-bar prerendering) does not use it up. The call returns
`approval_pending` with a short, non-secret reference code (also shown on the page, so the user
can match them), the expiry and whether the page was opened. Each approval binds tool, argument hash and preview hash, has a random
256-bit id, expires after 10 minutes and is used once; when the model calls the tool again with the
same arguments after the human approved, the server prepares again and runs the action only if the
preview is unchanged. The page is static HTML with every value escaped, under a strict Content
Security Policy (no scripts, no framing, forms only to itself; the only things it loads are its
own fonts and icon from the server's `/assets/` path, nothing from anyone else). It is in German
for a browser that asks for German, including the preview: tools that need a confirmation write
it in both languages, the server refuses a pair that does not have the same facts and warnings,
and the approval is bound to both texts. Approve and Reject are POST forms
that must carry a per-approval CSRF token from the page, the per-approval `SameSite=Strict` cookie
set by the launch link, `Host: 127.0.0.1:<port>` (every request is checked for the Host,
against DNS rebinding) and come from the page itself: `Origin: http://127.0.0.1:<port>`, or, from
clients that send no `Origin`, the browser-set `Sec-Fetch-Site: same-origin`. `Origin: null` is
refused; the page uses the `same-origin` referrer policy, under which browsers send the real
origin (under `no-referrer` they would send `null`). At most five approvals wait for a decision at
a time; beyond that, calls are refused until the user decides or the requests expire, so a looping
assistant cannot flood the browser with tabs. In remote mode `browser` uses the server's approval
inbox instead (see [Remote mode](#remote-mode)).

**Limit of the browser mode.** The model never sees the link, but the link is still a
capability. An agent that can read the server's stderr log (for example a client that shows MCP
logs to the model, or shell access to the log file) or that can drive the user's browser (an open
page, browser automation) can still approve on its own. The browser mode therefore protects against
a model that only talks (for example one steered by prompt injection in sevDesk data), not against
an agent with such access. `elicit` stays the recommended mode, especially in agentic clients
that can run commands.

Other users of the same computer can read the opener's command line (`ps`, `/proc`), and with it
the launch link. What they can do with it: nothing once the user's browser has used the link
(they get a page without content and without a cookie, and their attempt cancels a request that
has not run yet, which the user sees). If they present the link before the user's browser does,
they hold the page until that browser arrives: the browser's arrival then withdraws the request,
also when they had approved it already. Only an action the assistant ran in that gap (it called
the tool again before the user's browser arrived) cannot be undone; the user's browser then
shows that the link was used and decided elsewhere. So on a
computer that people you do not trust can log in to, set `SEVDESK_CONFIRM_OPEN=0` (the link is
then only in the server log, not on a command line) or use `elicit`.

**`SEVDESK_CONFIRM=off`** is accepted only together with `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`.

## Audit log

With `SEVDESK_AUDIT_LOG=<path>` every write call appends JSON Lines to that file: `dry_run`
(with the preview), `confirmation_requested` (with the preview and, in browser mode, the
reference code),
`confirmation_refused` (a replayed, expired or mismatched confirmation), `approval_decided` (Approve
or Reject pressed on the approval page, with the reference code), `declined`, `executing` (with how
it was approved: `elicit`, `browser`, `confirmation_off` or `not_required` for the `write` tier),
`executed` (with the records changed) and `failed` (with the error kind and any records an earlier
step already changed). Each line has a timestamp, a call id shared by the request, the decision and
the execution, the tool, its tier, the argument hash, the hash of the preview that was shown and
approved, and the arguments (token redacted, hidden characters written as visible `\u{…}` escapes,
strings up to 20,000 characters, longer ones marked). In remote mode each line also has `account`
(the sevDesk account id; `bearer` in bearer mode if the startup lookup of the account failed) and
`grant` (the grant id, or `bearer`), and one log covers every account the server serves. The file is
created with mode 0600 (and tightened to 0600 if it already exists), opened append-only and never
through a symlink. On macOS and Linux a file that belongs to another user is refused, whatever its
mode: its owner could rewrite it, and an ACL can grant access the mode does not show. Every line
is written whole or the write fails; a short write is continued, not accepted. If the `executing`
line cannot be written, the action is not run and nothing is sent (fail closed). The log is local and not tamper-proof: it records what this server did, for the
user, and is no defense against someone who controls the machine. Every line starts with `ts` and
the format version `v` (currently `1`).

## Generic read surface

`sevdesk_api_get` (toolset `advanced`, off by default) lets the model choose a GET path, which a
curated tool never does. It has four independent guards:

1. The configured sevDesk token anywhere in the path or the query is refused, and the refusal does
   not repeat the path.
2. `genericGetRefusal` refuses, before anything is sent, endpoints that change state, return files
   or start jobs (`getPdf`, `getXml`, `render`, `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`,
   the reset endpoints, `getNext…Number`, segments that start with a mutating verb, and everything
   under `Export`, `ExportJob`, `Progress`, `Report`, `DocServer` and `SevSequence`), and dangerous
   query keys: credentials (sevDesk accepts `?token=`), paging keys the tool sets itself,
   `download`, `preventSendBy`, `enshrine…`, `useNextNumber` and method overrides. Query keys are
   normalized the way PHP reads them, so `Api.Key` or `token[0]` are caught too.
3. The read-only client refuses every GET with a side effect that `resolveGetSafety` recognizes.
4. The HTTP client refuses it again, because a read declares no tier.

Answers are read with a 1 MiB cap, must be JSON in sevDesk's `{objects: …}` envelope, and are
cleaned as untrusted text: invisible characters removed, strings capped, binary content (base64
files, thumbnails) and `sevClient` echoes removed and listed, and at most about 100 KB returned.
The residual risk is an undocumented GET with a side effect that none of these rules matches; the
toolset is off by default for that reason.

## Local token storage and profiles

Over stdio the token comes from the environment, a file (`SEVDESK_API_TOKEN_FILE`) or the OS
keychain (`SEVDESK_API_TOKEN_KEYCHAIN`).

- **Keychain.** Items live under the fixed service `mcp-server-sevdesk`; configuration names only
  the label, so a hostile configuration cannot make the server read another keychain item (a
  password, another token) and send it to a custom `SEVDESK_BASE_URL`. The server runs the
  operating system's helper (`/usr/bin/security` on macOS, `secret-tool` on Linux, Windows
  PowerShell with WinRT `PasswordVault` on Windows) with an
  argument array, never through a shell. When storing, the token travels on the helper's stdin,
  never in its arguments, which other local users could see in the process list. The helper's
  output is capped, never logged or echoed, and errors are fixed texts. The keychain protects the
  token at rest, in configuration files, backups and screenshots; it does not protect against code
  that already runs as the same user. On macOS the item trusts `/usr/bin/security`, which created
  it, so any process of the user can read it that way without a dialog. On Windows the script is
  constant; operation, label and token travel only on stdin. The executable is resolved only
  beneath a validated, trusted `SystemRoot`, never through `PATH` or the current directory.
  Windows PowerShell must run in `FullLanguage` mode; Constrained Language Mode is refused
  without changing policy, with a pointer to `SEVDESK_API_TOKEN_FILE` or the `.mcpb` bundle.
  Credential Locker entries can roam with the Microsoft account; a protected token file is
  the alternative when the token must stay on this device.
- **The command line.** `token set` reads the token from stdin (hidden on a terminal), never from
  an argument, where it would stay in the shell history. It checks the token with sevDesk and
  stores nothing sevDesk rejects. Labels, profile names and unknown arguments that look like a
  token are never echoed.
- **Profiles.** A profile can widen tiers and folders, so on macOS and Linux the profiles file and
  its folder (also the real folder behind a symbolic link) must belong to the user or root and
  must not be writable by group or others; otherwise the file is refused. Windows does not check
  this. Profiles never hold a token, only where it is kept, and a profile's `token.env` may name
  only `SEVDESK_TOKEN_*` variables, so a profile cannot send an arbitrary secret from the
  environment to a custom base URL. A variable set both in the environment and by the profile is
  an error; only `SEVDESK_READ_ONLY=1` and `SEVDESK_DRY_RUN=1` in the environment may tighten a
  profile silently. Messages about the file never quote its content.
- The HTTP mode refuses `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH` and
  `SEVDESK_API_TOKEN_KEYCHAIN`: a server has no user keychain, and its configuration belongs in
  its environment.

## Claude Desktop extension

The `.mcpb` bundle runs the same server over stdio on Claude Desktop's built-in Node.js. Claude
Desktop stores the token, a setting marked sensitive, in the operating system's secure storage
(Keychain on macOS, Credential Manager on Windows) and passes it to the server as
`SEVDESK_API_TOKEN` when it starts it; the token never appears in the command line. The bundle
contains the server and all its dependencies in one file that imports only Node.js built-ins, with
the license notices of every bundled package. Confirmation cannot be switched off in the
extension: it offers no way to set `SEVDESK_I_UNDERSTAND_NO_CONFIRM`. The bundle is not signed
yet; verify a download with its provenance attestation (see [Supply chain](#supply-chain)).

## Remote mode

The HTTP transport (`--http`, operator's guide in [docs/remote.md](docs/remote.md)) adds a network
boundary and, in OAuth mode, several accounts and connections in one process. The decisions are
[ADR 0006](docs/adr/0006-built-in-authorization-server-and-grant-store.md) and
[ADR 0007](docs/adr/0007-approval-inbox-over-http.md).

**Network.** The server refuses to start without authentication. It binds `127.0.0.1` by default and
needs a public URL for any other bind address, and a public URL must use https unless its host is a
loopback name. The `Host` of every request must be one of the configured names (against DNS
rebinding; only `/healthz` is exempt, for platform health checks). An `Origin` header on `/mcp` must
name an allowed host (the check compares host names; `/mcp` sends no CORS headers, so web pages on
other origins cannot call it), and form POSTs must come from the server's own pages (`Origin: null`
is refused). Bodies are capped per route and must arrive within a short time, requests have
deadlines, and rate limits apply per client address (IPv6 per /64 network). The server handles at
most 64 requests at once: 8 per client address (32 with `SEVDESK_OAUTH_ACCOUNTS=any`) and, on
`/mcp`, 8 per sevDesk account, whatever addresses and connections they come from (429 beyond). 8
of the 64 are kept for the other routes, so token refresh, sign-in, the approval inbox and the
file pages stay reachable while `/mcp` is busy. Seven accounts that each use their 8 can still
fill `/mcp` for the others (503 until a request ends). A JSON-RPC batch, which only clients of
protocol version 2025-03-26 send, may hold at most 8 messages and no request id twice; otherwise
it is refused before any of it runs. Responses carry `nosniff`,
`no-store, no-transform` (so proxies do not rewrite pages), a referrer policy and, on https, HSTS. URLs the server prints or redirects to are built
from the configured public URL, never from request headers. `SEVDESK_HTTP_TRUST_PROXY` must match
the real number of proxies in front: a higher value lets clients choose the IP address the rate
limits see. Plain http is only accepted for a loopback public URL; keep such a setup to quick local
tests (see the inbox limits below).

**Bearer mode.** One shared secret (two during a rotation), at least 32 characters with at least 16
different ones, and never equal to the sevDesk token. The server compares an HMAC of the presented
value with an HMAC of each configured value using `timingSafeEqual`, without stopping at the first
match. Whoever holds the secret can use the server's tiers on its account. Startup warns when a
bearer or server secret looks like a passphrase rather than random bytes.

**OAuth consent and allowlists.** The consent page shows the host of the client's `client_id`, the
client's self-declared name (sanitized and labelled as such) and the host it will redirect to, with
a warning when every redirect goes to a loopback address (an app on the user's machine). Only `read`
is preselected; other tiers must be ticked. Clients get that far only when their metadata document
is on a host in `SEVDESK_OAUTH_CLIENTS` (default `claude.ai`), checked before anything is fetched:
an attacker cannot make your consent page present their own client (consent phishing). Only sevDesk
accounts in `SEVDESK_OAUTH_ACCOUNTS` can complete the consent, so a server whose URL becomes known
does not turn into a service for strangers' accounts; a refused account is logged as
`account_refused`. Both allowlists also apply to every request and refresh: after an account or
client host is removed and the server restarted, its existing grants are revoked at their next use
and the account's inbox sessions end. A checked consent can complete only once, and each account
holds a limited number of live grants (a new consent beyond it replaces the account's oldest), so
one account cannot fill the grant store for everyone else. The page uses a `SameSite=Strict` CSRF
cookie with a matching HMAC field, accepts POSTs only from itself, cannot be framed, and its Content
Security Policy sends forms only to itself and the validated redirect origin. Errors in the client,
its metadata or the redirect URI show an error page and never redirect. The pasted sevDesk token is
checked with sevDesk and never shown again.

**Fetching client metadata (SSRF).** Fetching a `client_id` URL is a request the server makes for
someone else. The URL must be https on a DNS name, without query, fragment, credentials or dot
segments, on an allowlisted host. The name is resolved once, every address must be public
(private, loopback, link-local, CGNAT, unique-local, documentation and multicast ranges are
refused, also inside NAT64, 6to4 and IPv4-mapped addresses), and the connection goes to the
address that was checked. No redirects, 3 seconds to connect and 5 in total, `application/json`
only, at most 5 KiB. The document must name the same `client_id`, list 1–10 redirect URIs and have
no client secret. Refusals are logged as `cimd_blocked`.

**OAuth tokens and revocation.** PKCE with S256 only; the verifier's hash is compared in constant
time. Redirect URIs match exactly (loopback redirects: the host exactly, any port). Authorization
codes live 60 seconds and are used once: a second exchange revokes the grant (`code_replay`).
Access tokens live 1 hour and are valid only for `<public URL>/mcp` (RFC 8707, exact match), and
every request looks the grant up, so a revocation takes effect on the next request. Refresh tokens
are replaced on every use; the previous one is accepted for 30 seconds after a rotation, and any
later use revokes the grant (`refresh_replay`). Every refresh checks the sevDesk token with sevDesk
again, and a 401 revokes the grant. A grant ends after 90 days at the latest. All tokens are
AES-256-GCM-sealed under a key per purpose, with type, issuer and key id authenticated, and carry
a readable `sdmcp_` prefix so redaction and secret scanners find them. Access ends with
`grants revoke` (one grant, an account, or all), the client's `/revoke` call (RFC 7009), a new
server secret without `_PREVIOUS` (everything), or a regenerated sevDesk token. A regenerated
token stops tool calls at once, because sevDesk refuses it, and revokes each grant that holds it
at its next refresh; it does not end inbox sessions, since a sign-in with a pasted token is not
tied to that token (it lasts up to 12 hours) and a consent session lasts until its grant is
revoked. `grants revoke --account <id>` ends the grants and every inbox session of the account at
once. A server that loses its lock on the state directory to another stops trusting its grant
store (OAuth requests fail with a server error) and exits, so it never answers from grants it can
no longer keep current.

**What the server secret can decrypt.** Every key comes from `SEVDESK_HTTP_SECRET`. Someone who
has it and captures an authorization code, an access or refresh token, or a consent page's form
state (from a client, a proxy log, a TLS-terminating middlebox) can read the sevDesk token inside.
The secret alone yields no sevDesk token, because the server stores none. Keep it in a secret
store (`SEVDESK_HTTP_SECRET_FILE`), never in the image, the repository or a deploy template, and
protect the state directory as well: with the secret and a copy of it, someone could forge an inbox
session for a listed session id. If the secret may have leaked, replace it without `_PREVIOUS`
(every client reconnects); if tokens may have leaked too, regenerate the sevDesk tokens and run
`grants revoke --account <id>` for the affected accounts.

**The approval inbox.** In remote mode `SEVDESK_CONFIRM=browser` serves an inbox at
`<public URL>/approvals`. Its URL is not a secret: the model sees it in the tool result, and without
a session the inbox shows only a sign-in form, no approval data. A browser gets a session at the
OAuth consent, or by pasting the sevDesk token (OAuth: checked with sevDesk and against the account
list; bearer: compared in constant time with the server's `SEVDESK_API_TOKEN`, never the bearer
secret, which the client holds). Sign-ins are limited to 5 a minute and 20 an hour per client
address (IPv6 per /64 network).
The session cookie is sealed and holds no sevDesk token, is `HttpOnly`, `Secure`, `SameSite=Lax`
and `__Host-` prefixed, lasts 12 hours, gets a new id at every sign-in and ends with its grant or
with `grants revoke --account`.
`Lax` is needed because the link is followed from claude.ai, a cross-site navigation; decisions are
POSTs that must also carry a CSRF token bound to the session and come from the inbox itself
(Origin, or `Sec-Fetch-Site: same-origin`; never `Origin: null`). Each decision checks that the
approval belongs to the session's account. An approval belongs to the grant that asked: a retry
from another connection, even of the same account, cannot use it. Approvals still bind tool,
arguments and preview, expire after 10 minutes, are used once, and at most five per account wait at
a time. An account keeps at most 20 approvals, waiting and decided, and makes room among its own.
The server keeps 100 in all. When that is reached, room comes only from an account that holds
more approvals than the one asking: its oldest rejected or waiting one first, an approved one
that was not used yet last (its owner is asked again on the next try, as after an expiry). So no
account loses an approval to one that holds as many or more, and a few accounts that leave
approved requests unused cannot keep the others from asking.

**Limits of the inbox.** An agent that can drive a signed-in browser (browser automation, a
computer-use tool) can still approve on its own: like the local page, the inbox protects against a
model that only talks. A lookalike page could phish the sevDesk token; paste it only on your own
server's `/approvals` (most users never need to, because the consent signs the browser in). Everyone
who can sign in to an account shares its inbox and can decide its approvals; they hold that
account's token anyway. A session stays valid for 12 hours on that browser, so sign out on a shared
computer; regenerating the sevDesk token does not end it (use `grants revoke --account`). On a
plain-http loopback URL (development) the cookie has no `__Host-` prefix and no `Secure` flag, and
browsers do not separate cookies by port: any other web server the browser reaches on that host
name receives the session cookie and could read and decide approvals. Use https, or a dedicated
browser profile, for anything beyond a quick local test. A restart voids pending approvals.

**Logs.** One JSON line per request on stderr: the route template, status, duration, client IP and
the first 8 characters of the grant id. Headers, bodies, cookies and query strings are never logged,
and every line is scrubbed of the sevDesk token, the bearer secrets, the server secret, sealed
tokens and any run of 32 or more hex digits (the shape of a sevDesk token). Errors, HTML pages and
redirects never contain a secret, and the in-memory grant object leaves the sevDesk token out when
it is serialized or inspected. Security events are logged by name (`refresh_replay`, `code_replay`,
`account_refused`, `cimd_blocked`).

**What stays the operator's job.** TLS in front of the server (a reverse proxy, a platform's edge or
a tunnel; whoever terminates TLS can see tokens in transit, so choose a provider you trust and keep
quick tunnels for tests), the server secret, a persistent volume for the state directory, exactly
one instance, narrow allowlists, and updating the image.

## Remote mode: files

With `SEVDESK_HTTP_FILES` on (the default), files reach the tools through upload pages and leave
as download links on the server ([docs/remote.md](docs/remote.md#files-uploads-and-download-links),
[ADR 0008](docs/adr/0008-file-transfer-over-http.md)). The model never sees or sends file bytes.

**Links are not capabilities.** `sevdesk_upload_request` returns `<public URL>/uploads/<id>` and
the delivering tools return `<public URL>/files/<id>`: the model sees both, so neither is a secret.
Every page needs the browser session of the approval inbox for the record's account (set at OAuth
consent, or by signing in with the account's sevDesk token; in bearer mode never with the bearer
secret). Without a session a page shows only the sign-in form, whose `next` accepts only the
server's own record paths (no open redirect). A record of another account answers exactly like an
unknown id (404). Tools read only uploads their own grant asked for; another grant, even of the
same account, gets the same refusal as an unknown id. Ids are 256-bit random; error messages,
summaries and logs never contain them.

**Uploads.** The page shows only trusted values (purpose, accepted kinds, size limit, account,
reference, expiry), so a prompt-injected model cannot put instructions on it. An upload is a
same-origin POST (`Origin: null` refused) with a CSRF token bound to the session, exactly the
fields `csrf` and `file`, and passes its checks before the body is read: rate limits (10 a minute
and 60 an hour per client), the session, an open ticket of that account, a declared
`Content-Length` (411 without) within the limit (413), and at most two bodies at once (503). The
file type is checked by content (receipts PDF, PNG, JPEG; e-invoices XML, PDF); no ZIP is
accepted, images are never decoded, and the e-invoice parser keeps its own guards against hostile
XML and PDFs. Names are cleaned to `[A-Za-z0-9._-]` (umlauts spelled out, path parts, control and
invisible characters, quotes and markup removed, at most 100 characters, extension from the
content), always escaped, and never used as paths. Each page takes one file; uploads are never
served back.

**Downloads.** The bytes are fetched from sevDesk during the tool call (PDFs with
`preventSendBy=true`); opening a link makes no sevDesk request and has no side effect. Responses
are attachments only (`Content-Disposition: attachment` with an ASCII and an RFC 5987 name), with
`Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `X-Frame-Options: DENY`,
`Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` and
`Cache-Control: no-store`: a file is never rendered on the server's origin, where XML could run
script. HEAD is refused. A link serves at most 5 downloads. A response is written in pieces of 64
KiB, and the connection is closed when the browser takes none of them for a minute: a browser
that stops reading cannot hold the file in memory for long, while a slow connection that keeps
reading gets the whole file.

**Storage.** Records live in memory only; the bytes in memory or in `<stateDir>/files/` (folder
0700, files 0600 created exclusively without following links, random names), encrypted with
AES-256-GCM under a key drawn at random when the process starts and never written anywhere, with
the blob id, account and kind authenticated (a blob swapped between records fails to open). Files
are deleted when they expire and at shutdown, and the folder is emptied at every startup, after the
state directory's lock is taken (a second server never touches a live one's files). A copy of the
volume or of the server secret opens none of them. Upload pages live 15 minutes, uploads and links
`SEVDESK_HTTP_FILES_TTL` (30 minutes, at most 24 hours).

**Exhaustion.** One upload is at most 20 MiB; one account holds at most 5 open upload pages, 10
uploads and links and half of `SEVDESK_HTTP_FILES_MAX_MB`; the server at most 1,000 records and the
full budget. Nothing is evicted, so one account cannot push out another's files; new requests are
refused until older ones expire.

**Logs and audit.** Log lines and `file_received`, `file_link_created` and `file_downloaded` audit
lines carry the account, grant, reference code, kind, size and SHA-256, never ids, file names or
content; request lines show the route templates `/uploads/*` and `/files/*`, and an `upload:` tool
argument is written to the audit log as `upload:[REDACTED]`.

**Limits.** An agent that can drive a signed-in browser could upload or download on its own, as it
could approve in the inbox. On a plain-http loopback URL other local web servers receive the
session cookie (startup warns). Whoever terminates TLS sees the files in transit. With
`SEVDESK_OAUTH_ACCOUNTS=any` the server briefly holds other people's receipts and exports (startup
warns). A downloaded file is whatever sevDesk returned.

## Supply chain

Releases are published from CI with npm provenance (trusted publishing, no long-lived tokens),
GitHub Actions are pinned by commit SHA, and the repository is scanned by CodeQL, dependency
review and OpenSSF Scorecard.

The container image `ghcr.io/jaylann/mcp-server-sevdesk` is built by the release workflow from base
images pinned by digest. It runs as a non-root user (uid 65532) on a distroless Node.js base, and
each release carries a build-provenance attestation and BuildKit's SBOM and provenance. Verify an
image before you run it, then pin the digest you verified:

```bash
gh attestation verify oci://ghcr.io/jaylann/mcp-server-sevdesk:<version> --owner jaylann
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .SBOM }}'
```

The Claude Desktop extension (`mcp-server-sevdesk-<version>.mcpb`) is built by the release workflow
too. Each new GitHub release attaches the extension and two files from its build-provenance
attestation:

- `<asset>.sigstore.json`: the complete Sigstore bundle, including the signature, certificate and
  transparency-log verification material.
- `<asset>.intoto.jsonl`: the signed DSSE envelope as one JSON line, containing the in-toto
  provenance statement. This is not a complete Sigstore bundle; use `.sigstore.json` with `gh`.

Verify the downloaded extension against GitHub's attestation store:

```bash
gh attestation verify mcp-server-sevdesk-<version>.mcpb --owner jaylann
```

Or download the matching `.sigstore.json` release asset and verify using that bundle:

```bash
gh attestation verify mcp-server-sevdesk-<version>.mcpb \
  --bundle mcp-server-sevdesk-<version>.mcpb.sigstore.json --owner jaylann
```

Both commands check the artifact's digest, signature and signer identity. The `--bundle` form
uses the local attestation; `gh` may still fetch Sigstore trust roots. See the
[GitHub CLI verification reference](https://cli.github.com/manual/gh_attestation_verify) for
verification policies and offline trust roots.

Maintainers use `node scripts/attach-release-attestation.ts [--dry-run] <tag> <asset> [bundle]`
for the release job and backfills. It checks the subject SHA-256 before writing or uploading
either file. A supplied bundle is preserved unchanged; otherwise it fetches by digest and
requires exactly one attestation across all API pages. `--dry-run` writes both files beside the
asset and prints the intended upload without changing the release. The script checks digest
consistency; use `gh attestation verify` for cryptographic verification before a backfill.
