/**
 * Lint over every shipped tool: the rules clients and models rely on, checked on the real catalog
 * (not just on whatever `defineTool` happened to see).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  isStrictObject,
  JSON_SCHEMA_TARGET,
  MAX_DESCRIPTION_LENGTH,
  validateToolDefinition,
} from "../../src/tools/define-tool.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import type { AnyToolDefinition } from "../../src/tools/types.js";
import { allEnabledConfig } from "../helpers/config.js";
import { filesDeployment, filesOffDeployment } from "../helpers/transfer.js";

const ANNOTATION_KEYS = ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"];

/**
 * The reviewed tools with file effects (catalog order = `ALL_TOOLS` order). Both go only through
 * `ToolContext.files` (`FileAccess`, `src/safety/file-sources.ts`): writers hand files out as new
 * files inside `SEVDESK_OUTPUT_DIR` (`writeNewFile`) or, over HTTP with file transfer, as download
 * links of the caller's account; readers read inside `SEVDESK_FILE_DIRS` (`readConfinedFile`) or
 * the caller's own uploads.
 */
const FILE_WRITERS = ["sevdesk_document_save", "sevdesk_datev_export", "sevdesk_csv_export"];
const FILE_READERS = [
  "sevdesk_voucher_create_draft",
  "sevdesk_voucher_import_einvoice",
  "sevdesk_voucher_update_draft",
  "sevdesk_einvoice_parse",
];

const cases = ALL_TOOLS.map((tool): [string, AnyToolDefinition] => [tool.name, tool]);

function localEffectsOf(tool: AnyToolDefinition): unknown {
  return tool.localEffects;
}

/** Names of the tools that declare `effect`, in catalog order. */
function toolsWith(effect: string): string[] {
  return ALL_TOOLS.filter((tool) => localEffectsOf(tool) === effect).map((tool) => tool.name);
}

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

describe("tool metadata", () => {
  it("ships at least one tool", () => {
    expect(ALL_TOOLS.length).toBeGreaterThan(0);
  });

  it("uses unique names and titles", () => {
    expect(duplicates(ALL_TOOLS.map((tool) => tool.name))).toEqual([]);
    expect(duplicates(ALL_TOOLS.map((tool) => tool.title))).toEqual([]);
  });

  it("lets only the reviewed tools write local files (extend this list deliberately)", () => {
    expect(toolsWith("writes-files")).toEqual(FILE_WRITERS);
  });

  it("lets only the reviewed tools read local files (extend this list deliberately)", () => {
    expect(toolsWith("reads-files")).toEqual(FILE_READERS);
  });

  it("offers file writers only when files can be delivered and declares nothing else", () => {
    const declared = ALL_TOOLS.filter((tool) => tool.localEffects !== undefined);
    expect(declared.map((tool) => tool.name).sort()).toEqual(
      [...FILE_WRITERS, ...FILE_READERS].sort(),
    );
    for (const tool of declared.filter((t) => t.localEffects === "writes-files")) {
      expect(tool.available?.(allEnabledConfig()), tool.name).toBe(false);
      expect(tool.available?.(allEnabledConfig({ fileDirs: ["/in"] })), tool.name).toBe(false);
      expect(
        tool.available?.(allEnabledConfig({ deployment: filesOffDeployment() })),
        tool.name,
      ).toBe(false);
      expect(tool.available?.(allEnabledConfig({ outputDir: "/out" })), tool.name).toBe(true);
      expect(tool.available?.(allEnabledConfig({ deployment: filesDeployment() })), tool.name).toBe(
        true,
      );
    }
  });

  it("offers the tools that only work on a file only when files can be read", () => {
    const fileOnly = ["sevdesk_einvoice_parse", "sevdesk_voucher_import_einvoice"];
    for (const name of fileOnly) {
      const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
      expect(tool?.available?.(allEnabledConfig()), name).toBe(false);
      expect(tool?.available?.(allEnabledConfig({ outputDir: "/out" })), name).toBe(false);
      expect(tool?.available?.(allEnabledConfig({ deployment: filesOffDeployment() })), name).toBe(
        false,
      );
      expect(tool?.available?.(allEnabledConfig({ fileDirs: ["/in"] })), name).toBe(true);
      expect(tool?.available?.(allEnabledConfig({ deployment: filesDeployment() })), name).toBe(
        true,
      );
    }
  });

  it("offers the upload request only over HTTP with file transfer, as a plain read tool", () => {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === "sevdesk_upload_request");
    expect(tool).toMatchObject({ tier: "read", toolset: "meta" });
    expect(tool?.localEffects).toBeUndefined();
    expect(tool?.available?.(allEnabledConfig({ fileDirs: ["/in"], outputDir: "/out" }))).toBe(
      false,
    );
    expect(tool?.available?.(allEnabledConfig({ deployment: filesOffDeployment() }))).toBe(false);
    expect(tool?.available?.(allEnabledConfig({ deployment: filesDeployment() }))).toBe(true);
  });

  describe.each(cases)("%s", (_name, tool) => {
    it("passes defineTool validation", () => {
      expect(validateToolDefinition(tool)).toEqual([]);
    });

    it(`has a description of at most ${MAX_DESCRIPTION_LENGTH} characters`, () => {
      expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    });

    it("sets all four annotations explicitly", () => {
      const annotations: Record<string, unknown> = { ...tool.annotations };
      expect(Object.keys(annotations).sort()).toEqual(ANNOTATION_KEYS);
      for (const key of ANNOTATION_KEYS) {
        expect(typeof annotations[key], key).toBe("boolean");
      }
    });

    it('is read-only exactly when it is a read tool without localEffects "writes-files"', () => {
      const localEffects = localEffectsOf(tool);
      const writesFiles = localEffects === "writes-files";
      expect(
        localEffects === undefined || writesFiles || localEffects === "reads-files",
        "localEffects value",
      ).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(tool.tier === "read" && !writesFiles);
    });

    it("has a strict, flat object-root input JSON Schema", () => {
      const input: unknown = tool.input;
      expect(input).toBeInstanceOf(z.ZodObject);
      const schema = input as z.ZodObject;
      const json = z.toJSONSchema(schema, { io: "input", target: JSON_SCHEMA_TARGET });

      expect(json.type).toBe("object");
      expect(json).not.toHaveProperty("anyOf");
      expect(json).not.toHaveProperty("oneOf");
      expect(json).not.toHaveProperty("allOf");
      expect(json.additionalProperties).toBe(false);
      expect(isStrictObject(schema)).toBe(true);
    });

    it("has an object output JSON Schema", () => {
      const output: unknown = tool.output;
      expect(output).toBeInstanceOf(z.ZodObject);
      const json = z.toJSONSchema(output as z.ZodObject, {
        io: "output",
        target: JSON_SCHEMA_TARGET,
      });

      expect(json.type).toBe("object");
    });
  });
});
