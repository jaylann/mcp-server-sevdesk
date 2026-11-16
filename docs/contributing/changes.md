# Making changes

How to add a tool, change a page, add a prompt, and keep a change inside the public contract. It
is for contributors who have the repository set up ([Contributing](../../CONTRIBUTING.md#setup));
how to test a change is in [Testing](testing.md).

## Before you start

Read [Architecture](../architecture.md) first: it explains the layers (tools → domain →
sevDesk client), the module map and the lifecycle of a tool call. Tools never call HTTP directly.

Hand-written zod schemas are the source of truth for sevDesk payloads, because the official
OpenAPI spec is incomplete and wrong in places. Every known deviation is listed in
[spec/deviations.md](../../spec/deviations.md) and has a test.

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
pnpm pages:watch      # the same, started again on every save (reload the tab)
pnpm pages:shots      # screenshots of every state into build/page-shots/; fails on page errors
pnpm pages:assets     # after changing a file in assets/: regenerate the embedded copy
```

Add a new state to `test/helpers/page-gallery.ts`, so the preview and the tests cover it. The
preview's `/texts` page lists every text in both languages side by side.

`pages:shots` photographs each state in both languages and both schemes at 1280 and 390 px
(`--only <name>`, `--locale`, `--scheme` and `--width` narrow it) and fails when a page logs an
error, including anything its Content-Security-Policy refused. It drives the installed Google
Chrome (`SEVDESK_CHROME=<path>` for another one); run it outside a sandboxed shell.

To try the approval flow itself, `pnpm approvals:dev` plays an assistant against recorded
fixtures: keys call the confirmed write tools, the server opens its local approval page as it does
for Claude Desktop, and you decide in the browser. `r` retries the waiting calls (approved ones
run against the fixtures), `c` changes a waiting record so the server asks again, `e`/`x` move the
clock 9 or 10 minutes, `f` fills up to the limit; `--scenario steady|burst` sends requests by
itself and `--no-open` only logs the links. It needs no token, and nothing leaves the machine.

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

From 1.0 the public surface (tool names, arguments, outputs, toolsets, tiers, prompts, variables,
commands, routes, resources, audit-log fields, the extension's setting keys) is a contract; the
full list and the deprecation policy are in [Compatibility](../compatibility.md). To stay
within it:

- Add freely: new tools, optional arguments, output fields, variables.
- To rename or remove, follow the
  [deprecation policy](../compatibility.md#deprecation-policy) and list the deprecation in the PR.
- A PR that breaks the contract anyway marks its title with `!` (`feat(invoices)!: …`) and explains
  the break in its body.
- Descriptions, result texts, error messages and logs are not part of the contract; improve them
  freely, but re-record the evals when you change what models read
  ([Tool-selection evals](testing.md#tool-selection-evals)).

### Tool surface report

The **Tool surface** PR workflow compares the event's base commit with the PR merged into that
base (GitHub's test merge commit), so a branch behind `main` shows only its own changes. One sticky
comment leads with **model-context tokens** and **response tokens**, base → head with signed Δ:

- Model context is the legacy (2025-era) Claude view: tool `name`, `description`, `input_schema`
  and the server instructions as the system prompt, as in `test/evals/tools.ts`. Watch this when
  adding tools or growing descriptions and input schemas. It is measured in four configurations:
  read, write, all toolsets/tiers (including advanced), and all over HTTP with OAuth and remote
  files.
- Response cost runs an invoice get, an invoice summary by month, and default-limit contact,
  transaction, voucher and invoice lists through the real server on **recorded fixtures**.
  `transactions_list`, `vouchers_list` and `invoices_list` each also run with `detail: "summary"`;
  `invoices_list` runs with both detail levels at `limit: 100` too. Each recorded list is expanded
  deterministically to 100 items by repeating its scrubbed row shapes with distinct ids (the
  original upstream total is discarded); default-limit calls currently return 25 rows. Tests
  assert those counts, compare full and summary responses (each summary row right after its full
  counterpart) and verify that reducing the default to 10 changes the measured cost. Both revisions
  use the same generated corpus, so this measures page-size and formatting changes, not a
  representative sample of real documents. The clock is fixed to 2026-11-13 so overdue flags
  cannot drift. A missing or failing tool or fixture route leaves only that response `n/a`; even a
  corpus setup failure keeps the tools, prompts, instructions and compatibility diff.
- The full modern `tools/list`, including output schemas, is secondary and labelled **not in
  model context for Claude clients**; it is shown in Unicode characters, not model tokens. The
  compatibility diff still covers full tools, prompts and instructions. Review names and schemas
  yourself: the report does not decide the required version bump.

Local and PR counts are labelled **estimated**: Unicode characters ÷ 2.3, rounded to whole tokens
(the ratio measured in [#61](https://github.com/jaylann/mcp-server-sevdesk/issues/61)). The
trusted publisher can upgrade the complete comparison to **exact** `messages.countTokens` counts
for `claude-opus-5-5` through Workload Identity Federation (WIF). Model-context counts subtract
the whole calibration message; response counts subtract only its framing, keeping the payload (the
calibration text `x` is one token). Model context counts the Messages API tool shape plus system
text; responses include the actual legacy text blocks, summaries and fences. Client message
envelopes, rendered prompt bodies and deferred-tool loading are outside this comparison. Missing
captures in older dumps show `n/a`, delta included, rather than zero; the publisher excludes
unknown response ids, so differing harness and publisher vocabularies do not break the report.
CI copies the current harness to the base, so a base that already supports `detail: "summary"`
captures these calls too; older tools that reject `detail` leave them `n/a`.

Capture, compare or recount locally without credentials or network access:

```bash
node --import tsx scripts/tool-surface.ts dump /tmp/head-surface.json
node --import tsx scripts/tool-surface.ts diff /tmp/base-surface.json /tmp/head-surface.json
node --import tsx scripts/tool-surface.ts report /tmp/base-surface.json /tmp/head-surface.json /tmp/pr-event.json /tmp/report.json
node scripts/tool-surface-tokens.ts /tmp/base-surface.json /tmp/head-surface.json /tmp/report.json
```

The report takes a GitHub PR event JSON (`number`, `pull_request.base.sha`,
`pull_request.head.sha`). Version 1 dumps optionally carry `modelContext` per configuration and
`responses`; reports add `tokenCost` with the method, fixed model and nullable base/head counts,
and keep `contextCost` (protocol character counts) for older consumers. Model-context
serialization preserves the client's tool/schema key order; only the protocol catalog is
canonicalized.

The workflow is path-filtered to relevant code, fixtures and workflows, and skips Dependabot. It
runs PR code without secrets or identity permissions, forks included: CI copies
`scripts/tool-surface*.ts` and the recorded corpus into the base checkout, both revisions install
their own frozen dependencies, and the `tool-surface-report` artifact holds `report.json`,
`base.json` and `head.json` for seven days (long comments link there and say when truncated).

Only the default branch's **Tool surface comment** `workflow_run` job can get credentials (the
`token-count` environment, job-level `id-token: write`, artifact-read and PR-comment permissions).
It checks out no code, installs nothing and executes no artifact contents. It verifies provenance
and the current PR commits, rejects artifact claims of exact counts, validates the tool, system
and response shapes, bounds the report at 300 KB, each capture at 20 MB and each counted context
or response at 2 million characters, and reads files through one open handle without following
symlinks; labels come only from the publisher. Only the validated tool definitions, system strings
and response texts go to the counting endpoint. Its inline script exchanges a fresh GitHub OIDC token for
`https://api.anthropic.com` (masked, in memory, no token file) at `/v1/oauth/token` for a
short-lived bearer token, then calls `/v1/messages/count_tokens` with the same counter and
calibration for base and head: native `fetch`, fixed origins, no redirects, 90 seconds at most,
and no credential or provider error is ever logged or uploaded.

Missing repository variables or any exchange or count failure publish the **entire estimated**
comparison. Exact counts replace estimates only after every available capture succeeds; a late
estimate never replaces an exact comment for the same base/head. Stale reports are skipped and diff
text is fenced. No live sevDesk account or dependency cache is used. Publisher changes only run
after landing on the default branch; inspect the PR's artifacts before then.

### Maintainer setup for exact counts

No API key secret is needed.
[Token counting is free and rate-limited](https://platform.claude.com/docs/en/build-with-claude/token-counting#pricing-and-rate-limits).
Follow the
[Anthropic GitHub Actions WIF setup](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions):

1. **Before merging**, create the GitHub environment **`token-count`**, restrict deployment
   branches to **`main`**, and set **no required reviewers**. Do not let the first run
   auto-create an unrestricted environment.
2. In Claude Console → **Workload identity → Connect workload → GitHub Actions**, set:
   - Issuer: `https://token.actions.githubusercontent.com`, using discovery.
   - Exact subject: `repo:jaylann@61842101/mcp-server-sevdesk@1449574146:environment:token-count`,
     with **no trailing `*`**.
   - Audience: `https://api.anthropic.com`.
   - Exact claims: `repository_owner: jaylann`, `repository_owner_id: 61842101`,
     `repository: jaylann/mcp-server-sevdesk`, `repository_id: 1449574146`,
     `event_name: workflow_run`, and
     `workflow_ref: jaylann/mcp-server-sevdesk/.github/workflows/tool-surface-comment.yml@refs/heads/main`.
     Use `workflow_ref` for this top-level workflow, not the reusable-workflow claim `job_workflow_ref`.
   - Target: a **new service account**, with only the dedicated workspace added explicitly and
     its lowest available spend limit. Bind the rule and exchanged token to that workspace only;
     Anthropic's implicit Default Workspace membership means membership alone is not isolation.
   - Scope: the narrowest offered (wizard default `workspace:developer`); lifetime **600 seconds**.
3. Set these four **repository variables** using the Console IDs:
   `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
   `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID`.
4. **After merge and the first relevant PR run**, confirm the actual subject, audience and all
   claim strings above in the **Console authentication history**. Verify a successful exchange
   and an **Exact** comment; an **Estimated** comment verifies fallback only. Independently
   confirm that `x` is one payload token for `claude-opus-5-5`, as assumed by `baseline - 1`.

This repository uses GitHub's
[immutable subject claims](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).
Until the federation is configured, the live exchange, the claim matching and the one-token
calibration assumption stay unverified; the first configured run from `main` checks them.
