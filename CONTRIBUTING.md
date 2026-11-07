# Contributing to mcp-server-sevdesk

Thanks for helping build the best sevDesk MCP server. This guide gets you from clone to merged PR.

## Setup

Requirements: Node 24 (see `.nvmrc`; Node ≥ 22.12 works) and pnpm via corepack.

```bash
corepack enable
pnpm install        # also wires the git hooks (core.hooksPath = githooks)
pnpm check          # everything CI runs: lint, format, typecheck, tests + coverage, knip, build, publint
```

Useful scripts: `pnpm test:watch`, `pnpm dev` (run the server from source over stdio),
`pnpm inspect` (open the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) against
the built server).

You do **not** need a sevDesk account to contribute: the test suite runs against recorded and
spec-derived fixtures. If you have one, see [Live tests](#live-tests).

## Branches and pull requests

- Branch off `main` and open your PR against `main`.
- PRs are **squash-merged**, so the **PR title must be a
  [Conventional Commit](https://www.conventionalcommits.org/)**: `type(scope): subject` with a
  lowercase subject. Types: `feat fix chore docs refactor test perf style ci build revert`;
  breaking changes use `!` (e.g. `feat(invoices)!: …`).
- Local commits are checked by the `commit-msg` hook; staged files are linted and formatted on
  commit.
- Keep PRs focused. Add or update tests for every behavior change.

## Architecture in one minute

Read [docs/architecture.md](docs/architecture.md) first. The short version:

- `src/sevdesk/` talks HTTP to sevDesk (auth, pacing, envelope unwrapping, errors).
- `src/domain/` holds normalized types, money/date handling and business rules.
- `src/tools/<toolset>/` defines MCP tools with `defineTool`. Tools never call HTTP directly.
- `src/safety/` holds tiers, confirmations, dry-run, audit log and redaction.

Hand-written zod schemas are the source of truth for sevDesk payloads, because the official
OpenAPI spec is incomplete and wrong in places. Every known deviation is listed in
[spec/deviations.md](spec/deviations.md) and has a test.

## Adding a tool

1. Pick the toolset (`src/tools/<toolset>/`) and the **tier**: `read`, `write` (reversible),
   `commit` (legally binding or irreversible) or `external` (reaches third parties). When in doubt,
   pick the higher tier.
2. Define it with `defineTool`: name, title, description (mention German terms such as Rechnung,
   Beleg), input/output zod schemas, and **all four annotations** (`readOnlyHint`,
   `destructiveHint`, `idempotentHint`, `openWorldHint`). The metadata lint test fails otherwise.
3. Implement the handler through the domain layer. Return compact DTOs, never raw sevDesk payloads.
4. Add fixtures and tests: happy path, error paths, and tier gating. Update the `tools/list`
   snapshot (`pnpm test -u`) and review the diff.
5. Regenerate the tool reference with `pnpm docs:tools` and commit `docs/tools.md` (a test fails
   when it is stale).

## Fixtures

Fixtures live in `test/fixtures/` and record their provenance (`spec`, `community` or `recorded`,
plus date and bookkeeping system version). Recorded fixtures must be scrubbed of personal data and
tokens before committing; the recorder does this, but review the diff anyway.

## Live tests

sevDesk has no sandbox: every write is real, and finalized documents cannot be deleted. The live
tooling therefore reads only a short list of variables (`SEVDESK_API_TOKEN` or
`SEVDESK_API_TOKEN_FILE`, `SEVDESK_BASE_URL`, `SEVDESK_RATE_LIMIT`, `SEVDESK_TIMEOUT_MS`) and
ignores tier switches from your shell.

- `pnpm test:live` calls every read tool through the real server against your account, in
  read-only mode (the HTTP client refuses any data-changing request), and checks that each answers
  without an error and with schema-valid output. Without a token every test is skipped with the
  reason. It runs from its own config (`vitest.live.config.ts`) and never in `pnpm test`.
- `SEVDESK_LIVE_LIFECYCLE=1 SEVDESK_LIVE_I_UNDERSTAND_WRITES=1 pnpm test:live` adds a write
  scenario through the write tools (contact, draft, finalize, payments, reminder, cancellation,
  credit note). **Trial accounts only**: it refuses accounts that already hold many records,
  e-mails nothing unless `SEVDESK_LIVE_EMAIL_TO` names your own address, tags what it creates
  (`MCP-E2E <run id>`) and prints a cleanup list.
- `pnpm probe --out report.md` checks the open questions of `spec/deviations.md` against the API
  and reports each finding with scrubbed evidence; `--allow-writes` (plus
  `SEVDESK_LIVE_I_UNDERSTAND_WRITES=1`) adds probes that create their own tagged test data;
  `--probe-email <your address>` adds one e-mail probe to that address only.
  `pnpm probe --list` shows every probe.
- `pnpm fixtures:record` records scrubbed read responses as fixtures (read-only;
  `--dry-run` lists the requests).

The step-by-step runbook for a recording session on a free trial account, including what to commit
and what never to commit, is [docs/recording-session.md](docs/recording-session.md). The manual
workflow `Live E2E` runs `pnpm test:live` in CI behind the protected `live` environment.

## Reporting bugs and security issues

Use the issue forms for bugs and feature requests. Report vulnerabilities privately, see
[SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
