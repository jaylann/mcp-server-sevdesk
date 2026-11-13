import { type EvalCase, NO_TOOL } from "./cases.js";
import type { JsonObject } from "./cassette.js";

/** What one case run produced (the harness output). JSON only, for the vitest-evals report. */
export type SelectionOutput = {
  /** Name of the first tool the model called, or `NO_TOOL` (cases.ts). */
  firstTool: string;
  /** Every tool called in the answer, in order. */
  tools: string[];
  calls: { name: string; input: JsonObject }[];
  stopReason: string | null;
  /** Where the answer came from: a cassette, or a call made by this run. */
  source: "replay" | "record";
};

export interface Score {
  /**
   * 1: the first answer makes an expected call; 0.5: only a second choice; 0: anything else, or
   * a refusal.
   */
  readonly score: number;
  readonly rationale: string;
}

/**
 * Scores the model's first answer against the case. The calls of one answer run in parallel, so
 * their order is not a decision: an answer that reads the invoice and calls the write tool with
 * `dryRun` side by side has picked the write tool. The best call counts. Spraying many tools is
 * not rewarded in practice: the summary lists every call of a case below 1, and a case's
 * configuration never offers the tools it must not use.
 */
export function scoreFirstAnswer(testCase: EvalCase, output: SelectionOutput): Score {
  if (output.stopReason === "refusal") {
    return { score: 0, rationale: "The model refused the request." };
  }
  const calls = output.tools.length > 0 ? output.tools : [NO_TOOL];
  const listed = calls.join(", ");
  const expected = testCase.expected.join(" or ");
  if (calls.some((name) => testCase.expected.includes(name))) {
    if (
      testCase.expectedInput !== undefined &&
      !output.calls.some(
        (call) =>
          testCase.expected.includes(call.name) &&
          Object.entries(testCase.expectedInput ?? {}).every(
            ([key, value]) => call.input[key] === value,
          ),
      )
    ) {
      return {
        score: 0,
        rationale: `Expected call (${expected}) did not include the required arguments.`,
      };
    }
    return { score: 1, rationale: `First answer (${listed}) makes an expected call.` };
  }
  if (calls.some((name) => testCase.secondChoice?.includes(name) === true)) {
    return {
      score: 0.5,
      rationale: `First answer (${listed}) makes only a second-choice call; expected ${expected}.`,
    };
  }
  return { score: 0, rationale: `First answer (${listed}); expected ${expected}.` };
}

export type CaseResult =
  | {
      readonly testCase: EvalCase;
      readonly status: "scored";
      readonly score: number;
      readonly output: SelectionOutput;
      readonly costUsd: number | undefined;
    }
  | { readonly testCase: EvalCase; readonly status: "skipped"; readonly reason: string };

export interface SummaryOptions {
  readonly model: string;
  readonly mode: string;
  readonly totalCases: number;
}

/** Number of scored cases and their mean score, for one summary row. */
interface Group {
  readonly name: string;
  readonly cases: number;
  readonly score: number;
}

/** Mean score of the scored results, or undefined when none was scored. */
export function accuracy(results: readonly CaseResult[]): number | undefined {
  const scored = results.filter((result) => result.status === "scored");
  if (scored.length === 0) {
    return undefined;
  }
  return scored.reduce((sum, result) => sum + result.score, 0) / scored.length;
}

/**
 * The run summary as Markdown (for the terminal and `$GITHUB_STEP_SUMMARY`): overall score,
 * score per toolset, language and kind, the misses, and the skipped cases with their reason.
 */
export function summaryMarkdown(results: readonly CaseResult[], options: SummaryOptions): string {
  const scored = results.filter((result) => result.status === "scored");
  const skipped = results.filter((result) => result.status === "skipped");
  const lines = [`## Tool-selection evals: ${options.model} (${options.mode})`, ""];

  if (scored.length === 0) {
    lines.push(
      `No case ran: ${skipped.length} of ${options.totalCases} skipped as stale cassettes ` +
        `(none recorded for this model, or recorded for different tools, instructions or prompts). ` +
        "Record them with `ANTHROPIC_API_KEY=… pnpm evals:record` (see test/evals/README.md).",
    );
    return `${lines.join("\n")}\n`;
  }

  const overall = accuracy(scored) ?? 0;
  const full = scored.filter((result) => result.score === 1).length;
  const half = scored.filter((result) => result.score === 0.5).length;
  const missed = scored.filter((result) => result.score === 0);
  const recorded = scored.filter((result) => result.output.source === "record");
  const cost = recorded.reduce((sum, result) => sum + (result.costUsd ?? 0), 0);
  lines.push(
    `Score **${format(overall)}** over ${scored.length} of ${options.totalCases} cases ` +
      `(expected call: ${full}, second choice: ${half}, miss: ${missed.length}; ` +
      `skipped as stale cassette: ${skipped.length}). ` +
      `Recorded in this run: ${recorded.length}` +
      (cost > 0 ? ` (about $${cost.toFixed(2)}).` : "."),
    "",
    "| Group | Cases | Score |",
    "| --- | ---: | ---: |",
    ...[
      ...groups(scored, (result) => `toolset ${result.testCase.toolset}`),
      ...groups(scored, (result) => `language ${result.testCase.lang}`),
      ...groups(scored, (result) => `${result.testCase.kind} cases`),
    ].map((group) => `| ${group.name} | ${group.cases} | ${format(group.score)} |`),
  );

  const notFull = scored.filter((result) => result.score < 1);
  if (notFull.length > 0) {
    lines.push(
      "",
      "### First answer without an expected call",
      "",
      "| Case | Calls in the first answer | Score | Expected |",
      "| --- | --- | ---: | --- |",
      ...notFull.map(
        (result) =>
          `| ${result.testCase.id} | ${result.output.tools.join(", ") || NO_TOOL} | ` +
          `${format(result.score)} | ` +
          `${result.testCase.expected.join(", ")} |`,
      ),
    );
  }
  if (skipped.length > 0) {
    lines.push(
      "",
      "<details><summary>Skipped cases</summary>",
      "",
      ...skipped.map((result) => `- ${result.testCase.id}: ${result.reason}`),
      "",
      "</details>",
    );
  }
  return `${lines.join("\n")}\n`;
}

function groups(
  scored: readonly Extract<CaseResult, { status: "scored" }>[],
  keyOf: (result: Extract<CaseResult, { status: "scored" }>) => string,
): Group[] {
  const byKey = new Map<string, number[]>();
  for (const result of scored) {
    const key = keyOf(result);
    byKey.set(key, [...(byKey.get(key) ?? []), result.score]);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, scores]) => ({
      name,
      cases: scores.length,
      score: scores.reduce((sum, score) => sum + score, 0) / scores.length,
    }));
}

function format(score: number): string {
  return score.toFixed(2);
}
