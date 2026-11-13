# Tool-selection evals

Does a model that sees this server's tools pick the right one? Each case is a user request in
German or English plus a server configuration. The eval builds the tool list and the server
instructions exactly as a client gets them for that configuration, sends the request to a model
once, and scores the tool calls of its **first answer**. The evals are opt-in and never part of
`pnpm test`.

## Run

```bash
pnpm evals                                # replay recorded answers; never calls a model
ANTHROPIC_API_KEY=sk-ant-… pnpm evals:record   # record answers that are missing or stale
```

On Windows PowerShell: `$env:ANTHROPIC_API_KEY = "sk-ant-…"; pnpm evals:record`.

| Variable            | Default             | Meaning                                                                                 |
| ------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `EVALS_MODE`        | `replay`            | `replay` or `record` (`pnpm evals:record` sets `record`).                               |
| `EVAL_MODEL`        | `claude-sonnet-5-5` | Model to evaluate. Each model has its own cassettes.                                    |
| `EVAL_EFFORT`       | model default       | `low` … `max` (`output_config.effort`). Part of the request, so changing it re-records. |
| `EVALS_MIN_SCORE`   | `0.8`               | The summary test fails when the mean score of the cases that ran is lower.              |
| `ANTHROPIC_API_KEY` |                     | Needed only for recording; without it, cases that need a new recording fail.            |

## How it works

| File                | Role                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `cases.ts`          | The cases: `{id, lang, toolset, kind, env, prompt, expected, secondChoice?, absent?, notes}`.         |
| `tools.ts`          | `clientView(env)`: `loadConfig` → in-process MCP client → `tools/list` and `instructions` (2025 era). |
| `model.ts`          | The single Messages API request per case and the call that records it.                                |
| `cassette.ts`       | Record/replay. Key: SHA-256 of the whole request (model, system, tools, messages, parameters).        |
| `scoring.ts`        | First-answer score and the Markdown summary.                                                          |
| `selection.eval.ts` | The `describeEval` suite (vitest-evals) with the `FirstAnswerJudge`, plus the summary test.           |

The system prompt is the server's generated `instructions`; the tools are the advertised names,
descriptions and input schemas. `tool_choice` is `auto`, so answering without a tool is possible
(and right for negative cases). The fake token and stub client mean nothing reaches sevDesk.

Cassettes live in `cassettes/<model>/<case id>.json` (pretty JSON): the request key, the time of
recording, and the answer's text and `tool_use` blocks, stop reason and token usage. Thinking
blocks are not kept.

- **Current**: the stored key equals the key of today's request → the answer is replayed.
- **Stale**: a tool description or schema, the instructions, the prompt, the model or a
  parameter changed since → the case is **skipped** with "stale cassette" (in replay mode) or
  re-recorded (in record mode). A case that was never recorded is skipped the same way.

Stale cassettes never fail the run: a PR that changes tool descriptions shows which cases need a
new recording. To re-record everything, delete `cassettes/<model>/` and run `pnpm evals:record`.
Commit new cassettes and review their diff like a snapshot.

## Cost

One request per case (about 70 cases). The tool list is 15–40k input tokens depending on the
configuration; the system block carries a cache breakpoint and cases run one after another, so
each configuration writes the cache once and the other cases read it at a tenth of the price.
With `claude-sonnet-5-5` ($2 / $10 per million input / output tokens) a full recording costs
about **$1–2** (roughly $0.75 input with caching plus thinking and answer tokens); without cache
hits it would be about $5. Recording only stale cases costs proportionally less. The summary
prints the estimate for the answers recorded in a run.

## Reading the results

The vitest-evals reporter prints every case with its `FirstAnswerJudge` score; the summary test
prints (and in CI writes to the job summary) a table. The calls of one answer run in parallel,
so their order is not a decision and the best call counts:

- **Score 1**: the first answer makes a call from `expected` (for negative cases: no tool, or
  `sevdesk_account_info` to check the permissions). Reading the invoice next to
  `sevdesk_invoice_cancel` with `dryRun` counts as picking the cancel tool.
- **Score 0.5**: it makes only reasonable but not ideal calls from `secondChoice`, usually a
  read before the write the user asked for.
- **Score 0**: anything else, or a refusal.

Scores are averaged per toolset, per language and for positive and negative cases, and every
case below 1 is listed with every call of its first answer. A case also **fails** (whatever the model says) when
its configuration does not offer a tool it names, or a negative case's configuration offers the
tool it must not see: fix the case or the configuration.

When a case misses, improve the tool's description (what it does, when to use it, the German
terms users say, which tool comes before or after) rather than the case, unless the case
expected the wrong thing. Single misses are normal: models vary between runs.

## Adding a case

Add it to `EVAL_CASES` with a new kebab-case `id`, reuse one of the `ENVS` (fewer distinct
configurations keep recording cheap), list every call that is fully right as a first step in `expected`
and reasonable detours in `secondChoice`, then run `pnpm evals:record` and commit the new
cassette.

## CI

The paired `invoices-summary-browse-en` / `invoice-get-after-summary-en` cases check browsing
with `detail: "summary"` and fetching the selected id. `expectedInput` scores the argument
subset as well as the tool name. The second case supplies a fixed summary in the prompt;
these are two first-answer checks, not a live multi-turn workflow. New recordings are needed
after changing the list schemas or descriptions; CI's record job can produce them.

`.github/workflows/evals.yml` runs on pull requests that touch `src/tools/**`,
`src/instructions.ts` or the evals. The **replay** job always runs, without secrets. The
**record** job runs for branches of this repository when the `evals` environment holds an
`ANTHROPIC_API_KEY` secret (add required reviewers there to approve each spend), records stale
cases and uploads the new cassettes as the `eval-cassettes` artifact. Both jobs are informational
(`continue-on-error`) and not part of `ci-ok`.
