# Remote mode (HTTP)

With `--http` the server speaks MCP over Streamable HTTP instead of stdio. Clients that cannot
start a local process can then use it: claude.ai custom connectors (and the Claude apps signed in
to the same account), Claude Code, Cursor or VS Code on another machine, or a small team sharing
one server. There is no hosted instance: you run the server yourself, on your own machine, a VM or
a platform such as Fly.io. For one person on one computer, stdio stays the simpler choice.

This page explains the concepts and gets a first server running; [Where next](#where-next) lists
the details. The design is in [Transports](architecture/transports.md), the threat
model in [Security in remote mode](security/remote.md).

## Concepts

### Bearer or OAuth

`SEVDESK_HTTP_AUTH` picks one of two modes. Without it, `--http` refuses to start.

|                             | `bearer`                                          | `oauth`                                                              |
| --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| Who holds the sevDesk token | the server (`SEVDESK_API_TOKEN`)                  | each user's client, sealed inside the tokens the server issued to it |
| Accounts                    | one                                               | every account on `SEVDESK_OAUTH_ACCOUNTS`                            |
| What a client sends         | a shared secret: `Authorization: Bearer <secret>` | OAuth 2.1 access tokens, after a consent page in the browser         |
| Tiers                       | `SEVDESK_ALLOW`                                   | chosen per connection on the consent page, capped by `SEVDESK_ALLOW` |
| Clients                     | anything that can send a header                   | clients with Client ID Metadata Documents: claude.ai, Claude Code    |
| Revoking access             | change the secret                                 | per connection, per account or everything (`grants revoke`)          |

**`bearer`** is the simple mode: one shared secret (`SEVDESK_HTTP_BEARER_TOKEN`) protects one
sevDesk account. Use it on a private network, behind other access control, or for clients you
configure yourself. Whoever has the secret can use the server's tiers on that account, so treat it
like the sevDesk token.

**`oauth`** makes the server its own OAuth 2.1 authorization server. A client that connects is sent
to a consent page on your server. There the user picks the tiers for this connection and pastes
their sevDesk API token once. The server checks the token with sevDesk, seals it (AES-256-GCM) into
the authorization code and the access and refresh tokens it gives the client, and keeps only a
record that the connection exists: a _grant_. claude.ai custom connectors need this mode. Clients
identify themselves with a Client ID Metadata Document (CIMD): their `client_id` is an https URL
that serves their name and redirect URIs. Dynamic Client Registration is not offered; a client that
only supports registration needs bearer mode.

### Single-tenant by default

In OAuth mode only the sevDesk accounts in `SEVDESK_OAUTH_ACCOUNTS` can connect. Find your account
id with [`account-id`](remote/operations.md#commands); a refused user sees their own account id on
the consent page. `SEVDESK_OAUTH_ACCOUNTS=any` lets anyone with a sevDesk token use your server,
and startup logs a warning: you would then process other people's accounting data (see
[Privacy](../PRIVACY.md)).

Clients are limited too: `SEVDESK_OAUTH_CLIENTS` lists the hosts that may serve a client's
metadata document (default `claude.ai`), checked before anything is fetched. Otherwise an attacker
could host their own metadata document and send you a legitimate-looking link to your own consent
page (consent phishing).

Both lists apply to every request and every refresh, not only at consent. Remove an account or a
client host and restart, and its existing grants are revoked the next time they are used (adding
the entry back later does not restore them; the user connects again), and the browser sessions of
a removed account end.

### Tiers per grant

Each OAuth connection has its own [tiers](permissions.md#tiers). The consent page always grants
`read` and offers a checkbox for each other tier that `SEVDESK_ALLOW` enables, all unchecked; a
client that asks for specific `sevdesk:<tier>` scopes is offered only those. A request gets the
grant's tiers that `SEVDESK_ALLOW` still enables (only `read` with `SEVDESK_READ_ONLY=1`), and the
model only sees the tools of those tiers. Narrowing `SEVDESK_ALLOW` applies to every grant at once;
widening it does not widen existing grants: the user reconnects and ticks the new tier.

In bearer mode the tiers are `SEVDESK_ALLOW`, as over stdio.

### What the server stores, and what it never stores

| Where                                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grants.jsonl` in `SEVDESK_HTTP_STATE_DIR`  | Per OAuth grant: a random id, the sevDesk account id, the client's `client_id` URL and host, the tiers, timestamps (created, expires, last rotation, revoked), the status, the refresh-token generation and why it was revoked. Per browser session (approval inbox and file pages, in bearer mode too): a random id, the account id, the grant it came from and how it was opened. Append-only, mode 0600, compacted at startup and from time to time. Without a state directory, in memory. |
| `grants.lock` in the state directory        | Marks the live instance (a heartbeat every 10 seconds).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `files/` in the state directory (or memory) | Uploaded files and the files behind download links while they are valid, encrypted with AES-256-GCM under a key drawn at random when the process starts and never written anywhere, under random names (folder 0700, files 0600). Deleted after a confirmed attachment, at expiry and at shutdown; emptied at every startup. See [Files](remote/files.md).                                                                                                                                    |
| `SEVDESK_AUDIT_LOG`, if set                 | Every write call of every account, with the account and the grant, and every received upload, created download link and download (reference, kind, size and SHA-256, no name or content). See [Audit log](permissions/audit-log.md).                                                                                                                                                                                                                                                          |
| Memory only (lost on restart)               | Pending approvals, pending confirmations (their single-use nonces), upload pages and download links, cached client metadata documents, per-account caches and rate-limit counters.                                                                                                                                                                                                                                                                                                            |

**Never stored**, in files or logs: sevDesk API tokens, authorization codes, access and refresh
tokens, cookies, the server secret, the bearer secrets and the key of the encrypted files. The
secrets come from the environment only. Upload and download ids never appear in a log, and the
server log (stderr) holds no file names. The audit log can: the preview it records contains the
facts of the call, for a voucher draft with a receipt the cleaned file name, and in bearer mode
with `SEVDESK_FILE_DIRS` a `file` path ([Audit log](permissions/audit-log.md)).

### Tokens and lifetimes

| What                         | Lifetime                                          | Notes                                                                                                       |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Authorization code           | 60 seconds                                        | Used once. A second exchange revokes the grant.                                                             |
| Access token                 | `SEVDESK_OAUTH_ACCESS_TTL` (1 hour)               | Only valid for `<public URL>/mcp`. Every request is checked against the grant store.                        |
| Refresh token                | `SEVDESK_OAUTH_REFRESH_IDLE_TTL` (14 days unused) | Replaced on every use; never valid beyond the grant.                                                        |
| Grant                        | `SEVDESK_OAUTH_GRANT_TTL` (90 days from consent)  | Then the user consents again.                                                                               |
| Browser session cookie       | 12 hours                                          | Approval inbox, upload and download pages. Holds no sevDesk token. Ends with its grant.                     |
| Upload page                  | 15 minutes                                        | Takes 1–10 files, as requested.                                                                             |
| Uploaded file, download link | `SEVDESK_HTTP_FILES_TTL` (30 minutes)             | Uploads are released after a confirmed attachment. A link serves at most 5 downloads. A restart voids both. |

Every token is sealed with keys derived from `SEVDESK_HTTP_SECRET`. The previous refresh token
still works for 30 seconds after a refresh (clients sometimes refresh twice at once); after that,
presenting it counts as a stolen token and revokes the grant. Every refresh also asks sevDesk
whether the sevDesk token still works: a 401 (token regenerated, or its user removed) or a token of
another account revokes the grant. If sevDesk cannot be reached, the refresh still succeeds: the
new access token is useless without a working sevDesk token anyway.

### One instance

MCP requests are handled statelessly, but run **exactly one instance**, in bearer mode too. Grants,
browser sessions, pending approvals, uploads and download links, the single-use nonces of
confirmations and the rate limits live in the process and its state directory, and a second
instance on the same state directory refuses to start. Several instances would need a shared
database, which this project avoids on purpose
([ADR 0006](adr/0006-built-in-authorization-server-and-grant-store.md)). One instance serves a
small team easily: sevDesk's own pace (`SEVDESK_RATE_LIMIT`, per account) is the bottleneck.

## Quick start: bearer mode with Docker

For a first try on your own machine:

```bash
# 1. A random client secret (43 characters).
docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret

# 2. The settings, in a file only you can read (outside any repository).
umask 077
cat > ~/sevdesk-mcp.env <<'EOF'
SEVDESK_HTTP_AUTH=bearer
SEVDESK_HTTP_PUBLIC_URL=http://localhost:8080
SEVDESK_HTTP_BEARER_TOKEN=<the secret from step 1>
SEVDESK_API_TOKEN=<your sevDesk API token>
EOF

# 3. Run it, reachable from this machine only.
docker run --rm --read-only -p 127.0.0.1:8080:8080 --env-file ~/sevdesk-mcp.env \
  -v sevdesk-mcp-data:/data ghcr.io/jaylann/mcp-server-sevdesk:latest
```

The server logs the MCP endpoint it serves on stderr. Connect a client to
`http://localhost:8080/mcp` with the header `Authorization: Bearer <the secret>`
([Connecting clients](#connecting-clients)).

The image binds `0.0.0.0` inside the container, and a non-loopback bind needs the URL clients use
(`SEVDESK_HTTP_PUBLIC_URL`; plain `http` is allowed for `localhost`). Use `localhost` in the client
too: other host names are refused unless listed in `SEVDESK_HTTP_ALLOWED_HOSTS`. Keep the
`127.0.0.1:` in `-p`: published on all interfaces, the port would take plain-http requests from
your network, where the secret travels unencrypted and any machine can send `Host: localhost`
(startup warns about a loopback public URL on a server listening on all interfaces).

> [!WARNING]
> Plain http on `localhost` is for a quick test only. Browsers do not separate cookies by port, so
> the session cookie of the server's pages (file transfer, the approval inbox) also goes to any
> other web server the browser reaches on `localhost`, which could then fetch your files, upload in
> your name, or decide your approvals. Use https (a [deployment](remote/deployment.md)), or at
> least a browser profile used for nothing else.

For anything that runs longer than a test, pin a version (`:<version>`) or a digest instead of
`latest`, and pass secrets as files (`SEVDESK_HTTP_BEARER_TOKEN_FILE`, `SEVDESK_API_TOKEN_FILE`)
rather than environment values, which `docker inspect` shows.

## Quick start: OAuth with a claude.ai custom connector

claude.ai connects from Anthropic's servers, not from your browser, so the server needs a public
https URL.

1. **Choose where it runs** ([Deployment](remote/deployment.md)): a domain behind Caddy, Fly.io,
   Render or Railway. For a short test, a tunnel works too:
   `cloudflared tunnel --url http://localhost:8080` prints an `https://….trycloudflare.com` URL.
2. **Generate the server secret** with `generate-secret`. It protects every connection: store it
   like a password, in your platform's secret store or a file.
3. **Find your account id**:
   `docker run --rm -e SEVDESK_API_TOKEN ghcr.io/jaylann/mcp-server-sevdesk:latest account-id`
   (`-e NAME` without a value passes on the exported variable without putting it on the command
   line).
4. **Configure the server**:

   ```bash
   SEVDESK_HTTP_AUTH=oauth
   SEVDESK_HTTP_PUBLIC_URL=https://mcp.example.com
   SEVDESK_HTTP_SECRET_FILE=/run/secrets/sevdesk_http_secret
   SEVDESK_OAUTH_ACCOUNTS=<your account id>
   # One reverse proxy in front of the server.
   SEVDESK_HTTP_TRUST_PROXY=1
   # The most any connection may get.
   SEVDESK_ALLOW=read,write,commit
   # Approvals in the inbox: claude.ai cannot be asked in the chat.
   SEVDESK_CONFIRM=browser
   SEVDESK_AUDIT_LOG=/data/audit.jsonl
   ```

   There is no `SEVDESK_API_TOKEN`: in OAuth mode every user brings their own on the consent page.
   Every variable is described in [Configuration](remote/configuration.md).

5. **Add the connector in claude.ai**: Settings → Connectors → Add custom connector, with the URL
   `https://mcp.example.com/mcp`. claude.ai opens your server's consent page:
   - check that the client is `claude.ai` and that the page sends you back to `claude.ai`;
   - tick the tiers this connection may use (`read` is always included);
   - paste your sevDesk API token; the server checks it with sevDesk and against
     `SEVDESK_OAUTH_ACCOUNTS`, then shows the account it belongs to (never the token again);
   - confirm that account. You are back in claude.ai, and this browser is now signed in to the
     server's own pages for 12 hours: the [upload and download pages](remote/files.md) (on by
     default) and, with `SEVDESK_CONFIRM=browser`, the [approval inbox](remote/approvals.md).

## Connecting clients

The MCP endpoint is always `<public URL>/mcp`, for example `https://mcp.example.com/mcp`. In
bearer mode any client that speaks Streamable HTTP and can send the `Authorization` header works;
in OAuth mode the host of the client's `client_id` URL must be in `SEVDESK_OAUTH_CLIENTS`. Each
client's setup, local and remote, is in [Clients](clients.md).

## Where next

- [Deployment](remote/deployment.md): the image, Compose with Caddy, Fly.io, Render, Railway.
- [Configuration](remote/configuration.md): every HTTP variable, startup refusals and warnings.
- [Approval inbox](remote/approvals.md): confirming `commit` and `external` calls in the browser.
- [Files](remote/files.md): upload pages for receipts and e-invoices, and download links.
- [Operating the server](remote/operations.md): commands, revoking, rotating, logs, limits.
- [Troubleshooting](remote/troubleshooting.md): connection, proxy, upload and consent problems.
