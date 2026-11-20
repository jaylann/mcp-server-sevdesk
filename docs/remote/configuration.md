# Configuration reference

Every variable of [remote mode](../remote.md), how the variables of the stdio mode change under
`--http`, and what startup refuses or warns about. For the variables shared with stdio, see
[Configuration](../configuration.md#variables).

All variables are read at startup. Startup reports every problem at once and refuses to start
until all are fixed. Variables ending in `_FILE` read the value from a file instead (Docker and
Kubernetes secrets); set one or the other.

## HTTP variables

| Variable                                 | Default                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_HTTP_AUTH`                      | (required)                           | `bearer` or `oauth` ([Bearer or OAuth](../remote.md#bearer-or-oauth)).                                                                                                                                                                                                                                                                                                                                                                   |
| `SEVDESK_HTTP_HOST`                      | `127.0.0.1` (image: `0.0.0.0`)       | Bind address. Anything other than a loopback address needs `SEVDESK_HTTP_PUBLIC_URL`.                                                                                                                                                                                                                                                                                                                                                    |
| `SEVDESK_HTTP_PORT`                      | `$PORT`, else `8080` (image: `8080`) | Bind port, 0–65535 (0 picks a free port, for tests).                                                                                                                                                                                                                                                                                                                                                                                     |
| `SEVDESK_HTTP_PUBLIC_URL`                |                                      | The origin clients use, for example `https://mcp.example.com`: scheme, host and port only, without path, query, fragment or credentials. https unless the host is `localhost`, `127.0.0.1` or `[::1]`. Required for OAuth and for non-loopback binds. The MCP endpoint (and OAuth resource) is `<origin>/mcp`, the OAuth issuer is the origin. Every URL the server prints or redirects to is built from it, never from request headers. |
| `SEVDESK_HTTP_ALLOWED_HOSTS`             |                                      | More host names accepted in the `Host` header, comma-separated. The host of the public URL is always accepted (the loopback names on a loopback bind without a public URL).                                                                                                                                                                                                                                                              |
| `SEVDESK_HTTP_ALLOWED_ORIGINS`           |                                      | More values accepted in the `Origin` header of `/mcp` requests, comma-separated; the check compares host names only (any scheme or port). The public origin is always accepted, and requests without `Origin` pass. `/mcp` sends no CORS headers and answers no preflight (`OPTIONS`), so MCP clients running in a web page on another origin are not supported: this only admits clients that send such an `Origin` header themselves.  |
| `SEVDESK_HTTP_TRUST_PROXY`               | `0`                                  | Reverse proxies in front of the server, 0–5. The client IP (rate limits, logs) is the entry that many places from the right of `X-Forwarded-For`.                                                                                                                                                                                                                                                                                        |
| `SEVDESK_HTTP_BEARER_TOKEN` (`_FILE`)    |                                      | Bearer mode, required: the client secret, or two comma-separated secrets while you rotate. Each at least 32 characters with at least 16 different ones, no whitespace, and not the sevDesk token.                                                                                                                                                                                                                                        |
| `SEVDESK_HTTP_SECRET` (`_FILE`)          |                                      | OAuth, required: the server secret all tokens and cookies are sealed with; at least 32 random bytes, hex or base64/base64url (`generate-secret`). Optional in bearer mode, where it keeps browser sign-ins valid across restarts.                                                                                                                                                                                                        |
| `SEVDESK_HTTP_SECRET_PREVIOUS` (`_FILE`) |                                      | The previous server secret while you [rotate it](operations.md#rotating-the-server-secret): tokens sealed with it are still accepted and resealed on refresh.                                                                                                                                                                                                                                                                            |
| `SEVDESK_HTTP_STATE_DIR`                 | memory (image: `/data`)              | Absolute directory for the grant store and the encrypted files of file transfer (`files/`); created with mode 0700 (an existing one is tightened to 0700) and checked for write access at startup. Without it, grants and browser sessions end with the process (OAuth startup warns) and files are kept in memory.                                                                                                                      |
| `SEVDESK_HTTP_FILES`                     | `on`                                 | [File transfer](files.md): upload pages for receipts and e-invoices, and download links for the files tools create. `on`/`off`, `1`/`0`, `true`/`false` or `yes`/`no`. Off: no pages, no `sevdesk_upload_request` and no `sevdesk_uploads_list`; in OAuth mode also no tool that needs a file to read or a place to save one. The PDF and XML tools and the `sevdesk://` resources stay: a client still reads document files over MCP.   |
| `SEVDESK_HTTP_FILES_MAX_MB`              | 256 with a state directory, else 64  | Mebibytes (MiB) the uploaded files and download links of all accounts may take together, 32 to 4096. One account may use a quarter of it (at least 20 MiB, at most half); room for one upload stays free for accounts that hold no files yet. With a state directory the files are on disk, otherwise in memory.                                                                                                                         |
| `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`     | `10`                                 | Reserved upload file slots, uploaded files and download links together per sevDesk account, a whole number from 1 to 1000. Separate limits of 5 pending pages and 1,000 records overall still apply; byte quotas stay unchanged.                                                                                                                                                                                                         |
| `SEVDESK_HTTP_FILES_TTL`                 | `30m`                                | Maximum lifetime of an uploaded file and a download link, 5 minutes to 24 hours. Successfully attached uploads are released sooner.                                                                                                                                                                                                                                                                                                      |
| `SEVDESK_OAUTH_ACCOUNTS`                 |                                      | OAuth, required: the sevDesk account ids that may connect, comma-separated, or `any` (startup warns).                                                                                                                                                                                                                                                                                                                                    |
| `SEVDESK_OAUTH_CLIENTS`                  | `claude.ai`                          | Hosts allowed to serve a client's metadata document (its `client_id` URL), comma-separated, or `any` (startup warns).                                                                                                                                                                                                                                                                                                                    |
| `SEVDESK_OAUTH_ACCESS_TTL`               | `1h`                                 | Access token lifetime, 5 minutes to 24 hours. Under 10 minutes startup warns: Claude refreshes 5 minutes before expiry, so it would refresh on nearly every request.                                                                                                                                                                                                                                                                     |
| `SEVDESK_OAUTH_REFRESH_IDLE_TTL`         | `14d`                                | A refresh token unused this long expires; 1 to 90 days.                                                                                                                                                                                                                                                                                                                                                                                  |
| `SEVDESK_OAUTH_GRANT_TTL`                | `90d`                                | Lifetime of a grant from consent; 1 to 365 days.                                                                                                                                                                                                                                                                                                                                                                                         |

Durations are a whole number with the unit `s`, `m`, `h` or `d` (`90s`, `30m`, `1h`, `14d`), or
a plain number of seconds.

## Other variables in HTTP mode

The [variables of the stdio mode](../configuration.md#variables) keep their meaning, with these
differences:

- **`SEVDESK_API_TOKEN` (`_FILE`)**: required in bearer mode, where it is the account the server
  serves and the token that signs a browser in to the server's pages (approval inbox, uploads and
  downloads). Not used in OAuth mode (startup warns if it is set): every user pastes their own
  token on the consent page.
- **`SEVDESK_API_TOKEN_KEYCHAIN`, `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH`**: refused. The OS
  keychain and local profiles are for local installs over stdio; a container has no keychain.
- **`SEVDESK_ALLOW`, `SEVDESK_READ_ONLY`**: the most any connection may get. In OAuth mode each
  grant gets the intersection with the tiers ticked on the consent page
  ([Tiers per grant](../remote.md#tiers-per-grant)).
- **`SEVDESK_CONFIRM`**: `elicit` (the default) works with clients that speak the 2026-07-28
  protocol and support form elicitation. 2025-era clients cannot be asked over stateless HTTP;
  that includes claude.ai at the time of writing. Startup therefore warns when `elicit` is combined
  with the `commit` or `external` tier. `browser` uses the server's
  [approval inbox](approvals.md).
- **`SEVDESK_CONFIRM_OPEN`**: off in HTTP mode unless set explicitly, and without effect there:
  approvals wait in the inbox, which you open yourself. Setting it to `1` together with a
  non-loopback bind is refused.
- **`SEVDESK_FILE_DIRS`, `SEVDESK_OUTPUT_DIR`**: refused in OAuth mode, because the server's disk
  would be shared by every connection. Files reach the tools through
  [upload pages and download links](files.md) instead (`SEVDESK_HTTP_FILES`, on by default).
  Bearer mode keeps them; the folders are on the server, not on the client's machine. There a file
  argument may be a path inside `SEVDESK_FILE_DIRS` or an upload, and `SEVDESK_OUTPUT_DIR`, when
  set, wins over download links: files are then saved on the server.
- **`SEVDESK_FILE_URL_HOSTS`**: works in every mode, OAuth included: it touches no disk, and a
  link is downloaded only from the hosts you list, from public addresses, without credentials
  ([Files from a link](../configuration.md#files-from-a-link)). The server then reaches those
  hosts for every connected account, with at most two downloads at once per account and four in
  all.
- **`SEVDESK_AUDIT_LOG`**: one log for all accounts; every line names the account and the grant.
  It also records each received upload, created download link and download. In the image the
  root filesystem is read-only, so put it under `/data`.
- **`SEVDESK_RATE_LIMIT`**: applies per sevDesk account, shared by all its connections.

## Startup refusals and warnings

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
  another live instance uses, or a `files/` folder in it that cannot be cleared or that holds
  anything the server did not write (it deletes only its own leftover files, never yours);
- any other value outside what the tables above allow, for example a variable set together with
  its `_FILE` variant, `SEVDESK_HTTP_SECRET_PREVIOUS` without `SEVDESK_HTTP_SECRET`, more than two
  bearer secrets, a relative state directory, an OAuth lifetime out of range, an invalid host or
  origin entry, or `any` mixed with ids or hosts.

Startup warns, and starts, for:

- `SEVDESK_CONFIRM=elicit` with the `commit` or `external` tier;
- `SEVDESK_OAUTH_ACCOUNTS=any` (with file transfer on, also because the server then briefly holds
  every connected account's receipts and exports, and a few accounts together can fill its file
  space), and `SEVDESK_OAUTH_CLIENTS=any`;
- OAuth without a state directory, and `SEVDESK_API_TOKEN` or a bearer secret in OAuth mode;
- a server or bearer secret that looks like a passphrase rather than random bytes (use
  `generate-secret`);
- a non-loopback bind with a loopback public URL: anyone who reaches the port can use the server
  (see the [Docker quick start](../remote.md#quick-start-bearer-mode-with-docker));
- file transfer over plain http (the browser session cookie reaches every server on that host
  name), and file transfer without a state directory (files are held in memory, up to
  `SEVDESK_HTTP_FILES_MAX_MB`);
- `SEVDESK_HTTP_FILES_MAX_MB`, `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` or `SEVDESK_HTTP_FILES_TTL`
  set together with `SEVDESK_HTTP_FILES=off` (they have no effect);
- `SEVDESK_OAUTH_ACCESS_TTL` under 10 minutes.
