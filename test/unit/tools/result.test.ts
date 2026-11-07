import { describe, expect, it } from "vitest";

import { errorResult, successResult } from "../../../src/tools/result.js";

describe("successResult", () => {
  const output = { summary: "Found 2 contacts.", data: { items: [{ id: "1" }, { id: "2" }] } };

  it("puts the summary, a blank line and indented JSON into one text block", () => {
    expect(successResult(output, { structured: false })).toEqual({
      content: [
        {
          type: "text",
          text: `Found 2 contacts.\n\n${JSON.stringify(output.data, null, 2)}`,
        },
      ],
    });
  });

  it("adds structuredContent only when structured output is on", () => {
    expect(successResult(output, { structured: true }).structuredContent).toEqual(output.data);
    expect(successResult(output, { structured: false })).not.toHaveProperty("structuredContent");
  });

  it("omits an empty summary", () => {
    const result = successResult({ summary: "  ", data: { a: 1 } }, { structured: false });
    expect(result.content).toEqual([{ type: "text", text: '{\n  "a": 1\n}' }]);
  });

  it("appends extra content blocks after the text block; structuredContent stays data", () => {
    const link = {
      type: "resource_link",
      uri: "sevdesk://invoices/1/pdf",
      name: "RE-1.pdf",
      mimeType: "application/pdf",
    } as const;

    const result = successResult({ ...output, extraContent: [link, link] }, { structured: true });

    expect(result.content).toEqual([
      { type: "text", text: `Found 2 contacts.\n\n${JSON.stringify(output.data, null, 2)}` },
      link,
      link,
    ]);
    expect(result.structuredContent).toEqual(output.data);
  });

  it("treats an empty extraContent like none", () => {
    const result = successResult({ ...output, extraContent: [] }, { structured: false });
    expect(result.content).toHaveLength(1);
  });
});

describe("errorResult", () => {
  it("marks the result as a tool error", () => {
    expect(errorResult("Nope.")).toEqual({
      content: [{ type: "text", text: "Nope." }],
      isError: true,
    });
  });
});
