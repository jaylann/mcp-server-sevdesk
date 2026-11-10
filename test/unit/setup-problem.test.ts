import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";
import { createSetupProblemFactory, SETUP_PROBLEM_TOOL } from "../../src/setup-problem.js";
import { connectConfirming } from "../helpers/confirm-client.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

/** The problems `loadConfig` reports for `env` (it must refuse it). */
function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("the setup-problem server (invalid configuration over stdio)", () => {
  const problems = problemsOf({ SEVDESK_API_TOKEN: TOKEN, SEVDESK_ALLOW: "read,execute" });

  it.each(["modern", "legacy"] as const)(
    "%s: explains the problem in its instructions and its one tool, never the token",
    async (era) => {
      const harness = await connectConfirming(createSetupProblemFactory(problems), {
        era,
        transport: "stdio",
        elicitation: false,
      });
      try {
        const instructions = harness.client.getInstructions() ?? "";
        expect(instructions).toContain('SEVDESK_ALLOW: unknown tier "execute"');
        expect(instructions).toContain("Settings → Extensions → sevDesk → Configure");

        const { tools } = await harness.client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual([SETUP_PROBLEM_TOOL]);
        expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });

        const result = await harness.client.callTool({ name: SETUP_PROBLEM_TOOL, arguments: {} });
        const text = JSON.stringify(result.content);
        expect(text).toContain("could not start: its configuration is invalid");
        expect(text).toContain('unknown tier \\"execute\\"');
        expect(`${instructions}${text}`).not.toContain(TOKEN);
      } finally {
        await harness.close();
      }
    },
  );
});
