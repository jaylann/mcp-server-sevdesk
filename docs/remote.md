# Remote mode (HTTP)

With `--http` the server speaks MCP over Streamable HTTP instead of stdio. Clients that cannot
start a local process can then use it: claude.ai custom connectors (and the Claude apps signed in
to the same account), Claude Code, Cursor or VS Code on another machine, or a small team sharing
one server. There is no hosted instance: you run the server yourself, on your own machine, a VM or
a platform such as Fly.io. For one person on one computer, stdio stays the simpler choice.

This page is the operator's guide. The design is in [architecture.md](architecture.md#transports)
and in ADRs [0006](adr/0006-built-in-authorization-server-and-grant-store.md),
[0007](adr/0007-approval-inbox-over-http.md) and [0008](adr/0008-file-transfer-over-http.md); the
threat model is in [SECURITY.md](../SECURITY.md#remote-mode).

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
record that the connection exists: a _grant_. claude.ai custom connectors need this mode.

Clients identify themselves with a Client ID Metadata Document (CIMD): their `client_id` is an
https URL that serves their name and redirect URIs. Dynamic Client Registration is not offered, so a
client that only supports registration cannot use OAuth mode. Use bearer mode for it.

### Single-tenant by default

In OAuth mode only the sevDesk accounts in `SEVDESK_OAUTH_ACCOUNTS` can connect. Find your account
id with [`account-id`](#commands); a refused user sees their own account id on the consent page.
`SEVDESK_OAUTH_ACCOUNTS=any` lets anyone with a sevDesk token use your server, and startup logs a
warning: you would then process other people's accounting data (see [PRIVACY.md](../PRIVACY.md)).

Clients are limited too. `SEVDESK_OAUTH_CLIENTS` lists the hosts that may serve a client's
metadata document (default `claude.ai`). The server checks it before it fetches anything. Without
it, an attacker could host their own metadata document and send you a link to your own consent
page that looks legitimate (consent phishing).

Both lists apply to every request and every refresh, not only at consent. Remove an account or a
client host and restart, and its existing grants are revoked the next time they are used (adding
the entry back later does not restore them; the user connects again), and the browser sessions of
a removed account end.

### Tiers per grant

Each OAuth connection has its own tiers. The consent page always grants `read` and offers a
checkbox for each other tier that `SEVDESK_ALLOW` enables, all unchecked; a client that asks for
specific `sevdesk:<tier>` scopes is offered only those. A request gets the
grant's tiers that `SEVDESK_ALLOW` still enables (only `read` with `SEVDESK_READ_ONLY=1`), and the
model only sees the tools of those tiers. Narrowing `SEVDESK_ALLOW` applies to every grant at once;
widening it does not widen existing grants: the user reconnects and ticks the new tier.

In bearer mode the tiers are `SEVDESK_ALLOW`, as over stdio.

### What the server stores, and what it never stores

| Where                                                  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grants.jsonl` in `SEVDESK_HTTP_STATE_DIR` (or memory) | Per grant (OAuth): a random id, the sevDesk account id, the client's `client_id` URL and host, the tiers, timestamps (created, expires, last rotation, revoked), the status, the refresh-token generation and why it was revoked. Per browser session (the sign-in of the approval inbox and the upload and download pages): a random id, the account id, the grant it came from and how it was opened. Append-only, mode 0600, compacted at startup and from time to time while the server runs. Bearer mode keeps its browser sessions here too, whenever the inbox or file transfer is on. |
| `grants.lock` in the state directory                   | Marks the live instance (a heartbeat every 10 seconds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `files/` in the state directory (or memory)            | Uploaded files and the files behind download links, while they are valid ([Files](#files-uploads-and-download-links)): encrypted with AES-256-GCM under a key drawn at random when the process starts and never written anywhere, under random names (folder 0700, files 0600). Deleted after a confirmed attachment, when they expire and at shutdown; the folder is emptied at every startup, so nothing outlives the process.                                                                                                                                                              |
| `SEVDESK_AUDIT_LOG`, if set                            | Every write call of every account, with the account and the grant, and every received upload, created download link and download (reference, kind, size and SHA-256, no name or content). See [SECURITY.md](../SECURITY.md#audit-log).                                                                                                                                                                                                                                                                                                                                                        |
| Memory only (lost on restart)                          | Pending approvals, pending confirmations (their single-use nonces), upload pages and download links (owner, reference, purpose, the cleaned file name, size, SHA-256, expiry, downloads left), cached client metadata documents, per-account caches and rate-limit counters.                                                                                                                                                                                                                                                                                                                  |

**Never stored**, in files or logs: sevDesk API tokens, authorization codes, access and refresh
tokens, cookies, the server secret, the bearer secrets and the key of the encrypted files. The
secrets come from the environment only. Upload and download ids never appear in a log, and the
server log (stderr) holds no file names. The audit log can hold one: the preview it records for a
dry run or a requested confirmation contains the facts of the call (customer names, amounts), and
for a voucher draft with a receipt that includes the cleaned name of the uploaded file, with its
size and the start of its SHA-256. In bearer mode with `SEVDESK_FILE_DIRS`, a path passed as
`file` is logged with the other arguments.

### Tokens and lifetimes

| What                         | Lifetime                                          | Notes                                                                                                       |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Authorization code           | 60 seconds                                        | Used once. A second exchange revokes the grant.                                                             |
| Access token                 | `SEVDESK_OAUTH_ACCESS_TTL` (1 hour)               | Only valid for `<public URL>/mcp`. Every request is checked against the grant store.                        |
| Refresh token                | `SEVDESK_OAUTH_REFRESH_IDLE_TTL` (14 days unused) | Replaced on every use; never valid beyond the grant.                                                        |
| Grant                        | `SEVDESK_OAUTH_GRANT_TTL` (90 days from consent)  | Then the user consents again.                                                                               |
| Browser session cookie       | 12 hours                                          | Approval inbox, upload and download pages. Holds no sevDesk token. Ends with its grant.                     |
| Upload page                  | 15 minutes                                        | Takes one file.                                                                                             |
| Uploaded file, download link | `SEVDESK_HTTP_FILES_TTL` (30 minutes)             | Uploads are released after a confirmed attachment. A link serves at most 5 downloads. A restart voids both. |

Every token is sealed with keys derived from `SEVDESK_HTTP_SECRET`. Each refresh returns a new
refresh token. The previous one still works for 30 seconds, because clients sometimes refresh twice
at once; after that, presenting it counts as a stolen token and revokes the grant. On every refresh
the server also asks sevDesk whether the sevDesk token still works: if sevDesk answers 401 (the
token was regenerated, or its user removed) or the token now belongs to another account, the grant
is revoked. If sevDesk cannot be reached, the refresh still succeeds: the new access token is
useless without a working sevDesk token anyway.

### One instance

MCP requests are handled statelessly, but run **exactly one instance**. Grants, browser sessions,
pending approvals, uploads and download links, the single-use nonces of confirmations and the rate
limits live in the process and its state directory, and a second instance on the same state
directory refuses to start. That holds in bearer mode too whenever browser pages are on (file
transfer is on by default).
Running several would need a shared database, which this project avoids on purpose
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

Why `SEVDESK_HTTP_PUBLIC_URL` here: the image binds `0.0.0.0` inside the container, and a
non-loopback bind needs the URL clients use. Plain `http` is allowed because the host is
`localhost`. Use `localhost` in the client too: other host names are refused unless they are listed
in `SEVDESK_HTTP_ALLOWED_HOSTS`. Keep the `127.0.0.1:` in `-p`: published on all interfaces, the
port would take plain-http requests from your network, where the secret travels unencrypted and
any machine can send `Host: localhost`. Startup warns about exactly this combination (a server
listening on all interfaces with a loopback public URL); with the port published on `127.0.0.1`
only, the warning does not apply.

Plain http on `localhost` is for a quick test only. Browsers do not separate cookies by port, so
the browser session cookie (of the upload and download pages, on by default, and with
`SEVDESK_CONFIRM=browser` of the approval inbox) also goes to any other web server the browser
reaches on `localhost`, which could then fetch your files, upload in your name, or read and decide
your approvals. Startup warns about this while file transfer is on. Use https (a deployment
below), or at least a browser profile used for nothing else.

For anything that runs longer than a test, pin a version (`:<version>`) or a digest instead of
`latest`, and pass secrets as files (`SEVDESK_HTTP_BEARER_TOKEN_FILE`, `SEVDESK_API_TOKEN_FILE`)
rather than environment values, which `docker inspect` shows.

## Quick start: OAuth with a claude.ai custom connector

claude.ai connects from Anthropic's servers, not from your browser, so the server needs a public
https URL.

1. **Choose where it runs** ([Deployment](#deployment)): a domain behind Caddy, Fly.io, Render or
   Railway. For a short test, a tunnel works too: `cloudflared tunnel --url http://localhost:8080`
   prints an `https://….trycloudflare.com` URL.
2. **Generate the server secret** with `generate-secret`. It protects every connection: store it
   like a password, in your platform's secret store or a file.
3. **Find your account id**:
   `docker run --rm -e SEVDESK_API_TOKEN ghcr.io/jaylann/mcp-server-sevdesk:latest account-id`
   (with `SEVDESK_API_TOKEN` exported in your shell; `-e NAME` without a value passes it on
   without putting it on the command line).
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

5. **Add the connector in claude.ai**: Settings → Connectors → Add custom connector, with the URL
   `https://mcp.example.com/mcp`. claude.ai opens your server's consent page:
   - check that the client is `claude.ai` and that the page sends you back to `claude.ai`;
   - tick the tiers this connection may use (`read` is always included);
   - paste your sevDesk API token; the server checks it with sevDesk and against
     `SEVDESK_OAUTH_ACCOUNTS`, then shows the account it belongs to (never the token again);
   - confirm that account. You are back in claude.ai, and this browser is now signed in to the
     server's own pages for 12 hours: the [upload and download pages](#files-uploads-and-download-links)
     (on by default) and, with `SEVDESK_CONFIRM=browser`, the
     [approval inbox](#the-approval-inbox).

## Deployment

The image is `ghcr.io/jaylann/mcp-server-sevdesk`, for amd64 and arm64, with the tags `<version>`,
`<major>.<minor>` and `latest`. It runs as uid 65532 on a distroless Node.js base (no shell),
starts `--http`, listens on `0.0.0.0:8080`, keeps its state in the volume `/data`
(`SEVDESK_HTTP_STATE_DIR=/data`) and has a health check that runs the `healthcheck` command. Its
root filesystem can be read-only: only `/data` is written. Any other command replaces `--http`,
for example `docker run --rm <image> generate-secret`.

The templates below run the image in OAuth mode, as one instance with a volume at `/data`,
`SEVDESK_CONFIRM=browser`, the audit log in `/data/audit.jsonl` and `SEVDESK_ALLOW=read`: raise
`SEVDESK_ALLOW` to the most you want any connection to get. release-please updates their image tag
with each release. Every deployment needs at least `SEVDESK_HTTP_PUBLIC_URL` and either
`SEVDESK_HTTP_SECRET` plus `SEVDESK_OAUTH_ACCOUNTS` (OAuth) or `SEVDESK_HTTP_BEARER_TOKEN` plus
`SEVDESK_API_TOKEN` (bearer).

### Docker Compose with Caddy (`deploy/compose/`)

For a VM or a home server with a domain name.
[`deploy/compose/compose.yaml`](../deploy/compose/compose.yaml) runs two services:

- **`mcp`**, the server: read-only root filesystem, all Linux capabilities dropped,
  `no-new-privileges`, memory and process limits, the server secret from a file through Compose
  secrets (`SEVDESK_HTTP_SECRET_FILE`), a named volume at `/data`, and no port published to the
  host;
- **`caddy`** (pinned by digest): gets and renews the TLS certificate for your domain, keeps the
  `Host` header, sets `X-Forwarded-For`, and passes streamed responses on at once
  (`flush_interval -1`). It writes no access log on purpose: OAuth redirect URLs carry
  authorization codes.

Point the domain's DNS at the machine and open ports 80 and 443. Then, in `deploy/compose/`:

```bash
cp .env.example .env      # SEVDESK_DOMAIN, SEVDESK_OAUTH_ACCOUNTS, SEVDESK_ALLOW
install -d -m 0700 secrets
docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret > secrets/http_secret
sudo chown 65532:65532 secrets/http_secret && sudo chmod 0400 secrets/http_secret
docker compose up -d
```

Compose mounts a secret file as it is on the host, so it must be readable by uid 65532 (the
`chown`). `secrets/` is git-ignored. Caddy is the one proxy in front, so the template sets
`SEVDESK_HTTP_TRUST_PROXY=1`. For bearer mode, follow the commented lines in `compose.yaml`. Run
the operator commands in a one-off container of the same service, for example
`docker compose run --rm mcp grants list`.

### Fly.io (`deploy/fly/fly.toml`)

[`deploy/fly/fly.toml`](../deploy/fly/fly.toml) runs one Machine in Frankfurt with a 1 GB volume
(`sevdesk_data`) at `/data`. Fly terminates TLS and forces https; the Machine suspends when idle
(`auto_stop_machines = "suspend"`, which keeps its memory) and starts on the next request.

```bash
fly apps create <app>
# In fly.toml: set `app`, SEVDESK_HTTP_PUBLIC_URL (https://<app>.fly.dev or your domain) and
# SEVDESK_OAUTH_ACCOUNTS.
fly secrets set --app <app> --stage \
  SEVDESK_HTTP_SECRET="$(docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret)"
fly deploy --config deploy/fly/fly.toml --ha=false
```

Keep it at one Machine (`--ha=false`): a second one would have its own volume and its own grants.
The Fly proxy is one hop (`SEVDESK_HTTP_TRUST_PROXY=1`).

### Render (`deploy/render/render.yaml`)

[`deploy/render/render.yaml`](../deploy/render/render.yaml) is a Blueprint: one web service from
the image in Frankfurt, with a 1 GB disk at `/data` and `/healthz` as its health check. In the
Render dashboard choose New → Blueprint, pick this repository (or your fork) and set the Blueprint
path to `deploy/render/render.yaml`. Render generates `SEVDESK_HTTP_SECRET` itself
(`generateValue`, never shown in the file) and asks for `SEVDESK_HTTP_PUBLIC_URL`
(`https://<service>.onrender.com` or your domain) and `SEVDESK_OAUTH_ACCOUNTS` when you create
it. A disk needs a paid instance type and keeps the service at one instance. The template sets
`PORT=8080`, the port Render routes to.

### Railway

Railway no longer reads `railway.json` for new services (its config as code is deprecated and
stops being read on 2026-12-01). Create the service from the image in the dashboard, or describe
it in a Railway infrastructure-as-code file (`.railway/railway.ts`) in your own project:
[`deploy/README.md`](../deploy/README.md#railway) has both, with a volume at `/data`, `/healthz`
as the health check and one replica. Railway mounts volumes owned by root, so the service runs
with `RAILWAY_RUN_UID=0`. The image listens on port 8080.

### A tunnel, for testing

`cloudflared tunnel --url http://localhost:8080` gives a local server a temporary public https URL.
Set it as `SEVDESK_HTTP_PUBLIC_URL` (restart when it changes) and `SEVDESK_HTTP_TRUST_PROXY=1`.
The tunnel provider terminates TLS and sees the traffic, including tokens; use it for tests, not
for your books.

## Configuration reference

All variables are read at startup. Startup reports every problem at once and refuses to start
until all are fixed. Variables ending in `_FILE` read the value from a file instead (Docker and
Kubernetes secrets); set one or the other.

### HTTP variables

| Variable                                 | Default                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_HTTP_AUTH`                      | (required)                           | `bearer` or `oauth`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SEVDESK_HTTP_HOST`                      | `127.0.0.1` (image: `0.0.0.0`)       | Bind address. Anything other than a loopback address needs `SEVDESK_HTTP_PUBLIC_URL`.                                                                                                                                                                                                                                                                                                                                                    |
| `SEVDESK_HTTP_PORT`                      | `$PORT`, else `8080` (image: `8080`) | Bind port, 0–65535 (0 picks a free port, for tests).                                                                                                                                                                                                                                                                                                                                                                                     |
| `SEVDESK_HTTP_PUBLIC_URL`                |                                      | The origin clients use, for example `https://mcp.example.com`: scheme, host and port only, without path, query, fragment or credentials. https unless the host is `localhost`, `127.0.0.1` or `[::1]`. Required for OAuth and for non-loopback binds. The MCP endpoint (and OAuth resource) is `<origin>/mcp`, the OAuth issuer is the origin. Every URL the server prints or redirects to is built from it, never from request headers. |
| `SEVDESK_HTTP_ALLOWED_HOSTS`             |                                      | More host names accepted in the `Host` header, comma-separated. The host of the public URL is always accepted (the loopback names on a loopback bind without a public URL).                                                                                                                                                                                                                                                              |
| `SEVDESK_HTTP_ALLOWED_ORIGINS`           |                                      | More values accepted in the `Origin` header of `/mcp` requests, comma-separated; the check compares host names only (any scheme or port). The public origin is always accepted, and requests without `Origin` pass. `/mcp` sends no CORS headers and answers no preflight (`OPTIONS`), so MCP clients running in a web page on another origin are not supported: this only admits clients that send such an `Origin` header themselves.  |
| `SEVDESK_HTTP_TRUST_PROXY`               | `0`                                  | Reverse proxies in front of the server, 0–5. The client IP (rate limits, logs) is the entry that many places from the right of `X-Forwarded-For`.                                                                                                                                                                                                                                                                                        |
| `SEVDESK_HTTP_BEARER_TOKEN` (`_FILE`)    |                                      | Bearer mode, required: the client secret, or two comma-separated secrets while you rotate. Each at least 32 characters with at least 16 different ones, no whitespace, and not the sevDesk token.                                                                                                                                                                                                                                        |
| `SEVDESK_HTTP_SECRET` (`_FILE`)          |                                      | OAuth, required: the server secret all tokens and cookies are sealed with; at least 32 random bytes, hex or base64/base64url (`generate-secret`). Optional in bearer mode, where it keeps browser sign-ins valid across restarts.                                                                                                                                                                                                        |
| `SEVDESK_HTTP_SECRET_PREVIOUS` (`_FILE`) |                                      | The previous server secret while you [rotate it](#rotating-the-server-secret): tokens sealed with it are still accepted and resealed on refresh.                                                                                                                                                                                                                                                                                         |
| `SEVDESK_HTTP_STATE_DIR`                 | memory (image: `/data`)              | Absolute directory for the grant store and the encrypted files of file transfer (`files/`); created with mode 0700 (an existing one is tightened to 0700) and checked for write access at startup. Without it, grants and browser sessions end with the process (OAuth startup warns) and files are kept in memory.                                                                                                                      |
| `SEVDESK_HTTP_FILES`                     | `on`                                 | [File transfer](#files-uploads-and-download-links): upload pages for receipts and e-invoices, and download links for the files tools create. `on`/`off`, `1`/`0`, `true`/`false` or `yes`/`no`. Off: no pages and no `sevdesk_upload_request`; in OAuth mode also no tool that needs a file to read or a place to save one. The PDF and XML tools and the `sevdesk://` resources stay: a client still reads document files over MCP.     |
| `SEVDESK_HTTP_FILES_MAX_MB`              | 256 with a state directory, else 64  | Mebibytes (MiB) the uploaded files and download links of all accounts may take together, 32 to 4096. One account may use a quarter of it (at least 20 MiB, at most half); room for one upload stays free for accounts that hold no files yet. With a state directory the files are on disk, otherwise in memory.                                                                                                                         |
| `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`     | `10`                                 | Live upload pages, uploaded files and download links together per sevDesk account, a whole number from 1 to 1000. Separate limits of 5 pending pages and 1,000 records overall still apply; byte quotas stay unchanged.                                                                                                                                                                                                                  |
| `SEVDESK_HTTP_FILES_TTL`                 | `30m`                                | Maximum lifetime of an uploaded file and a download link, 5 minutes to 24 hours. Successfully attached uploads are released sooner.                                                                                                                                                                                                                                                                                                      |
| `SEVDESK_OAUTH_ACCOUNTS`                 |                                      | OAuth, required: the sevDesk account ids that may connect, comma-separated, or `any` (startup warns).                                                                                                                                                                                                                                                                                                                                    |
| `SEVDESK_OAUTH_CLIENTS`                  | `claude.ai`                          | Hosts allowed to serve a client's metadata document (its `client_id` URL), comma-separated, or `any` (startup warns).                                                                                                                                                                                                                                                                                                                    |
| `SEVDESK_OAUTH_ACCESS_TTL`               | `1h`                                 | Access token lifetime, 5 minutes to 24 hours. Under 10 minutes startup warns: Claude refreshes 5 minutes before expiry, so it would refresh on nearly every request.                                                                                                                                                                                                                                                                     |
| `SEVDESK_OAUTH_REFRESH_IDLE_TTL`         | `14d`                                | A refresh token unused this long expires; 1 to 90 days.                                                                                                                                                                                                                                                                                                                                                                                  |
| `SEVDESK_OAUTH_GRANT_TTL`                | `90d`                                | Lifetime of a grant from consent; 1 to 365 days.                                                                                                                                                                                                                                                                                                                                                                                         |

Durations are a whole number with the unit `s`, `m`, `h` or `d` (`90s`, `30m`, `1h`, `14d`), or
a plain number of seconds.

### Other variables in HTTP mode

The [variables of the stdio mode](configuration.md#variables) keep their meaning, with these
differences:

- **`SEVDESK_API_TOKEN` (`_FILE`)**: required in bearer mode, where it is the account the server
  serves and the token that signs a browser in to the server's pages (approval inbox, uploads and
  downloads). Not used in OAuth mode (startup warns if it is set): every user pastes their own
  token on the consent page.
- **`SEVDESK_API_TOKEN_KEYCHAIN`, `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH`**: refused. The OS
  keychain and local profiles are for local installs over stdio; a container has no keychain.
- **`SEVDESK_ALLOW`, `SEVDESK_READ_ONLY`**: the most any connection may get. In OAuth mode each
  grant gets the intersection with the tiers ticked on the consent page.
- **`SEVDESK_CONFIRM`**: `elicit` (the default) works with clients that speak the 2026-07-28
  protocol and support form elicitation. 2025-era clients cannot be asked over stateless HTTP;
  that includes claude.ai at the time of writing. Startup therefore warns when `elicit` is combined
  with the `commit` or `external` tier. `browser` uses the server's
  [approval inbox](#the-approval-inbox).
- **`SEVDESK_CONFIRM_OPEN`**: off in HTTP mode unless set explicitly, and without effect there:
  approvals wait in the inbox, which you open yourself. Setting it to `1` together with a
  non-loopback bind is refused.
- **`SEVDESK_FILE_DIRS`, `SEVDESK_OUTPUT_DIR`**: refused in OAuth mode, because the server's disk
  would be shared by every connection. Files reach the tools through
  [upload pages and download links](#files-uploads-and-download-links) instead
  (`SEVDESK_HTTP_FILES`, on by default). Bearer mode keeps them; the folders are on the server,
  not on the client's machine. There a file argument may be a path inside `SEVDESK_FILE_DIRS` or
  an upload, and `SEVDESK_OUTPUT_DIR`, when set, wins over download links: files are then saved
  on the server.
- **`SEVDESK_AUDIT_LOG`**: one log for all accounts; every line names the account and the grant.
  It also records each received upload, created download link and download. In the image the
  root filesystem is read-only, so put it under `/data`.
- **`SEVDESK_RATE_LIMIT`**: applies per sevDesk account, shared by all its connections.

### Startup refusals and warnings

Startup refuses, among others:

- `--http` without `SEVDESK_HTTP_AUTH`;
- bearer mode without a valid bearer secret or without a sevDesk token;
- OAuth without `SEVDESK_HTTP_SECRET`, `SEVDESK_HTTP_PUBLIC_URL` or `SEVDESK_OAUTH_ACCOUNTS`, or
  with a secret that is too short or not random enough;
- a non-loopback bind without a public URL, or an `http://` public URL whose host is not loopback;
- OAuth together with `SEVDESK_FILE_DIRS` or `SEVDESK_OUTPUT_DIR` (the message points to the
  upload pages and download links);
- `SEVDESK_API_TOKEN_KEYCHAIN`, `SEVDESK_PROFILE` or `SEVDESK_PROFILES_PATH` (stdio only);
- `SEVDESK_HTTP_FILES` that is not a flag value (see the table), `SEVDESK_HTTP_FILES_MAX_MB`
  outside 32–4096, `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` that is not a whole number from 1–1000,
  or `SEVDESK_HTTP_FILES_TTL` outside 5 minutes to 24 hours;
- `SEVDESK_CONFIRM_OPEN=1` with a non-loopback bind;
- a state directory that cannot be written, a corrupt `grants.jsonl`, a state directory that
  another live instance uses, or a `files/` folder in it that cannot be emptied;
- any other value outside what the tables above allow, for example a variable set together with
  its `_FILE` variant, `SEVDESK_HTTP_SECRET_PREVIOUS` without `SEVDESK_HTTP_SECRET`, more than two
  bearer secrets, a relative state directory, an OAuth lifetime out of range, an invalid host or
  origin entry, or `any` mixed with ids or hosts.

Startup warns (and starts) for `SEVDESK_CONFIRM=elicit` with the `commit` or `external` tier,
`SEVDESK_OAUTH_ACCOUNTS=any` (with file transfer on, also because the server then briefly holds
every connected account's receipts and exports, and a few accounts together can fill its file
space), `SEVDESK_OAUTH_CLIENTS=any`, OAuth without a state directory, `SEVDESK_API_TOKEN` or a
bearer secret in OAuth mode, a server or bearer secret that looks like a passphrase rather than
random bytes (use `generate-secret`), a non-loopback bind with a loopback public URL (anyone who
reaches the port can use the server; see the
[Docker quick start](#quick-start-bearer-mode-with-docker)), file transfer over plain http (the
browser session cookie reaches every server on that host name), file transfer without a state
directory (files are held in memory, up to `SEVDESK_HTTP_FILES_MAX_MB`), and
`SEVDESK_HTTP_FILES_MAX_MB`, `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` or `SEVDESK_HTTP_FILES_TTL`
set together with `SEVDESK_HTTP_FILES=off` (they have no effect).

## Connecting clients

The MCP endpoint is always `<public URL>/mcp`, for example `https://mcp.example.com/mcp`.

### claude.ai, Claude Desktop and the mobile apps (OAuth)

Settings → Connectors → Add custom connector, with the URL `https://<host>/mcp`. claude.ai opens
the consent page ([Quick start](#quick-start-oauth-with-a-claudeai-custom-connector)). The
connector is then available in the Claude apps signed in to the same account. Removing the
connector in claude.ai drops its tokens there; [revoking the grant](#revoking-access) also ends it
on the server.

### Claude Code

With OAuth:

```bash
claude mcp add --transport http sevdesk https://<host>/mcp
```

Then run `/mcp` in Claude Code and choose to authenticate: the consent page opens in your browser
and sends you back to Claude Code. Claude Code identifies itself with its own metadata document,
served from `claude.ai` like claude.ai's (so the default `SEVDESK_OAUTH_CLIENTS` covers it), and a
loopback redirect, which the consent page points out.

With a bearer secret (read it from a file or your password manager instead of typing it):

```bash
claude mcp add --transport http sevdesk https://<host>/mcp \
  --header "Authorization: Bearer $MCP_BEARER_SECRET"
```

### Cursor (bearer)

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "sevdesk": {
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer ${env:MCP_BEARER_SECRET}" }
    }
  }
}
```

### VS Code (bearer)

In `.vscode/mcp.json`, with a password prompt so the secret stays out of the file:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "sevdesk-mcp-bearer",
      "description": "Bearer secret of your sevDesk MCP server",
      "password": true
    }
  ],
  "servers": {
    "sevdesk": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer ${input:sevdesk-mcp-bearer}" }
    }
  }
}
```

### Other clients

Any client that speaks Streamable HTTP and can send a header works in bearer mode. In OAuth mode
a client needs Client ID Metadata Documents; add the host of its `client_id` URL to
`SEVDESK_OAUTH_CLIENTS`.

## The approval inbox

With `SEVDESK_CONFIRM=browser`, `commit` and `external` calls wait for a decision in the server's
approval inbox at `<public URL>/approvals`. It replaces the local approval page of the stdio mode,
which a remote server cannot open in your browser.

How a confirmation runs:

1. The model calls, say, the tool that finalizes an invoice. The server prepares it and answers
   `approval_pending` with a short reference code, the expiry (10 minutes) and the inbox URL.
2. You open the inbox, find the request with that reference code and read the preview: the
   action, warnings, amounts, recipients, texts. With a German browser the inbox and the preview
   are in German ([Permissions](permissions.md#browser)).
3. You press Approve or Reject (Freigeben or Ablehnen).
4. You ask the model to try again. It calls the tool with the same arguments; the server prepares
   the action once more and runs it only if you approved and the preview is unchanged. Each
   approval is used once.

**Signing in.** The inbox shows nothing but a sign-in form until the browser proves it may act for
the account:

- **after OAuth consent**, automatically: the consent page signs in the browser that completed it
  (whenever the inbox or [file transfer](#files-uploads-and-download-links) is on; the same
  session opens both);
- **by pasting the sevDesk API token** into the sign-in form. In OAuth mode the server checks the
  token with sevDesk and against `SEVDESK_OAUTH_ACCOUNTS`. In bearer mode it must be the server's
  own `SEVDESK_API_TOKEN`; the bearer secret does not sign in, because the client holds it.

A sign-in lasts 12 hours, or until you sign out, the grant it came from is revoked, or
`grants revoke --account <id>` ends every session of the account. A sign-in with a pasted token is
not tied to that token: regenerating the token in sevDesk does not end it. Sign-in attempts are
limited per client address, with IPv6 addresses counted per /64 network (5 a minute, 20 an hour).
In bearer mode, set `SEVDESK_HTTP_SECRET` as well if sign-ins should survive a restart.

**What the model sees.** The reference code, the expiry and the inbox URL. The URL is not a
secret: without a sign-in it shows only the form. The model never sees an approval's own id, a
cookie or anything that could approve.

**Who sees what.** Approvals belong to the connection that asked: a retry only finds approvals its
own grant created. The inbox lists the approvals of the whole account, so everyone signed in to
that account sees and can decide them. At most five approvals per account wait at a time, and one
account's requests cannot push another account's approvals out of the server's memory.

**Limits.** An agent that can drive your browser while it is signed in (browser automation, a
computer-use tool) could approve on its own. And the inbox asks for your sevDesk token, so a
lookalike page could try to phish it: only paste it into a page whose address is your server's
`/approvals`. On a plain-http `localhost` setup, other local web servers receive the session
cookie too ([Quick start](#quick-start-bearer-mode-with-docker)). Pending approvals end when the
server restarts; the model then simply asks again.
See [ADR 0007](adr/0007-approval-inbox-over-http.md).

## Files: uploads and download links

A remote server cannot read files on your computer, and the files it creates cannot land there by
themselves. With `SEVDESK_HTTP_FILES=on` (the default) files travel through pages of the server
that you open in your browser. The model never sees or sends the bytes of those files. (Document
PDFs and XML that a client asks for as `sevdesk://` resources are a different path: they go to the
client over MCP.)

**Uploading a receipt or an e-invoice:**

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
   `sevdesk_einvoice_parse` or `sevdesk_voucher_import_einvoice`. Only the connection that asked
   for the upload can use it. Once a create, update or import succeeds and sevDesk's read-back
   confirms an attachment, the server releases the upload and deletes its stored file, freeing
   the slot immediately. Parsing, dry runs and failed calls keep the upload until expiry for
   another attempt. A missing or uncertain attachment in the read-back also keeps it. To use a
   successfully attached file again, request a new upload.

**Downloading.** `sevdesk_document_save`, `sevdesk_voucher_receipt_save`, `sevdesk_csv_export` and
`sevdesk_datev_export` return a download link, `<public URL>/files/<id>`, instead of a file path. The server fetched the file from
sevDesk during the tool call; opening the link sends nothing to sevDesk. The browser saves the file
as a download; it is never displayed on the server's page.

**What needs a browser session.** Every upload page and download link. The links are not secrets:
without a session they show only the sign-in form, and a link of another account looks exactly
like one that does not exist. The session is the one of the [approval inbox](#the-approval-inbox):

- the browser that completed the OAuth consent is signed in for 12 hours, also when the inbox is
  off;
- any other browser signs in on the form with the sevDesk API token of the account (OAuth mode:
  checked with sevDesk and against `SEVDESK_OAUTH_ACCOUNTS`; bearer mode: the server's
  `SEVDESK_API_TOKEN`, never the bearer secret), and lands back on the page it came from.

The form posts to `/approvals/login` even when the approval inbox is off. Signed in to an account,
a browser sees the upload pages and links of every connection of that account; the tools only use
the uploads of their own connection.

**On the phone.** The Claude apps may open a link in a browser that does not share the cookies of
the one you consented in: you then see the sign-in form. Sign in with the sevDesk API token there,
or open the link in the browser where you consented.

**Limits and lifetimes:**

| What                | Limit                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload page         | Valid 15 minutes, takes one file.                                                                                                                                                                                    |
| Accepted files      | Receipts: PDF, PNG or JPEG. E-invoices: XML (XRechnung) or PDF (ZUGFeRD, Factur-X). Checked by content.                                                                                                              |
| One upload          | 20 MiB, or half of `SEVDESK_HTTP_FILES_MAX_MB` if that is less.                                                                                                                                                      |
| Uploaded file, link | Valid for at most `SEVDESK_HTTP_FILES_TTL` (30 minutes); an upload is released after a confirmed attachment. A link serves at most 5 downloads.                                                                      |
| Per account         | 5 upload pages waiting for a file; `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` live pages, uploads and links together (default 10, range 1–1000); a quarter of `SEVDESK_HTTP_FILES_MAX_MB` (at least 20 MiB, at most half). |
| All accounts        | `SEVDESK_HTTP_FILES_MAX_MB` (256 MiB with a state directory, 64 MiB without), 1,000 uploads and links. Room for one upload is kept for accounts that hold no files yet.                                              |
| Requests per client | 60 a minute to the upload and download pages together; 10 uploads a minute and 60 an hour (IPv6 per /64 network).                                                                                                    |
| Uploads at once     | 2 for the whole server, 1 per account; another gets "Server busy" or "Upload in progress" (503): try again in a moment.                                                                                              |
| Upload speed        | The file must arrive within 90 seconds, without a 10-second pause, and at 16 KB/s or more on average after the first 10 seconds; else 408.                                                                           |
| Download speed      | The browser must keep taking the file: a download from which it takes less than 64 KiB within a minute is cut, and still counts as one of the link's 5.                                                              |
| A restart           | Voids every upload page, upload and link. The model asks for a new one.                                                                                                                                              |

Nothing is pushed out to make room: when a limit is reached, new uploads and links are refused
until older ones expire or are released. A count-limit refusal names the earliest known expiry
of the requesting account, never another account's timestamps. Transfers still being stored have
no fixed expiry yet; the refusal says so when none is known. To allow more simultaneous records,
raise `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`; this does not change any byte quota.
Download links count against the same space as uploads, so a large DATEV
export may not fit (with 64 MiB in memory, one account has 20 MiB). The tool then says that sevDesk
has started the export, and you download it in sevDesk instead; or raise
`SEVDESK_HTTP_FILES_MAX_MB`, best with a state directory, so the files go to disk.

**Memory.** Files are kept in memory without a state directory. While an upload arrives it is held
about three times over, which is why at most two are received at once. On a small machine (512 MB)
keep a state directory and the default limits.

**Reverse proxies.** An upload body is up to 20 MiB plus a little form overhead, must arrive within
90 seconds without a 10-second pause, and must carry `Content-Length`; a chunked upload without it
is refused with 411. nginx needs `client_max_body_size 25m;` (its default of 1 MB refuses most
receipts), and its default request buffering sends `Content-Length`. Caddy, as in the compose template, needs nothing.

**Turning it off.** `SEVDESK_HTTP_FILES=off` removes `sevdesk_upload_request` and the pages. In
OAuth mode the tools that need a file to read or a place to save one are not offered then
(`sevdesk_einvoice_parse`, `sevdesk_voucher_import_einvoice`, `sevdesk_document_save`,
`sevdesk_voucher_receipt_save`, `sevdesk_csv_export`, `sevdesk_datev_export`), and the `file`
argument of the voucher draft tools is refused; bearer mode still uses `SEVDESK_FILE_DIRS` and
`SEVDESK_OUTPUT_DIR` if they are set. The PDF and XML tools and the `sevdesk://` resources are not
affected: a client reads document files through them over MCP.

**Limits of the design.** An agent that can drive your signed-in browser could upload or download
on its own, as it could approve in the inbox. A downloaded file is whatever sevDesk returned; open
it like any document from your bookkeeping. On a plain-http `localhost` setup, other local web
servers receive the session cookie too. See [ADR 0008](adr/0008-file-transfer-over-http.md).

## Operating the server

### Commands

The binary has a few commands besides serving. With Docker, append them to `docker run --rm
<image>` (the image's default command is `--http`).

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

### Revoking access

| To end                         | Do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One connection                 | `grants revoke <grant-id>`. Its next request gets 401 and the client asks to reconnect. Clients that support token revocation (RFC 7009, `/revoke`) do the same when you disconnect them.                                                                                                                                                                                                                                                                                                                                              |
| Every connection of an account | `grants revoke --account <id>`. It also ends every browser session of the account, including sign-ins with a pasted token.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Everything                     | `grants revoke --all` (every grant and every browser session, sign-ins with a token included), or replace `SEVDESK_HTTP_SECRET` without keeping the old one as `_PREVIOUS`: no token issued before can be opened any more.                                                                                                                                                                                                                                                                                                             |
| Access with a sevDesk token    | Regenerate the token in sevDesk (Settings → Users → API token). sevDesk refuses the old one at once, so tool calls stop working, and the next refresh of every grant that holds it (within the access-token lifetime) revokes that grant. This works even if the server secret or a client's tokens leaked. Browser sessions are not tied to the token: a sign-in with the old token stays valid for up to 12 hours, and a consent session until its grant is revoked. Run `grants revoke --account <id>` as well to end them at once. |
| Bearer access                  | Replace `SEVDESK_HTTP_BEARER_TOKEN` and restart. Browser sign-ins survive a restart when `SEVDESK_HTTP_SECRET` and the state directory persist; `grants revoke --account <id>` ends them (the id is the one the server logged at startup, or `bearer` if that lookup failed).                                                                                                                                                                                                                                                          |

Uploads and download links are not revoked with a grant: a session's end stops the browser that
held it, and the files expire within `SEVDESK_HTTP_FILES_TTL`. A restart voids them all at once.

### Rotating the server secret

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

### Logs

The server logs to stderr: at startup the MCP endpoint it serves, then one JSON object per request
with the route (as a template, not the full path), the status, the duration, the client IP and the
first 8 characters of the grant id. Headers, bodies, cookies and query strings are never logged, and
every line is scrubbed of the sevDesk token, the bearer and server secrets, anything that looks like
a sealed token (`sdmcp_…`) and any run of 32 or more hex digits (the shape of a sevDesk token, which
the server does not know in advance in OAuth mode). Security events are logged as warnings by name:
`refresh_replay` and `code_replay` (a token was used twice; the grant was revoked),
`account_refused` (consent with an account not on the list), `cimd_blocked` (a client metadata
document was refused) and `grant_revoked` (with its reason, for example `account_removed` when an
allowlist no longer covers the grant).

The browser pages log their own events. Sign-ins (shared by the inbox and the file pages, and
named after the inbox): `approval_login`, `approval_login_refused`, `approval_login_limited`,
`approval_login_unavailable` (sevDesk could not be asked), `approval_logout` and
`approval_session_refused` (a session of an account no longer allowed). File transfer:

| Event              | Level | Fields                                                                                                                                                                                                                                                 |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `upload_received`  | info  | `account`, `reference`, `kind`, `bytes`                                                                                                                                                                                                                |
| `upload_refused`   | warn  | `reason` (`rate_limited`, `foreign_origin`, `signed_out`, `unknown`, `expired`, `already_received`, `unsupported_type`, `length_required`, `too_large`, `bad_form`, `csrf`, `empty`, `wrong_kind`, `storage_full`, `failed`), `account` once signed in |
| `download_served`  | info  | `account`, `reference`, `kind`, `bytes`                                                                                                                                                                                                                |
| `download_refused` | warn  | `reason` (`signed_out`, `unknown`, `expired`, `exhausted`), `account` once signed in                                                                                                                                                                   |
| `audit_failed`     | warn  | `event`: a file event could not be written to `SEVDESK_AUDIT_LOG`                                                                                                                                                                                      |

Their request lines show the routes as `/uploads/*` and `/files/*`. Upload and download ids and
file names are never logged; the reference code connects a log line with the page, the tool result
and the audit log.

Every page loads its fonts and its icon from the server itself: request lines with the route
`/assets/*`, answered without a session and cached by the browser for good (the file names carry
a content hash). The pages load nothing from any other server, so a proxy needs no rule beyond
passing these paths on like the rest.

### Health and shutdown

`GET /healthz` answers `{"status":"ok"}` without authentication and without the Host check, for
platform health checks. On SIGTERM the server answers 503 there, gives running requests 10 seconds,
then deletes the files of uploads and download links, writes the grant store and releases the
lock.

## Troubleshooting

**claude.ai says it couldn't reach or connect to the server.** claude.ai connects from the
internet, so check from outside your network:

- `curl https://<host>/healthz` answers `{"status":"ok"}`;
- `curl https://<host>/.well-known/oauth-protected-resource/mcp` returns JSON with your public URL;
- the connector URL is exactly `SEVDESK_HTTP_PUBLIC_URL` plus `/mcp`;
- the server runs in OAuth mode (in bearer mode the metadata documents answer 404, and claude.ai
  cannot connect);
- the certificate is valid for the host, and nothing in front of the server asks for a login.

**A 401 loop: consent works, then claude.ai asks to connect again.** The access token is valid only
for `<public URL>/mcp`, sealed with the current secret, and checked against the grant store.

- The connector URL differs from the public URL (another host, `http` instead of `https`, a
  trailing slash or another path): fix the URL or `SEVDESK_HTTP_PUBLIC_URL`.
- The secret changed since consent, or two instances with different secrets serve the same URL.
- The state directory is not persistent, so a restart forgot the grants. Mount a volume at it.
- More than one instance: a grant exists only in the store of the instance that created it.

**Requests are refused because of `Host` or `Origin`, behind a proxy.** The server only accepts the
host of its public URL. Most proxies (Caddy, Fly, Render, Railway, cloudflared) pass the original
`Host` on; if yours sends its own (an internal name such as `localhost:8080`), configure it to pass
the original host, or add that name to `SEVDESK_HTTP_ALLOWED_HOSTS`. A client that sends an
`Origin` header other than the public origin needs it in `SEVDESK_HTTP_ALLOWED_ORIGINS`; an MCP
client running in a web page on another origin cannot work at all, because `/mcp` has no CORS
support. `/healthz` is never refused for its host. Both refusals answer 403.

**Many 429 answers, or every request logged with the proxy's IP.** Behind a proxy, set
`SEVDESK_HTTP_TRUST_PROXY` to the number of proxies that add to `X-Forwarded-For`; otherwise all
clients share the rate limits of the proxy's address. Never set it higher than the real number:
clients could then choose their own IP address. A 429 whose message names the sevDesk account is
a different limit: that account already has 8 `/mcp` requests in progress, from whatever
addresses ([Limits](#limits)). It passes as soon as one of them ends.

**Responses hang or arrive all at once.** A proxy buffers the streamed responses. Turn buffering
off for the server: Caddy `flush_interval -1` (the compose template does), nginx
`proxy_buffering off`.

**Uploads fail behind a proxy.** The upload page answers in the server's own words; anything else
comes from the proxy.

- "Size missing" (411): the proxy forwarded the upload without `Content-Length` (chunked). Let it
  pass the browser's `Content-Length` on, or buffer request bodies: nginx does by default
  (`proxy_request_buffering on`); Caddy passes it on unchanged.
- A 413 page of the proxy, not the server's "File too large": the proxy's body limit is below the
  server's (a little over 20 MiB). nginx: `client_max_body_size 25m;` (default 1 MB). Caddy has no
  limit unless you set one.
- A timeout (408) on large files over a slow connection: the body must arrive within 90 seconds,
  at 16 KB/s or more on average, and never pause for 10 seconds. A proxy that buffers request
  bodies (nginx by default) sends them on at full speed.

**A link from the chat shows the sign-in form.** The browser has no session of that account: it
is not the browser you consented in (the Claude apps may open links in their own browser), the 12
hours are over, you signed out, or it is signed in to another account. Sign in with the account's
sevDesk API token on that form; it brings you back to the page.

**"Upload page not found" or "File not found".** The link is unknown, belongs to another sevDesk
account, was already attached successfully, or the server restarted since (a restart voids every
upload and link). "Expired" and "used up" mean what they say. Ask the model for a new upload link or to create the file again.

**"No space for the file" (507), or the model reports that the limit is reached.** The account's
uploads and links fill its quarter of `SEVDESK_HTTP_FILES_MAX_MB`, the accounts together fill the
space, or the account has reached `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` (default 10). Successful
attachments release uploads immediately. For a count limit, wait until the next account expiry
named in the refusal or raise that count setting; for space, wait for files to expire or raise
`SEVDESK_HTTP_FILES_MAX_MB`. "Server busy" (503) means two other uploads are arriving right now,
"Upload in progress" (503) that another upload of the same account is; try again in a moment.

**The model says the client cannot be asked for confirmation.** The client has no form
elicitation over HTTP (claude.ai at the time of writing). Set `SEVDESK_CONFIRM=browser` and use the
[approval inbox](#the-approval-inbox).

**The consent page refuses the account or the client.** It names the account id or the client host;
add it to `SEVDESK_OAUTH_ACCOUNTS` or `SEVDESK_OAUTH_CLIENTS` and restart, if you mean to allow it.
Removing an entry and restarting also revokes the existing grants of that account or client at
their next use, and ends the account's browser sessions.

**The consent page says there are too many connections.** The grant store is full. `grants list`
shows the grants; revoke the ones nobody uses.

**The state directory is not writable.** The image runs as uid 65532. A named Docker volume takes
its owner from the image and just works. A bind mount needs a directory that uid 65532 can write:
`sudo install -d -o 65532 -g 65532 -m 700 ./data`. A platform that mounts volumes owned by root
needs the platform's own fix: Railway documents `RAILWAY_RUN_UID=0`, which runs the container as
root ([deploy/README.md](../deploy/README.md#volumes-and-the-container-user)). Without a writable
volume, set `SEVDESK_HTTP_STATE_DIR` to an empty value: state is then kept in memory, and every
restart signs all clients out.

**Startup says another instance uses the state directory.** Only one live server may use it. After
a crash, the old lock counts as stale after 30 seconds and the next start takes it over. If two
are really running (a second replica or machine), scale to one. A running server that finds its
lock taken over by another stops trusting its grant store: OAuth requests fail with a server error
(clients keep their tokens) and the process exits, so the platform restarts it.

## Verifying the image

Each release image carries a build-provenance attestation from GitHub Actions and BuildKit's SBOM
and provenance. Check that an image was built from this repository by its release workflow:

```bash
gh attestation verify oci://ghcr.io/jaylann/mcp-server-sevdesk:<version> --owner jaylann
```

Read the SBOM and the provenance:

```bash
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .Provenance }}'
```

Then pin the digest you verified (`ghcr.io/jaylann/mcp-server-sevdesk@sha256:…`) in your
deployment.

## Limits

- **One instance** per state directory; no horizontal scaling ([One instance](#one-instance)).
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
  64, 8 are kept for token refresh, sign-in, the approvals inbox and the file pages, so those stay
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
  session of the account, and live at most `SEVDESK_HTTP_FILES_TTL`
  ([Files](#files-uploads-and-download-links)). One upload is at most 20 MiB. The PDF of an
  invoice, credit note or order and the XML of an e-invoice also reach the client without the
  browser, as MCP resources (`sevdesk://…`), whatever `SEVDESK_HTTP_FILES` is set to.
- **Clients without Client ID Metadata Documents** cannot use OAuth mode; bearer mode works for
  them.
- **No hosted instance.** You are the operator of what you deploy.
