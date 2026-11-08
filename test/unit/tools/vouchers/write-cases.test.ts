/**
 * The voucher write cases (test/write-cases/vouchers.ts) checked the way
 * `test/integration/write-cases.test.ts` checks every case, so they can run on their own.
 */
import { describe, expect, it } from "vitest";

import { VOUCHER_WRITE_TOOLS } from "../../../../src/tools/vouchers/write-tools.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { withCaseEnvironment } from "../../../helpers/write-cases.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { VOUCHERS_CASES } from "../../../write-cases/vouchers.js";

describe("voucher write cases", () => {
  it("cover every voucher write tool", () => {
    const covered = new Set(VOUCHERS_CASES.map((testCase) => testCase.tool.name));
    expect(
      VOUCHER_WRITE_TOOLS.map((tool) => tool.name).filter((name) => !covered.has(name)),
    ).toEqual([]);
  });

  it.each(VOUCHERS_CASES.map((testCase) => [testCase.label, testCase] as const))(
    "%s: prepare writes nothing, execute makes exactly the declared writes",
    async (_label, testCase) => {
      await withCaseEnvironment(testCase, async (config) => {
        const preparing = new FakeSevdeskClient(testCase.routes);
        await prepareWrite(testCase.tool, testCase.args, preparing, config);
        expect(preparing.writes()).toEqual([]);

        const client = new FakeSevdeskClient(testCase.routes);
        const { output } = await executeWrite(testCase.tool, testCase.args, client, config);
        expect(client.writes().map(({ method, path }) => ({ method, path }))).toEqual(
          testCase.writes,
        );
        for (const call of client.writes()) expect(call.tier).toBe(testCase.tool.tier);
        expect(output.affected?.length ?? 0).toBeGreaterThan(0);
      });
    },
  );
});
