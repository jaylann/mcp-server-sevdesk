# ADR 0007: Approval inbox over HTTP

- **Status:** Accepted
- **Date:** 2026-11-09
- **Amends:** [ADR 0003](0003-tiers-and-human-confirmation.md) (the browser mode over HTTP)

## Context

[ADR 0003](0003-tiers-and-human-confirmation.md) requires a human confirmation for `commit` and
`external` tools: MCP elicitation by default, or a local approval page (`SEVDESK_CONFIRM=browser`)
for clients without elicitation. The local page runs on `127.0.0.1` of the server's machine, is
opened with the operating system's opener, and its link is a capability that never reaches the
model. None of that works for a remote server:

- the server runs elsewhere; it cannot open the user's browser, and its `127.0.0.1` is not the
  user's;
- claude.ai, the main remote client, reportedly offers no MCP elicitation (third-party reports,
  mid-2026), and 2025-era clients cannot be asked over stateless HTTP at all
  ([ADR 0003](0003-tiers-and-human-confirmation.md), Consequences);
- so, as ADR 0003 noted, remote setups could only run `read` and `write`. Finalizing, booking or
  sending from claude.ai, or from the Claude mobile app, would be impossible.

The remote mode also serves more than one grant, and in OAuth mode more than one account, from
one process. ADR 0003's approvals were keyed by tool and arguments only, so one connection could
have used another's approval.

## Decision

**In HTTP mode, `SEVDESK_CONFIRM=browser` uses an approval inbox served by the server itself** at
`<public URL>/approvals` (`src/http/approval-routes.ts`). Elicitation stays the default. Over stdio
nothing changes: the local page of ADR 0003 (now `src/safety/approval-local.ts`).

**The inbox URL is not a capability; the browser proves the account.** The tool result
(`approval_pending`) names the inbox URL, the reference code and the expiry, and the model may see
all three. Without a session the inbox shows only a sign-in form and no approval data. A browser
gets a session in one of two ways:

- **At OAuth consent.** The browser that completed the consent page, where the user pasted their
  sevDesk token, is signed in for that account.
- **By pasting the sevDesk token.** In OAuth mode it is checked with sevDesk and against
  `SEVDESK_OAUTH_ACCOUNTS`. In bearer mode it must equal the server's `SEVDESK_API_TOKEN`
  (constant-time compare). The bearer secret never signs in: the client holds it, so anything that
  can read the client's configuration could approve.

Sign-in attempts are limited to 5 a minute and 20 an hour per IP address.

**The session cookie.** `__Host-sevdesk_session`: sealed (no sevDesk token inside), HttpOnly,
Secure, path `/`, valid for 12 hours, with a new session id at every sign-in. The session is stored
in the grant store and revoked together with the grant it came from; Sign out ends it. Without
https (a loopback test setup) the cookie drops the `__Host-` prefix and `Secure`.

**`SameSite=Lax` plus CSRF tokens.** The user follows the inbox link from inside claude.ai, which is
a cross-site top-level navigation. A `SameSite=Strict` cookie would not be sent on that click, and
the inbox would ask to sign in again each time. `Lax` sends the cookie on that GET but never on a
cross-site POST. Every decision is a POST that must also carry a CSRF token bound to the session
(an HMAC of the session id under the server's CSRF key) and come from the inbox itself (`Origin`
equal to the public origin, or `Sec-Fetch-Site: same-origin` without one; never `Origin: null`).
GET requests change nothing. The pages are static HTML with every value escaped, a strict Content
Security Policy, no framing, and the Host checked on every request.

**Approvals are scoped to the grant and listed per account.** Each approval is owned by the
principal that asked (grant id, or `bearer`/`stdio`, plus the account). A retry only takes an
approval its own grant created, so one connection cannot use another's approval, even within the
same account. The inbox lists and decides per account: a session for account A sees all of A's
approvals and nothing else. Approvals still bind tool, argument hash and preview hash, expire after
10 minutes and are used once (ADR 0003). At most 5 approvals per account and 100 overall wait at
once. The elicitation codec binds the same principal, so a `requestState` issued to one account is
refused for another.

**Code layout.** ADR 0003's approval server is split into a transport-agnostic store
(`src/safety/approval-store.ts`), the local page (`approval-local.ts`) and the inbox routes; the
HTML helpers are shared (`src/safety/web.ts`, `approval-page.ts`).

## Consequences

- Good: `commit` and `external` tools work from claude.ai and the Claude apps, with the same
  preview, binding and single use as over stdio.
- Good: approving needs proof of the account, not a link that could leak through the model, a
  log or a screenshot.
- Good: approvals cannot cross accounts or connections.
- Bad: an agent that can drive the user's browser while it is signed in (browser automation, a
  computer-use tool) can still approve on its own. The inbox protects against a model that only
  talks, as the local page does.
- Bad: the inbox asks for the sevDesk token, so a lookalike page could phish it. Users must only
  paste it on their own server's address; the consent page signs the browser in, so most users
  never need to paste it in the inbox at all.
- Bad: everyone who can sign in to an account shares its inbox and can decide each other's
  approvals. They hold the account's token anyway.
- Bad: a session lasts up to 12 hours on that browser. A shared computer should sign out.
- Bad: pending approvals live in memory: a restart voids them, and the model asks again.

## Alternatives considered

- **The stdio design: a secret link per approval.** Rejected for HTTP: the link would have to reach
  the human through the tool result, so the model would see it, and anything that can browse could
  use it.
- **`SameSite=Strict`.** Rejected: the cookie would be missing on the click from claude.ai, so the
  user would see the sign-in form every time. CSRF tokens and the Origin check close the gap that
  `Lax` leaves.
- **Signing in with the bearer secret.** Rejected: the client holds it, so it proves nothing about
  the human.
- **Out-of-band notifications (e-mail, push).** Rejected: they need third-party services and still
  need a page that proves the account.
- **Requiring elicitation for `commit` and `external`.** Rejected: claude.ai could then never use
  them.
