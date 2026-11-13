import type { z } from "zod";

/**
 * Shared by MCP advertisement, metadata lint and the generated input reference. Shared output
 * DTOs opt into local $defs with explicit metadata IDs: Zod keeps .describe() clones as $ref
 * siblings. Leave automatic reuse off to avoid extracting anonymous primitive definitions and
 * to keep model-facing input schemas inline.
 */
export const JSON_SCHEMA_OPTIONS = {
  target: "draft-2020-12",
  override: ({ jsonSchema }) => {
    // These are Zod's implicit .int() limits, not endpoint bounds. Runtime Zod validation
    // still enforces safe integers; retain every narrower bound in the advertised schema.
    if (jsonSchema.minimum === -Number.MAX_SAFE_INTEGER) delete jsonSchema.minimum;
    if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
  },
} satisfies z.core.ToJSONSchemaParams;
