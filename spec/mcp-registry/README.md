# MCP Registry schema

`server.schema.json` is the official JSON Schema draft-07 file referenced by the root
`server.json`, downloaded on 2026-11-12 from:

<https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json>

The original download's SHA-256 is
`3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0`.
Only JSON formatting may differ. This is a Registry schema snapshot, not a sevDesk API response.
The upstream [MCP Registry](https://github.com/modelcontextprotocol/registry) license and its
licensing-transition notice are copied verbatim in `LICENSE` in this directory.

`test/unit/scripts/prepare-registry.test.ts` uses this snapshot to validate the generated
`server.json` without network access. Its `$id` must match the template's `$schema`; when that
changes, fetch the new schema, update this provenance and review the validation changes.

The official [MCPB package requirements](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx#mcpb-packages)
also require `fileSha256`, although the schema only checks its format when present. Tests therefore
assert the exact generated entry, including a known SHA-256 test vector, as well as schema validity.
