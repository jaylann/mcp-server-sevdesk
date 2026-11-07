/**
 * Every write-tool case (the shipped tools' cases from `test/write-cases/` plus the dummy tools)
 * through the real MCP server and the write flow: nothing is written in a dry run, before an
 * approval or after a declined one; an approved (or confirmation-free) call makes exactly the
 * case's writes with the tool's tier. New cases are picked up automatically.
 */
import { describe, expect, it } from "vitest";

import { requiresConfirmation } from "../../src/safety/tiers.js";
import { decideInBrowser } from "../helpers/approval-browser.js";
import { createDummyTools, dummyWriteCases } from "../helpers/dummy-tools.js";
import type { WriteToolCase } from "../helpers/write-cases.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultText,
  writeHarness,
  type WriteHarnessOptions,
  writesOf,
} from "../helpers/write-flow.js";
import { WRITE_TOOL_CASES } from "../write-cases/index.js";

closeWriteHarnessesAfterEach();

const CASES: readonly WriteToolCase[] = [
  ...WRITE_TOOL_CASES,
  ...dummyWriteCases(createDummyTools()),
];
const confirmed = CASES.filter((testCase) => requiresConfirmation(testCase.tool.tier));
const unconfirmed = CASES.filter((testCase) => !requiresConfirmation(testCase.tool.tier));

const each = (cases: readonly WriteToolCase[]) =>
  cases.map((testCase) => [testCase.label, testCase] as const);

function setup(testCase: WriteToolCase, options: Partial<WriteHarnessOptions> = {}) {
  return writeHarness({ tools: [testCase.tool], routes: testCase.routes, ...options });
}

function call(testCase: WriteToolCase, extra: Record<string, unknown> = {}) {
  return { name: testCase.tool.name, arguments: { ...testCase.args, ...extra } };
}

describe("every write tool", () => {
  it("has at least one case per tier among the dummies", () => {
    expect(new Set(CASES.map((testCase) => testCase.tool.tier))).toEqual(
      new Set(["write", "commit", "external"]),
    );
  });

  it.each(each(CASES))(
    "%s: dryRun: true sends nothing and asks nobody",
    async (_label, testCase) => {
      const { client, fake, prompts } = await setup(testCase);

      const result = await client.callTool(call(testCase, { dryRun: true }));

      expect(result.isError, resultText(result)).toBeFalsy();
      expect(resultData(result)).toMatchObject({
        status: "dry_run",
        preview: expect.any(Object) as unknown,
      });
      expect(resultData(result)).not.toHaveProperty("result");
      expect(writesOf(fake)).toEqual([]);
      expect(prompts).toEqual([]);
    },
  );

  it.each(each(CASES))("%s: SEVDESK_DRY_RUN=1 sends nothing", async (_label, testCase) => {
    const { client, fake, prompts } = await setup(testCase, { config: { dryRun: true } });

    const result = await client.callTool(call(testCase));

    expect(resultData(result)).toMatchObject({ status: "dry_run" });
    expect(writesOf(fake)).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

describe("write tier", () => {
  it.each(each(unconfirmed))(
    "%s: runs without asking and makes exactly the declared writes",
    async (_label, testCase) => {
      const { client, fake, prompts } = await setup(testCase);

      const result = await client.callTool(call(testCase));

      expect(result.isError, resultText(result)).toBeFalsy();
      expect(resultData(result)).toMatchObject({
        status: "done",
        result: expect.any(Object) as unknown,
      });
      expect(writesOf(fake)).toEqual(testCase.writes);
      expect(fake.writes().every((write) => write.tier === testCase.tool.tier)).toBe(true);
      expect(prompts).toEqual([]);
    },
  );
});

describe("commit and external tiers (SEVDESK_CONFIRM=elicit)", () => {
  it.each(each(confirmed))(
    "%s: approved, makes exactly the declared writes",
    async (_label, testCase) => {
      const { client, fake, prompts } = await setup(testCase);

      const result = await client.callTool(call(testCase));

      expect(result.isError, resultText(result)).toBeFalsy();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.message).toContain("Nothing happens unless you approve.");
      expect(prompts[0]?.requestedSchema).toMatchObject({
        type: "object",
        properties: { approve: { type: "boolean", default: false } },
        required: ["approve"],
      });
      expect(resultData(result)).toMatchObject({
        status: "done",
        result: expect.any(Object) as unknown,
      });
      expect(writesOf(fake)).toEqual(testCase.writes);
      expect(fake.writes().every((write) => write.tier === testCase.tool.tier)).toBe(true);
    },
  );

  it.each(
    each(confirmed).flatMap(([label, testCase]) =>
      (
        [
          ["declined", { action: "decline" }],
          ["cancelled", { action: "cancel" }],
          ["approve: false", { action: "accept", content: { approve: false } }],
          ["an empty form", { action: "accept", content: {} }],
        ] as const
      ).map(([how, answer]) => [`${label} (${how})`, testCase, answer] as const),
    ),
  )("%s: sends nothing and reports declined", async (_label, testCase, answer) => {
    const { client, fake, prompts } = await setup(testCase, {
      connect: { answer: () => answer },
    });

    const result = await client.callTool(call(testCase));

    expect(result.isError).toBeFalsy();
    expect(prompts).toHaveLength(1);
    expect(resultData(result)).toMatchObject({ status: "declined" });
    expect(resultText(result)).toContain("nothing was changed in sevDesk");
    expect(writesOf(fake)).toEqual([]);
  });

  it.each(each(confirmed))(
    "%s: a 2025-era client is asked through the legacy shim (stdio)",
    async (_label, testCase) => {
      const { client, fake, prompts } = await setup(testCase, {
        connect: { era: "legacy", transport: "stdio" },
      });

      const result = await client.callTool(call(testCase));

      expect(result.isError, resultText(result)).toBeFalsy();
      expect(prompts).toHaveLength(1);
      expect(writesOf(fake)).toEqual(testCase.writes);
    },
  );

  it.each(each(confirmed))(
    "%s: a 2025-era client that declines gets declined, nothing sent",
    async (_label, testCase) => {
      const { client, fake } = await setup(testCase, {
        connect: { era: "legacy", transport: "stdio", answer: () => ({ action: "decline" }) },
      });

      const result = await client.callTool(call(testCase));

      expect(resultData(result)).toMatchObject({ status: "declined" });
      expect(writesOf(fake)).toEqual([]);
    },
  );

  it.each(
    each(confirmed).flatMap(([label, testCase]) =>
      (
        [
          ["modern client without elicitation", { elicitation: false }],
          [
            "2025-era client without elicitation (stdio)",
            { era: "legacy", transport: "stdio", elicitation: false },
          ],
          ["2025-era client over stateless HTTP", { era: "legacy", transport: "http" }],
        ] as const
      ).map(([how, connect]) => [`${label} (${how})`, testCase, connect] as const),
    ),
  )("%s: refused with an actionable error, nothing sent", async (_label, testCase, connect) => {
    const { client, fake, prompts } = await setup(testCase, { connect });

    const result = await client.callTool(call(testCase));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("cannot show confirmation prompts");
    expect(resultText(result)).toContain("SEVDESK_CONFIRM=browser");
    expect(resultText(result)).toContain("Nothing was sent to sevDesk");
    expect(prompts).toEqual([]);
    expect(writesOf(fake)).toEqual([]);
  });
});

describe("commit and external tiers (SEVDESK_CONFIRM=browser)", () => {
  it.each(each(confirmed))(
    "%s: pending until approved on the page, then exactly the declared writes",
    async (_label, testCase) => {
      const { client, fake, prompts, lastApprovalUrl } = await setup(testCase, {
        config: { confirm: "browser" },
      });

      const first = await client.callTool(call(testCase));
      expect(first.isError, resultText(first)).toBeFalsy();
      const pending = resultData(first);
      expect(pending).toMatchObject({
        status: "approval_pending",
        preview: expect.any(Object) as unknown,
      });
      expect(writesOf(fake)).toEqual([]);

      const url = lastApprovalUrl();
      expect(JSON.stringify(first)).not.toContain(url);
      expect((await decideInBrowser(url, "approve")).status).toBe(200);

      const second = await client.callTool(call(testCase));
      expect(resultData(second)).toMatchObject({ status: "done" });
      expect(writesOf(fake)).toEqual(testCase.writes);
      expect(prompts).toEqual([]);
    },
  );

  it.each(each(confirmed))("%s: rejected on the page, nothing sent", async (_label, testCase) => {
    const { client, fake, lastApprovalUrl } = await setup(testCase, {
      config: { confirm: "browser" },
    });
    await client.callTool(call(testCase));

    await decideInBrowser(lastApprovalUrl(), "reject");
    const second = await client.callTool(call(testCase));

    expect(resultData(second)).toMatchObject({ status: "declined" });
    expect(writesOf(fake)).toEqual([]);
  });
});

describe("commit and external tiers (SEVDESK_CONFIRM=off)", () => {
  it.each(each(confirmed))("%s: runs without asking", async (_label, testCase) => {
    const { client, fake, prompts } = await setup(testCase, { config: { confirm: "off" } });

    const result = await client.callTool(call(testCase));

    expect(resultData(result)).toMatchObject({ status: "done" });
    expect(writesOf(fake)).toEqual(testCase.writes);
    expect(prompts).toEqual([]);
  });
});
