# Supply chain

How releases are built and published, and how to check that the npm package, the container image
or the Claude Desktop extension you run came from this repository's release workflow. Read it
before you pin a version for production or install a downloaded extension.

## Releases and the repository

Releases are published from CI with npm provenance (trusted publishing, no long-lived tokens),
GitHub Actions are pinned by commit SHA, and the repository is scanned by CodeQL, dependency
review and OpenSSF Scorecard.

## The container image

The container image `ghcr.io/jaylann/mcp-server-sevdesk` is built by the release workflow from base
images pinned by digest. It runs as a non-root user (uid 65532) on a distroless Node.js base, and
each release carries a build-provenance attestation and BuildKit's SBOM and provenance. Verify an
image before you run it, then pin the digest you verified; the commands are in
[Deployment](../remote/deployment.md#verifying-the-image).

## The Claude Desktop extension

The Claude Desktop extension (`mcp-server-sevdesk-<version>.mcpb`) is built by the release workflow
too. Each new GitHub release attaches the extension and attempts to attach two files from its
build-provenance attestation:

- `<asset>.sigstore.json`: the complete Sigstore bundle, including the signature, certificate and
  transparency-log verification material.
- `<asset>.intoto.jsonl`: the signed DSSE envelope as one JSON line, containing the in-toto
  provenance statement. This is not a complete Sigstore bundle; use `.sigstore.json` with `gh`.

The companion-file upload retries once. If the attachment step still fails, the workflow emits a
warning and allows MCP Registry publication to continue. Either companion file may be missing
until a maintainer backfills it; the attestation in GitHub's store remains available.

Verify the downloaded extension against GitHub's attestation store:

```bash
gh attestation verify mcp-server-sevdesk-<version>.mcpb --owner jaylann
```

Or download the matching `.sigstore.json` release asset and verify using that bundle:

```bash
gh attestation verify mcp-server-sevdesk-<version>.mcpb \
  --bundle mcp-server-sevdesk-<version>.mcpb.sigstore.json --owner jaylann
```

Both commands check the artifact's digest, signature and signer identity. The `--bundle` form uses
the local attestation; `gh` may still fetch Sigstore trust roots. See the
[GitHub CLI verification reference](https://cli.github.com/manual/gh_attestation_verify) for
verification policies and offline trust roots.

## Backfilling attestation files

Maintainers use `node scripts/attach-release-attestation.ts [--dry-run] <tag> <asset> [bundle]`
for the release job and backfills. It requires a SLSA provenance statement and checks the subject
SHA-256 before writing or uploading either file. A supplied bundle is preserved unchanged;
otherwise it fetches by digest, filters for SLSA v1 provenance and requires exactly one attestation
across all API pages. `--dry-run` writes both files beside the asset and prints the intended upload
without changing the release. The script checks digest consistency; use `gh attestation verify`
for cryptographic verification before a backfill.
