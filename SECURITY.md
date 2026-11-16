# Security policy

How to report a vulnerability in mcp-server-sevdesk, which versions get fixes, and the threat model
the server is built against. The detailed analysis of each part is on the pages listed under
[Details](#details).

## Reporting a vulnerability

Please **do not open a public issue**. Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/jaylann/mcp-server-sevdesk/security/advisories/new).
You will get an acknowledgement within 72 hours and a fix or mitigation plan within 14 days for
confirmed issues. Credit is given in the advisory unless you prefer otherwise.

## Supported versions

Only the latest released version receives security fixes.

## Threat model

This server sits between an AI model and a sevDesk account. The design assumes:

1. **The sevDesk API token is all-powerful.** sevDesk tokens have no scopes and never expire; they
   can do everything their user can, on the whole account. The server therefore enforces its own
   least privilege: tools are grouped into tiers (`read`, `write`, `commit`, `external`), only
   `read` is enabled by default, and tools above the allowed tiers are never registered. The tier
   is enforced again on every call and in the HTTP client, which knows the minimum tier of each
   sevDesk endpoint (for example `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`, finalizing a
   voucher and changing a bank transaction need `commit`; `sendViaEmail` needs `external`) and
   refuses a request from a tool whose tier is too low.
   ([Permissions](docs/permissions.md#tiers))
2. **The model can be manipulated.** Text stored in sevDesk (contact names, invoice and voucher
   descriptions, bank transfer purposes, e-invoice contents) can be written by third parties and
   may contain prompt injection. Such text is treated as untrusted data: it is fenced in output,
   stripped of invisible Unicode, and never placed in error messages. Legally binding or external
   actions (`commit`, `external`) require **human confirmation** outside the model's control (MCP
   elicitation or an approval page); a model-supplied `confirm` flag is never accepted as
   approval. ([Human confirmation](docs/security/confirmation.md))
3. **There is no sandbox.** Every write is real. Writes are never retried automatically (to avoid
   duplicates), are read back to verify, can be dry-run (`dryRun: true` or `SEVDESK_DRY_RUN=1`:
   the tool reads, checks and returns its preview, sends nothing and asks nobody), and can be
   recorded in a local audit log. ([Dry run](docs/permissions.md#dry-run),
   [Audit log](docs/permissions/audit-log.md))
4. **Secrets must not leak.** The token is read from the environment, a file or the OS keychain;
   it is never logged, echoed, or included in errors. Logs go to stderr only. In remote mode the
   same holds for the bearer and server secrets, sealed tokens, authorization codes and cookies.
   ([Local use](docs/security/local.md#local-token-storage-and-profiles),
   [Remote mode](docs/security/remote.md#logs))
5. **Local files are a boundary too.** The model names files, so the server must not become a way
   to read or write arbitrary files. Tools read only inside `SEVDESK_FILE_DIRS` and write only new
   files inside `SEVDESK_OUTPUT_DIR`; without these settings, no tool touches local files.
   Received e-invoices and PDFs are parsed as hostile input with size and work limits, and the
   DATEV export is fetched from exactly one host without credentials.
   ([Local files](docs/security/local.md#local-files))
6. **Remote mode adds a network boundary.** The HTTP transport refuses to start without
   authentication, binds 127.0.0.1 by default (any other address needs a configured public URL),
   and validates Host and Origin. In OAuth mode it is single-tenant by default (only listed sevDesk
   accounts can connect, only allowlisted clients can ask), stores no sevDesk tokens (each user's
   token travels sealed inside the tokens their client holds), and scopes approvals, confirmations
   and caches to the account and grant of each request.
   ([Remote mode](docs/security/remote.md))

The confirmation modes have known limits, described with each of them: `elicit` trusts the MCP
client application, and an agent that can read the server log or drive the user's browser can
approve a `browser` confirmation on its own
([Human confirmation](docs/security/confirmation.md#what-elicitation-trusts)).

### Out of scope

Vulnerabilities in sevDesk itself (report those to sevdesk GmbH), and attacks that require control
of the machine running the server.

## Details

| Page                                                | What it covers                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Permissions](docs/permissions.md)                  | Tiers, what the model sees, how a write runs, dry run, confirmation modes, recommendations.                    |
| [Audit log](docs/permissions/audit-log.md)          | Events, fields and the integrity of the local audit log.                                                       |
| [Human confirmation](docs/security/confirmation.md) | How previews are built and hardened, what an approval binds, the elicitation and the local approval page.      |
| [Local use](docs/security/local.md)                 | Local files and e-invoices, the generic read tool, the keychain, profiles and the Claude Desktop extension.    |
| [Remote mode](docs/security/remote.md)              | Network, bearer and OAuth, client metadata fetching, tokens and revocation, the approval inbox, file transfer. |
| [Supply chain](docs/security/supply-chain.md)       | Release provenance, the container image and verifying the Claude Desktop extension.                            |
| [Safety model](docs/architecture/safety.md)         | How tiers, confirmations, record locks and untrusted text are enforced in the code.                            |
| [Privacy](PRIVACY.md)                               | What data flows where and what is stored.                                                                      |
