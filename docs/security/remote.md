# Remote mode

The threat analysis of the HTTP transport (`--http`): the network boundary, bearer and OAuth
authentication, the approval inbox and file transfer. It is for operators who want to know what
the server defends against and what stays their job; the setup steps are in
[Remote mode](../remote.md). The decisions behind it are
[ADR 0006](../adr/0006-built-in-authorization-server-and-grant-store.md),
[ADR 0007](../adr/0007-approval-inbox-over-http.md) and
[ADR 0008](../adr/0008-file-transfer-over-http.md).

Remote mode adds a network boundary and, in OAuth mode, several accounts and connections in one
process. Approvals, confirmations and caches are scoped to the account and grant of each request.

## Network

The server refuses to start without authentication. It binds `127.0.0.1` by default and needs a
public URL for any other bind address, and a public URL must use https unless its host is a
loopback name.

- **Host and Origin.** The `Host` of every request must be one of the configured names (against
  DNS rebinding; only `/healthz` is exempt, for platform health checks). An `Origin` header on
  `/mcp` must name an allowed host (the check compares host names; `/mcp` sends no CORS headers, so
  web pages on other origins cannot call it), and form POSTs must come from the server's own pages
  (`Origin: null` is refused).
- **Bodies, deadlines and rate limits.** Bodies are capped per route and must arrive within a
  short time, requests have deadlines, and rate limits apply per client address (IPv6 per /64
  network).
- **Requests at once.** At most 64: 8 per client address (32 with `SEVDESK_OAUTH_ACCOUNTS=any`)
  and, on `/mcp`, 8 per sevDesk account, whatever addresses and connections they come from (429
  beyond). 8 of the 64 are kept for the other routes, so token refresh, sign-in, the approval
  inbox and the file pages stay reachable while `/mcp` is busy. Seven accounts that each use their
  8 can still fill `/mcp` for the others (503 until a request ends).
- **Batches.** A JSON-RPC batch, which only clients of protocol version 2025-03-26 send, may hold
  at most 8 messages and no request id twice; otherwise it is refused before any of it runs.
- **Headers.** Responses carry `nosniff`, `no-store, no-transform` (so proxies do not rewrite
  pages), a referrer policy and, on https, HSTS. URLs the server prints or redirects to are built
  from the configured public URL, never from request headers.
- **Proxies.** `SEVDESK_HTTP_TRUST_PROXY` must match the real number of proxies in front: a higher
  value lets clients choose the IP address the rate limits see.

Plain http is only accepted for a loopback public URL; keep such a setup to quick local tests (see
[Limits of the inbox](#limits-of-the-inbox)).

## Bearer mode

One shared secret (two during a rotation), at least 32 characters with at least 16 different ones,
and never equal to the sevDesk token. The server compares an HMAC of the presented value with an
HMAC of each configured value using `timingSafeEqual`, without stopping at the first match.
Whoever holds the secret can use the server's tiers on its account. Startup warns when a bearer or
server secret looks like a passphrase rather than random bytes.

## OAuth consent and allowlists

The consent page shows the host of the client's `client_id`, the client's self-declared name
(sanitized and labelled as such) and the host it will redirect to, with a warning when every
redirect goes to a loopback address (an app on the user's machine). Only `read` is preselected;
other tiers must be ticked.

- **Clients.** Clients get that far only when their metadata document is on a host in
  `SEVDESK_OAUTH_CLIENTS` (default `claude.ai`), checked before anything is fetched: an attacker
  cannot make your consent page present their own client (consent phishing).
- **Accounts.** Only sevDesk accounts in `SEVDESK_OAUTH_ACCOUNTS` can complete the consent, so a
  server whose URL becomes known does not turn into a service for strangers' accounts; a refused
  account is logged as `account_refused`. The server stores no sevDesk tokens: each user's token
  travels sealed inside the tokens their client holds.
- **On every request.** Both allowlists also apply to every request and refresh: after an account
  or client host is removed and the server restarted, its existing grants are revoked at their
  next use and the account's inbox sessions end.
- **Grant limits.** A checked consent can complete only once, and each account holds a limited
  number of live grants (a new consent beyond it replaces the account's oldest), so one account
  cannot fill the grant store for everyone else.

The page uses a `SameSite=Strict` CSRF cookie with a matching HMAC field, accepts POSTs only from
itself, cannot be framed, and its Content Security Policy sends forms only to itself and the
validated redirect origin. Errors in the client, its metadata or the redirect URI show an error
page and never redirect. The pasted sevDesk token is checked with sevDesk and never shown again.

## Fetching client metadata (SSRF)

Fetching a `client_id` URL is a request the server makes for someone else. The URL must be https on
a DNS name, without query, fragment, credentials or dot segments, on an allowlisted host. The name
is resolved once, every address must be public (private, loopback, link-local, CGNAT,
unique-local, documentation and multicast ranges are refused, also inside NAT64, 6to4 and
IPv4-mapped addresses), and the connection goes to the address that was checked. No redirects, 3
seconds to connect and 5 in total, `application/json` only, at most 5 KiB. The document must name
the same `client_id`, list 1–10 redirect URIs and have no client secret. Refusals are logged as
`cimd_blocked`.

## OAuth tokens and revocation

PKCE with S256 only; the verifier's hash is compared in constant time. Redirect URIs match exactly
(loopback redirects: the host exactly, any port).

- Authorization codes live 60 seconds and are used once: a second exchange revokes the grant
  (`code_replay`).
- Access tokens live 1 hour and are valid only for `<public URL>/mcp` (RFC 8707, exact match), and
  every request looks the grant up, so a revocation takes effect on the next request.
- Refresh tokens are replaced on every use; the previous one is accepted for 30 seconds after a
  rotation, and any later use revokes the grant (`refresh_replay`). Every refresh checks the
  sevDesk token with sevDesk again, and a 401 revokes the grant.
- A grant ends after 90 days at the latest.

All tokens are AES-256-GCM-sealed under a key per purpose, with type, issuer and key id
authenticated, and carry a readable `sdmcp_` prefix so redaction and secret scanners find them.

Access ends with `grants revoke` (one grant, an account, or all), the client's `/revoke` call
(RFC 7009), a new server secret without `_PREVIOUS` (everything), or a regenerated sevDesk token. A
regenerated token stops tool calls at once, because sevDesk refuses it, and revokes each grant
that holds it at its next refresh. It does not end inbox sessions: a sign-in with a pasted token is
not tied to that token (it lasts up to 12 hours), and a consent session lasts until its grant is
revoked. `grants revoke --account <id>` ends the grants and every inbox session of the account at
once.

A server that loses its lock on the state directory to another stops trusting its grant store
(OAuth requests fail with a server error) and exits, so it never answers from grants it can no
longer keep current.

## What the server secret can decrypt

Every key comes from `SEVDESK_HTTP_SECRET`. Someone who has it and captures an authorization code,
an access or refresh token, or a consent page's form state (from a client, a proxy log, a
TLS-terminating middlebox) can read the sevDesk token inside. The secret alone yields no sevDesk
token, because the server stores none.

Keep it in a secret store (`SEVDESK_HTTP_SECRET_FILE`), never in the image, the repository or a
deploy template, and protect the state directory as well: with the secret and a copy of it,
someone could forge an inbox session for a listed session id. If the secret may have leaked,
replace it without `_PREVIOUS` (every client reconnects); if tokens may have leaked too, regenerate
the sevDesk tokens and run `grants revoke --account <id>` for the affected accounts.

## The approval inbox

In remote mode `SEVDESK_CONFIRM=browser` serves an inbox at `<public URL>/approvals`
([how to use it](../remote/approvals.md)). Its URL is not a secret: the model sees it in the tool
result, and without a session the inbox shows only a sign-in form, no approval data.

- **Sign-in.** A browser gets a session at the OAuth consent, or by pasting the sevDesk token
  (OAuth: checked with sevDesk and against the account list; bearer: compared in constant time
  with the server's `SEVDESK_API_TOKEN`, never the bearer secret, which the client holds).
  Sign-ins are limited to 5 a minute and 20 an hour per client address (IPv6 per /64 network).
- **Session cookie.** Sealed, holds no sevDesk token, `HttpOnly`, `Secure`, `SameSite=Lax` and
  `__Host-` prefixed; lasts 12 hours, gets a new id at every sign-in and ends with its grant or
  with `grants revoke --account`. `Lax` is needed because the link is followed from claude.ai, a
  cross-site navigation.
- **Decisions** are POSTs that must also carry a CSRF token bound to the session and come from the
  inbox itself (Origin, or `Sec-Fetch-Site: same-origin`; never `Origin: null`). Each decision
  checks that the approval belongs to the session's account.
- **Binding.** An approval belongs to the grant that asked: a retry from another connection, even
  of the same account, cannot use it. Approvals still bind
  [what every approval binds](confirmation.md#what-an-approval-binds), expire after 10 minutes, are
  used once, and at most five per account wait at a time.
- **Room.** An account keeps at most 20 approvals, waiting and decided, and makes room among its
  own; the server keeps 100 in all. When that is reached, room comes only from an account that
  holds more approvals than the one asking: its oldest rejected or waiting one first, an approved
  one that was not used yet last (its owner is asked again on the next try). So no account loses
  an approval to one that holds as many or more.

## Limits of the inbox

- An agent that can drive a signed-in browser (browser automation, a computer-use tool) can still
  approve on its own: like the [local page](confirmation.md#limits-of-the-browser-mode), the inbox
  protects against a model that only talks.
- A lookalike page could phish the sevDesk token; paste it only on your own server's `/approvals`
  (most users never need to, because the consent signs the browser in).
- Everyone who can sign in to an account shares its inbox and can decide its approvals; they hold
  that account's token anyway.
- A session stays valid for 12 hours on that browser, so sign out on a shared computer;
  regenerating the sevDesk token does not end it (use `grants revoke --account`).
- On a plain-http loopback URL (development) the cookie has no `__Host-` prefix and no `Secure`
  flag, and browsers do not separate cookies by port: any other web server the browser reaches on
  that host name receives the session cookie and could read and decide approvals. Use https, or a
  dedicated browser profile, for anything beyond a quick local test.
- A restart voids pending approvals.

## Files

With `SEVDESK_HTTP_FILES` on (the default), files reach the tools through upload pages and leave as
download links on the server ([how to use them](../remote/files.md)). The model never sees or sends
file bytes.

**Links are not capabilities.** `sevdesk_upload_request` returns `<public URL>/uploads/<id>` and the
delivering tools return `<public URL>/files/<id>`: the model sees both, so neither is a secret.
Every page needs the inbox's browser session for the record's account. Without a session a page
shows only the sign-in form, whose `next` accepts only the server's own record paths (no open
redirect). A record of another account answers exactly like an unknown id (404). Tools read only
uploads their own grant asked for; another grant, even of the same account, gets the same refusal.
Ids are 256-bit random; error messages, summaries and logs never contain them.

**Uploads.** The page shows only trusted values (purpose, accepted kinds, size limit, account,
reference, expiry), so a prompt-injected model cannot put instructions on it. An upload is a
same-origin POST (`Origin: null` refused) with a CSRF token bound to the session, exactly the fields
`csrf` and `file`, and passes its checks before the body is read: rate limits, the session, an open
ticket of that account, a declared `Content-Length` (411 without) within the limit (413), and at
most two bodies at once (503). The file type is checked by content; no ZIP is accepted, images are
never decoded, and the e-invoice parser keeps its own guards against hostile XML and PDFs
([Local files](local.md#local-files)). Names are cleaned to `[A-Za-z0-9._-]` (path parts, control
and invisible characters, quotes and markup removed), always escaped, and never used as paths.
Uploads are never served back.

**Downloads.** The bytes are fetched from sevDesk during the tool call (PDFs with
`preventSendBy=true`); opening a link makes no sevDesk request and has no side effect. Responses are
attachments only (`Content-Disposition: attachment`), with
`Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `X-Frame-Options: DENY`,
`Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` and
`Cache-Control: no-store`: a file is never rendered on the server's origin, where XML could run
script. HEAD is refused. A link serves at most 5 downloads, written in pieces of 64 KiB; a browser
that takes none of them for a minute is cut off, so it cannot hold the file in memory for long.

**Storage.** Records live in memory only; the bytes in memory or in `<stateDir>/files/` (folder
0700, files 0600 created exclusively without following links, random names), encrypted with
AES-256-GCM under a key drawn at random when the process starts and never written anywhere, with
the blob id, account and kind authenticated (a blob swapped between records fails to open). Files
are deleted when they expire and at shutdown, and the folder is emptied at every startup, after the
state directory's lock is taken. A copy of the volume or of the server secret opens none of them.

**Exhaustion.** Per-upload, per-account and server-wide caps apply
([limits](../remote/files.md#limits-and-lifetimes)). Nothing is evicted, so one account cannot push out another's files;
new requests are refused until older ones expire.

**Logs and audit.** Log lines and the file events of the [audit log](../permissions/audit-log.md)
carry the account, grant, reference code, kind, size and SHA-256, never ids, file names or content;
request lines show the route templates `/uploads/*` and `/files/*`, and an `upload:` tool argument
is written to the audit log as `upload:[REDACTED]`.

**Limits.** An agent that can drive a signed-in browser could upload or download on its own, as it
could approve in the inbox. On a plain-http loopback URL other local web servers receive the
session cookie (startup warns). Whoever terminates TLS sees the files in transit. With
`SEVDESK_OAUTH_ACCOUNTS=any` the server briefly holds other people's receipts and exports (startup
warns). A downloaded file is whatever sevDesk returned.

## Logs

One JSON line per request on stderr: the route template, status, duration, client IP and the first
8 characters of the grant id. Headers, bodies, cookies and query strings are never logged, and every
line is scrubbed of the sevDesk token, the bearer secrets, the server secret, sealed tokens and any
run of 32 or more hex digits (the shape of a sevDesk token). Errors, HTML pages and redirects never
contain a secret, and the in-memory grant object leaves the sevDesk token out when it is serialized
or inspected. Security events are logged by name (`refresh_replay`, `code_replay`,
`account_refused`, `cimd_blocked`).

## What stays the operator's job

TLS in front of the server (a reverse proxy, a platform's edge or a tunnel; whoever terminates TLS
can see tokens in transit, so choose a provider you trust and keep quick tunnels for tests), the
server secret, a persistent volume for the state directory, exactly one instance, narrow
allowlists, and updating the image.
