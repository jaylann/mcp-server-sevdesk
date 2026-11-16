# Operating the server

Day-to-day work for the operator of a [remote](../remote.md) server: the operator commands, how to
revoke access and rotate the secret, what the logs show, health checks and shutdown, and the fixed
limits.

## Commands

The binary has a few commands besides serving. With Docker, append them to
`docker run --rm <image>` (the image's default command is `--http`).

| Command                                  | What it does                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate-secret`                        | Prints 32 random bytes, base64url: a value for `SEVDESK_HTTP_SECRET` or a bearer secret.                                                                                                                                                                                                                       |
| `account-id`                             | Asks sevDesk which account the configured token belongs to (`SEVDESK_API_TOKEN`, its `_FILE`, the keychain or a profile) and prints its id, for `SEVDESK_OAUTH_ACCOUNTS`.                                                                                                                                      |
| `grants list [--json]`                   | Lists the grants in `SEVDESK_HTTP_STATE_DIR`, newest first: id, account, client host, tiers, status (with the reason of a revocation), created, expires and last refresh. `--json` prints JSON with the full `client_id` (fields below).                                                                       |
| `grants revoke <grant-id>`               | Revokes one grant and its browser sessions.                                                                                                                                                                                                                                                                    |
| `grants revoke --account <id>` / `--all` | Revokes every grant of one account, or all grants.                                                                                                                                                                                                                                                             |
| `healthcheck`                            | Asks the server at `SEVDESK_HTTP_HOST` and its port for `/healthz` (127.0.0.1 when it binds to all interfaces) and exits 0 when it answers `{"status":"ok"}`; the image's health check uses it. Without `SEVDESK_HTTP_AUTH` (an image started with `--stdio`) it exits 0 without asking; with port 0 it fails. |

`grants list --json` prints an array with one object per grant, newest first: `id`, `account`
(the sevDesk account id), `client` (the full `client_id` URL), `clientHost`, `tiers`, `status`
(`pending` until the client has exchanged its authorization code, then `active`, `revoked` or
`expired`), `reason` (why it was revoked, a short code such as `user`, `operator`, `superseded`
or `sevdesk_401`; otherwise `null`), and the times `createdAt`, `expiresAt`, `lastRefreshAt` and
`revokedAt` (ISO 8601, `null` when it has not happened).

The `grants` commands need the same `SEVDESK_HTTP_STATE_DIR` as the server and work while it runs:
they append to `grants.jsonl`, and the server picks the change up within about a second. With the
image they need the volume, for example
`docker run --rm -v sevdesk-mcp-data:/data ghcr.io/jaylann/mcp-server-sevdesk:<version> grants list`.
Without a state directory, grants exist only inside the server process, and the commands cannot
see them. The image has no shell, so a platform console that needs one cannot run them; there,
revoke by replacing the server secret or the sevDesk token ([Revoking access](#revoking-access)).

## Revoking access

| To end                         | Do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One connection                 | `grants revoke <grant-id>`. Its next request gets 401 and the client asks to reconnect. Clients that support token revocation (RFC 7009, `/revoke`) do the same when you disconnect them.                                                                                                                                                                                                                                                                                                                                              |
| Every connection of an account | `grants revoke --account <id>`. It also ends every browser session of the account, including sign-ins with a pasted token.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Everything                     | `grants revoke --all` (every grant and every browser session, sign-ins with a token included), or replace `SEVDESK_HTTP_SECRET` without keeping the old one as `_PREVIOUS`: no token issued before can be opened any more.                                                                                                                                                                                                                                                                                                             |
| Access with a sevDesk token    | Regenerate the token in sevDesk (Settings → Users → API token). sevDesk refuses the old one at once, so tool calls stop working, and the next refresh of every grant that holds it (within the access-token lifetime) revokes that grant. This works even if the server secret or a client's tokens leaked. Browser sessions are not tied to the token: a sign-in with the old token stays valid for up to 12 hours, and a consent session until its grant is revoked. Run `grants revoke --account <id>` as well to end them at once. |
| Bearer access                  | Replace `SEVDESK_HTTP_BEARER_TOKEN` and restart. Browser sign-ins survive a restart when `SEVDESK_HTTP_SECRET` and the state directory persist; `grants revoke --account <id>` ends them (the id is the one the server logged at startup, or `bearer` if that lookup failed).                                                                                                                                                                                                                                                          |

Uploads and download links are not revoked with a grant: a session's end stops the browser that
held it, and the files expire within `SEVDESK_HTTP_FILES_TTL`. A restart voids them all at once.
Removing a connector in claude.ai drops its tokens there; revoking the grant also ends it on the
server.

## Rotating the server secret

1. Generate a new secret with `generate-secret`.
2. Set it as `SEVDESK_HTTP_SECRET`, move the old one to `SEVDESK_HTTP_SECRET_PREVIOUS`, and
   restart. Tokens sealed with the old secret are still accepted; refreshing them seals the new
   ones with the new secret.
3. Keep `_PREVIOUS` for as long as the refresh idle time (`SEVDESK_OAUTH_REFRESH_IDLE_TTL`, 14
   days by default), then remove it and restart. A client that did not refresh in that time
   reconnects.

If the secret may have leaked, skip step 3's wait: replace it without `_PREVIOUS`. Every client
reconnects. If tokens may have leaked as well (the secret opens them and the sevDesk token inside),
also regenerate the sevDesk tokens and run `grants revoke --account <id>` for each account, which
ends its browser sessions too.

Bearer secrets rotate the same way: set `SEVDESK_HTTP_BEARER_TOKEN=<new>,<old>`, update the
clients, then remove the old value.

## Logs

The server logs to stderr: at startup the MCP endpoint it serves, then one JSON object per request
with the route (as a template, not the full path), the status, the duration, the client IP and the
first 8 characters of the grant id. Headers, bodies, cookies and query strings are never logged, and
every line is scrubbed of the sevDesk token, the bearer and server secrets, anything that looks like
a sealed token (`sdmcp_…`) and any run of 32 or more hex digits (the shape of a sevDesk token, which
the server does not know in advance in OAuth mode).

Security events are logged as warnings by name: `refresh_replay` and `code_replay` (a token was
used twice; the grant was revoked), `account_refused` (consent with an account not on the list),
`cimd_blocked` (a client metadata document was refused) and `grant_revoked` (with its reason, for
example `account_removed` when an allowlist no longer covers the grant).

The browser pages log their own events. Sign-ins (shared by the inbox and the file pages, and
named after the inbox): `approval_login`, `approval_login_refused`, `approval_login_limited`,
`approval_login_unavailable` (sevDesk could not be asked), `approval_logout` and
`approval_session_refused` (a session of an account no longer allowed). File transfer:

| Event              | Level | Fields                                                                                                                                                                                                                                                               |
| ------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload_received`  | info  | `account`, `reference`, `kind`, `bytes`                                                                                                                                                                                                                              |
| `upload_refused`   | warn  | `reason` (`rate_limited`, `foreign_origin`, `signed_out`, `unknown`, `expired`, `already_received`, `unsupported_type`, `length_required`, `too_large`, `bad_form`, `stale_form`, `csrf`, `empty`, `wrong_kind`, `storage_full`, `failed`), `account` once signed in |
| `download_served`  | info  | `account`, `reference`, `kind`, `bytes`                                                                                                                                                                                                                              |
| `download_refused` | warn  | `reason` (`signed_out`, `unknown`, `expired`, `exhausted`), `account` once signed in                                                                                                                                                                                 |
| `audit_failed`     | warn  | `event`: a file event could not be written to `SEVDESK_AUDIT_LOG`                                                                                                                                                                                                    |

Their request lines show the routes as `/uploads/*` and `/files/*`. Upload and download ids and
file names are never logged; the reference code connects a log line with the page, the tool result
and the audit log.

Every page loads its fonts and its icon from the server itself: request lines with the route
`/assets/*`, answered without a session and cached by the browser for good (the file names carry
a content hash). The pages load nothing from any other server, so a proxy needs no rule beyond
passing these paths on like the rest.

## Health and shutdown

`GET /healthz` answers `{"status":"ok"}` without authentication and without the Host check, for
platform health checks. On SIGTERM the server answers 503 there, gives running requests 10 seconds,
then deletes the files of uploads and download links, writes the grant store and releases the
lock.

## Limits

- **One instance** per state directory; no horizontal scaling
  ([One instance](../remote.md#one-instance)).
- **A restart voids pending approvals and confirmations, and every upload and download link.** The
  model asks again. Grants and browser sessions survive with a state directory (and, in bearer
  mode, `SEVDESK_HTTP_SECRET`); without one, a restart signs every client out.
- **At most 500 grants** in all: beyond that, new consents are refused until grants are revoked
  or expire. Each account also has a smaller limit of live grants: a new consent beyond it revokes
  the account's oldest grant (reason `superseded`), so one account cannot fill the store. Revoked
  grants stay listed for 7 days. **At most 1,000 browser sessions**: beyond that the oldest one
  ends.
- **Requests at once.** The server handles at most 64 requests at a time. One client address
  (IPv6: its /64 network) may have 8 in progress, 32 with `SEVDESK_OAUTH_ACCOUNTS=any`, where many
  users share the addresses of claude.ai. One sevDesk account may have 8 `/mcp` requests in
  progress, across all its connections and addresses. More get 429 with `Retry-After: 1`. Of the
  64, 8 are kept for token refresh, sign-in, the approval inbox and the file pages, so those stay
  reachable while `/mcp` is busy; `/mcp` itself answers 503 once its 56 are taken, which seven
  accounts at their limit can cause. A request may take 120 seconds; the tax reports
  (`sevdesk_vat_summary`, `sevdesk_profit_and_loss`) stop reading after 90 seconds and return
  what they have, marked incomplete. These numbers are fixed.
- **JSON-RPC batches** (several messages in one request, sent only by clients of protocol version
  2025-03-26) may hold at most 8 messages and no request id twice; otherwise the whole batch is
  refused with 400 and nothing of it runs. A batch counts as one request.
- **Approvals** (`SEVDESK_CONFIRM=browser`): 5 waiting and 20 kept per account, 100 for the whole
  server. When the server holds 100, room comes from an account that holds more than the one
  asking (its oldest rejected or waiting request first, an approved, unused one last; that call is
  then asked about again). An account never loses a request to one that holds as many or more.
- **No server folders in OAuth mode.** `SEVDESK_FILE_DIRS` and `SEVDESK_OUTPUT_DIR` are refused;
  receipts are uploaded and saved files downloaded on the server's pages, which need a browser
  session of the account, and live at most `SEVDESK_HTTP_FILES_TTL`. One upload is at most 20 MiB
  ([all file limits](files.md#limits-and-lifetimes)). The PDF of an invoice, credit note or order
  and the XML of an e-invoice also reach the client without the browser, as MCP resources
  (`sevdesk://…`), whatever `SEVDESK_HTTP_FILES` is set to.
- **Clients without Client ID Metadata Documents** cannot use OAuth mode; bearer mode works for
  them.
- **No hosted instance.** You are the operator of what you deploy.
