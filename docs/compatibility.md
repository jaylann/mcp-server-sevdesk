# Compatibility

From 1.0.0 on, releases follow [Semantic Versioning](https://semver.org). This page defines the
public surface that version numbers protect: what you, your scripts, your client configuration
and the models that use the server can rely on within a major version, and what may change in any
release.

## What 1.0 freezes

A change that breaks anything in this list needs a new major version, unless it goes through the
[deprecation policy](#deprecation-policy) first.

| Area                     | What is stable                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools                    | Names (`sevdesk_…`), the toolset and the tier of each tool.                                                                                                                                                                                                                                                                                  |
| Tool inputs              | Argument names, types, whether they are required, accepted enum values and the meaning of each value, including the `dryRun` argument of write tools and the `upload:<id>` form of file references.                                                                                                                                          |
| Tool outputs             | Field names, types and enum values of the JSON result and of `structuredContent`, including the write statuses `done`, `dry_run`, `approval_pending` and `declined`.                                                                                                                                                                         |
| Toolsets and tiers       | The names (`meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`, `banking`, `parts`, `reports`, `advanced`; `read`, `write`, `commit`, `external`), the keywords `default` and `all`, and the safe defaults: only `read` enabled, `advanced` not loaded, `elicit` confirmation.                                              |
| Prompts                  | Names (`month_end_close`, `receipt_intake`, `dunning_run`, `vat_precheck`, `bank_reconciliation`) and argument names with their formats.                                                                                                                                                                                                     |
| Environment variables    | Names, accepted values and their meaning, defaults, and the `_FILE` variants of secrets ([Configuration](configuration.md#variables), [remote mode](remote.md#configuration-reference)).                                                                                                                                                     |
| Command line             | Commands, their arguments and flags, the exit codes `0`, `1` and `2`, and the fields of `grants list --json` and their values ([Command line](configuration.md#command-line), [remote mode](remote.md#commands)).                                                                                                                            |
| Local files              | The profiles file format (`"version": 1` and its keys), its default location, and the keychain service name `mcp-server-sevdesk`.                                                                                                                                                                                                            |
| Resources                | The URI templates `sevdesk://invoices/{id}/pdf`, `sevdesk://credit-notes/{id}/pdf`, `sevdesk://orders/{id}/pdf`, `sevdesk://invoices/{id}/xml` and the URIs `sevdesk://reference/tax-rules`, `sevdesk://reference/status-codes`.                                                                                                             |
| Audit log                | Event names, field names and the meaning of each field ([Audit log](permissions.md#audit-log)). The line format version `v` is raised when a field changes its meaning or is removed.                                                                                                                                                        |
| HTTP routes              | `POST /mcp`, `GET /healthz` and its `{"status":"ok"}` answer, the approval inbox under `/approvals` (with sign-in at `/approvals/login`), the upload pages `/uploads/<id>` and the download links `/files/<id>`.                                                                                                                             |
| Claude Desktop extension | The setting keys of the `.mcpb` bundle (`api_token`, `allow`, `read_only`, `dry_run`, `confirm`, `toolsets`, `file_dir`, `output_dir`), under which Claude Desktop stores your values, and their defaults (`confirm` is `browser` there, since Claude Desktop shows no `elicit` dialog).                                                     |
| Names                    | The npm package `mcp-server-sevdesk` and its binary, the image `ghcr.io/jaylann/mcp-server-sevdesk`, the MCP Registry name `io.github.jaylann/mcp-server-sevdesk`, the release asset `mcp-server-sevdesk-<version>.mcpb`, and the Claude Code plugin `sevdesk` with its skill `sevdesk-bookkeeping` in the marketplace `mcp-server-sevdesk`. |
| Docker image             | The default command `--http`, the port `8080`, the state directory and volume `/data`, the user id `65532`, the bind address `0.0.0.0` inside the image, and the tags `X.Y.Z`, `X.Y` and `latest` (`latest` never for a pre-release).                                                                                                        |
| State directory          | Its files (`grants.jsonl` and the rest) are internal and their format is not public, but a 1.x release keeps reading what earlier 1.x releases wrote, so grants survive an upgrade within the major version.                                                                                                                                 |

## What it does not freeze

These may change in any release, including patch releases:

- **Text written for people or models:** tool and prompt descriptions and titles, argument
  descriptions, the summary text of results, error messages, warnings, notes, the server
  instructions, the rendered text of prompts and the wording of confirmation previews. Models read
  them, so they improve over time; do not parse them.
- **Logs:** the server's stderr lines, the JSON request log of remote mode, its field names and its
  event names.
- **OAuth endpoints:** clients discover `/authorize`, `/token` and `/revoke` from the metadata
  documents, so their paths may move. The metadata documents
  (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`) are not
  frozen separately: their paths and format are those of RFC 8414 and RFC 9728, which clients
  rely on.
- **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) may
  change, but only toward more caution, for example a tool newly marked as destructive.
- **HTML pages:** the consent page, the approval pages, the sign-in, upload and download pages,
  their layout, text and form fields.
- **The setup-problem mode:** with an invalid configuration the stdio server starts with only
  `sevdesk_setup_problem` ([Configuration](configuration.md#command-line)); that tool's name and
  output may change.
- **Which tools a configuration offers** beyond the rules above: new tools can appear in a toolset
  in a minor release, and tools that need a folder or remote file transfer appear only when it is
  configured.
- **Limits and tuning:** page sizes, size caps, timeouts and the pacing of requests, as long as
  existing arguments stay valid.
- **Internals:** the package exports no library API; its modules, the build output, test fixtures,
  scripts and the evals can change at any time.

## Breaking and non-breaking changes

**Breaking** (a major version, or a deprecation first):

- removing or renaming anything in the frozen list;
- changing the type or the meaning of an argument, output field, value or variable;
- making an optional argument required, or refusing values that were accepted;
- moving a tool to another toolset or a higher tier;
- changing a default so that the server allows more than before (more tiers, more toolsets,
  weaker confirmation).

**Not breaking** (a minor release):

- new tools, prompts, toolsets, resources, variables and commands;
- new optional arguments, new accepted input values, new output fields;
- new events or fields in the audit log;
- a new value in an output enum when sevDesk itself introduces it (for example a new document
  status). Clients should treat a value they do not know as "other".

**Exceptions.** A fix for a security vulnerability may break compatibility in a minor or patch
release when there is no safe alternative; the advisory and the release notes say so. When sevDesk
changes or removes an endpoint, a tool may have to change with it; the release notes say what
changed and why.

## Deprecation policy

A name that is going away is deprecated first:

1. The old name keeps working next to the new one, at least until the next major release and for
   at least three months.
2. The deprecation is announced in the release notes and the changelog. A deprecated tool or
   argument says so at the start of its description (`Deprecated: use … instead.`), so models
   prefer the new one; the [tool reference](tools.md) shows it. A deprecated environment variable
   triggers a warning in the server log at startup.
3. The next major release removes it, listed under breaking changes in its release notes.

Pull requests that change the public surface follow the same rules
([CONTRIBUTING.md](../CONTRIBUTING.md#compatibility)).

## Changes from 0.x

Before 1.0, a review renamed these so the frozen names are consistent. Configurations and scripts
written for 0.x need the new names.

| Before 1.0                                                                        | From 1.0                                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `sevdesk_export_csv` (input `kind`, output `contentType`)                         | `sevdesk_csv_export` (input `subject`, output `mimeType`)       |
| `sevdesk_order_to_invoice` (toolset `orders`)                                     | `sevdesk_invoice_create_from_order` (toolset `invoices`)        |
| `transactionId` of `sevdesk_transaction_book`, `_mark_private`, `_reset`          | `id`                                                            |
| `taxRule` of the invoice, order, credit-note and voucher draft tools              | `taxRuleId`                                                     |
| parts input `priceType`, documents output `pricesEnteredAs`                       | `priceMode`                                                     |
| vouchers `amountsAre`                                                             | `amountMode`                                                    |
| `sevdesk_bank_accounts_list` `balanceDate`                                        | `asOf`                                                          |
| `sevdesk_records_summarize` `accountId`                                           | `checkAccountId`                                                |
| `sevdesk_reconcile_suggest` `matches` (input)                                     | `maxMatches`                                                    |
| `sevdesk_reconcile_suggest` output `followUp.arguments.transactionId`             | `followUp.arguments.id`                                         |
| voucher write tools: output `receipt.pages` as any number                         | an integer                                                      |
| `sevdesk_order_create_draft` `orderType`                                          | `type`                                                          |
| `sentVia` value `own_email`; output `sent.via` as sevDesk codes (`VM`, `VPDF`, …) | `email`; `sent.via` as `pdf_download`, `post`, `print`, `email` |
| payment output `bookingType` (sevDesk codes)                                      | `paymentType` with the input's values                           |
| email output `copyToMe`                                                           | `sendCopyToMe`                                                  |
| report text field `basis` (summaries, aging, cash position, changes)              | `source`                                                        |
| voucher amounts `net`, `tax`, `gross`, `base`, `paidAmount`; `taxRule`, `taxType` | `totals`, `totalsEur`, `paid`; a `tax` block as on invoices     |
| tax rates and stock as JSON numbers                                               | decimal strings, like money                                     |
| audit lines without a version                                                     | `v: 1` after `ts`                                               |
