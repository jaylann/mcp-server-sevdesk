# Troubleshooting remote mode

Problems that only occur with `--http`: connecting clients, proxies, uploads, consent and the state
directory. For token errors, missing tools, confirmations and other problems that also occur over
stdio, see [Troubleshooting](../troubleshooting.md).

## Connecting

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

**The model says the client cannot be asked for confirmation.** The client has no form
elicitation over HTTP (claude.ai at the time of writing). Set `SEVDESK_CONFIRM=browser` and use the
[approval inbox](approvals.md).

## Behind a proxy

**Requests are refused because of `Host` or `Origin`.** The server only accepts the host of its
public URL. Most proxies (Caddy, Fly, Render, Railway, cloudflared) pass the original `Host` on; if
yours sends its own (an internal name such as `localhost:8080`), configure it to pass the original
host, or add that name to `SEVDESK_HTTP_ALLOWED_HOSTS`. A client that sends an `Origin` header
other than the public origin needs it in `SEVDESK_HTTP_ALLOWED_ORIGINS`; an MCP client running in a
web page on another origin cannot work at all, because `/mcp` has no CORS support. `/healthz` is
never refused for its host. Both refusals answer 403.

**Many 429 answers, or every request logged with the proxy's IP.** Behind a proxy, set
`SEVDESK_HTTP_TRUST_PROXY` to the number of proxies that add to `X-Forwarded-For`; otherwise all
clients share the rate limits of the proxy's address. Never set it higher than the real number:
clients could then choose their own IP address. A 429 whose message names the sevDesk account is
a different limit: that account already has 8 `/mcp` requests in progress, from whatever
addresses ([Limits](operations.md#limits)). It passes as soon as one of them ends.

**Responses hang or arrive all at once.** A proxy buffers the streamed responses. Turn buffering
off for the server: Caddy `flush_interval -1` (the Compose template does), nginx
`proxy_buffering off`.

**Uploads fail behind a proxy.** The upload page answers in the server's own words; anything else
comes from the proxy.

- "Size missing" (411): the proxy forwarded the upload without `Content-Length` (chunked). Let it
  pass the browser's `Content-Length` on, or buffer request bodies: nginx does by default
  (`proxy_request_buffering on`); Caddy passes it on unchanged.
- A 413 page of the proxy, not the server's "File too large": the proxy's body limit is below the
  server's (a little over 20 MiB for one file, up to the account's remaining byte share for several
  files on one page; see [Reverse proxies](files.md#reverse-proxies)). nginx:
  `client_max_body_size 65m;` at the disk-backed default, or `201m` for the absolute ceiling
  (default 1 MB). Caddy has no limit unless you set one.
- A timeout (408) on large files over a slow connection: the body must arrive within 90 seconds,
  at 16 KB/s or more on average, and never pause for 10 seconds. A proxy that buffers request
  bodies (nginx by default) sends them on at full speed.

## Uploads and download links

**A link from the chat shows the sign-in form.** The browser has no session of that account: it
is not the browser you consented in (the Claude apps may open links in their own browser), the 12
hours are over, you signed out, or it is signed in to another account. Sign in with the account's
sevDesk API token on that form; it brings you back to the page.

**"Upload page not found" or "File not found".** The link is unknown, belongs to another sevDesk
account, was already attached successfully, or the server restarted since (a restart voids every
upload and link). "Expired" and "used up" mean what they say. Ask the model for a new upload link
or to create the file again.

**"No space for the file" (507), or the model reports that the limit is reached.** The account's
uploads and links fill its quarter of `SEVDESK_HTTP_FILES_MAX_MB`, the accounts together fill the
space, or the account has reached `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` (default 10). Successful
attachments release uploads immediately. For a count limit, wait until the account's next file
expires (the refusal says when) or raise that count setting; for space, wait for files to expire or raise
`SEVDESK_HTTP_FILES_MAX_MB`. "Server busy" (503) means two other uploads are arriving right now,
"Upload in progress" (503) that another upload of the same account is; try again in a moment
([Limits and lifetimes](files.md#limits-and-lifetimes)).

## Consent

**The consent page refuses the account or the client.** It names the account id or the client host;
add it to `SEVDESK_OAUTH_ACCOUNTS` or `SEVDESK_OAUTH_CLIENTS` and restart, if you mean to allow it.
Removing an entry and restarting also revokes the existing grants of that account or client at
their next use, and ends the account's browser sessions.

**The consent page says there are too many connections.** The grant store is full. `grants list`
shows the grants; revoke the ones nobody uses ([Commands](operations.md#commands)).

## State directory and instances

**The state directory is not writable.** The image runs as uid 65532. A named Docker volume takes
its owner from the image and just works; a bind mount or a platform disk owned by root needs the
fix in [Volumes and the container user](deployment.md#volumes-and-the-container-user). Without a
writable volume, set `SEVDESK_HTTP_STATE_DIR` to an empty value: state is then kept in memory, and
every restart signs all clients out.

**Startup says another instance uses the state directory.** Only one live server may use it. After
a crash, the old lock counts as stale after 30 seconds and the next start takes it over. If two
are really running (a second replica or machine), scale to one. A running server that finds its
lock taken over by another stops trusting its grant store: OAuth requests fail with a server error
(clients keep their tokens) and the process exits, so the platform restarts it.

**Startup refuses or warns.** Startup lists every problem at once; what each one means is in
[Startup refusals and warnings](configuration.md#startup-refusals-and-warnings).
