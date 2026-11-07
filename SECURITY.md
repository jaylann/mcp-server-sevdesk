# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/jaylann/mcp-server-sevdesk/security/advisories/new).
You will get an acknowledgement within 72 hours and a fix or mitigation plan within 14 days for
confirmed issues. Credit is given in the advisory unless you prefer otherwise.

Only the latest released version receives security fixes.

## Threat model

This server sits between an AI model and a sevDesk account. The design assumes:

1. **The sevDesk API token is all-powerful.** sevDesk tokens have no scopes and never expire; they
   can do everything their user can, on the whole account. The server therefore enforces its own
   least privilege: tools are grouped into tiers (`read`, `write`, `commit`, `external`), only
   `read` is enabled by default, and tools above the allowed tiers are never registered. The tier
   is enforced again in the dispatcher and in the HTTP client.
2. **The model can be manipulated.** Text stored in sevDesk (contact names, invoice and voucher
   descriptions, bank transfer purposes, e-invoice contents) can be written by third parties and
   may contain prompt injection. Such text is treated as untrusted data: it is fenced in output,
   stripped of invisible Unicode, and never placed in error messages. Legally binding or external
   actions (`commit`, `external`) require **human confirmation** outside the model's control
   (MCP elicitation or a local approval page); a model-supplied `confirm` flag is never accepted
   as approval.
3. **There is no sandbox.** Every write is real. Writes are never retried automatically (to avoid
   duplicates), are read back to verify, can be dry-run, and can be recorded in a local audit log.
4. **Secrets must not leak.** The token is read from the environment, a file or the OS keychain;
   it is never logged, echoed, or included in errors. Logs go to stderr only.
5. **Remote mode is single-tenant by default.** The HTTP transport refuses to start without
   authentication, validates Origin/Host, and in OAuth mode stores no tokens server-side (the
   sevDesk token is encrypted into the grant).

Out of scope: vulnerabilities in sevDesk itself (report those to sevdesk GmbH), and attacks that
require control of the machine running the server.

## Supply chain

Releases are published from CI with npm provenance (trusted publishing, no long-lived tokens),
GitHub Actions are pinned by commit SHA, and the repository is scanned by CodeQL, dependency
review and OpenSSF Scorecard.
