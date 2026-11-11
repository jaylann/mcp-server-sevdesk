# ADR 0001: Curated task tools, toolsets and a read-only generic GET

- **Status:** Accepted; the tool-count targets of the Decision were given up, see
  [Update 2026-11-11](#update-2026-11-11-the-tool-count-targets-are-given-up)
- **Date:** 2026-11-07

## Context

The sevDesk API has 154 documented operations (spec snapshot of 2026-10-06) plus several
undocumented ones that real integrations need. Existing sevDesk MCP servers expose them in one of
three ways:

- **One tool per endpoint.** For example 103 CRUD tools in one server. Every quirk of the API
  (silent truncation at 100 records, `getPdf` marking documents as sent, update-2.0 tax fields,
  required `contactPerson`) becomes the model's problem. Wrong hard-coded ids were the most common
  bug class we found across these servers.
- **A few generic tools** that take any operation and a raw body. Small tool list, but the model
  has to know the API, and writes bypass any validation or confirmation.
- **Dynamic toolsets or a tool-search gateway** on the server: meta-tools that list, search or
  enable groups of tools at runtime.

Evidence that shaped the choice:

- Tool-selection accuracy drops as the number of tools grows, and every tool definition costs
  context tokens on every request
  ([RAG-MCP, arXiv:2505.03275](https://arxiv.org/abs/2505.03275);
  [Speakeasy, "Less is more"](https://www.speakeasy.com/mcp/tool-design/less-is-more)). Reports
  put the trouble zone between a few dozen and about 100 tools.
- GitHub removed the dynamic toolsets from its MCP server in May 2026
  ([github/github-mcp-server#2512](https://github.com/github/github-mcp-server/pull/2512)): the
  mode added a parallel registration path and meta-tools, and the remote server never offered it.
- MCP clients now defer and search tool definitions themselves (progressive discovery). A
  server-side gateway duplicates that work and hides tools from clients that do it better.
- MCP 2026-07-28 has no protocol-level session, and our HTTP mode is stateless
  ([ADR 0004](0004-stateless-remote-oauth.md)). "Enable a toolset, then new tools appear on this
  connection" does not fit that model.

## Decision

- **Curated, task-shaped tools.** Each tool does one bookkeeping task and carries the sevDesk
  knowledge for it: drafting an invoice fills `contactPerson` and picks the tax fields for the
  account's system version; rendering a PDF always sets `preventSendBy`; list tools page and
  aggregate on the server. Tool names follow `sevdesk_<resource>_<verb>`.
- **One tier per tool; reads and writes never share a tool** (see
  [ADR 0003](0003-tiers-and-human-confirmation.md)).
- **Toolsets** (`meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`, `banking`,
  `parts`, `reports`, `advanced`) chosen with `SEVDESK_TOOLSETS`. The default read-only set is about
  20 tools; everything enabled stays at or below 45.
- **Static registration.** The tool list is fixed for the life of a server instance and filtered
  only by toolset and tier at startup. `tools/list` returns one page in a stable order. No
  meta-tools that enable, list or search tools.
- **Reference data as lookups and resources.** Tax rules, booking accounts, units, countries and
  payment methods come from a `lookup` tool and MCP resources instead of ids in descriptions.
- **Escape hatch, read-only.** The `advanced` toolset (off by default) has a generic `api_get` for
  any GET path, with path validation, and refuses state-changing GETs. There is **no generic write
  tool**: every write goes through a curated tool with validation, dry-run and confirmation.

## Consequences

- Good: the model chooses among a small set of clearly named tools; fewer tokens per request.
- Good: safety and API knowledge live in tested code, not in prompts.
- Good: the tool surface is reviewable. A `tools/list` snapshot per tier configuration and a
  metadata lint run in CI, and PRs show the tool-surface diff.
- Bad: coverage grows only as fast as we write tools. An operation without a curated tool is
  reachable read-only through `api_get`, and not at all for writes.
- Bad: more code to maintain than a generated 1:1 mapping. Contributors can request endpoints with
  an issue form, and "add a tool in 5 steps" is documented in CONTRIBUTING.md.

## Alternatives considered

- **1:1 endpoint mapping (generated).** Rejected: too many tools for reliable selection, pushes API
  quirks onto the model, and inherits the spec's errors
  ([ADR 0002](0002-hand-written-zod-schemas.md)).
- **Generic call tool for all methods.** Rejected for writes: it bypasses validation, tiers and
  confirmation. Kept for reads as `api_get`.
- **Server-side dynamic toolsets or tool-search gateway.** Rejected: clients now do progressive
  discovery themselves, it does not fit a stateless server, and GitHub dropped the same mode.

## Update 2026-11-11: the tool-count targets are given up

The Decision says the default read-only set is "about 20 tools" and everything enabled "stays at
or below 45". Both numbers were estimates from before the first tool was written, and neither
holds: as of release 1.2.0 the server has 74 tools (37 `read`, 16 `write`, 18 `commit`, 3
`external`; [docs/tools.md](../tools.md)). The default configuration lists 31 of them, and a
server with every toolset, every tier and file transfer lists all 74. Nothing in the code or the
tests enforces a count.

The numbers are given up, not the tools, because the count follows from the other rules of this
decision and from what the server covers:

- One task and one tier per tool makes every lifecycle step of every document type its own tool:
  18 `commit` tools (finalize, book a payment, enshrine, reset, cancel, delete a draft, and book,
  mark private or reset a bank transaction) and 3 `external` ones (send by email). Fewer, broader
  tools would break that rule.
- Coverage grew: vouchers with receipt files, e-invoices, bank reconciliation, VAT and
  profit-and-loss reports, and the DATEV and CSV exports.

What limits the list a model sees is unchanged: `SEVDESK_TOOLSETS` and `SEVDESK_ALLOW` filter it
at startup, tools above the enabled tiers are not registered, 7 tools appear only where files can
be read or delivered, and clients defer tool definitions themselves (see Context). The rest of
the decision stands: curated task tools, static registration, no meta-tools, no generic write
tool.
