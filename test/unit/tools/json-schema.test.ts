import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { moneySchema } from "../../../src/domain/common.js";
import { JSON_SCHEMA_OPTIONS } from "../../../src/tools/json-schema.js";
import { inlineLocalRefs } from "../../helpers/json-schema.js";

describe.each(["input", "output"] as const)("%s JSON Schema conversion", (io) => {
  it("omits only safe-integer sentinel bounds, preserving real bounds and runtime validation", () => {
    const schema = z.object({
      integer: z.number().int(),
      page: z.number().int().min(1).max(1000),
      offset: z.number().int().min(0),
      negative: z.number().int().max(-1),
      positive: z.number().int().positive(),
    });
    const json = z.toJSONSchema(schema, { ...JSON_SCHEMA_OPTIONS, io });
    expect(json.properties).toEqual({
      integer: { type: "integer" },
      page: { type: "integer", minimum: 1, maximum: 1000 },
      offset: { type: "integer", minimum: 0 },
      negative: { type: "integer", maximum: -1 },
      positive: { type: "integer", exclusiveMinimum: 0 },
    });
    expect(schema.shape.integer.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(schema.shape.integer.safeParse(-Number.MAX_SAFE_INTEGER - 1).success).toBe(false);
    expect(schema.shape.integer.safeParse(1.5).success).toBe(false);
  });
});

it("shares named money with described and optional clones without losing decimal semantics", () => {
  const schema = z.object({
    net: moneySchema,
    gross: moneySchema.describe("Gross amount."),
    paid: moneySchema.optional().describe("Amount paid."),
  });
  const json = z.toJSONSchema(schema, { ...JSON_SCHEMA_OPTIONS, io: "output" });
  expect(Object.keys(json.$defs ?? {})).toEqual(["Money"]);
  expect(json.$defs?.["Money"]).toMatchObject({
    description: "Exact decimal amount as a string and ISO 4217 currency code.",
    required: ["amount", "currency"],
  });
  expect(json.properties).toEqual({
    net: { $ref: "#/$defs/Money" },
    gross: { $ref: "#/$defs/Money", description: "Gross amount." },
    paid: { $ref: "#/$defs/Money", description: "Amount paid." },
  });
  const validate = new Ajv2020().compile(json);
  const valid = {
    net: { amount: "1.00", currency: "EUR" },
    gross: { amount: "1.19", currency: "EUR" },
  };
  expect(validate(valid)).toBe(true);
  expect(validate({ ...valid, gross: { amount: 1.19, currency: "EUR" } })).toBe(false);
  expect(validate({ ...valid, paid: { amount: "0", currency: "EU" } })).toBe(false);
});

it("resolves escaped local pointers, preserves siblings and stops at recursive references", () => {
  const schema = {
    $ref: "#/$defs/a~1b~0c",
    description: "Root description.",
    $defs: {
      "a/b~c": { type: "object", properties: { next: { $ref: "#/$defs/a~1b~0c" } } },
    },
  };
  expect(inlineLocalRefs(schema)).toEqual({
    type: "object",
    description: "Root description.",
    properties: { next: { $ref: "#/$defs/a~1b~0c" } },
  });
  expect(() => inlineLocalRefs({ $ref: "#/$defs/missing" })).toThrow("Unresolved");
  expect(() => inlineLocalRefs({ $ref: "https://example.com/schema" })).toThrow("Non-local");
});
