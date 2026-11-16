/**
 * The audit steps of `month_end_close` and `vat_precheck` (#92) on the real tool catalog: the
 * audit checks with the period's arguments, and the receipt folder step only where the server
 * reads local folders, without a "needs" line elsewhere (uploads would not enable it).
 */
import { describe, expect, it } from "vitest";

import type { Config, Deployment } from "../../../src/config.js";
import { PROMPTS } from "../../../src/prompts/catalog.js";
import { type PlannedPrompt, planPrompts, renderPrompt } from "../../../src/prompts/index.js";
import { ALL_TOOLS } from "../../../src/tools/index.js";
import { selectTools } from "../../../src/tools/registry.js";
import { testConfig } from "../../helpers/config.js";

/** 2026-11-09 12:00 UTC: the previous month is 2026-10. */
const NOW = () => Date.UTC(2026, 10, 9, 12);
const FOLDER_TOOL = "sevdesk_receipt_folder_check";

const OAUTH_FILES: Deployment = {
  kind: "http",
  auth: "oauth",
  publicOrigin: "https://mcp.example.com",
  approvalsUrl: undefined,
  files: { ttlSeconds: 900 },
};

function planned(name: string, config: Config): PlannedPrompt {
  const prompt = PROMPTS.find((candidate) => candidate.name === name);
  if (prompt === undefined) throw new Error(`no prompt ${name}`);
  const [plan] = planPrompts(config, selectTools(ALL_TOOLS, config), ALL_TOOLS, [prompt]);
  if (plan === undefined) throw new Error(`${name} is not offered`);
  return plan;
}

function textOf(plan: PlannedPrompt): string {
  const content = renderPrompt(plan, {}, NOW).messages[0]?.content;
  return content?.type === "text" ? content.text : "";
}

describe.each(["month_end_close", "vat_precheck"])("%s", (name) => {
  it("runs the audit checks for the period", () => {
    const text = textOf(planned(name, testConfig()));
    for (const check of ["vat", "reverse_charge", "duplicates", "recurring_gaps"]) {
      expect(text).toContain(`\`check: "${check}"\``);
    }
    expect(text).toContain(
      '`sevdesk_records_audit` with `check: "vat"` and `year: 2026, month: 10`',
    );
  });

  it("checks a receipt folder only where the server reads local folders", () => {
    const local = textOf(planned(name, testConfig({ fileDirs: ["/srv/belege"] })));
    expect(local).toContain(`\`${FOLDER_TOOL}\` with that folder (ask me which one) and`);
    expect(local).toContain("no match is a hint, not proof");

    for (const config of [testConfig(), testConfig({ deployment: OAUTH_FILES })]) {
      const plan = planned(name, config);
      expect(textOf(plan)).not.toContain(FOLDER_TOOL);
      // No "needs" line: the folder step has no fallback, so nothing names uploads for it.
      expect(plan.unavailable.join(" ")).not.toMatch(
        /SEVDESK_FILE_DIRS|SEVDESK_HTTP_FILES|receipt/i,
      );
    }
  });
});
