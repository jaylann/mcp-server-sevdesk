/**
 * The wrapped output of write tools (`{status, result?, preview?, approval?}`) and the era rules
 * for `outputSchema` / `structuredContent` it shares with read tools.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AnyToolDefinition } from "../../src/tools/types.js";
import { writeOutputSchema } from "../../src/tools/write-flow.js";
import { createDummyTools, dummyInvoiceBody } from "../helpers/dummy-tools.js";
import type { FakeRoute } from "../helpers/fake-client.js";
import { inlineLocalRefs } from "../helpers/json-schema.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  resultSummary,
  resultText,
  writeHarness,
} from "../helpers/write-flow.js";

closeWriteHarnessesAfterEach();

const finalize: AnyToolDefinition = createDummyTools().tools.find(
  (tool) => tool.name === "sevdesk_dummy_finalize",
)!;
const routes: FakeRoute[] = [
  { path: "/Invoice/7", response: { body: dummyInvoiceBody() } },
  { method: "PUT", path: "/Invoice/7/sendBy", response: { body: { objects: { id: "7" } } } },
];
const PREVIEW = {
  action: "Finalize invoice RE-1042 and mark it as sent.",
  facts: [
    { label: "Customer", value: "Muster GmbH" },
    { label: "Total (gross)", value: "1190.00 EUR" },
  ],
  warnings: ["The invoice becomes legally binding."],
  irreversible: false,
};

describe("writeOutputSchema", () => {
  it("wraps the tool's output and is built once per output schema", () => {
    const output = z.object({ id: z.string() });
    const schema = writeOutputSchema(output);

    expect(writeOutputSchema(output)).toBe(schema);
    expect(schema.safeParse({ status: "done", result: { id: "1" } }).success).toBe(true);
    expect(schema.safeParse({ status: "done", result: { id: 1 } }).success).toBe(false);
    expect(schema.safeParse({ status: "dry_run", preview: PREVIEW }).success).toBe(true);
    expect(schema.safeParse({ status: "finished" }).success).toBe(false);
  });

  it("converts to an object-root JSON Schema with the status enum", () => {
    const json = z.toJSONSchema(writeOutputSchema(z.object({ id: z.string() })), {
      io: "output",
      target: "draft-2020-12",
    });

    expect(json).toMatchObject({
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ["done", "dry_run", "approval_pending", "declined"] },
        result: { type: "object", properties: { id: { type: "string" } } },
        preview: { type: "object", required: ["action", "facts", "warnings", "irreversible"] },
        approval: { type: "object", required: ["reference", "expiresAt", "opened"] },
      },
    });
  });
});

describe("modern clients (structured output on)", () => {
  it("advertise the wrapped schema for write tools", async () => {
    const { client } = await writeHarness({ tools: [finalize], routes });

    const { tools } = await client.listTools();

    expect(inlineLocalRefs(tools[0]?.outputSchema)).toMatchObject({
      type: "object",
      properties: {
        status: { enum: ["done", "dry_run", "approval_pending", "declined"] },
        result: { type: "object", properties: { status: { type: "string" } } },
      },
    });
  });

  it("receive done results as structuredContent, with result only", async () => {
    const { client } = await writeHarness({ tools: [finalize], routes });

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.structuredContent).toEqual({ status: "done", result: { status: "open" } });
    expect(resultData(result)).toEqual(result.structuredContent);
    expect(resultText(result).split("\n\n")[1]).toBe(JSON.stringify(result.structuredContent));
    expect(resultSummary(result)).toBe("Finalized the invoice.");
  });

  it("receive dry runs with the sanitized preview and without result", async () => {
    const { client } = await writeHarness({ tools: [finalize], routes });

    const result = await client.callTool({
      name: "sevdesk_dummy_finalize",
      arguments: { id: 7, dryRun: true },
    });

    expect(result.structuredContent).toEqual({ status: "dry_run", preview: PREVIEW });
    expect(resultData(result)).toEqual(result.structuredContent);
    expect(resultText(result).split("\n\n")[1]).toBe(JSON.stringify(result.structuredContent));
    expect(resultSummary(result)).toBe(
      "Dry run: nothing was sent to sevDesk. The preview shows what sevdesk_dummy_finalize " +
        "would do; call it without dryRun to make the change (the user will be asked to approve it).",
    );
  });

  it("receive pending approvals with the approval link", async () => {
    const { client } = await writeHarness({
      tools: [finalize],
      routes,
      config: { confirm: "browser" },
    });

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.structuredContent).toEqual({
      status: "approval_pending",
      preview: PREVIEW,
      approval: {
        reference: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) as unknown,
        expiresAt: expect.any(String) as unknown,
        opened: false,
      },
    });
    expect(resultData(result)).toEqual(result.structuredContent);
    expect(resultText(result).split("\n\n")[1]).toBe(JSON.stringify(result.structuredContent));
  });

  it("receive declined results with the preview", async () => {
    const { client } = await writeHarness({
      tools: [finalize],
      routes,
      connect: { answer: () => ({ action: "decline" }) },
    });

    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "declined", preview: PREVIEW });
    expect(resultData(result)).toEqual(result.structuredContent);
    expect(resultText(result).split("\n\n")[1]).toBe(JSON.stringify(result.structuredContent));
    expect(resultSummary(result)).toBe(
      "The user did not approve this action, so nothing was changed in sevDesk. Do not call " +
        "sevdesk_dummy_finalize again for it unless the user asks you to.",
    );
  });
});

describe("2025-era clients (structured output auto)", () => {
  it("get the JSON text only, no outputSchema", async () => {
    const { client } = await writeHarness({
      tools: [finalize],
      routes,
      connect: { era: "legacy", transport: "stdio" },
    });

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: "sevdesk_dummy_finalize", arguments: { id: 7 } });

    expect(tools[0]?.outputSchema).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(resultData(result)).toEqual({ status: "done", result: { status: "open" } });
  });

  it("get structured output when SEVDESK_STRUCTURED_OUTPUT=on", async () => {
    const { client } = await writeHarness({
      tools: [finalize],
      routes,
      config: { structuredOutput: "on" },
      connect: { era: "legacy", transport: "stdio" },
    });

    const result = await client.callTool({
      name: "sevdesk_dummy_finalize",
      arguments: { id: 7, dryRun: true },
    });

    expect(result.structuredContent).toEqual({ status: "dry_run", preview: PREVIEW });
  });
});
