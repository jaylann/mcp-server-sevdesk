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

## Releases

Releases are automatic ([ADR 0005](docs/adr/0005-trunk-based-releases.md)). After every merge to
`main`, release-please opens or updates a release PR with the next version and the changelog,
derived from the Conventional Commit titles. Merging that PR tags the release and publishes npm,
the container image, the MCP Registry entry and the Claude Desktop extension.

The release PR is opened by the `lanfermann-release-bot` GitHub App, so CI runs on it like on any
other PR. Maintainers set this up once per repository: install the app on the repository, store
its private key as the Actions secret `RP_APP_KEY` and its App ID as the Actions variable
`RP_APP_ID`. Without them the release workflow fails when it mints the bot's token.

## Architecture in one minute

Read [docs/architecture.md](docs/architecture.md) first. The short version:

- `src/sevdesk/` talks HTTP to sevDesk (auth, pacing, envelope unwrapping, errors).
- `src/domain/` holds normalized types, money/date handling and business rules.
- `src/tools/<toolset>/` defines MCP tools with `defineTool`. Tools never call HTTP directly.
- `src/safety/` holds tiers, confirmations, dry-run, audit log, redaction, the OS keychain and
  the file access tools use for local folders and remote uploads.
- `src/prompts/` holds the MCP prompts, rendered from the registered tools.
- `src/http/` (with `oauth/`) and `src/accounts/` hold the HTTP mode: hardening, bearer and
  OAuth, the approval inbox, and the per-account contexts the tools run with. Tools never see
  them; they get a `Config` and a client as over stdio.

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
   A `commit` or `external` tool writes its confirmation preview in English and in German,
   because a human reads it on the approval page: build both from the same data with
   `bothPreviews` (`src/domain/preview-text.ts`; the tool does not compile without the German
   one). Keep the same facts and warnings in the same order, and use sevDesk's own German terms
   (Rechnung, Beleg, festschreiben).
4. Add fixtures and tests: happy path, error paths, and tier gating. Update the `tools/list`
   snapshot (`pnpm test -u`) and review the diff. For a tool with a German preview, add a case
   to `test/write-cases/` and read its German text in the snapshot of
   `test/integration/write-previews-de.test.ts`.
5. Regenerate the tool reference with `pnpm docs:tools` and commit `docs/tools.md` (a test fails
   when it is stale).

New tools appear in the Claude Desktop extension's manifest by themselves; the build generates its
tool list.

## Changing a page

The pages a human sees (approval, inbox, sign-in, consent, upload) share `src/pages/`: the
`markup` template tag escapes every value, the texts live in `src/pages/text/en.ts` and `de.ts`,
and one stylesheet (`theme.ts`) styles them all. There is no script, no `style=""` attribute and
nothing loaded from outside `/assets/`; a test renders every page in every state and both
languages and fails on any of these.

```bash
pnpm pages:preview    # http://127.0.0.1:4173: every page state, en/de, light/dark, real headers
pnpm pages:assets     # after changing a file in assets/: regenerate the embedded copy
```

Add a new state to `test/helpers/page-gallery.ts`, so the preview and the tests cover it. The
preview's `/texts` page lists every text in both languages side by side.

## Adding a prompt

Prompts are bookkeeping workflows the user picks in the client. They render text only and never
call sevDesk.

1. Add the prompt to `src/prompts/catalog.ts` with `definePrompt`: a snake_case `name` without a
   `sevdesk_` prefix (clients namespace prompts per server), title, description, the tools it
   `requires` to be listed, and its steps. Keep it in line with the matching workflow in
   `plugin/skills/sevdesk-bookkeeping/references/workflows.md`.
2. Each step lists every tool its text names (in backticks) in `tools`; the step is shown only
   when all of them are registered. Give a `fallback` (what is skipped, naming no tool) when the
   user should learn that a setting would enable the step; the renderer adds which one.
3. Arguments are optional strings with a pattern or length check. Show a raw argument only
   through `fenceInline`, never in the trusted text.
4. Run `test/unit/prompts/` and `test/integration/prompts-list.test.ts`: the lint renders every
   prompt in many configurations and fails when a step names a tool that configuration does not
   register. Update the `prompts/list` snapshot
   (`pnpm test test/integration/prompts-list.test.ts -u`) and review the diff, then
   `pnpm docs:tools`.

## Compatibility

From 1.0 the tool names, arguments, output fields, toolsets, tiers, prompts, environment
variables, commands, routes, resource URIs, audit-log fields and the extension's setting keys are
a public contract ([docs/compatibility.md](docs/compatibility.md)).

- Adding is fine: new tools, optional arguments, output fields, variables.
- Renaming or removing needs a deprecation first: keep the old name working next to the new one,
  mark it `Deprecated: use … instead.` in its description, and list it in the PR. Removal happens
  in the next major release.
- A PR that breaks the contract anyway marks its title with `!` (`feat(invoices)!: …`) and explains
  the break in its body.
- Descriptions, result texts, error messages and logs are not part of the contract; improve them
  freely, but re-record the evals when you change what models read (below).

## HTTP mode

The remote mode (`--http`) is documented for operators in [docs/remote.md](docs/remote.md). To run
it locally in bearer mode against a trial account:

```bash
pnpm build
export SEVDESK_HTTP_AUTH=bearer
export SEVDESK_HTTP_BEARER_TOKEN="$(node dist/index.js generate-secret)"
export SEVDESK_API_TOKEN_FILE=~/.config/sevdesk-trial.token
node dist/index.js --http      # or from source: pnpm dev --http
```

It listens on `http://127.0.0.1:8080/mcp` (`SEVDESK_HTTP_PORT` changes the port). Connect a client
with the bearer header, for example Claude Code:

```bash
claude mcp add --transport http sevdesk-dev http://127.0.0.1:8080/mcp \
  --header "Authorization: Bearer $SEVDESK_HTTP_BEARER_TOKEN"
```

Pass the flag as `pnpm dev --http`, not `pnpm dev -- --http`: pnpm hands the `--` on to the
server, which refuses unknown arguments. Plain http on loopback is for development only: browsers
share cookies across the ports of a host, so another local web server could receive the approval
inbox's session cookie. Try the inbox in a browser profile you use for nothing else.

OAuth mode works locally too, with a loopback public URL
(`SEVDESK_HTTP_PUBLIC_URL=http://localhost:8080`, `SEVDESK_HTTP_SECRET`, `SEVDESK_OAUTH_ACCOUNTS`);
claude.ai cannot reach it, so the end-to-end check with claude.ai runs through a tunnel
([docs/recording-session.md](docs/recording-session.md#3b-m5-remote-check-about-60-to-90-minutes)).

- **HTTP smoke test:** `pnpm build && node scripts/smoke-http.ts --bin dist/index.js` starts the
  built server in bearer mode on a free port (with a dummy sevDesk token, so nothing reaches
  sevDesk) and checks the health endpoint, the 401s, the Host and Origin refusals, the MCP
  handshake on both protocol eras and a clean shutdown. Against a running server, with
  `SEVDESK_HTTP_BEARER_TOKEN` exported (the script reads the token from the environment only, so
  it never shows up in the process list): `node scripts/smoke-http.ts --url http://127.0.0.1:8080`.
- **The image:** `docker build -t mcp-server-sevdesk:dev .`, then run it read-only as in the
  [Docker quick start](docs/remote.md#quick-start-bearer-mode-with-docker) and point the smoke
  test at it with `--url`. CI does the same in its `docker` job.
- **Tests:** unit tests in `test/unit/http/` (OAuth in `test/unit/http/oauth/`), integration tests
  on a real socket in `test/integration/http-*.test.ts` (bearer, OAuth with the real SDK client,
  the full flow through the approval inbox) and `test/integration/cross-account.test.ts`; helpers
  for the consent and inbox pages in `test/helpers/`. Every module with secrets has a test with a
  captured logger or response that asserts no secret appears; keep it that way.

## The Claude Desktop extension

`pnpm mcpb` builds the `.mcpb` bundle into `build/`: it bundles the server with all its
dependencies into one file (`tsdown.mcpb.config.ts`), generates the manifest's tool list, writes
the license notices of every bundled package, validates and packs the bundle with the `mcpb`
library, and then starts the unpacked server the way Claude Desktop does. The CI job `mcpb` runs
it on every pull request and uploads the bundle as an artifact; the release job `publish-mcpb`
attaches it to the GitHub release with a provenance attestation.

The checked-in `server.json` is the npm/OCI template. `publish-registry` waits for `publish-mcpb`,
downloads the public release bundle, and runs `scripts/prepare-registry.ts` with plain Node to add
its MCPB URL and SHA-256 to the `server.json` it publishes. It checks the bundle's name and manifest
version before writing; no dependency install runs in that privileged job. The MCPB entry is
generated at publication time because release-please cannot know the hash of a future asset.
The generator's tests validate against the official schema pinned by `server.json` (snapshot and
provenance in `spec/mcp-registry/`). To dry-run the same preparation after `pnpm mcpb`:

```bash
version="$(node -p 'require("./package.json").version')"
node scripts/prepare-registry.ts "$version" "v$version" \
  "build/mcp-server-sevdesk-$version.mcpb" build/registry/server.json
```

Change the extension's settings only in `mcpb/manifest.json`. Keep its `JSON.stringify` layout
(release-please rewrites the file when it bumps the version, so Prettier ignores it), and give
every optional setting a default: Claude Desktop passes an empty setting without one as the
literal `${user_config.…}`, and the build refuses such a manifest. The setting keys are part of the
[compatibility](#compatibility) contract, because Claude Desktop stores the user's values under
them. To try a build, open `build/mcp-server-sevdesk-<version>.mcpb` in Claude Desktop.

## Keychain and profiles

The keychain code (`src/safety/keychain.ts`) takes an injected `spawn`, so tests never run
`security`, `secret-tool` or Windows PowerShell; the profile code takes an injected platform,
user id and home folder. A real round trip is a manual check: `token set`, `token check`, a
server start with `SEVDESK_API_TOKEN_KEYCHAIN` set to a throwaway label, then `token delete`.

On Windows, from a clean PowerShell session in the repository (use a new throwaway label and
paste the token only at the hidden prompt):

```powershell
pnpm build
node dist/index.js token set windows-check-11
node dist/index.js token check windows-check-11
$env:SEVDESK_API_TOKEN_KEYCHAIN = 'windows-check-11'
node dist/index.js --stdio
# After the startup message, stop the server with Ctrl+C, then:
Remove-Item Env:SEVDESK_API_TOKEN_KEYCHAIN
node dist/index.js token delete windows-check-11
node dist/index.js token check windows-check-11 # must report no stored token
```

Repeat `token set` before deletion to check replacement, and confirm no token appears in the
output or PowerShell process arguments. `PasswordVault` requires Windows PowerShell's
`FullLanguage` mode; Constrained Language Mode must give a safe refusal, never bypass the policy
([ADR 0009](docs/adr/0009-local-profiles-and-os-keychain.md)).

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

## Tool-selection evals

`test/evals/` checks which tool a model picks first for about 70 German and English requests.
`pnpm evals` replays recorded model answers (no API key, no cost); cases without a recording are
skipped as "stale cassette". A cassette is keyed on the whole request, which contains every tool
of its configuration: changing any tool's name, description or schema, or the server
instructions, stales every case of that configuration. Re-record with
`ANTHROPIC_API_KEY=… pnpm evals:record` (about $1–2 per full run) and commit the cassettes; when
you rename a tool, also update the expected tool names in `test/evals/cases.ts`. On pull requests that touch tools, `.github/workflows/evals.yml` replays them and, for
branches of this repository with the `evals` environment configured, records fresh answers. The
evals are informative, not a required check. Details: [test/evals/README.md](test/evals/README.md).

## Reporting bugs and security issues

Use the issue forms for bugs and feature requests. Report vulnerabilities privately, see
[SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
