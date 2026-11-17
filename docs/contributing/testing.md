# Testing

How to try a change beyond `pnpm check`: the HTTP mode, the Claude Desktop extension, the
keychain, fixtures, live tests against a trial account and the tool-selection evals. It is for
contributors; what each test layer covers is in
[Builds and tests](../architecture/build-and-test.md#testing).

## HTTP mode

The remote mode (`--http`) is documented for operators in [Remote mode](../remote.md). To run it
locally in bearer mode against a trial account:

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
([Remote check](../recording-session/remote-check.md)).

- **HTTP smoke test:** `pnpm build && node scripts/smoke-http.ts --bin dist/index.js` starts the
  built server in bearer mode on a free port (with a dummy sevDesk token, so nothing reaches
  sevDesk) and checks the health endpoint, the 401s, the Host and Origin refusals, the MCP
  handshake on both protocol eras and a clean shutdown. Against a running server, with
  `SEVDESK_HTTP_BEARER_TOKEN` exported (the script reads the token from the environment only, so
  it never shows up in the process list): `node scripts/smoke-http.ts --url http://127.0.0.1:8080`.
- **The image:** `docker build -t mcp-server-sevdesk:dev .`, then run it read-only as in the
  [Docker quick start](../remote.md#quick-start-bearer-mode-with-docker) and point the smoke test
  at it with `--url`. CI does the same in its `docker` job.
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
generated at publication time because release-please cannot know the hash of a future asset. The
same step moves the icon URL from `main` to the release tag: the checked-in URL has to resolve
before the tag exists, the published one keeps the icon of that release.
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
[compatibility](changes.md#compatibility) contract, because Claude Desktop stores the user's values
under them. To try a build, open `build/mcp-server-sevdesk-<version>.mcpb` in Claude Desktop.

## Keychain and profiles

The keychain code (`src/safety/keychain.ts`) takes an injected `spawn`, so tests never run
`security`, `secret-tool` or Windows PowerShell; the profile code takes an injected platform,
user id and home folder. A real round trip is a manual check: `token set`, `token check`, a
server start with `SEVDESK_API_TOKEN_KEYCHAIN` set to a throwaway label, then `token delete`
(the commands are described in [Profiles and keychain](../configuration/profiles.md)).

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
([ADR 0009](../adr/0009-local-profiles-and-os-keychain.md)).

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
and what never to commit, is the [Recording session runbook](../recording-session.md). The manual
workflow `Live E2E` runs `pnpm test:live` in CI behind the protected `live` environment.

## Tool-selection evals

`test/evals/` checks which tool a model picks first for about 70 German and English requests.
`pnpm evals` replays recorded model answers (no API key, no cost); cases without a recording are
skipped as "stale cassette". A cassette is keyed on the whole request, which contains every tool
of its configuration: changing any tool's name, description or schema, or the server
instructions, stales every case of that configuration. Re-record with
`ANTHROPIC_API_KEY=… pnpm evals:record` (about $1–2 per full run) and commit the cassettes; when
you rename a tool, also update the expected tool names in `test/evals/cases.ts`. On pull requests
that touch tools, `.github/workflows/evals.yml` only replays them, without secrets or cost.
Recording is a local step, run before a release or after description changes, never in CI. The
evals are informative, not a required check. Details:
[test/evals/README.md](../../test/evals/README.md).
