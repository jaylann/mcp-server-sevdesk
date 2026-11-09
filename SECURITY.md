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
   the XML parser refuses DOCTYPEs and entities and caps size and nesting depth, the PDF attachment
   reader caps decompressed sizes, and every parsed text field is treated as untrusted. The DATEV
   export ZIP is fetched from a presigned link that sevDesk returns; the server accepts exactly
   one https host for it, follows no redirects, sends no credentials, caps the size and never
   shows the link to the model.
6. **Remote mode adds a network boundary.** The HTTP transport refuses to start without
   authentication, binds 127.0.0.1 by default (any other address needs a configured public URL),
   and validates Host and Origin. In OAuth mode it is single-tenant by default (only listed sevDesk accounts can connect,
   only allowlisted clients can ask), stores no sevDesk tokens (each user's token travels sealed
   inside the tokens their client holds), and scopes approvals, confirmations and caches to the
   account and grant of each request. See [Remote mode](#remote-mode).

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
10 minutes, bound to the method, the client and, in HTTP mode, the grant and the account). It binds the tool name,
a SHA-256 of the arguments (without `dryRun`), a SHA-256 of the preview and a single-use nonce. On
the retry the server refuses a state for other arguments or another tool, refuses a replayed
approval (the nonce is consumed once), prepares the action again and, if the preview changed in the
meantime (the record was edited), asks again instead of executing. Decline, cancel or an unchecked
switch return `declined`: nothing changes. For 2025-era clients the SDK's legacy shim sends a
real `elicitation/create` request on the same connection, so the same checks apply. Clients that
do not declare form elicitation, and 2025-era clients over stateless HTTP (which cannot receive
server-to-client requests), get an error telling the user to switch to `browser`; nothing is sent.

**`SEVDESK_CONFIRM=browser`** over stdio. For clients without elicitation, the server creates an
approval page, served by itself on `127.0.0.1` and an ephemeral port only, and opens it in the user's
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
assistant cannot flood the browser with tabs. In remote mode `browser` uses the server's approval
inbox instead (see [Remote mode](#remote-mode)).

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
written as visible `\u{…}` escapes, strings up to 20,000 characters, longer ones marked). In
remote mode each line also names the sevDesk account and the grant, and one log covers every
account the server serves. The
file is created with mode 0600 (and tightened to 0600 if it already exists), opened append-only and
never through a symlink. If the `executing` line cannot be written, the action is not run and
nothing is sent (fail closed). The log is local and not tamper-proof: it records what this server
did, for the user, and is no defense against someone who controls the machine.

## Remote mode

The HTTP transport (`--http`, operator's guide in [docs/remote.md](docs/remote.md)) adds a network
boundary and, in OAuth mode, several accounts and connections in one process. The decisions are
[ADR 0006](docs/adr/0006-built-in-authorization-server-and-grant-store.md) and
[ADR 0007](docs/adr/0007-approval-inbox-over-http.md).

**Network.** The server refuses to start without authentication. It binds `127.0.0.1` by default
and needs a public URL for any other bind address, and a public URL must use https unless its host
is a loopback name. The
`Host` of every request must be one of the configured names (against DNS rebinding; only
`/healthz` is exempt, for platform health checks). Browser `Origin`s on `/mcp` must be allowed,
and form POSTs must come from the server's own pages (`Origin: null` is refused). Bodies are capped
per route, requests have deadlines, rate limits apply per client IP, and at most 64 requests run at
once. Responses carry `nosniff`, `no-store`, a referrer policy and, on https, HSTS. URLs the server
prints or redirects to are built from the configured public URL, never from request headers.
`SEVDESK_HTTP_TRUST_PROXY` must match the real number of proxies in front: a higher value lets
clients choose the IP address the rate limits see.

**Bearer mode.** One shared secret (two during a rotation), at least 32 characters with at least 16
different ones, and never equal to the sevDesk token. The server compares an HMAC of the presented
value with an HMAC of each configured value using `timingSafeEqual`, without stopping at the first
match. Whoever holds the secret can use the server's tiers on its account.

**OAuth consent and allowlists.** The consent page shows the host of the client's `client_id`, the
client's self-declared name (sanitized and labelled as such) and the host it will redirect to, with
a warning when every redirect goes to a loopback address (an app on the user's machine). Only
`read` is preselected; other tiers must be ticked. Clients get that far only when their metadata
document is on a host in `SEVDESK_OAUTH_CLIENTS` (default `claude.ai`), checked before anything is
fetched: an attacker cannot make your consent page present their own client (consent phishing).
Only sevDesk accounts in `SEVDESK_OAUTH_ACCOUNTS` can complete the consent, so a server whose URL
becomes known does not turn into a service for strangers' accounts; a refused account is logged as
`account_refused`. The page uses a `SameSite=Strict` CSRF cookie with a matching HMAC field, accepts
POSTs only from itself, cannot be framed, and its Content Security Policy sends forms only to
itself and the validated redirect origin. Errors in the client, its metadata or the redirect URI
show an error page and never redirect. The pasted sevDesk token is checked with sevDesk and never
shown again.

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
server secret without `_PREVIOUS` (everything), or a regenerated sevDesk token (every grant that
holds the old one).

**What the server secret can decrypt.** Every key comes from `SEVDESK_HTTP_SECRET`. Someone who
has it and captures an authorization code, an access or refresh token, or a consent page's form
state (from a client, a proxy log, a TLS-terminating middlebox) can read the sevDesk token inside.
The secret alone yields no sevDesk token, because the server stores none. Keep it in a secret
store (`SEVDESK_HTTP_SECRET_FILE`), never in the image, the repository or a deploy template, and
protect the state directory as well: with the secret and a copy of it, someone could forge an inbox
session for a listed session id. If the secret may have leaked, replace it without `_PREVIOUS`
(every client reconnects); if tokens may have leaked too, regenerate the sevDesk tokens.

**The approval inbox.** In remote mode `SEVDESK_CONFIRM=browser` serves an inbox at
`<public URL>/approvals`. Its URL is not a secret: the model sees it in the tool result, and without
a session the inbox shows only a sign-in form, no approval data. A browser gets a session at the
OAuth consent, or by pasting the sevDesk token (OAuth: checked with sevDesk and against the account
list; bearer: compared in constant time with the server's `SEVDESK_API_TOKEN`, never the bearer
secret, which the client holds). Sign-ins are limited to 5 a minute and 20 an hour per IP address.
The session cookie is sealed and holds no sevDesk token, is `HttpOnly`, `Secure`, `SameSite=Lax`
and `__Host-` prefixed, lasts 12 hours, gets a new id at every sign-in and ends with its grant.
`Lax` is needed because the link is followed from claude.ai, a cross-site navigation; decisions are
POSTs that must also carry a CSRF token bound to the session and come from the inbox itself
(Origin, or `Sec-Fetch-Site: same-origin`; never `Origin: null`). Each decision checks that the
approval belongs to the session's account. An approval belongs to the grant that asked: a retry
from another connection, even of the same account, cannot use it. Approvals still bind tool,
arguments and preview, expire after 10 minutes, are used once, and at most five per account wait at
a time.

**Limits of the inbox.** An agent that can drive a signed-in browser (browser automation, a
computer-use tool) can still approve on its own: like the local page, the inbox protects against a
model that only talks. A lookalike page could phish the sevDesk token; paste it only on your own
server's `/approvals` (most users never need to, because the consent signs the browser in). Everyone
who can sign in to an account shares its inbox and can decide its approvals; they hold that
account's token anyway. A session stays valid for 12 hours on that browser, so sign out on a shared
computer. A restart voids pending approvals.

**Logs.** One JSON line per request on stderr: the route template, status, duration, client IP and
the first 8 characters of the grant id. Headers, bodies, cookies and query strings are never
logged, and every line is scrubbed of the sevDesk token, the bearer secrets, the server secret and
sealed tokens. Errors, HTML pages and redirects never contain a secret, and the in-memory grant
object leaves the sevDesk token out when it is serialized or inspected. Security events are logged
by name (`refresh_replay`, `code_replay`, `account_refused`, `cimd_blocked`).

**What stays the operator's job.** TLS in front of the server (a reverse proxy, a platform's edge or
a tunnel; whoever terminates TLS can see tokens in transit, so choose a provider you trust and keep
quick tunnels for tests), the server secret, a persistent volume for the state directory, exactly
one instance, narrow allowlists, and updating the image.

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
