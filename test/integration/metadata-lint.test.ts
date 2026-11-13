/**
 * Lint over every shipped tool: the rules clients and models rely on, checked on the real catalog
 * (not just on whatever `defineTool` happened to see).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  isStrictObject,
  MAX_DESCRIPTION_LENGTH,
  validateToolDefinition,
} from "../../src/tools/define-tool.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { JSON_SCHEMA_OPTIONS } from "../../src/tools/json-schema.js";
import { type AnyToolDefinition, isWriteTool } from "../../src/tools/types.js";
import { allEnabledConfig } from "../helpers/config.js";
import { inlineLocalRefs } from "../helpers/json-schema.js";
import { filesDeployment, filesOffDeployment } from "../helpers/transfer.js";

const ANNOTATION_KEYS = ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"];

/**
 * The reviewed tools with file effects (catalog order = `ALL_TOOLS` order). Both go only through
 * `ToolContext.files` (`FileAccess`, `src/safety/file-sources.ts`): writers hand files out as new
 * files inside `SEVDESK_OUTPUT_DIR` (`writeNewFile`) or, over HTTP with file transfer, as download
 * links of the caller's account; readers read inside `SEVDESK_FILE_DIRS` (`readConfinedFile`) or
 * the caller's own uploads.
 */
const FILE_WRITERS = [
  "sevdesk_voucher_receipt_save",
  "sevdesk_document_save",
  "sevdesk_datev_export",
  "sevdesk_csv_export",
];
const FILE_READERS = [
  "sevdesk_voucher_create_draft",
  "sevdesk_voucher_import_einvoice",
  "sevdesk_voucher_update_draft",
  "sevdesk_einvoice_parse",
];
/** The reviewed tools that open an upload page (a ticket in the transfer store). */
const UPLOAD_OPENERS = ["sevdesk_upload_request"];

/**
 * The reviewed write tools without `locks` (`WriteToolDefinition.locks`), each with the reason
 * why its calls may interleave. Every other tool that changes sevDesk declares the records (or
 * the account-wide key) its checks depend on: a check followed by a write is void when two calls
 * run at once (review 2026-11, round 3). Extend this list deliberately.
 */
const WITHOUT_LOCKS: Readonly<Record<string, string>> = {
  sevdesk_invoice_create_draft:
    "creates a new draft; its duplicate check only warns, and sevDesk assigns the number at finalization",
  sevdesk_order_create_draft:
    "creates a new draft; its duplicate check only warns, and the number is reserved by one sevDesk request",
  sevdesk_datev_export: "starts an export job from its arguments; no record is checked before it",
};

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
      [...FILE_WRITERS, ...FILE_READERS, ...UPLOAD_OPENERS].sort(),
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

  it("lists only shipped tools as write tools without locks", () => {
    const names = new Set(ALL_TOOLS.map((tool) => tool.name));
    expect(Object.keys(WITHOUT_LOCKS).filter((name) => !names.has(name))).toEqual([]);
  });

  it("lets only the reviewed tools open an upload page (extend this list deliberately)", () => {
    expect(toolsWith("opens-upload")).toEqual(UPLOAD_OPENERS);
  });

  it("offers the upload request only over HTTP with file transfer, as a read tool that is not read-only", () => {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === "sevdesk_upload_request");
    expect(tool).toMatchObject({ tier: "read", toolset: "meta" });
    // It changes nothing in sevDesk but opens a ticket on this server, of which an account holds
    // only a few: like a tool that creates a download link, it must not claim to be read-only.
    expect(tool?.localEffects).toBe("opens-upload");
    expect(tool?.annotations.readOnlyHint).toBe(false);
    expect(tool?.annotations.destructiveHint).toBe(false);
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

    it("is read-only exactly when it is a read tool that changes nothing outside sevDesk either", () => {
      const localEffects = localEffectsOf(tool);
      // A new file or download link, or an upload ticket: state outside sevDesk.
      const changesState = localEffects === "writes-files" || localEffects === "opens-upload";
      expect(
        localEffects === undefined || changesState || localEffects === "reads-files",
        "localEffects value",
      ).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(tool.tier === "read" && !changesState);
    });

    it("declares locks when it changes sevDesk, or is on the reviewed list with a reason", () => {
      const reason = WITHOUT_LOCKS[tool.name];
      if (!isWriteTool(tool)) {
        expect(reason, "a read tool takes no locks").toBeUndefined();
        return;
      }
      const declares = typeof tool.locks === "function";
      // Exactly one of the two: a tool with locks must not stay on the list.
      expect(declares, `${tool.name}: locks, or an entry in WITHOUT_LOCKS`).toBe(
        reason === undefined,
      );
      if (reason !== undefined) expect(reason.trim().length).toBeGreaterThan(20);
    });

    it("has a strict, flat object-root input JSON Schema", () => {
      const input: unknown = tool.input;
      expect(input).toBeInstanceOf(z.ZodObject);
      const schema = input as z.ZodObject;
      const json = z.toJSONSchema(schema, { ...JSON_SCHEMA_OPTIONS, io: "input" });

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
        ...JSON_SCHEMA_OPTIONS,
        io: "output",
      });

      expect(inlineLocalRefs(json)).toMatchObject({ type: "object" });
    });
  });
});
