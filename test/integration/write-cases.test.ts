/**
 * Every shipped write tool has a known-good case (test/write-cases/), and each case does exactly
 * what it declares: `prepare` writes nothing, `execute` makes the declared writes in order, each
 * stamped with the tool's tier.
 */
import { describe, expect, it } from "vitest";

import { ALL_TOOLS } from "../../src/tools/index.js";
import { isWriteTool } from "../../src/tools/types.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../helpers/write-tools.js";
import { WRITE_TOOL_CASES } from "../write-cases/index.js";

const writeTools = ALL_TOOLS.filter(isWriteTool);

describe("write-tool cases", () => {
  it("cover every shipped write tool", () => {
    const covered = new Set(WRITE_TOOL_CASES.map((testCase) => testCase.tool.name));
    expect(writeTools.map((tool) => tool.name).filter((name) => !covered.has(name))).toEqual([]);
  });

  it("only use shipped tools", () => {
    for (const testCase of WRITE_TOOL_CASES) {
      expect(ALL_TOOLS, testCase.label).toContain(testCase.tool);
    }
  });

  it.each(WRITE_TOOL_CASES.map((testCase) => [testCase.label, testCase] as const))(
    "%s: prepare writes nothing",
    async (_label, testCase) => {
      const client = new FakeSevdeskClient(testCase.routes);

      await prepareWrite(testCase.tool, testCase.args, client);

      expect(client.writes()).toEqual([]);
    },
  );

  it.each(WRITE_TOOL_CASES.map((testCase) => [testCase.label, testCase] as const))(
    "%s: execute makes exactly the declared writes with the tool's tier",
    async (_label, testCase) => {
      const client = new FakeSevdeskClient(testCase.routes);

      const { output } = await executeWrite(testCase.tool, testCase.args, client);

      expect(client.writes().map(({ method, path }) => ({ method, path }))).toEqual(
        testCase.writes,
      );
      for (const call of client.writes()) {
        expect(call.tier, `${call.method} ${call.path}`).toBe(testCase.tool.tier);
      }
      expect(output.affected?.length ?? 0, "affected records").toBeGreaterThan(0);
    },
  );
});
