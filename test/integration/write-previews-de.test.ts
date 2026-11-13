/**
 * Every tool a human confirms (`commit`, `external`) writes its preview in German too, because
 * that is what a German reader approves on the approval page. For each known-good case
 * (test/write-cases/) the German preview must say the same as the English one: the same facts
 * and warnings in the same order, the same `irreversible`, and no English left in it.
 *
 * The snapshot is the German wording of every confirmed tool in one place, as the approval page
 * and its plain-text form show it: review it when a preview changes (`pnpm test -u`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { displayPreview, previewPairSchema } from "../../src/safety/preview.js";
import { requiresConfirmation } from "../../src/safety/tiers.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { type ConfirmationPreview, isWriteTool } from "../../src/tools/types.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { withCaseEnvironment } from "../helpers/write-cases.js";
import { prepareWrite } from "../helpers/write-tools.js";
import { WRITE_TOOL_CASES } from "../write-cases/index.js";

const CONFIRMED = WRITE_TOOL_CASES.filter((testCase) => requiresConfirmation(testCase.tool.tier));
// Voucher updates also carry bilingual previews, including the currency conversion warning.
const BILINGUAL = WRITE_TOOL_CASES.filter(
  (testCase) =>
    requiresConfirmation(testCase.tool.tier) ||
    testCase.tool.name === "sevdesk_voucher_update_draft",
);
const UNCONFIRMED = WRITE_TOOL_CASES.filter((testCase) => !BILINGUAL.includes(testCase));

/**
 * Words that only English sentences have, in any case, and English bookkeeping words that the
 * German text writes differently (lower case only: "Status" and "Position" are German too).
 * Tool names (`sevdesk_…`) and the terms the German text keeps (Storno, GoBD, Cc) match neither.
 */
const ENGLISH_WORDS =
  /\b(?:the|and|or|is|are|its|it|with|cannot|this|of|to|be|by|from|not|then|only)\b/i;
const ENGLISH_TERMS = /\b(?:account|contact|draft|open|paid|booked|unbooked|linked|status)\b/;

/** The first English word left in `text`, if any. */
function english(text: string): string | undefined {
  return (ENGLISH_WORDS.exec(text) ?? ENGLISH_TERMS.exec(text))?.[0];
}

/** The German preview as plain text: the action, the consequences, then the facts. */
function germanText(preview: ConfirmationPreview): string {
  return [
    preview.action,
    ...preview.warnings.map((warning) => `! ${warning}`),
    preview.irreversible ? "(nicht umkehrbar)" : "(umkehrbar)",
    ...preview.facts.map((fact) => `${fact.label}: ${fact.value}`),
  ].join("\n");
}

/** Our own wording in a preview: everything but the fact values, which carry sevDesk's data. */
function wording(preview: ConfirmationPreview): string[] {
  return [preview.action, ...preview.warnings, ...preview.facts.map((fact) => fact.label)];
}

describe("German previews", () => {
  // Some previews name today's date (a booking date that defaults to today).
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-09T11:00:00Z") });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("have a case for every tool a human confirms", () => {
    const confirmedTools = ALL_TOOLS.filter(isWriteTool).filter((tool) =>
      requiresConfirmation(tool.tier),
    );
    const covered = new Set(CONFIRMED.map((testCase) => testCase.tool.name));
    expect(confirmedTools.length).toBeGreaterThan(20);
    expect(confirmedTools.map((tool) => tool.name).filter((name) => !covered.has(name))).toEqual(
      [],
    );
  });

  it.each(BILINGUAL.map((testCase) => [testCase.label, testCase] as const))(
    "%s: says the same in German",
    async (_label, testCase) => {
      const client = new FakeSevdeskClient(testCase.routes);
      const plan = await withCaseEnvironment(testCase, (config) =>
        prepareWrite(testCase.tool, testCase.args, client, config),
      );
      const { preview, previewDe } = plan;
      if (previewDe === undefined) throw new Error("no German preview");

      // The same shape (what the write flow enforces before it asks anyone).
      const checked = previewPairSchema.safeParse({ preview, previewDe });
      expect(checked.error?.issues ?? []).toEqual([]);
      expect(previewDe.facts).toHaveLength(preview.facts.length);
      expect(previewDe.warnings).toHaveLength(preview.warnings.length);
      expect(previewDe.irreversible).toBe(preview.irreversible);

      // Translated: the action and every warning differ, and no English is left in our wording.
      expect(previewDe.action).not.toBe(preview.action);
      for (const [index, warning] of previewDe.warnings.entries()) {
        expect(warning, `warning ${String(index + 1)}`).not.toBe(preview.warnings[index]);
      }
      for (const text of wording(previewDe)) {
        expect(english(text), text).toBeUndefined();
      }
      // A value that was reworded (a status change, an amount with a note) is German as well;
      // values taken over unchanged are sevDesk's data (names, numbers, an email text).
      for (const [index, fact] of previewDe.facts.entries()) {
        if (fact.value === preview.facts[index]?.value) continue;
        expect(english(fact.value), `${fact.label}: ${fact.value}`).toBeUndefined();
      }

      // Shown in full in both languages: nothing reaches a display cap.
      for (const shown of [displayPreview(preview), displayPreview(previewDe)]) {
        for (const text of wording(shown)) expect(text).not.toContain("[truncated");
      }

      expect(germanText(displayPreview(previewDe))).toMatchSnapshot();
    },
  );

  it.each(UNCONFIRMED.map((testCase) => [testCase.label, testCase] as const))(
    "%s: needs none (nobody is asked)",
    async (_label, testCase) => {
      const client = new FakeSevdeskClient(testCase.routes);
      const plan = await withCaseEnvironment(testCase, (config) =>
        prepareWrite(testCase.tool, testCase.args, client, config),
      );
      expect(testCase.tool.tier).toBe("write");
      expect(plan.previewDe).toBeUndefined();
    },
  );
});
