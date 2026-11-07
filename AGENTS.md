# AGENTS.md — guidance for AI coding agents

This file is for AI agents (Claude Code, Codex, Cursor, …) working in this repository. Human
contributors: see [CONTRIBUTING.md](CONTRIBUTING.md); everything there applies to agents too.

## Project

`mcp-server-sevdesk`: a TypeScript MCP server (`@modelcontextprotocol/server` v2, spec 2026-07-28)
for the sevDesk accounting API. Safety-first: tiered permissions, human confirmation for binding
actions, no side effects on reads. Architecture: [docs/architecture.md](docs/architecture.md).
Decisions: [docs/adr/](docs/adr/).

## Commands

- `pnpm check`: the full gate (lint, format, typecheck, tests + coverage, knip, build, publint).
  Run it before declaring work done.
- `pnpm test` / `pnpm test -u` (update snapshots; review the diff).
- `pnpm dev`: run from source over stdio. Never print to stdout outside the transport.

## Rules

- **Layering:** `tools/` → `domain/` → `sevdesk/`. Tools never call `fetch` or the client
  directly.
- **Schemas:** hand-written zod schemas are the source of truth; the OpenAPI spec in `spec/` is a
  reference only. Every deviation from the spec goes into `spec/deviations.md` with a test.
- **Every tool** declares its tier and all four annotations explicitly. Reads and writes never
  share a tool. A `confirm: true` argument is never a safety gate.
- **sevDesk traps** (each has a regression test in `test/regressions/`): call `getPdf` only with
  `preventSendBy=true`; never retry POST/PUT; always send an explicit `limit` (1–1000);
  `saveVoucher` takes `filename` at the top level; update 2.0 needs `taxRule` + `accountDatev`;
  `0` is a value, not "missing".
- **Money** uses the domain money type (decimal-safe), never float arithmetic. Dates go through
  the per-endpoint serializers.
- **Untrusted text** from sevDesk is fenced in output and never interpolated into error messages
  or instructions.
- **Secrets:** never log or echo the sevDesk token; use the redaction helpers.
- Commits and PR titles are Conventional Commits. Do not commit, push or publish unless asked.
