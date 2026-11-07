# ADR 0003: Permission tiers and human confirmation

- **Status:** Accepted
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
   state (`getPdf` without `preventSendBy`, `sendByWithRender`).

**Human confirmation for `commit` and `external`**, configured with `SEVDESK_CONFIRM`:

- `elicit` (default): the tool call answers with an MCP elicitation through the SDK v2
  multi-round-trip request (MRTR) flow: an `inputRequired` result that shows the exact effect,
  which the client presents to the user before retrying the call with the answer. The pending
  state is signed with the SDK's request-state codec and bound to a SHA-256 of the tool name and
  arguments, a nonce and an expiry. It is verified again on the retry, so changed arguments need a
  new confirmation. Older clients get a compatibility shim.
- `browser`: for clients without elicitation, the tool returns a pending handle and a local
  approval page shows the same preview.
- `off`: allowed only together with `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1`.

`enshrine` always carries an "irreversible (GoBD)" warning.

**No confirmation flag.** Tools have no `confirm` argument that acts as a gate.

**No write retries.** POST and PUT are never retried. Writes check for duplicates first and read
the record back afterwards. Only GETs are retried.

**Supporting controls:** dry-run (`SEVDESK_DRY_RUN=1` or `dryRun` per call), an optional JSONL
audit log (`SEVDESK_AUDIT_LOG`), fencing of untrusted text, and all four MCP tool annotations
declared explicitly on every tool.

## Consequences

- Good: a default install cannot change anything. Enabling writes is an explicit, visible choice.
- Good: binding actions need a human, independently of the client's own approval settings.
- Good: three independent layers, so a bug in one does not open everything.
- Bad: more friction for users who want full automation; they have to opt in twice (tiers and
  confirmation mode).
- Bad: clients without elicitation need the browser mode, which needs a local browser. Remote
  setups without either can only run `read` and `write`.
- Bad: after a timeout on a write the outcome is unknown. The tool reports this and tells the user
  how to check, instead of retrying.

## Alternatives considered

- **Rely on the client's tool-approval prompt** and annotations only. Rejected: behavior differs per
  client and is often auto-approved; annotations are hints, not enforcement.
- **A `confirm: true` parameter.** Rejected: the model sets it itself.
- **Separate read-only and full packages.** Rejected: harder to install and maintain, and still
  needs confirmation inside the full package.
- **Per-tool allowlists only.** Rejected as the main control: easy to misconfigure. Toolsets and
  tiers cover the common cases.
- **Retrying writes with idempotency keys.** Not possible: sevDesk has no idempotency keys.
