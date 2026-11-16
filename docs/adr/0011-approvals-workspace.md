# ADR 0011: One approvals workspace, with decisions on several requests

- **Status:** Proposed
- **Date:** 2026-11-16
- **Amends:** [ADR 0003](0003-tiers-and-human-confirmation.md) (the local approval page: one
  workspace per server instead of a page per request, a session instead of a cookie per
  request), [ADR 0007](0007-approval-inbox-over-http.md) (the inbox becomes the same workspace,
  and a decision can cover several requests) and
  [ADR 0010](0010-server-pages-in-two-languages.md) (one script, on the workspace pages only)

## Context

In browser mode (`SEVDESK_CONFIRM=browser`) a human decides every `commit` and `external` step on
a page of its own:

- **Locally** each request opens a tab. An assistant that finalizes three invoices and then emails
  them opens six tabs within a minute, each with its own link, cookie and countdown, on top of
  whatever the user was doing. At most five can wait.
- **Remotely** the inbox lists the account's requests, but a row only links to its page. Deciding
  five requests takes five round trips, and the list changes only when the user reloads it.

Bookkeeping comes in batches: a month end finalizes several invoices and books several
transactions, and the person approving reads similar previews in a row. Tabs that pile up invite
the reflex [ADR 0010](0010-server-pages-in-two-languages.md) set out to avoid: approving quickly to
get rid of them. Elicitation, the default, is not affected; there the client asks in the chat.

What must hold after the change ([ADR 0003](0003-tiers-and-human-confirmation.md),
[ADR 0007](0007-approval-inbox-over-http.md),
[Confirmation](../security/confirmation.md)):

- The model can never approve, and the local link never reaches the model, a tool result or the
  audit log.
- An approval binds the tool, the hash of the arguments, the hash of the English and German
  preview and, for binding documents, the stored record. It lasts 10 minutes, is used once, and
  the server asks again when anything it binds has changed.
- Previews are shown in full, warnings first, and the buttons come after everything they decide.
- At most five requests wait per account.

## Decision

**One workspace, the same page in both modes.** One page lists every waiting request of the
account (reference, tool, the one-line action, time left) and the requests decided in the last
minutes. Opening one shows its full preview with the buttons last; deciding it moves on to the next
waiting request. Locally the workspace replaces the page per request; remotely it replaces the
inbox at `/approvals`. One renderer serves both.

**Decisions on several requests, only from a review.** Requests ticked in the list open a review:
a summary on top (how many, how many cannot be undone, how many send an email), then every
selected preview in full, one after the other, then one form with "Approve N" and "Reject N".

- The server accepts a decision on several requests only from a review it rendered: the form
  carries a tag (an HMAC of the session and the sorted ids), and any other set of ids is refused.
  A single request is a review of one.
- A review only shrinks. A request that expired, was decided elsewhere or was replaced (a changed
  record makes a new request with a new id) drops out and is reported; it is never approved with
  the rest.
- Each request is decided on its own record, with its own `approval_decided` audit line. The lines
  of one decision share a batch id and its size, so a missing line shows.
- At most five requests per decision, the waiting limit. Nothing on these pages is fixed or
  sticky, so the buttons stay below what they decide; a test checks the stylesheet.

**Locally: a session per browser, a fresh link only when no workspace is open.** This replaces the
link, cookie and form token per request of ADR 0003.

- The launch link stays a single-use ticket (`/open/<ticket>`, 256 bit), and it stays the only
  URL the server logs or hands to the opener. Its first use creates a session and redirects to the
  workspace at a random path (`/w/<path>/`, 256 bit), which is never logged.
- The cookie is scoped to that path: HttpOnly, `SameSite=Strict`, 12 hours. Browsers do not
  separate cookies by port, so a cookie for `/` on `127.0.0.1` would reach every other local server
  the browser visits ([Remote security](../security/remote.md) notes the same for an inbox over
  plain http); the random path keeps it from them. A decision still needs the session's CSRF token,
  a same-origin `Origin` (or `Sec-Fetch-Site: same-origin`) and the right `Host`.
- A new request opens nothing while a workspace is watched: its page holds the live connection, or
  held it in the last seconds. The request appears there, and the log line names its reference.
  Otherwise the server mints a new ticket (the previous unused one stops working) and opens it.
- A ticket used a second time, from another browser, ends every session of the server and
  withdraws every request that waits or was approved but not run. The server cannot tell which of
  the two browsers is the user's; ending everything is the answer that leaves nothing in reach of
  the wrong one. Every page and the log say so, and the assistant asks again.
- At most three sessions at once; a fourth ends the oldest.

**Remotely: the inbox's sign-in and session stay** (ADR 0007). The decision form gains the review
tag, and each id is checked against the session's account; an id of another account is reported
as unknown and decided nowhere.

**One script, on the workspace pages only.** This amends ADR 0010's "no script". It is one file,
`assets/approvals.js`, embedded and served from `/assets/` like the fonts, with subresource
integrity. The policy of the workspace pages allows exactly that file, connections only to the
workspace's own paths, and Trusted Types. The script:

- keeps the list current. Locally a server-sent event stream says only "something changed";
  remotely the page reloads its list when the tab becomes visible and every 30 seconds while it is,
  because the HTTP router ends every response after 120 seconds. Either way the script fetches the
  page again and swaps the list, the counts and the title: one renderer, no templates in the
  browser.
- adds keys: J and K (or the arrow keys) move, X ticks, A and D move the focus to Approve or
  Reject and never decide ("Ablehnen" also starts with an A), Enter on the focused button decides
  as a click does, Escape clears the selection.
- has no text of its own and inserts no markup it builds.

Every action works without it: links, a GET form for the selection, and POST forms that redirect
to the next request. Every other page (sign-in, consent, uploads, results) still runs no script.

**The model's side does not change.** The tool still returns `approval_pending` with the reference
and the expiry, never a link, and its text says that the request waits on the approvals page in the
user's browser. Nothing tells the model that requests can be decided together.

## Consequences

- Good: one tab per server process, whatever the assistant does; new requests appear where the
  human already is.
- Good: a batch of similar steps is read in one go and decided with one click, every step still
  shown in full and decided on its own record.
- Good: the same page and the same tests for both modes.
- Bad: locally, the cookie and the form token now cover a session of up to 12 hours instead of one
  request. Someone who uses a stolen launch link before the user's browser does can decide up to
  five waiting requests until that browser arrives, instead of one. The advice stays:
  `SEVDESK_CONFIRM_OPEN=0` or `elicit` on a computer shared with people one does not trust.
- Bad: a local attacker who uses a ticket twice cancels every waiting request. The user sees it;
  nothing runs.
- Bad: one click can now commit up to five binding steps. The review shows each in full first and
  the server refuses any other set, but nothing stops a reader who scrolls past.
- Bad: the workspace pages run a script. It is one reviewed file under a policy that admits nothing
  else, and the pages work without it; ADR 0010's reasons still hold for every other page.
- Bad: remote updates arrive up to 30 seconds late, until the router has a kind of response that
  may stay open.
- Neutral: two server processes on one computer (Claude Desktop and Claude Code at once) have one
  workspace each.

## Alternatives considered

- **A page per request plus a list.** The tabs would stay, and the list would need a session
  anyway.
- **A local cookie for `/`.** Rejected: every other local server would receive it.
- **Approving several requests from the list, without a review.** Rejected: one click would commit
  previews that were never on screen.
- **Keys that decide (A approves).** Rejected: a key lands on whatever has focus, and the decision
  would no longer come after the preview.
- **A JSON API and rendering in the browser.** Rejected: two renderers and escaping in two places.
  The script swaps HTML the server rendered.
- **A reload by `<meta http-equiv="refresh">`, without script.** Rejected: it reloads a review the
  user is reading, and the pages ban `http-equiv`.
- **A client app built from the website's design system.** Deferred to the move of the pages to
  the new design system (ADR 0010, update 2026-11-16); it would bring a framework and a client
  bundle to pages that need neither.
