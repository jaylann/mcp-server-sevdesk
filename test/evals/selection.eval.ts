/**
 * Tool-selection evals: for each case in cases.ts, does a model that sees this server's tools and
 * instructions (as a client would, for the case's configuration) pick a right FIRST tool call?
 * Answers replay from cassettes by default; see README.md for recording and reading the results.
 */
import { appendFileSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";
import { expect } from "vitest";
import { createHarness, createJudge, describeEval } from "vitest-evals";

import { EVAL_CASES, type EvalCase, NO_TOOL } from "./cases.js";
import {
  type CassetteLookup,
  evalsMode,
  lookupCassette,
  type RecordedResponse,
  requestKey,
  writeCassette,
} from "./cassette.js";
import { buildRequest, callModel, estimateCostUsd, evalEffort, evalModel } from "./model.js";
import {
  accuracy,
  type CaseResult,
  scoreFirstAnswer,
  type SelectionOutput,
  summaryMarkdown,
} from "./scoring.js";
import { clientView } from "./tools.js";

const MODE = evalsMode();
const MODEL = evalModel();
const EFFORT = evalEffort();
/** The summary test fails when the mean score of the cases that ran is below this. */
const MIN_SCORE = Number(process.env["EVALS_MIN_SCORE"] ?? "0.8");

interface PreparedCase {
  readonly request: Anthropic.MessageCreateParamsNonStreaming;
  readonly key: string;
  readonly lookup: CassetteLookup;
  readonly offered: ReadonlySet<string>;
}

async function prepare(testCase: EvalCase): Promise<PreparedCase> {
  const view = await clientView(testCase.env);
  const request = buildRequest(view, testCase.prompt, MODEL, EFFORT);
  const key = requestKey(request);
  return {
    request,
    key,
    lookup: await lookupCassette(MODEL, testCase.id, key),
    offered: new Set(view.tools.map((tool) => tool.name)),
  };
}

let anthropic: Anthropic | undefined;

/** Created on first use, so replay runs never need credentials. */
function apiClient(): Anthropic {
  anthropic ??= new Anthropic({ timeout: 120_000, maxRetries: 2 });
  return anthropic;
}

/** Answers one case from its cassette, or (record mode) from the API, writing the cassette. */
async function answer(
  testCase: EvalCase,
): Promise<{ response: RecordedResponse; source: SelectionOutput["source"] }> {
  const prepared = await prepare(testCase);
  if (prepared.lookup.status === "current") {
    return { response: prepared.lookup.cassette.response, source: "replay" };
  }
  if (MODE !== "record") {
    throw new Error(`No current cassette for ${testCase.id}; the test should have been skipped.`);
  }
  // Checked per case (the eval reporter does not show suite-level errors); current cassettes
  // replay without a key.
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "Recording calls the Anthropic API: set ANTHROPIC_API_KEY (see test/evals/README.md).",
    );
  }
  const response = await callModel(apiClient(), prepared.request);
  await writeCassette({
    caseId: testCase.id,
    model: MODEL,
    key: prepared.key,
    recordedAt: new Date().toISOString(),
    response,
  });
  return { response, source: "record" };
}

const harness = createHarness<EvalCase, SelectionOutput>({
  name: "first-tool-call",
  run: async ({ input }) => {
    const { response, source } = await answer(input);
    const toolUses = response.content.filter((block) => block.type === "tool_use");
    const costUsd = estimateCostUsd(MODEL, response.usage);
    return {
      output: {
        firstTool: toolUses[0]?.name ?? NO_TOOL,
        tools: toolUses.map((block) => block.name),
        stopReason: response.stopReason,
        source,
      },
      events: [
        { type: "message", role: "user", content: input.prompt },
        ...response.content.map((block, index) =>
          block.type === "text"
            ? { type: "message" as const, role: "assistant" as const, content: block.text }
            : {
                type: "tool_call" as const,
                id: `call_${index}`,
                name: block.name,
                arguments: block.input,
              },
        ),
      ],
      usage: {
        provider: "anthropic",
        model: response.model,
        inputTokens:
          response.usage.inputTokens +
          response.usage.cacheCreationInputTokens +
          response.usage.cacheReadInputTokens,
        outputTokens: response.usage.outputTokens,
        toolCalls: toolUses.length,
        ...(costUsd === undefined ? {} : { costUsd }),
      },
    };
  },
});

const FirstAnswerJudge = createJudge<EvalCase, SelectionOutput>(
  "FirstAnswerJudge",
  ({ input, output }) => {
    const { score, rationale } = scoreFirstAnswer(input, output);
    return { score, metadata: { rationale } };
  },
);

const results: CaseResult[] = [];

describeEval(
  "tool selection",
  // Single misses are expected (models vary); the summary test gates on the mean score.
  { harness, judges: [FirstAnswerJudge], judgeThreshold: null },
  (it) => {
    it("case definitions are well-formed", () => {
      const ids = EVAL_CASES.map((testCase) => testCase.id);
      expect(new Set(ids).size, "duplicate case ids").toBe(ids.length);
      for (const testCase of EVAL_CASES) {
        expect(testCase.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(testCase.expected.length, testCase.id).toBeGreaterThan(0);
        expect(testCase.kind === "negative", testCase.id).toBe(testCase.absent !== undefined);
      }
    });

    it.for(EVAL_CASES)("$toolset [$lang] $id", async (testCase, { run, skip }) => {
      const prepared = await prepare(testCase);
      const notOffered = [...testCase.expected, ...(testCase.secondChoice ?? [])].filter(
        (name) => name !== NO_TOOL && !prepared.offered.has(name),
      );
      expect(notOffered, "tools the case names but its env does not offer").toEqual([]);
      const offeredAnyway = (testCase.absent ?? []).filter((name) => prepared.offered.has(name));
      expect(offeredAnyway, "tools a negative case's env must not offer").toEqual([]);

      if (MODE === "replay" && prepared.lookup.status !== "current") {
        const reason =
          prepared.lookup.status === "missing"
            ? `stale cassette: none recorded for ${MODEL}`
            : `stale cassette: tools, instructions or prompt changed since ${prepared.lookup.cassette.recordedAt}`;
        results.push({ testCase, status: "skipped", reason });
        skip(reason);
      }

      const result = await run(testCase);
      results.push({
        testCase,
        status: "scored",
        score: scoreFirstAnswer(testCase, result.output).score,
        output: result.output,
        costUsd: result.usage.costUsd,
      });
    });

    it("summary", () => {
      const markdown = summaryMarkdown(results, {
        model: MODEL,
        mode: MODE,
        totalCases: EVAL_CASES.length,
      });
      console.log(`\n${markdown}`);
      const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
      if (stepSummary) {
        appendFileSync(stepSummary, `${markdown}\n`);
      }
      const score = accuracy(results);
      if (score !== undefined) {
        expect(score, `mean score (EVALS_MIN_SCORE=${MIN_SCORE})`).toBeGreaterThanOrEqual(
          MIN_SCORE,
        );
      }
    });
  },
);
