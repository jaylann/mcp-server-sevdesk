# Contributing to mcp-server-sevdesk

Thanks for helping build the best sevDesk MCP server. This guide gets you from clone to merged PR;
the detailed pages are listed under [Where to read on](#where-to-read-on).

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
spec-derived fixtures. If you have one, see [Live tests](docs/contributing/testing.md#live-tests).

## Branches and pull requests

- Branch off `main` and open your PR against `main`.
- PRs are **squash-merged**, so the **PR title must be a
  [Conventional Commit](https://www.conventionalcommits.org/)**: `type(scope): subject` with a
  lowercase subject. Types: `feat fix chore docs refactor test perf style ci build revert`;
  breaking changes use `!` (e.g. `feat(invoices)!: …`).
- Local commits are checked by the `commit-msg` hook; staged files are linted and formatted on
  commit.
- Keep PRs focused. Add or update tests for every behavior change.
- A PR that changes the public surface (tool names, arguments, outputs, variables and the rest)
  follows the [compatibility rules](docs/contributing/changes.md#compatibility).

## Releases

Releases are automatic ([ADR 0005](docs/adr/0005-trunk-based-releases.md)). After every merge to
`main`, release-please opens or updates a release PR with the next version and the changelog,
derived from the Conventional Commit titles. Merging that PR tags the release and publishes npm,
the container image, the MCP Registry entry and the Claude Desktop extension.

The release PR is opened by the `lanfermann-release-bot` GitHub App, so CI runs on it like on any
other PR. Maintainers set this up once per repository: install the app on the repository, store
its private key as the Actions secret `RP_APP_KEY` and its App ID as the Actions variable
`RP_APP_ID`. Without them the release workflow fails when it mints the bot's token.

## Where to read on

- [Architecture](docs/architecture.md): the layers, the module map and the lifecycle of a tool
  call. Read it first.
- [Making changes](docs/contributing/changes.md): adding a tool, changing a page, adding a prompt,
  staying within the compatibility contract, and the Tool surface report on PRs.
- [Testing](docs/contributing/testing.md): the HTTP mode, the Claude Desktop extension, keychain
  and profiles, fixtures, live tests and the tool-selection evals.
- [Recording session runbook](docs/recording-session.md): checking the API on a free trial account
  and recording fixtures.
- [Compatibility](docs/compatibility.md): what 1.0 freezes and the deprecation policy.
- [Architecture decision records](docs/adr/README.md): why the bigger decisions went the way they
  did.

## Reporting bugs and security issues

Use the issue forms for bugs and feature requests. Report vulnerabilities privately, see
[Security policy](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
