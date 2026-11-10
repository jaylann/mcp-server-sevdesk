# ADR 0003: Permission tiers and human confirmation

- **Status:** Accepted; browser mode over HTTP amended by [0007](0007-approval-inbox-over-http.md);
  the preview's languages and the pages amended by
  [0010](0010-server-pages-in-two-languages.md)
- **Date:** 2026-11-07

## Context

- A sevDesk API token has **full account access**: no scopes, no expiry, no read-only variant.
- sevDesk has **no sandbox**. Every write changes real books.
- Some actions are **legally binding or irreversible**: finalizing an invoice, booking a payment,
  cancelling (Storno), creating a credit note, and `enshrine`, which locks a document for GoBD.
  Sending by email or letter **reaches third parties** and cannot be undone.
- Data read from sevDesk (contact names, descriptions, bank transfer purposes, e-invoice fields)
  can be written by outsiders, so **prompt injection** through tool results is realistic.
- Client-side approval prompts differ between clients and are often set to auto-approve. A
  `confirm: true` parameter proves nothing, because the model fills it in.
- A write that times out may still have succeeded. Retrying it can create a duplicate invoice or a
  double booking.

## Decision

**Four tiers.** Every tool has exactly one, and reads and writes never share a tool.

| Tier       | Covers                                                                            | Default |
| ---------- | --------------------------------------------------------------------------------- | ------- |
| `read`     | list, get, search, reports, PDF preview                                           | on      |
| `write`    | reversible changes: contacts, parts, drafts, deleting drafts                      | off     |
| `commit`   | binding or irreversible: finalize, book, reconcile, cancel, credit note, enshrine | off     |
| `external` | reaches third parties: send by email or letter                                    | off     |

`SEVDESK_ALLOW` lists the enabled tiers; `SEVDESK_READ_ONLY=1` overrides it.

**Enforcement in three layers:**

1. **Registration:** tools above the allowed tiers are not registered, so the model never sees
   them.
2. **Dispatcher:** every call re-checks the tool's tier against the configuration.
3. **HTTP client:** in read-only mode it refuses every non-GET request and the GETs that change
   state (`getPdf` without `preventSendBy`, `sendByWithRender`). Every request that changes data
   carries the calling tool's tier (stamped by the framework, never by the tool), and the client
   refuses it when that tier is not enabled or is below the endpoint's minimum: `sendBy`,
   `bookAmount`, `enshrine`, `cancelInvoice`, `resetToDraft`, `resetToOpen`, `changeParameter`,
   a sending `getPdf` and DATEV exports with `enshrine` need `commit`; `sendViaEmail` and
   `sendByWithRender` need `external`; everything else needs `write`. So a `write` tool cannot
   finalize, book, cancel or send, even by mistake.

**Human confirmation for `commit` and `external`**, configured with `SEVDESK_CONFIRM`:

Every write tool is split into `prepare` (reads, checks preconditions and builds a preview: the
action, key facts, warnings and whether it is irreversible; it gets a client that refuses writes)
and `execute` (makes exactly the previewed writes with a tier-stamped client). The framework
(`src/tools/write-flow.ts`) runs `prepare`, then the confirmation, then `execute`, so the human
always approves what actually runs:

- `elicit` (default): the tool call answers with an MCP elicitation through the SDK v2
  multi-round-trip request (MRTR) flow: an `inputRequired` result with a one-switch form ("Approve
  this action", off by default) and the sanitized preview as its message; the client presents it
  and retries the call with the answer. The pending `requestState` is sealed with the SDK's
  `createRequestStateCodec` (HMAC-SHA256, a random 32-byte key per server factory, which means per
  process, 10-minute expiry, bound to the method and the OAuth client) and verified by the SDK
  before the retry reaches the tool (`ServerOptions.requestState.verify`). Its payload binds the
  tool name, a SHA-256 of the tool name and canonical JSON of the parsed arguments without
  `dryRun`, a SHA-256 of the canonical preview, a nonce and a call id for the audit log. On the
  retry the framework refuses other arguments or another tool, consumes the nonce once (a replayed
  approval is refused), runs `prepare` again and asks again, saying the record changed, when the
  preview hash differs. Decline, cancel or an unchecked switch return `declined` (not an error).
  2025-era clients are served by the SDK's legacy shim (`ServerOptions.inputRequired`, on by
  default), which sends a real `elicitation/create` on the connection and re-enters the same
  handler, so one code path serves both eras. Before asking, the framework checks the client's
  declared capabilities the way the SDK does (the request's `_meta` envelope on the 2026 era, the
  `initialize` declaration on 2025 connections) and returns an actionable error instead of the
  SDK's protocol error when form elicitation is missing.
- `browser`: for clients without elicitation, the server creates a local approval page (one HTTP
  server per process, `127.0.0.1` and an ephemeral port only, started on first use), opens it in
  the user's browser with the OS opener (`SEVDESK_CONFIRM_OPEN`, default on) and writes its link
  to stderr. The link never reaches the model: the tool returns `approval_pending` with a short,
  non-secret reference code that the page shows too, the expiry and whether the page was opened.
  Each approval binds tool, argument hash and preview hash, has a 256-bit random id, expires after
  10 minutes and is used once. The page escapes everything, has a strict
  CSP and decides through POST forms checked for a CSRF token, a `SameSite=Strict` cookie, Origin
  and Host. The model calls the tool again with the same arguments; the framework runs the action
  only if the human approved and the preview is unchanged.
- `off`: allowed only together with `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`.

Write-tool results are wrapped as `{status: "done" | "dry_run" | "approval_pending" | "declined",
result?, preview?, approval?: {reference, expiresAt, opened}}`, with `result` (the tool's own
output) only when done.

Previews are shown in full, warnings first: fact values keep their line breaks (indented under
their label in the prompt, `pre-wrap` on the page) and are capped only at 12,000 characters with
an explicit "[… N more characters not shown; open the dry run to see everything]" marker. The
preview hash covers the complete raw preview. Conversely, arguments with characters a human would
not see (`findHiddenCharacters` in `src/safety/fence.ts`: control, format and other
default-ignorable characters, CR, U+2028/2029, tabs) are refused before `prepare`, so what reaches
sevDesk is what the human saw. The approval page accepts decisions only from itself (`Origin`
equal to its origin, or `Sec-Fetch-Site: same-origin` without `Origin`; never `Origin: null`,
which is why the page uses the `same-origin` referrer policy) and lets at most five approvals wait
at once.

`enshrine` always carries an "irreversible (GoBD)" warning.

**No confirmation flag.** Tools have no `confirm` argument that acts as a gate.

**No write retries.** POST and PUT are never retried. Writes check for duplicates first and read
the record back afterwards. Only GETs are retried.

**Supporting controls:** dry-run (`SEVDESK_DRY_RUN=1` or `dryRun` per call: `prepare` and the
preview only, never asks), an optional JSONL audit log (`SEVDESK_AUDIT_LOG`, mode 0600, append-only,
token redacted; if the `executing` line cannot be written, nothing is sent), fencing of untrusted
text, and all four MCP tool annotations declared explicitly on every tool.

## Consequences

- Good: a default install cannot change anything. Enabling writes is an explicit, visible choice.
- Good: binding actions need a human, independently of the client's own approval settings.
- Good: three independent layers, so a bug in one does not open everything.
- Bad: more friction for users who want full automation; they have to opt in twice (tiers and
  confirmation mode).
- Bad: clients without elicitation need the browser mode, which needs a local browser. Remote
  setups without either can only run `read` and `write`.
- Bad: 2025-era clients over the stateless HTTP mode cannot be asked at all: each request gets its
  own server instance, which never saw the client's `initialize` and cannot send it requests. They
  get an error pointing to `SEVDESK_CONFIRM=browser`. Over stdio, 2025-era clients work through the
  shim.
- Bad: the confirmation state lives in one process (random key, in-memory nonces and approvals).
  A restart between asking and approving voids the pending approval (the user is asked again).
  **M5 work:** the multi-process HTTP mode needs a shared codec key and shared nonce and approval
  stores, or sticky routing, before confirmations work across instances.
- Bad: the browser mode is weaker than elicitation. The model never sees the link, but an agent
  that can read the server's stderr log or drive the user's browser could still approve on its
  own; it only stops a model that can do nothing but talk. Elicitation stays the recommended mode.
- Bad: after a timeout on a write the outcome is unknown. The tool reports this and tells the user
  how to check, instead of retrying.

## Alternatives considered

- **Rely on the client's tool-approval prompt** and annotations only. Rejected: behavior differs per
  client and is often auto-approved; annotations are hints, not enforcement.
- **A `confirm: true` parameter.** Rejected: the model sets it itself.
- **Push-style `elicitInput` on every era.** Rejected: the 2026-07-28 revision has no
  server-to-client requests; the MRTR flow with the SDK's legacy shim covers both eras with one
  handler.
- **Keeping the pending confirmation in server memory only, keyed by a token the client echoes.**
  Rejected: the stateless HTTP mode builds a new instance per request; a signed `requestState`
  plus a per-process nonce set needs no session, and the nonce still makes approvals single-use.
- **Separate read-only and full packages.** Rejected: harder to install and maintain, and still
  needs confirmation inside the full package.
- **Per-tool allowlists only.** Rejected as the main control: easy to misconfigure. Toolsets and
  tiers cover the common cases.
- **Retrying writes with idempotency keys.** Not possible: sevDesk has no idempotency keys.
