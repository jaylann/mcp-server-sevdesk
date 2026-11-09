# ADR 0006: Built-in authorization server and a small grant store

- **Status:** Accepted
- **Date:** 2026-11-09
- **Supersedes:** [ADR 0004](0004-stateless-remote-oauth.md)

## Context

[ADR 0004](0004-stateless-remote-oauth.md) chose stdio by default and a stateless remote HTTP mode
with OAuth, in which the user's sevDesk token is sealed into the grant instead of being stored. It
left the revocation mechanism open until M5. Building M5 settled that and a few more questions:

- **The SDK covers only the resource server.** `@modelcontextprotocol/server` 2.4 verifies bearer
  tokens (`requireBearerAuth` with an audience check), serves the metadata documents and validates
  Host and Origin. It has no authorization server and no Node HTTP adapter.
- **What the 2026-07-28 spec asks of an authorization server:** protected resource metadata (RFC 9728) and a 401 that points to it; PKCE with S256, advertised in the metadata; an audience check
  (RFC 8707); refresh-token rotation for public clients; `iss` in the authorization response (RFC
  9207, SHOULD). It deprecates Dynamic Client Registration (DCR) in favor of Client ID Metadata
  Documents (CIMD), and asks for SSRF care and a 5 KB cap when fetching them.
- **What clients do:** claude.ai uses CIMD only when the server's metadata has
  `client_id_metadata_document_supported: true` and `"none"` in
  `token_endpoint_auth_methods_supported`; its redirect URI is
  `https://claude.ai/api/mcp/auth_callback`. Claude Code uses its own metadata document with a
  loopback redirect on any port, for both `localhost` and `127.0.0.1`. Clients refresh tokens both
  ahead of time and on a 401, sometimes at once.
- **Revocation in ADR 0004 was coarse.** Without any state, the only way to end a grant is to
  rotate the server key, which signs everyone out, and there is no list of connections. Refresh
  rotation with replay detection needs to know a grant's current generation, which is state too.
- **Who connects.** Most operators run the server for their own account. An open server that
  accepts any sevDesk token would make them the processor of other people's books and an easy
  target for consent phishing.

## Decision

**What still holds from ADR 0004.** stdio is the default transport. Streamable HTTP (`--http`)
handles MCP statelessly and refuses to start without authentication, in one of two modes:

- `bearer`: a static shared secret (up to two values, for rotation), compared as HMACs with
  `timingSafeEqual` against every configured value. The server holds one sevDesk token.
- `oauth`: the server is an OAuth 2.1 authorization server for itself, with PKCE, clients
  identified by CIMD instead of DCR, and an exact RFC 8707 audience check on every token. The user
  pastes their sevDesk token once on the consent page; it is sealed into the tokens the client
  holds, and the server stores no sevDesk tokens.

Host and Origin validation, a loopback bind by default, rate limits and the same tiers and
confirmations as over stdio apply. We publish a Docker image and deploy templates and run no
public instance.

**A built-in authorization server** (`src/http/oauth/`), with no new dependency:

- Protected resource metadata at `/.well-known/oauth-protected-resource/mcp` and at the root path,
  and authorization server metadata at `/.well-known/oauth-authorization-server`: S256 only,
  `"none"` as the only client authentication, CIMD supported, `iss` in responses, scopes
  `sevdesk:<tier>` plus `offline_access`, no registration endpoint.
- `GET`/`POST /authorize` with a two-step consent page, `POST /token` and `POST /revoke` (RFC
  7009). The resource must equal `<public URL>/mcp` exactly; the SDK's prefix match is not used.
- Errors in the client, its metadata document or the redirect URI show a page and never
  redirect. Redirect URIs match exactly; loopback redirects match on the host (`localhost`,
  `127.0.0.1` and `[::1]` each on its own) with any port.

**CIMD only, with a client allowlist.** `SEVDESK_OAUTH_CLIENTS` (default `claude.ai`) lists the
hosts that may serve a `client_id`, checked before anything is fetched. The `client_id` URL must be
https on a DNS name, without query, fragment, credentials or dot segments. The fetch resolves the
name once, refuses any address that is not public (private, loopback, link-local, CGNAT, ULA,
documentation and multicast ranges, also behind NAT64, 6to4 and IPv4-mapped forms), connects to
the checked address, follows no redirects, takes at most 3 seconds to connect and 5 in total,
accepts only `application/json` up to 5 KiB, and caches documents for 60 seconds to 24 hours
(never errors). The document must name the same `client_id`, 1–10 redirect URIs, no client
secret and no client authentication other than `none`.

**Sealed tokens with purpose keys.** Codes, access and refresh tokens, the consent form state and
the inbox session cookie are `sdmcp_<type>_` plus AES-256-GCM over a JSON payload. The key for
each type comes from `SEVDESK_HTTP_SECRET` through HKDF-SHA256 with its own purpose label, and the
additional data binds the type, the issuer and the key id, so one kind of token cannot be used as
another or at another server. A 4-byte key id lets `SEVDESK_HTTP_SECRET_PREVIOUS` open old tokens
during a rotation; refreshing reseals them with the current key. The readable prefix lets log
redaction and secret scanners find tokens.

**Lifetimes.** Codes 60 seconds; access tokens 1 hour; refresh tokens 14 days idle; grants 90
days from consent (configurable within 5 minutes–24 hours, 1–90 days and 1–365 days).

**Rotation and replay.** Every refresh returns a new refresh token of the next generation. The
previous generation is accepted for 30 seconds after a rotation and answered at the current
generation, so a client that refreshes twice at once keeps working. Any other old generation is a
replay and revokes the grant, as does a second exchange of an authorization code. Every failure at
`/token` is `invalid_grant`. Each refresh also checks the sevDesk token with `GET /SevClient`: a 401
from sevDesk revokes the grant, so regenerating the token in sevDesk ends access.

**A small, non-secret grant store** (`grant-store.ts`). A grant is one consented connection of one
client to one account. The store keeps its id, account, client, tiers, timestamps, status,
refresh generation and revocation reason, plus the inbox sessions, and never a token. With
`SEVDESK_HTTP_STATE_DIR` it is an append-only `grants.jsonl` (mode 0600) that is compacted at
startup; without one it lives in memory. Access tokens are checked against it on every request,
which makes revocation immediate. A heartbeat lock file (stale after 30 seconds) refuses a second
live instance without blocking a restart after a crash, and a corrupt file refuses startup. Caps:
500 grants and 1,000 sessions. The `grants list` and `grants revoke` commands append to the same
file while the server runs; the server reads new events before every `/token` request and at most
once a second on `/mcp`.

**Single-tenant by default.** OAuth needs `SEVDESK_OAUTH_ACCOUNTS`: the sevDesk account ids that
may connect. `any` opts in to serving any account and logs a warning.

**Tiers per grant.** The consent page always grants `read` and offers the other tiers that
`SEVDESK_ALLOW` enables, unchecked. A request gets the token's tiers ∩ the grant's tiers ∩
`SEVDESK_ALLOW`, so narrowing the server's setting narrows every grant at once.

**One instance.** Grants, sessions, pending approvals, confirmation nonces and rate limits live in
one process and its state directory. The deploy templates run one instance with a volume.

## Consequences

- Good: single connections can be listed and revoked, and revocation takes effect on the next
  request. Stolen access tokens expire within an hour; a stolen refresh token is detected when
  either party uses it after the other.
- Good: still no store of sevDesk tokens. A copy of the state directory reveals which accounts and
  clients are connected, nothing that grants access.
- Good: the account and client allowlists keep a self-hosted server single-tenant unless the
  operator decides otherwise, and make consent phishing through foreign metadata documents
  harder.
- Good: works with claude.ai and Claude Code as they behave today, without client registration.
- Bad: we maintain an authorization server ourselves. It is security-critical code without a
  library behind it, so every rule above has a threat test.
- Bad: the server secret opens every token. Someone with the secret and a captured token reads the
  sevDesk token inside. The secret belongs in a secret store, and rotating it without
  `_PREVIOUS` signs everyone out.
- Bad: the server keeps state: a volume to mount and back up, a lock, and no horizontal scaling.
  Several instances would need a shared store or sticky routing.
- Bad: clients that only support DCR cannot use OAuth mode; they have to use bearer mode.
- Bad: the sevDesk token itself never expires. Grant lifetimes, revocation and the refresh-time
  check are the only limits we can enforce.

## Alternatives considered

- **Dynamic Client Registration.** Rejected: deprecated by the 2026-07-28 spec, an open
  registration endpoint with per-client state, and registered names prove nothing. CIMD ties a
  client to a host we can allowlist.
- **JWT access tokens.** Rejected: a signed JWT is readable by the client and anyone who logs it,
  so it cannot carry the sevDesk token; encrypted JWTs (JWE) need a library or a lot of code. We
  are our own only resource server, so interoperable token formats buy nothing; opaque sealed
  tokens are smaller and encrypted.
- **No refresh tokens.** Rejected: either access tokens live long (a longer window for a stolen
  token, and no point at which the sevDesk token is checked again) or the user consents every
  hour.
- **A token database.** Rejected as in ADR 0004: storing every user's sevDesk token makes the
  server the thing to breach. Sealed tokens keep the token with the client; the store holds only
  what is needed to list and revoke.
- **Revocation by rotating the server key only, or a deny-list.** Rejected: rotation signs everyone
  out, and a deny-list is the same state as a grant store without the list of connections.
