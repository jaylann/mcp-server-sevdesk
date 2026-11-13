/**
 * Offline response-cost comparison: node --import tsx scripts/measure-list-detail.ts
 * Cycle the scrubbed community fixtures to 25 rows, then format validated tool results exactly
 * as the MCP registry does. Counts are Unicode code points of text blocks, including the trusted
 * summary and the current JSON serialization (minified since #64). Tokens are estimates at the measured #61 ratio, not API counts.
 */
import assert from "node:assert/strict";

import { successResult } from "../src/tools/result.js";
import { FakeSevdeskClient, testContext } from "../test/helpers/fake-client.js";
import { LIST_CASES, listRoutes } from "../test/helpers/list-detail.js";

console.log(
  "| Tool (25 items) | Full chars | Summary chars | Reduction | Full est. tokens | Summary est. tokens |",
);
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const testCase of LIST_CASES) {
  const sizes: number[] = [];
  for (const detail of ["full", "summary"]) {
    const { tool } = testCase;
    const output = await tool.handler(
      tool.input.parse({ detail, limit: 25 }),
      testContext(new FakeSevdeskClient(listRoutes(testCase, 25))),
    );
    const data = tool.output.parse(output.data);
    assert(Array.isArray(data["items"]) && data["items"].length === 25);
    const result = successResult({ ...output, data }, { structured: false });
    sizes.push(
      result.content.reduce(
        (sum, block) => sum + (block.type === "text" ? Array.from(block.text).length : 0),
        0,
      ),
    );
  }
  const [full = 0, summary = 0] = sizes;
  console.log(
    `| ${testCase.tool.name} | ${full} | ${summary} | ${((100 * (full - summary)) / full).toFixed(1)}% | ${Math.round(full / 2.3)} | ${Math.round(summary / 2.3)} |`,
  );
}
