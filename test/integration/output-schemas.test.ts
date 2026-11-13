import type { AnySchemaObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Config } from "../../src/config.js";
import { createServerFactory } from "../../src/server.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { writeOutputSchema } from "../../src/tools/write-flow.js";
import { allEnabledConfig, testConfig, tiers } from "../helpers/config.js";
import { connectFactory } from "../helpers/connect.js";
import { stubClient } from "../helpers/dummy-tools.js";
import { type FakeRoute, FakeSevdeskClient } from "../helpers/fake-client.js";
import { inlineLocalRefs } from "../helpers/json-schema.js";
import { filesConfig } from "../helpers/transfer.js";
import { withCaseEnvironment } from "../helpers/write-cases.js";
import { closeWriteHarnessesAfterEach, writeHarness } from "../helpers/write-flow.js";
import { WRITE_TOOL_CASES } from "../write-cases/index.js";

closeWriteHarnessesAfterEach();

/** Remove only the annotations and sentinel bounds this change intentionally alters. */
function validationShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(validationShape);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, child]) =>
          !(key === "description" && typeof child === "string") &&
          !(key === "minimum" && child === -Number.MAX_SAFE_INTEGER) &&
          !(key === "maximum" && child === Number.MAX_SAFE_INTEGER),
      )
      .map(([key, child]) => [key, validationShape(child)]),
  );
}

const configurations: [string, Config][] = [
  ["read", testConfig()],
  ["write", testConfig({ allowedTiers: tiers("read", "write") })],
  ["all", allEnabledConfig()],
  ["http-files", filesConfig()],
  ["local-files", allEnabledConfig({ fileDirs: ["/in"], outputDir: "/out" })],
];

describe.each(configurations)("%s output schemas", (_name, config) => {
  it("compile standalone in Ajv2020 and retain every inline Zod validation constraint", async () => {
    const factory = createServerFactory({ config, client: stubClient() });
    const client = await connectFactory(factory);
    try {
      const { tools } = await client.listTools();
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      for (const tool of tools) {
        const schema = tool.outputSchema;
        expect(schema, tool.name).toBeDefined();
        expect(schema?.["type"], tool.name).toBe("object");
        expect(() => ajv.compile(schema as AnySchemaObject), tool.name).not.toThrow();
        const definition = ALL_TOOLS.find(({ name }) => name === tool.name)!;
        const declaredOutput = definition.output as z.ZodObject;
        const output =
          definition.tier === "read" ? declaredOutput : writeOutputSchema(declaredOutput);
        // An empty metadata registry deliberately emits the original inline layout, without IDs.
        const inline = z.toJSONSchema(output, { io: "output", metadata: z.registry() });
        expect(validationShape(inlineLocalRefs(schema)), tool.name).toEqual(
          validationShape(inlineLocalRefs(inline)),
        );
        const input = z.toJSONSchema(definition.input, { io: "input" });
        expect(validationShape(tool.inputSchema), tool.name).toEqual(validationShape(input));
      }
    } finally {
      await client.close();
      await factory.close();
    }
  });
});

const recorded = (path: string, file: string): FakeRoute => ({
  path,
  response: { fixture: `recorded/2026-11-07/${file}` },
});

it.each([
  ["invoice", "Invoice", 138793718, "invoices"],
  ["credit_note", "CreditNote", 3084629, "credit-notes"],
  ["order", "Order", 31523703, "orders"],
] as const)(
  "validates recorded %s structuredContent, including nested money and totals",
  async (kind, object, id, folder) => {
    const file = kind.replaceAll("_", "-");
    const routes = [
      recorded(`/${object}/${id}`, `${folder}/${file}-by-id.json`),
      recorded(`/${object}Pos`, `${folder}/${file}-positions.json`),
      recorded("/Unity", "meta/units.json"),
      recorded("/StaticCountry", "meta/static-countries.json"),
      ...(kind === "order"
        ? [recorded(`/Order/${id}/getRelatedObjects`, "orders/order-related.json")]
        : []),
    ];
    const factory = createServerFactory({
      config: allEnabledConfig(),
      client: new FakeSevdeskClient(routes),
    });
    const client = await connectFactory(factory);
    try {
      const name = `sevdesk_${kind}_get`;
      const { tools } = await client.listTools();
      const schema = tools.find((tool) => tool.name === name)!.outputSchema!;
      const result = await client.callTool({ name, arguments: { id } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeDefined();
      const validate = new Ajv2020({ strict: false }).compile(schema as AnySchemaObject);
      expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true);
      expect(schema).toHaveProperty("$defs.Money");
      expect(schema).toHaveProperty("$defs.DocumentTotals");
    } finally {
      await client.close();
      await factory.close();
    }
  },
);

it("validates a cancellation's two described Invoice refs and the dry-run envelope", async () => {
  const testCase = WRITE_TOOL_CASES.find(({ tool }) => tool.name === "sevdesk_invoice_cancel")!;
  await withCaseEnvironment(testCase, async (config) => {
    const { client } = await writeHarness({
      tools: [testCase.tool],
      routes: testCase.routes,
      config,
    });
    const { tools } = await client.listTools();
    const schema = tools[0]!.outputSchema!;
    const validate = new Ajv2020({ strict: false }).compile(schema as AnySchemaObject);
    for (const dryRun of [true, false]) {
      const result = await client.callTool({
        name: testCase.tool.name,
        arguments: { ...testCase.args, dryRun },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ status: dryRun ? "dry_run" : "done" });
      expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(schema).toHaveProperty("$defs.Invoice");
    expect(schema).toMatchObject({
      properties: {
        result: {
          properties: {
            invoice: { $ref: "#/$defs/Invoice", description: "The cancelled invoice, read back." },
            cancellationInvoice: {
              $ref: "#/$defs/Invoice",
              description: "The new cancellation invoice (SR).",
            },
          },
        },
      },
    });
  });
});
