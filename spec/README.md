# spec/: the upstream sevDesk OpenAPI spec, for reference

This directory holds a snapshot of the official sevDesk API description and what we know about
where it is wrong.

The separate [`mcp-registry/`](mcp-registry/README.md) directory holds the official MCP Registry
schema used to test the release's generated `server.json`, with its own provenance and license.

| File                             | What it is                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`openapi.yaml`](openapi.yaml)   | Unmodified copy of [api.sevdesk.de/openapi.yaml](https://api.sevdesk.de/openapi.yaml) (OpenAPI 3.0). Never edit it by hand. |
| [`upstream.json`](upstream.json) | Where and when the snapshot was fetched: URL, `ETag`, `Last-Modified`, SHA-256, size, and the newest API-news post seen.    |
| [`deviations.md`](deviations.md) | Register of known differences between the spec and the real API, each with an id (`D-001` …), sources and a test.           |

The spec is published by sevdesk GmbH. We keep an unmodified copy only as a reference for
interoperability. It is not part of the npm package, and formatters, linters and the spell checker
skip it.

## Not the source of truth

The source of truth for every request and response is the set of **hand-written zod schemas in
`src/sevdesk/`**, not this file. We do not generate types or clients from the spec, because the
spec is incomplete and wrong in ways that break generated code:

- Most write responses are documented without the `{objects: …}` envelope the API actually
  returns ([D-001](deviations.md#d-001-most-write-and-pdf-responses-are-wrapped-in-objects)).
- Response types, enums and `required` lists are wrong in many places
  ([D-002](deviations.md#d-002-scalars-come-back-as-strings) to
  [D-009](deviations.md#d-009-sendtype-can-be-an-empty-string-or-0)).
- Endpoints that real integrations need are missing
  ([D-024](deviations.md#d-024-undocumented-endpoints-we-rely-on)).

Clients generated from it fail to deserialize ordinary responses. The community keeps a patched
mirror for exactly this reason (see below), and the PHP SDK generated from it needed one patch
after another to read invoices, vouchers and PDFs at all
([example](https://github.com/j-mastr/sevdesk-php-sdk/issues/70)).

So the zod schemas follow observed behavior: outgoing schemas are strict, incoming schemas are
lenient and coerce types. Every place where they knowingly differ from the spec has an entry in
[`deviations.md`](deviations.md) and a test. Use the spec to look up endpoints, parameters and
field descriptions; trust `deviations.md` and the schemas where they disagree.

## Drift detection

sevDesk never changes `info.version`, so the version number cannot tell us when the spec changed.
[`scripts/check-spec-drift.ts`](../scripts/check-spec-drift.ts) watches two things instead:

1. **The spec.** It sends a conditional request with the stored `ETag` and `Last-Modified`. A
   `304 Not Modified` means no change and costs no download. On a `200` it hashes the body and
   compares it with the stored SHA-256. If the content changed, it compares the old and new
   `paths`, operations and `components.schemas` keys.
2. **API news.** It reads the RSS feed of the
   [sevDesk API news](https://tech.sevdesk.com/api_news/)
   ([`index.xml`](https://tech.sevdesk.com/api_news/index.xml)) and reports posts newer than the
   stored `latestPostDate`. Breaking changes are announced there, often months ahead, and do not
   always show up in the spec.

The scheduled workflow [`spec-drift.yml`](../.github/workflows/spec-drift.yml) runs the script
every Monday. On drift it opens an issue labelled `spec-drift` (or comments on the open one) with
a Markdown report. CI never changes `spec/` itself; a maintainer reviews and refreshes it.

Exit codes: `0` no drift, `10` drift found, `1` error. Run `--help` for the flags.

## Refreshing the snapshot

```bash
pnpm exec tsx scripts/check-spec-drift.ts                    # check only, prints a summary to stderr
pnpm exec tsx scripts/check-spec-drift.ts --report drift.md  # also write the Markdown report
pnpm exec tsx scripts/check-spec-drift.ts --update           # rewrite openapi.yaml and upstream.json
```

After `--update`:

1. Review `git diff spec/` and read any new API-news posts.
2. For every change that affects us, update the zod schemas in `src/sevdesk/`, add or update the
   entry in [`deviations.md`](deviations.md), and add a test. When upstream fixes a deviation, set
   its status to `Fixed upstream` instead of deleting it.
3. Commit `spec/` together with those changes in one PR, for example
   `chore(spec): refresh upstream snapshot`, and close the `spec-drift` issue.

Behind an HTTP proxy, Node's `fetch` ignores `HTTPS_PROXY` unless you set `NODE_USE_ENV_PROXY=1`.

## Community cross-reference

[j-mastr/sevdesk-api](https://github.com/j-mastr/sevdesk-api) is a community-maintained, patched
copy of this spec (it backs [j-mastr/sevdesk-php-sdk](https://github.com/j-mastr/sevdesk-php-sdk)).
Its pull requests and issues document many real response shapes, and several entries in
`deviations.md` cite them. Use it as a second opinion, not as a source of truth: it is maintained
by volunteers and can lag behind upstream too.
