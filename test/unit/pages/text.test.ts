import { describe, expect, it } from "vitest";

import { LOCALES } from "../../../src/pages/locale.js";
import { pageTexts } from "../../../src/pages/text/index.js";
import {
  flattenTexts,
  NUMBER_ARGUMENT,
  takesNumbers,
  TEXT_ARGUMENT,
} from "../../helpers/page-texts.js";

/** Texts that read the same in both languages. */
const SAME_IN_BOTH = new Set<string>([]);

describe("page texts", () => {
  const english = flattenTexts(pageTexts("en"));
  const german = flattenTexts(pageTexts("de"));

  it("has the same texts in every language", () => {
    for (const locale of LOCALES) {
      expect([...flattenTexts(pageTexts(locale)).keys()].sort()).toEqual(
        [...english.keys()].sort(),
      );
    }
    expect(english.size).toBeGreaterThan(100);
  });

  it("leaves no text empty, untrimmed or with a doubled space", () => {
    for (const texts of [english, german]) {
      for (const [path, text] of texts) {
        expect(text.trim(), path).not.toBe("");
        expect(text, path).toBe(text.trim());
        expect(text, path).not.toMatch(/ {2}/);
      }
    }
  });

  it("translates every text", () => {
    for (const [path, text] of german) {
      if (SAME_IN_BOTH.has(path)) continue;
      expect(text, path).not.toBe(english.get(path));
    }
  });

  it("puts each parameter into its text, in both languages", () => {
    for (const texts of [english, german]) {
      const byFunction = new Map<string, string[]>();
      for (const [path, text] of texts) {
        const call = /^(.*?)\(\)/.exec(path)?.[1];
        if (call !== undefined) byFunction.set(call, [...(byFunction.get(call) ?? []), text]);
      }
      expect(byFunction.size).toBeGreaterThan(0);
      for (const [call, parts] of byFunction) {
        const expected = takesNumbers(call) ? String(NUMBER_ARGUMENT) : TEXT_ARGUMENT;
        expect(parts.join("\n"), call).toContain(expected);
      }
    }
  });

  it("addresses the reader formally in German", () => {
    for (const [path, text] of german) {
      expect(text, path).not.toMatch(/\b(?:du|dein|deine|deinen|dir|dich)\b/i);
    }
  });
});
