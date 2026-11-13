import { describe, expect, it } from "vitest";

import { EVAL_CASES, type EvalCase } from "../evals/cases.js";
import { scoreFirstAnswer } from "../evals/scoring.js";

describe("list browsing eval arguments", () => {
  const browse = EVAL_CASES.find((testCase) => testCase.id === "invoices-summary-browse-en");
  if (browse === undefined) throw new Error("Missing summary browsing eval.");
  function score(testCase: EvalCase, input: Record<string, string | number>) {
    return scoreFirstAnswer(testCase, {
      firstTool: "sevdesk_invoices_list",
      tools: ["sevdesk_invoices_list"],
      calls: [{ name: "sevdesk_invoices_list", input }],
      stopReason: "tool_use",
      source: "replay",
    }).score;
  }
  it("requires summary and the document filter on the same expected call", () => {
    expect(score(browse, { number: "RE-1003" })).toBe(0);
    expect(score(browse, { detail: "full", number: "RE-1003" })).toBe(0);
    expect(score(browse, { detail: "summary", number: "RE-1003", limit: 25 })).toBe(1);
  });
  it("keeps tool-only scoring for existing cases", () => {
    const { expectedInput: _input, ...existing } = browse;
    expect(score(existing, {})).toBe(1);
  });
});
