import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineTool,
  defineWriteTool,
  isStrictObject,
  MAX_DESCRIPTION_LENGTH,
  ToolDefinitionError,
  type ToolMetadata,
  validateToolDefinition,
} from "../../../src/tools/define-tool.js";
import type { ReadToolDefinition, WriteToolDefinition } from "../../../src/tools/types.js";
import { dryRunInputShape } from "../../../src/tools/write-input.js";
import {
  COMMIT_ANNOTATIONS,
  EXTERNAL_ANNOTATIONS,
  READ_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from "../../helpers/dummy-tools.js";

const input = z.strictObject({ id: z.string().min(1).describe("Contact id.") });
const output = z.object({ name: z.string() });

function valid(): ReadToolDefinition<typeof input, typeof output> {
  return {
    name: "sevdesk_contact_get",
    title: "Get contact",
    description: "Gets one contact (Kontakt) by id.",
    toolset: "contacts",
    tier: "read",
    annotations: READ_ANNOTATIONS,
    input,
    output,
    handler: () => Promise.resolve({ data: { name: "A" }, summary: "Found it." }),
  };
}

const writeInput = z.strictObject({ id: z.string().min(1), ...dryRunInputShape });

function validWrite(): WriteToolDefinition<typeof writeInput, typeof output, null> {
  return {
    name: "sevdesk_contact_update",
    title: "Update contact",
    description: "Updates one contact (Kontakt) by id.",
    toolset: "contacts",
    tier: "write",
    annotations: WRITE_ANNOTATIONS,
    input: writeInput,
    output,
    prepare: () =>
      Promise.resolve({
        preview: { action: "Update the contact.", facts: [], warnings: [], irreversible: false },
        state: null,
      }),
    execute: () => Promise.resolve({ data: { name: "A" }, summary: "Updated it." }),
  };
}

/**
 * Problems of the valid read definition with `overrides`; when the overrides name a write tier,
 * the base is the valid write definition instead, so only the overridden fields can fail.
 */
function problems(overrides: Partial<Record<keyof ToolMetadata, unknown>>): string[] {
  const writeTier = overrides.tier !== undefined && overrides.tier !== "read";
  const base: ToolMetadata = writeTier ? validWrite() : valid();
  return validateToolDefinition({ ...base, ...overrides } as ToolMetadata);
}

describe("defineTool", () => {
  it("returns a valid definition unchanged and frozen", () => {
    const definition = valid();

    const defined = defineTool(definition);

    expect(defined).toBe(definition);
    expect(Object.isFrozen(defined)).toBe(true);
  });

  it("throws one error listing every problem", () => {
    const broken = {
      ...valid(),
      name: "contact_get",
      title: " ",
      annotations: { ...valid().annotations, destructiveHint: true },
    };

    expect(() => defineTool(broken)).toThrow(ToolDefinitionError);
    try {
      defineTool(broken);
    } catch (error) {
      expect(error).toBeInstanceOf(ToolDefinitionError);
      const definitionError = error as ToolDefinitionError;
      expect(definitionError.toolName).toBe("contact_get");
      expect(definitionError.problems).toHaveLength(3);
      expect(definitionError.message).toMatch(
        /^Invalid tool definition "contact_get":\n {2}- name/,
      );
    }
  });
});

describe("validateToolDefinition", () => {
  it("accepts a valid definition", () => {
    expect(validateToolDefinition(valid())).toEqual([]);
  });

  it.each([
    "contact_get",
    "sevdesk_contact",
    "sevdesk_Contact_get",
    "sevdesk_contact-get",
    "sevdesk_contact__get",
    "sevdesk_contact_get_",
  ])("rejects the name %s", (name) => {
    expect(problems({ name })).toEqual([expect.stringContaining("name must match")]);
  });

  it("rejects names longer than 64 characters", () => {
    const name = `sevdesk_${"a".repeat(50)}_${"b".repeat(10)}`;
    expect(problems({ name })).toEqual([`name has ${name.length} chars; the maximum is 64.`]);
  });

  it("requires a title and a description of 20 to 2,048 characters", () => {
    expect(problems({ title: "  " })).toEqual(["title must not be empty."]);
    expect(problems({ description: "Too short." })).toEqual([
      "description must have at least 20 chars.",
    ]);
    expect(problems({ description: "x".repeat(MAX_DESCRIPTION_LENGTH) })).toEqual([]);
    expect(problems({ description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1) })).toEqual([
      "description has 2049 chars; the maximum is 2048.",
    ]);
  });

  it("rejects unknown toolsets and tiers", () => {
    expect(problems({ toolset: "payroll" })).toEqual([
      expect.stringContaining('toolset "payroll" is unknown'),
    ]);
    expect(problems({ tier: "admin" })).toEqual([
      expect.stringContaining('tier "admin" is unknown'),
    ]);
  });

  it("requires all four annotations explicitly", () => {
    const { openWorldHint: _omitted, ...partial } = READ_ANNOTATIONS;
    expect(problems({ annotations: partial })).toEqual([
      "annotations.openWorldHint must be set explicitly to true or false.",
    ]);
  });

  it.each([
    [
      "read",
      { ...READ_ANNOTATIONS, readOnlyHint: false },
      'tier "read" requires annotations.readOnlyHint = true.',
    ],
    [
      "read",
      { ...READ_ANNOTATIONS, destructiveHint: true },
      'tier "read" requires annotations.destructiveHint = false.',
    ],
    [
      "write",
      { ...WRITE_ANNOTATIONS, readOnlyHint: true },
      'tier "write" requires annotations.readOnlyHint = false.',
    ],
    [
      "commit",
      { ...COMMIT_ANNOTATIONS, destructiveHint: false },
      'tier "commit" requires annotations.destructiveHint = true.',
    ],
    [
      "external",
      { ...EXTERNAL_ANNOTATIONS, openWorldHint: false },
      'tier "external" requires annotations.openWorldHint = true.',
    ],
    [
      "external",
      { ...EXTERNAL_ANNOTATIONS, readOnlyHint: true },
      'tier "external" requires annotations.readOnlyHint = false.',
    ],
  ])("checks tier %s against its annotations", (tier, annotations, expected) => {
    expect(problems({ tier, annotations })).toEqual([expected]);
  });

  it.each([
    ["write", WRITE_ANNOTATIONS],
    ["commit", COMMIT_ANNOTATIONS],
    ["external", EXTERNAL_ANNOTATIONS],
  ])("accepts the usual %s annotations", (tier, annotations) => {
    expect(problems({ tier, annotations })).toEqual([]);
  });

  describe("localEffects (tools that read or write local files)", () => {
    const writesFiles = { ...READ_ANNOTATIONS, readOnlyHint: false, idempotentHint: false };

    it('accepts a read tool with localEffects "writes-files" and readOnlyHint false', () => {
      expect(problems({ localEffects: "writes-files", annotations: writesFiles })).toEqual([]);
      expect(() =>
        defineTool({ ...valid(), localEffects: "writes-files", annotations: writesFiles }),
      ).not.toThrow();
    });

    it("requires readOnlyHint false together with the flag", () => {
      expect(problems({ localEffects: "writes-files" })).toEqual([
        'localEffects "writes-files" requires annotations.readOnlyHint = false.',
      ]);
    });

    it("still forbids destructive read tools", () => {
      expect(
        problems({
          localEffects: "writes-files",
          annotations: { ...writesFiles, destructiveHint: true },
        }),
      ).toEqual(['tier "read" requires annotations.destructiveHint = false.']);
    });

    it("is the only way for a read tool to drop readOnlyHint", () => {
      expect(problems({ annotations: writesFiles })).toEqual([
        'tier "read" requires annotations.readOnlyHint = true.',
      ]);
    });

    it('treats "opens-upload" like "writes-files": a read tool with it is not read-only', () => {
      // An upload ticket is state on this server, like a download link (review 2026-11, round 3).
      expect(problems({ localEffects: "opens-upload", annotations: writesFiles })).toEqual([]);
      expect(problems({ localEffects: "opens-upload" })).toEqual([
        'localEffects "opens-upload" requires annotations.readOnlyHint = false.',
      ]);
      expect(
        problems({
          localEffects: "opens-upload",
          annotations: { ...writesFiles, destructiveHint: true },
        }),
      ).toEqual(['tier "read" requires annotations.destructiveHint = false.']);
    });

    it("rejects other values", () => {
      expect(problems({ localEffects: "deletes-files", annotations: writesFiles })).toEqual([
        'localEffects must be "reads-files", "writes-files" or "opens-upload" when set.',
        'tier "read" requires annotations.readOnlyHint = true.',
      ]);
    });

    it('keeps a read tool with "reads-files" read-only', () => {
      expect(problems({ localEffects: "reads-files" })).toEqual([]);
      expect(problems({ localEffects: "reads-files", annotations: writesFiles })).toEqual([
        'tier "read" requires annotations.readOnlyHint = true.',
      ]);
    });

    it.each([
      ["write", WRITE_ANNOTATIONS],
      ["commit", COMMIT_ANNOTATIONS],
      ["external", EXTERNAL_ANNOTATIONS],
    ])("is accepted on %s tools without extra annotation rules", (tier, annotations) => {
      expect(problems({ tier, annotations, localEffects: "writes-files" })).toEqual([]);
      expect(problems({ tier, annotations, localEffects: "reads-files" })).toEqual([]);
      expect(problems({ tier, annotations, localEffects: "opens-upload" })).toEqual([]);
    });
  });

  it("requires a strict input object", () => {
    const strictMessage =
      "input must reject unknown keys: use z.strictObject({ … }) or z.object({ … }).strict().";
    expect(problems({ input: z.object({ id: z.string() }) })).toEqual([strictMessage]);
    expect(problems({ input: z.looseObject({ id: z.string() }) })).toEqual([strictMessage]);
    expect(problems({ input: z.object({ id: z.string() }).strict() })).toEqual([]);
    expect(problems({ input: z.string() })).toEqual([
      "input must be a zod object schema, e.g. z.strictObject({ … }).",
    ]);
  });

  it("requires schemas that convert to JSON Schema", () => {
    expect(problems({ input: z.strictObject({ when: z.date() }) })).toEqual([
      "input schema cannot be converted to JSON Schema: Date cannot be represented in JSON Schema",
    ]);
    expect(problems({ output: z.object({ when: z.date() }) })).toEqual([
      "output schema cannot be converted to JSON Schema: Date cannot be represented in JSON Schema",
    ]);
  });

  it("requires an object output schema", () => {
    expect(problems({ output: z.array(z.string()) })).toEqual([
      "output must be a zod object schema, e.g. z.object({ … }).",
    ]);
  });
});

describe("tool shape per tier", () => {
  it("accepts a valid write definition and defineWriteTool returns it frozen", () => {
    const definition = validWrite();

    expect(validateToolDefinition(definition)).toEqual([]);
    expect(Object.isFrozen(defineWriteTool(definition))).toBe(true);
  });

  it("requires a handler and no dryRun argument on read tools", () => {
    expect(validateToolDefinition({ ...valid(), handler: undefined, input: writeInput })).toEqual([
      "a read tool needs a handler function (declare it with defineTool).",
      'a read tool must not take "dryRun"; it changes nothing anyway.',
    ]);
    expect(validateToolDefinition({ ...valid(), prepare: () => undefined })).toEqual([
      "prepare/execute are for write tools only; a read tool has a handler.",
    ]);
  });

  it("requires prepare, execute and dryRun, and no handler, on write tools", () => {
    expect(
      validateToolDefinition({
        ...validWrite(),
        execute: undefined,
        handler: () => undefined,
        input,
      }),
    ).toEqual([
      "a write tool needs prepare and execute functions (declare it with defineWriteTool).",
      "a write tool has prepare/execute instead of a handler.",
      'a write tool must accept "dryRun": spread dryRunInputShape into its input.',
    ]);
  });
});

describe("isStrictObject", () => {
  it("is true only for objects that reject unknown keys", () => {
    expect(isStrictObject(z.strictObject({}))).toBe(true);
    expect(isStrictObject(z.object({}).strict())).toBe(true);
    expect(isStrictObject(z.object({}))).toBe(false);
    expect(isStrictObject(z.object({}).loose())).toBe(false);
    expect(isStrictObject(z.object({}).catchall(z.string()))).toBe(false);
  });

  it("agrees with zod's JSON Schema output", () => {
    for (const schema of [z.strictObject({}), z.object({}), z.looseObject({})]) {
      const json = z.toJSONSchema(schema, { io: "input" });
      expect(isStrictObject(schema)).toBe(json.additionalProperties === false);
    }
  });
});
