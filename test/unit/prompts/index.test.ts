import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Config, Deployment } from "../../../src/config.js";
import { PROMPTS } from "../../../src/prompts/catalog.js";
import {
  type PlannedPrompt,
  planPrompts,
  type PromptToolInfo,
  promptToolNames,
  renderPrompt,
  selectPrompts,
} from "../../../src/prompts/index.js";
import { definePrompt, type PromptDefinition } from "../../../src/prompts/types.js";
import { TEST_TOKEN, testConfig, tiers } from "../../helpers/config.js";

/** 2026-11-09 12:00 UTC: "today" is 2026-11-09 in Berlin. */
const NOW = () => Date.UTC(2026, 10, 9, 12);

const TOOLS: readonly PromptToolInfo[] = [
  { name: "sevdesk_a_list", toolset: "meta", tier: "read" },
  { name: "sevdesk_b_create", toolset: "meta", tier: "write" },
  { name: "sevdesk_c_book", toolset: "advanced", tier: "commit" },
  {
    name: "sevdesk_d_parse",
    toolset: "vouchers",
    tier: "read",
    localEffects: "reads-files",
    available: (config) => config.fileDirs.length > 0,
  },
  {
    name: "sevdesk_e_save",
    toolset: "meta",
    tier: "read",
    localEffects: "writes-files",
    available: (config) => config.outputDir !== undefined,
  },
  { name: "sevdesk_f_other", toolset: "meta", tier: "read", available: () => false },
];

const sample = definePrompt({
  name: "sample_flow",
  title: "Sample",
  description: "A test prompt. Not tax advice.",
  args: z.object({
    label: z
      .string()
      .regex(/^[a-z]+$/)
      .optional()
      .describe("A label."),
  }),
  requires: ["sevdesk_a_list", { anyOf: ["sevdesk_b_create", "sevdesk_d_parse"] }],
  resolve: (args, context) => ({ label: args.label ?? "none", today: context.today }),
  intro: ({ label, today }) => `Intro ${label} ${today}.`,
  steps: [
    { text: "List with `sevdesk_a_list`.", tools: ["sevdesk_a_list"] },
    { text: "Create with `sevdesk_b_create`.", tools: ["sevdesk_b_create"], fallback: "Creating" },
    { text: "Book with `sevdesk_c_book`.", tools: ["sevdesk_c_book"], fallback: "Booking" },
    { text: "Parse with `sevdesk_d_parse`.", tools: ["sevdesk_d_parse"], fallback: "Parsing" },
    { text: "Save with `sevdesk_e_save`.", tools: ["sevdesk_e_save"], fallback: "Saving" },
    { text: "Other with `sevdesk_f_other`.", tools: ["sevdesk_f_other"], fallback: "Other" },
    { text: "Ghost with `sevdesk_g_ghost`.", tools: ["sevdesk_g_ghost"], fallback: "Ghost" },
    { text: "Optional `sevdesk_c_book`.", tools: ["sevdesk_c_book"] },
    { text: ({ today }) => `Summary on ${today}.`, tools: [] },
  ],
});

/** The tools `config` registers, like `selectTools`. */
function registered(config: Config): PromptToolInfo[] {
  return TOOLS.filter(
    (tool) =>
      config.toolsets.has(tool.toolset) &&
      config.allowedTiers.has(tool.tier) &&
      (tool.available?.(config) ?? true),
  );
}

function plan(config: Config, prompts: readonly PromptDefinition[] = [sample]): PlannedPrompt[] {
  return planPrompts(config, registered(config), TOOLS, prompts);
}

function textOf(planned: PlannedPrompt, args: unknown = {}): string {
  const content = renderPrompt(planned, args, NOW).messages[0]?.content;
  return content?.type === "text" ? content.text : "";
}

const HTTP_BEARER: Deployment = {
  kind: "http",
  auth: "bearer",
  publicOrigin: "https://mcp.example.com",
  approvalsUrl: undefined,
};
const HTTP_OAUTH: Deployment = { ...HTTP_BEARER, auth: "oauth" };

describe("selectPrompts", () => {
  it("keeps a prompt only when every requirement is met, sorted by name", () => {
    const other = definePrompt({ ...sampleSpec(), name: "another_flow" });
    expect(selectPrompts([sample, other], new Set(["sevdesk_a_list"]))).toEqual([]);
    expect(
      selectPrompts([sample, other], new Set(["sevdesk_a_list", "sevdesk_d_parse"])).map(
        (prompt) => prompt.name,
      ),
    ).toEqual(["another_flow", "sample_flow"]);
  });
});

/** The spec of `sample` again, for a second prompt with another name. */
function sampleSpec() {
  return {
    name: "sample_flow",
    title: "Sample 2",
    description: "Another test prompt. Not tax advice.",
    args: z.object({}),
    requires: ["sevdesk_a_list", { anyOf: ["sevdesk_b_create", "sevdesk_d_parse"] }],
    resolve: () => ({}),
    intro: () => "Intro.",
    steps: [{ text: "List with `sevdesk_a_list`.", tools: ["sevdesk_a_list"] }],
  };
}

describe("promptToolNames", () => {
  it("collects requirements and step tools once, sorted", () => {
    expect(promptToolNames(sample)).toEqual([
      "sevdesk_a_list",
      "sevdesk_b_create",
      "sevdesk_c_book",
      "sevdesk_d_parse",
      "sevdesk_e_save",
      "sevdesk_f_other",
      "sevdesk_g_ghost",
    ]);
  });
});

describe("planPrompts and renderPrompt", () => {
  it("is not listed when no alternative of a requirement is registered", () => {
    expect(plan(testConfig())).toEqual([]);
  });

  it("shows the steps whose tools are registered and names what enables the others (stdio)", () => {
    const [planned] = plan(testConfig({ allowedTiers: tiers("read", "write") }));
    expect(planned?.shown).toEqual([0, 1, 8]);
    const text = textOf(planned as PlannedPrompt);
    expect(text).toContain("Intro none 2026-11-09.");
    expect(text).toContain(
      [
        "Steps:",
        "1. List with `sevdesk_a_list`.",
        "2. Create with `sevdesk_b_create`.",
        "3. Summary on 2026-11-09.",
        "",
        "Not available with the current settings:",
        "- Booking: needs the `advanced` toolset (SEVDESK_TOOLSETS) and the `commit` tier " +
          "(SEVDESK_ALLOW).",
        "- Parsing: needs a folder to read files from (SEVDESK_FILE_DIRS).",
        "- Saving: needs an output folder (SEVDESK_OUTPUT_DIR).",
        "- Other: needs a setting that is off.",
        "- Ghost: needs a setting that is off.",
        "Only I can change these settings, in the server's configuration, followed by a " +
          "restart. Tell me what a step needs; do not work around a missing tool.",
      ].join("\n"),
    );
    // A step without a fallback is left out silently.
    expect(text).not.toContain("Optional");
    expect(text).not.toMatch(/sevdesk_(c|d|e|f|g)_/);
  });

  it("drops the section when every step is shown", () => {
    const prompt = definePrompt({ ...sampleSpec(), steps: sampleSpec().steps });
    const [planned] = plan(testConfig({ fileDirs: ["/belege"] }), [prompt]);
    expect(planned?.unavailable).toEqual([]);
    expect(planned?.changeNote).toBe("");
    expect(textOf(planned as PlannedPrompt)).not.toContain("Not available");
  });

  it("carries the working rules: dry run first, untrusted data, not tax advice", () => {
    const [planned] = plan(testConfig({ fileDirs: ["/belege"] }));
    const text = textOf(planned as PlannedPrompt);
    expect(text).toContain("`dryRun: true` first");
    expect(text).toContain("untrusted");
    expect(text).toContain("Not tax advice");
  });

  it("words read-only mode, bearer and OAuth deployments", () => {
    const readOnly = plan(testConfig({ readOnly: true, fileDirs: ["/belege"] }))[0];
    expect(readOnly?.unavailable).toContain(
      "Creating: needs the `write` tier (SEVDESK_READ_ONLY is on).",
    );

    const bearer = plan(testConfig({ deployment: HTTP_BEARER, fileDirs: ["/belege"] }))[0];
    expect(bearer?.unavailable).toContain(
      "Saving: needs download links (SEVDESK_HTTP_FILES) or SEVDESK_OUTPUT_DIR.",
    );
    expect(bearer?.changeNote).toMatch(/^Only the server's operator can change these settings\./);

    const oauth = plan(
      testConfig({ deployment: HTTP_OAUTH, allowedTiers: tiers("read", "write") }),
    )[0];
    expect(oauth?.unavailable).toEqual(
      expect.arrayContaining([
        "Booking: needs the `advanced` toolset (SEVDESK_TOOLSETS) and the `commit` tier " +
          "(granted on the consent page).",
        "Parsing: needs file uploads (SEVDESK_HTTP_FILES).",
        "Saving: needs download links (SEVDESK_HTTP_FILES).",
      ]),
    );
    expect(oauth?.changeNote).toMatch(/^Tiers are granted on the consent page when I connect/);

    const bearerRead = plan(
      testConfig({ deployment: HTTP_BEARER, allowedTiers: tiers("read", "write") }),
    )[0];
    expect(bearerRead?.unavailable).toContain(
      "Parsing: needs file uploads (SEVDESK_HTTP_FILES) or SEVDESK_FILE_DIRS.",
    );
  });

  it("validates arguments again and never puts the token into the text", () => {
    const [planned] = plan(testConfig({ fileDirs: ["/belege"] }));
    expect(textOf(planned as PlannedPrompt, { label: "abc" })).toContain("Intro abc");
    expect(() => renderPrompt(planned as PlannedPrompt, { label: "A B" }, NOW)).toThrow();
    for (const prompt of plan(testConfig({ allowedTiers: tiers("read", "write") }))) {
      expect(textOf(prompt)).not.toContain(TEST_TOKEN);
    }
  });

  it("returns one user message and the prompt's description", () => {
    const [planned] = plan(testConfig({ fileDirs: ["/belege"] }));
    const result = renderPrompt(planned as PlannedPrompt, undefined, NOW);
    expect(result.description).toBe("A test prompt. Not tax advice.");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
  });

  it("uses the Berlin date for defaults (late on 31 December UTC is already January)", () => {
    const monthEnd = PROMPTS.find((prompt) => prompt.name === "month_end_close");
    const planned: PlannedPrompt = {
      prompt: monthEnd as PromptDefinition,
      shown: [],
      unavailable: [],
      changeNote: "",
    };
    const content = renderPrompt(planned, {}, () => Date.UTC(2026, 11, 31, 23, 30)).messages[0]
      ?.content;
    expect(content?.type === "text" ? content.text : "").toContain("December 2026");
  });
});

describe("receipt_intake and file uploads", () => {
  const upload: PromptToolInfo = { name: "sevdesk_upload_request", toolset: "meta", tier: "read" };
  const catalog: readonly PromptToolInfo[] = [
    { name: "sevdesk_vouchers_list", toolset: "vouchers", tier: "read" },
    { name: "sevdesk_voucher_create_draft", toolset: "vouchers", tier: "write" },
    upload,
  ];
  const receipt = PROMPTS.find((prompt) => prompt.name === "receipt_intake") as PromptDefinition;
  const config = testConfig({ allowedTiers: tiers("read", "write") });

  it("mentions sevdesk_upload_request only when it is registered", () => {
    const withUpload = planPrompts(config, catalog, catalog, [receipt])[0];
    expect(textOf(withUpload as PlannedPrompt)).toContain("`sevdesk_upload_request`");

    const without = planPrompts(config, catalog.slice(0, 2), catalog, [receipt])[0];
    const text = textOf(without as PlannedPrompt);
    expect(text).not.toContain("sevdesk_upload_request");
    expect(text).not.toContain("upload is done");
  });
});
