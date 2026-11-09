/**
 * Renders `docs/tools.md` from the tool and prompt definitions, so the reference can never drift
 * from the code. `pnpm docs:tools` writes the file; `test/integration/tool-docs.test.ts` fails
 * when the committed file is stale.
 */
import { z } from "zod";

import { PROMPTS } from "../src/prompts/catalog.js";
import type { PromptDefinition } from "../src/prompts/types.js";
import { requiresConfirmation, TIER_DESCRIPTIONS, TIERS } from "../src/safety/tiers.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { TOOLSETS } from "../src/tools/toolsets.js";
import type { AnyToolDefinition } from "../src/tools/types.js";

interface JsonSchemaProperty {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly items?: JsonSchemaProperty;
  readonly minimum?: number;
  readonly maximum?: number;
}

function typeOf(property: JsonSchemaProperty): string {
  if (property.enum !== undefined) {
    return property.enum.map((value) => `\`${String(value)}\``).join(" \\| ");
  }
  if (property.type === "array" && property.items !== undefined) {
    return `${typeOf(property.items)}[]`;
  }
  if (Array.isArray(property.type)) return property.type.join(" \\| ");
  return typeof property.type === "string" ? property.type : "any";
}

/** Makes text safe for one Markdown table cell: backslashes first, then pipes, no line breaks. */
function cell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ");
}

function inputTable(tool: AnyToolDefinition): string {
  const schema = z.toJSONSchema(tool.input as z.ZodObject, { io: "input" }) as {
    properties?: Record<string, JsonSchemaProperty>;
    required?: readonly string[];
  };
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) return "No arguments.\n";
  const required = new Set(schema.required ?? []);
  const rows = entries.map(([name, property]) => {
    const defaultValue =
      property.default === undefined ? "" : ` Default: \`${JSON.stringify(property.default)}\`.`;
    const need = required.has(name) && property.default === undefined ? "yes" : "no";
    return `| \`${name}\` | ${typeOf(property)} | ${need} | ${cell((property.description ?? "") + defaultValue)} |`;
  });
  return ["| Argument | Type | Required | Description |", "|---|---|---|---|", ...rows, ""].join(
    "\n",
  );
}

function annotationSummary(tool: AnyToolDefinition): string {
  const flags: string[] = [];
  flags.push(tool.annotations.readOnlyHint ? "read-only" : "changes state");
  if (tool.annotations.destructiveHint) flags.push("destructive");
  if (tool.annotations.idempotentHint) flags.push("idempotent");
  if (tool.annotations.openWorldHint) flags.push("reaches third parties");
  if (tool.tier !== "read") flags.push("supports `dryRun`");
  if (requiresConfirmation(tool.tier)) flags.push("asks the user to confirm");
  return flags.join(", ");
}

/** "`a` and one of `b` or `c`": a prompt's requirements as Markdown. */
function requirementText(prompt: PromptDefinition): string {
  const parts = prompt.requires.map((requirement) =>
    typeof requirement === "string"
      ? `\`${requirement}\``
      : `one of ${requirement.anyOf.map((name) => `\`${name}\``).join(" or ")}`,
  );
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

function argumentTable(prompt: PromptDefinition): string {
  const schema = z.toJSONSchema(prompt.args, { io: "input" }) as {
    properties?: Record<string, JsonSchemaProperty>;
    required?: readonly string[];
  };
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) return "No arguments.\n";
  const required = new Set(schema.required ?? []);
  const rows = entries.map(
    ([name, property]) =>
      `| \`${name}\` | ${required.has(name) ? "yes" : "no"} | ${cell(property.description ?? "")} |`,
  );
  return ["| Argument | Required | Description |", "|---|---|---|", ...rows, ""].join("\n");
}

/** The "Prompts" section: every shipped prompt, sorted by name. */
function promptSection(prompts: readonly PromptDefinition[]): string[] {
  if (prompts.length === 0) return [];
  const lines = [
    "## Prompts",
    "",
    "Ready-made bookkeeping workflows (MCP prompts). Clients offer them by name, e.g. Claude " +
      "Code as `/mcp__sevdesk__month_end_close` for a server named `sevdesk`. A prompt is listed " +
      "only when the tools it needs are enabled; a step whose tools are not enabled is replaced " +
      "by a note naming the setting that enables it. Prompts only produce text: they never call " +
      "sevDesk.",
    "",
  ];
  for (const prompt of [...prompts].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      `### \`${prompt.name}\``,
      "",
      `**${prompt.title}** · needs ${requirementText(prompt)}`,
      "",
      prompt.description,
      "",
      argumentTable(prompt),
    );
  }
  return lines;
}

/**
 * The full Markdown reference, deterministic (tools sorted by toolset order, then name; then the
 * prompts by name).
 */
export function renderToolDocs(
  tools: readonly AnyToolDefinition[] = ALL_TOOLS,
  prompts: readonly PromptDefinition[] = PROMPTS,
): string {
  const lines: string[] = [
    "# Tool reference",
    "",
    "<!-- Generated by `pnpm docs:tools` from the tool definitions. Do not edit by hand. -->",
    "",
    `${tools.length} tools. Which ones a client sees depends on \`SEVDESK_TOOLSETS\` and ` +
      "`SEVDESK_ALLOW` (see docs/configuration.md); tools above the enabled tiers are never listed.",
    "",
    "Tiers:",
    "",
    ...TIERS.map((tier) => `- \`${tier}\`: ${TIER_DESCRIPTIONS[tier]}.`),
    "",
  ];
  for (const toolset of TOOLSETS) {
    const members = tools
      .filter((tool) => tool.toolset === toolset)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (members.length === 0) continue;
    lines.push(`## Toolset \`${toolset}\``, "");
    for (const tool of members) {
      lines.push(
        `### \`${tool.name}\``,
        "",
        `**${tool.title}** · tier \`${tool.tier}\` · ${annotationSummary(tool)}`,
        "",
        tool.description,
        "",
        inputTable(tool),
      );
    }
  }
  lines.push(...promptSection(prompts));
  return `${lines.join("\n").trimEnd()}\n`;
}
