# Safety model

How the server keeps the model from changing more than the user allowed: where tiers are
enforced, how a write runs, and how state is kept apart per account. It is for contributors and
reviewers; how to configure all this is in [Permissions and confirmation](../permissions.md).

## Tiers

Every tool has exactly one tier, and reads and writes never share a tool. What each tier covers,
its default and the switches (`SEVDESK_ALLOW`, `SEVDESK_READ_ONLY`, dry run) are in
[Permissions](../permissions.md#tiers).

## Enforcement in three places

1. Registration: tools above the allowed tiers are not registered.
2. Dispatcher: every call re-checks the tier.
3. HTTP client: every request that changes data (any non-GET, and the GETs that change state)
   must declare its tier, and is refused before sending in read-only or dry-run mode, when it
   declares no tier, when `SEVDESK_ALLOW` does not enable that tier, or when the tier is below the
   endpoint's minimum (`minimumWriteTier` in `paths.ts`: `sendBy`, `bookAmount`, `enshrine`,
   `cancelInvoice`, `resetToDraft`, `resetToOpen`, `changeParameter`, a sending `getPdf`, DATEV
   `enshrine` exports, a `saveVoucher` whose voucher is not a draft (the voucher's finalize),
   `PUT`/`DELETE /CheckAccountTransaction/{id}` (private marking, reset), creating a bank
   transaction (`POST /CheckAccountTransaction`), a document's status set directly (a `status` in
   the body or query of a request to one document record; `PUT /Order/{id}` accepts or rejects
   an offer this way) or through a save (a `saveInvoice`, `saveOrder` or `saveCreditNote` whose
   document has a status other than the draft status 100), `createContractNoteFromOrder` (it
   accepts the source offer) and saving a recurring invoice template (a `saveInvoice` whose type
   is `WKR`, missing or not text, or a `PUT /Invoice/{id}` that sets the type or schedule) need
   `commit`; `sendViaEmail` and `sendByWithRender` need `external`). These rules read the body as
   it is sent (its JSON text) and the query keys of the same names; a multipart form to a
   document record or one of these saves counts as binding. Why each of these binds:
   [ADR 0003](../adr/0003-tiers-and-human-confirmation.md).

Write tools never set the tier: their `execute` gets a client that stamps it (`tierScopedClient`,
which applies the endpoint rule too), their `prepare` one that refuses every write
(`readOnlyClient`). The client recognizes the state-changing GETs by endpoint, not only by the
caller's `sideEffect` flag: a `getPdf` read always goes out with the literal `preventSendBy=true`
(recorded: drafts stay drafts), while `getPdf` with `preventSendBy` off, `sendByWithRender`, DATEV
exports with an `enshrine` flag (all `commit`/`external`, see
[D-023](../../spec/deviations.md#d-023-some-gets-change-state)) and the next-number endpoints
unless `useNextNumber=false` (they reserve a document number; `write`; the documented
`getNextCustomerNumber` stays a read) count as writes.

## Write flow

A write tool (`src/tools/write-flow.ts`) has `prepare` (reads, checks, builds a preview: action,
facts, warnings, irreversible) and `execute`. A `commit` or `external` tool builds the preview
twice from the same data, in English and in German (`previewDe`; the type of `defineWriteTool`
requires it): the model, dry runs, the audit log and the elicitation show the English text, the
approval pages show the German one to a reader whose browser asks for German. The flow refuses a
pair that differs in the number of facts or warnings or in `irreversible`, and the preview hash
covers both texts.

Every call runs `prepare`, then a dry run stops, `commit`/`external` calls are confirmed, the audit
log records `executing` and only then `execute` runs. Results are wrapped as
`{status: "done" | "dry_run" | "approval_pending" | "declined", result?, preview?, approval?}`
(`result` only when done); the same era rules for `outputSchema` and `structuredContent` apply as
for reads.

## Human confirmation

`SEVDESK_CONFIRM` sets how a human approves the preview of a `commit` or `external` call
([Confirmation modes](../permissions.md#confirmation-modes),
[ADR 0003](../adr/0003-tiers-and-human-confirmation.md)); what the preview shows and what an
approval binds is in [Human confirmation](../security/confirmation.md).
In the code, `elicit` uses the SDK's sealed `requestState`; `browser` keeps approvals in
`src/safety/approval-store.ts` and shows them on the local approval page over stdio
(`src/safety/approval-local.ts`, opened by `src/safety/open-url.ts`) or in the
[approval inbox](../remote/approvals.md) over HTTP (`src/http/approval-routes.ts`,
[ADR 0007](../adr/0007-approval-inbox-over-http.md)). The key, the nonces, the approvals and the
audit writer live in one `SafetyRuntime` (`src/safety/runtime.ts`) per server factory, shared by
every instance the factory builds.

A `confirm: true` argument is never a gate, because the model can set it itself. `enshrine` always
warns that it is irreversible (GoBD).

## Pages

Every page a human sees (approval, inbox, sign-in, consent, upload, results and errors) is built
on `src/pages/`: static HTML without script, every value escaped by the `markup` template tag, one
style block with a per-response nonce, German or English from `Accept-Language`. The response
headers come from `htmlResponse` (`src/safety/web.ts`): `no-store`, no framing, and the policy
`default-src 'none'; style-src 'nonce-…'; font-src <origin>/assets/; img-src <origin>/assets/;
form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. Fonts and the icon are embedded in
the build and served by the server itself under `/assets/` (immutable, by content hash); nothing
is fetched from anyone else ([ADR 0010](../adr/0010-server-pages-in-two-languages.md)).

## Account scoping

In OAuth mode one process serves several accounts and grants, so everything that holds state is
keyed by the request's principal (grant and account, from `requestPrincipal`):

- the confirmation codec binds the principal, so a `requestState` issued to one account is refused
  for another;
- a retry takes only an approval its own grant created; the inbox lists and decides per account,
  and one account's approvals cannot push another account's out of the store;
- every account gets its own frozen `Config` and sevDesk client, and the domain caches (account
  settings, ReceiptGuidance, booking accounts, the bookkeeping system version, country codes) are
  keyed by that config object, so accounts never share cached data;
- the audit log records the account and the grant of every line.

## Annotations

Every tool declares all four MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) explicitly; a test enforces it.

## Write integrity

Duplicate check before creating (number, amount, date, description). No retries for writes. Read
back after every write. Optional JSONL audit log via `SEVDESK_AUDIT_LOG` (`src/safety/audit.ts`;
its format and integrity are in [Audit log](../permissions/audit-log.md#integrity)). A multi-step
write that fails half-way reports the records it already changed (`SevdeskError.completedWrites`),
in the error text and the audit log.

Document drafts validate tax rule × rate against the reference tax rules before any API call;
booking accounts against ReceiptGuidance (`src/domain/receipt-guidance.ts`): voucher drafts and
finalizing check every account × tax rule × rate against it, because sevDesk itself accepts any
combination on a draft. Bank bookings plan every allocation against the document's open amount and
the transaction's remaining amount (from the transaction log) before anything is sent.

## Record locks

A check followed by a write is void when two calls run at once: both read the state before either
wrote. So a write tool declares `locks`: the records its checks depend on (the document, the bank
transaction, the contact, the part, the order or invoice a document is derived from) or an
account-wide key (all bookings; the credit note number range, whose counter sevDesk does not
advance on `createFromInvoice`; customer numbers; part numbers; new voucher drafts, for their
duplicate refusal). Calls of one account that share a key run one after the other, from `prepare`
to the end of `execute` (`src/safety/record-locks.ts`). A receipt from an https link is downloaded
before the lock (the tool's `preload`, `src/safety/link-prefetch.ts`): the download reads only the
outside host, never sevDesk, and `prepare` checks exactly those bytes as before, so a slow host does
not hold up the account's other calls.

The locks live in one server process; several replicas would need a shared lock. The metadata lint
fails for a write tool without `locks` unless it is on a short list with its reason: new invoice
and order drafts (their duplicate check only warns) and the DATEV export.

## Untrusted text

Contact names, descriptions, bank transfer purposes (Verwendungszweck) and e-invoice fields can be
written by third parties and may carry prompt injection. They are stripped of invisible and bidi
characters, fenced in output, and never interpolated into error messages or instructions.

## Files

Tools never touch the file system or the transfer store directly; every byte they read or hand out
passes the `FileAccess` of their context ([Files](transports.md#files)). Every tool that reads or
writes files or opens an upload page declares `localEffects` and is on a reviewed list in the
metadata lint; a `read` tool that hands out files or opens an upload page (a ticket on this server)
sets `readOnlyHint: false`, because it changes state outside sevDesk. E-invoice XML is parsed
without entity expansion or DOCTYPEs, with size and depth limits.

## Generic read

`sevdesk_api_get` (toolset `advanced`, off by default) lets the model choose a GET path, so it has
four independent guards, described in
[Generic read surface](../security/local.md#generic-read-surface). The code is
`genericGetRefusal` in `src/sevdesk/paths.ts` and `src/domain/api-get.ts`.

## Token

The sevDesk API token has full account access, no scopes and no expiry. It is redacted everywhere,
and a 401 is final. Where it comes from depends on the mode:

- **stdio:** the environment, a `*_FILE` or, optionally, the OS keychain, checked at startup with
  `GET /Tools/bookkeepingSystemVersion`. `SEVDESK_PROFILE` first overlays a named profile from a
  local JSON file onto the same variables before they are validated
  (`src/accounts/local-config.ts`, [ADR 0009](../adr/0009-local-profiles-and-os-keychain.md)). The
  keychain is read through the operating system's helpers (`/usr/bin/security` on macOS,
  `secret-tool` on Linux, Windows PowerShell with WinRT `PasswordVault` on Windows) under the fixed
  service `mcp-server-sevdesk`, so configuration names only a label. How to use both is in
  [Profiles and keychain](../configuration/profiles.md).
- **bearer:** the environment or a `*_FILE`; the server looks up its account (`GET /SevClient`) at
  startup. A failed lookup is logged as a warning and does not stop the server (approvals and audit
  lines then use the account scope `bearer`).
- **OAuth:** each user pastes it on the consent page; it is checked with `GET /SevClient`, sealed
  into that user's tokens and checked again on every refresh.

The threat model is in the [Security policy](../../SECURITY.md); token storage on your own machine is
analysed in [Local security](../security/local.md).
