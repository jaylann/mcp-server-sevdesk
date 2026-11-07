# ADR 0004: stdio by default, stateless remote HTTP with OAuth

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

- Remote access is the most requested feature among sevDesk MCP users (claude.ai custom connectors,
  mobile apps, shared team setups). Remote MCP clients expect Streamable HTTP and OAuth.
- sevDesk itself has **no OAuth and no scopes**. Its API token never expires and grants full
  access.
- Hosted sevDesk MCP services exist that store their users' tokens. A token store is a liability:
  one breach exposes every connected account.
- MCP 2026-07-28 has no protocol-level session, and SDK v2 offers a stateless handler
  (`createMcpHandler(...).fetch`).
- Local use (Claude Desktop, Claude Code, Cursor, VS Code) works best over stdio with the token in
  the local environment.

## Decision

- **stdio is the default** transport.
- **Streamable HTTP** (`--http`) is **stateless**: every request carries everything needed, so any
  instance can serve any request.
- **HTTP refuses to start without authentication.** Two modes:
  - `bearer`: a static shared secret, compared in constant time. For private deployments behind
    other access control.
  - `oauth`: the server acts as an OAuth 2.1 authorization server for itself, with PKCE, clients
    identified by Client ID Metadata Documents (CIMD) rather than Dynamic Client Registration, and
    an [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707) resource (audience) check on every token.
- **No token storage.** On the consent page the user pastes their sevDesk token once. It is
  encrypted with AES-GCM under a server key and carried inside the grant, so the server keeps no
  database of tokens. Grants can be revoked; the exact mechanism (server-key rotation for all
  grants, a deny-list for single grants) is settled when M5 is built.
- **Hardening:** Origin and Host validation, binding to 127.0.0.1 unless configured otherwise,
  rate limits, and the same tiers and confirmations as stdio
  ([ADR 0003](0003-tiers-and-human-confirmation.md)).
- **Self-host only.** We publish a Docker image and deploy templates, but run no public instance.
  We revisit this after 1.0; the stateless design keeps that option open.

## Consequences

- Good: nothing to breach at rest; scaling out is trivial; works with clients that require OAuth.
- Good: users keep control: they choose where the server runs and can revoke grants.
- Bad: the server key protects every grant. It must come from a secret store, and rotating it signs
  everyone out.
- Bad: the sevDesk token itself never expires, so grant lifetimes and revocation are the only time
  limit we can enforce.
- Bad: no list of active sessions, since nothing is stored.
- Bad: self-hosters must run TLS (a reverse proxy) and manage the server key.

## Alternatives considered

- **Stateful sessions with a token database.** Rejected: storage to secure and back up, and harder
  to scale.
- **Dynamic Client Registration.** Rejected in favor of CIMD, which avoids an open registration
  endpoint and per-client state.
- **Clients send the sevDesk token directly as the bearer token.** Rejected: it spreads a
  never-expiring full-access token into every client configuration, with no audience binding.
- **A public hosted instance.** Deferred: it would make us custodians of other people's accounting
  access.
