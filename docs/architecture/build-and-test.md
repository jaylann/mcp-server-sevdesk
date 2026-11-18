# Builds and tests

The three forms the server ships in, and the layers of tests that keep it correct without a shared
sevDesk account. It is for contributors; how to run each kind of test is in
[Testing](../contributing/testing.md).

## Builds

The same source ships in three forms; no code path is specific to one of them.

- **npm** (`tsdown.config.ts` → `dist/`): the package `mcp-server-sevdesk`, dependencies installed
  by npm. `npx -y mcp-server-sevdesk` runs it over stdio.
- **Container image** (`Dockerfile`): `dist/` with production dependencies on distroless Node.js,
  `--http` by default, `--stdio` on request.
- **Claude Desktop extension** (`pnpm mcpb`: `tsdown.mcpb.config.ts`, `scripts/build-mcpb.ts`):
  everything bundled into one file, `server/index.mjs`, that imports only Node.js built-ins, plus
  `mcpb/manifest.json`, the icon, the license and the notices of every bundled package and of the
  embedded fonts. The manifest maps Claude Desktop's settings to the same `SEVDESK_*` variables,
  its tool list is generated from the tool definitions, and every optional setting has a default,
  because Claude Desktop would pass an empty one as the literal `${user_config.…}`. The build
  validates and packs the bundle, then starts the unpacked server the way Claude Desktop does. CI
  builds it on every pull request; a release attaches it to the GitHub release with a provenance
  attestation.

All three carry the pages' fonts and icon inside the JavaScript (`src/pages/assets.generated.ts`,
written by `pnpm pages:assets` from `assets/`), the pages' stylesheet
(`src/pages/styles.generated.ts`, compiled by `pnpm pages:css` from `src/pages/pages.css` and
`@lanfermann/ui`; for both, a test fails when they drift apart from their sources) and the
licence texts of the fonts and icons (`licenses/`).

## Testing

There is no shared paid test account, so most tests run against fixtures. Each fixture records its
provenance (`spec`, `community` or `recorded`, plus date and system version).

1. **Unit:** envelope and coercion, dates, money, tiers, redaction, fencing, the confirmation
   codec, ReceiptGuidance validator, e-invoice parser (official KoSIT samples plus an attack
   corpus) and reconciliation matcher.
2. **Contract:** domain functions against fixtures served by an in-memory fake client
   (`test/helpers/fake-client.ts`) or a scripted fake `fetch` (`test/helpers/fake-fetch.ts`). Each
   open entry in the deviations register has a test.
3. **Regressions:** one test per known trap (for example `preventSendBy`, top-level `filename` on
   vouchers, no write retries, the silent 100-record limit, the expense sign).
4. **MCP integration:** in-process calls through the real server: a `tools/list` snapshot per tier
   configuration, every tool against fixtures, and a metadata lint (explicit annotations, unique
   names, description length, object-root schemas, output matching its schema).
5. **HTTP mode** (`test/unit/http/`, `test/integration/http-*.test.ts`): every startup refusal;
   the bridge, router and hardening on a real socket (Host and Origin refusals, 413, 429, 503,
   aborts, streaming); bearer and OAuth end to end with the real SDK client (CIMD, PKCE, `iss`,
   refresh rotation and replay, revocation); threat tests for sealed tokens, redirect matching,
   CIMD SSRF, CSRF and cookies; two accounts through one server that never share caches,
   approvals or confirmation state; captured logs and responses that never contain a secret. CI
   also builds the image and runs the HTTP smoke test in a read-only container.
6. **Pages** (`test/unit/pages/`): every page in every state and both languages is rendered from
   one set of fixtures (`test/helpers/page-gallery.ts`) and checked against what its policy would
   block (no script, no inline style, nothing loaded from outside `/assets/`), for labelled fields
   and CSRF-protected forms, and for speaking one language; the colour tokens are checked for
   contrast (WCAG AA) in light and dark. `pnpm pages:preview` serves the same fixtures under the
   real headers for a look in a browser, with all texts in both languages side by side.
   `test/integration/write-previews-de.test.ts` holds the German preview of every confirmed tool
   against the English one and snapshots its wording.
7. **Package smoke:** `npm pack`, install the tarball, run the binary, complete the MCP handshake on
   Linux, macOS and Windows with Node 22 and 24.
8. **Live tests:** opt-in, run by hand with a real token (`pnpm test:live`), read-only unless a
   trial account runs the lifecycle scenario ([Recording session runbook](../recording-session.md)).
9. **Tool-selection evals** (`test/evals/`, `pnpm evals`): about 70 German and English requests,
   scored on the tools the model picks in its first answer; model answers are recorded once and
   replayed, and `.github/workflows/evals.yml` runs them on PRs that touch tools (informative, not
   required).

Upstream changes are watched separately: a weekly job compares the spec and the API-news feed with
the stored snapshot and opens an issue on drift ([spec/README.md](../../spec/README.md)).
