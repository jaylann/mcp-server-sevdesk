# ADR 0005: Trunk-based development and automated releases

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The maintainer's other projects use two long-lived branches: work lands on `stage`, and `stage` is
promoted to `main` for releases. This project is open source and expects external contributors:

- Forks and pull requests target the default branch. A second integration branch is one more thing
  for contributors to get wrong.
- [release-please](https://github.com/googleapis/release-please) works from a single release
  branch and derives versions and the changelog from Conventional Commits.
- npm trusted publishing (OIDC, no long-lived `NPM_TOKEN`) and the MCP Registry publisher are tied
  to a specific workflow on a specific branch.

## Decision

- **One long-lived branch, `main`.** All PRs target it. A ruleset requires a PR and passing
  checks, allows squash merges only, keeps history linear, forbids force pushes and protects tags.
- **PR titles are Conventional Commits**, checked in CI. With squash merges the PR title becomes the
  commit message on `main`.
- **release-please** keeps a release PR open with the next version and changelog. Merging it tags
  the release and triggers publishing:
  - npm with provenance through trusted publishing (the very first version is published by hand,
    then the trusted publisher is configured);
  - the MCP Registry entry through `mcp-publisher` with GitHub OIDC;
  - the `.mcpb` bundle as a release asset;
  - the multi-arch GHCR image with a build-provenance attestation and an SBOM.
- **The MCPB registry entry is generated at publication time** (added 2026-11-12).
  `publish-registry` waits for the bundle upload, downloads the public asset and adds its URL and
  SHA-256 to the npm/OCI `server.json` template with `scripts/prepare-registry.ts`. Its embedded
  manifest must match the release identity and version. A future bundle's checksum is not known
  when release-please updates versions, so the source template never carries a placeholder or a
  stale hash. Tests validate the generated document against the pinned official Registry schema.
- **The release PR is opened by a GitHub App** (`lanfermann-release-bot`, added 2026-11-12), not
  by `GITHUB_TOKEN`. GitHub runs no workflows on PRs opened with `GITHUB_TOKEN`, so the required
  checks would never start on the release PR. The app's token can open PRs, push branches and
  create tags and releases; publishing still runs only on OIDC.
- **0.x releases from the first milestone on**, so people can try the server early; 1.0.0 at launch.

## Consequences

- Good: contributors only need to know "branch off `main`, open a PR".
- Good: every merge to `main` is releasable; versions and changelog are automatic.
- Good: no publish secrets in the repository; releases carry provenance. The one release secret,
  the app's private key, cannot publish anything.
- Bad: no staging branch where changes collect before a release. The release PR is the batching
  point, and the CI gate (lint, types, tests with coverage, package smoke on three OSes) has to be
  strong enough to keep `main` releasable.
- Bad: it differs from the maintainer's other repositories.

## Alternatives considered

- **`stage` → `main` promotion.** Rejected for this repository: it confuses fork-based contributors
  and fights release-please's single-branch model.
- **GitFlow.** Rejected: too much process for one package.
- **changesets or semantic-release.** Rejected: changesets needs a file per PR from contributors;
  semantic-release publishes on every merge without a reviewable release PR.
- **Manual tags and `NPM_TOKEN`.** Rejected: error-prone, and a long-lived publish token is a
  supply-chain risk.
