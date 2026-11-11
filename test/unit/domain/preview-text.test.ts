import { describe, expect, it } from "vitest";

import {
  bothPreviews,
  dateText,
  germanNumber,
  inLanguage,
  numberText,
  phrase,
} from "../../../src/domain/preview-text.js";

describe("germanNumber", () => {
  it("swaps the separators and groups thousands, keeping every digit", () => {
    expect(germanNumber("1190.00")).toBe("1.190,00");
    expect(germanNumber("119")).toBe("119");
    expect(germanNumber("0.5")).toBe("0,5");
    expect(germanNumber("-0.5")).toBe("-0,5");
    expect(germanNumber("-23.8")).toBe("-23,8");
    expect(germanNumber("1234567.891")).toBe("1.234.567,891");
    expect(germanNumber("1000")).toBe("1.000");
    expect(germanNumber("999")).toBe("999");
    expect(germanNumber("-1000000.00")).toBe("-1.000.000,00");
    expect(germanNumber("2903.62000000001")).toBe("2.903,62000000001");
    expect(germanNumber("0")).toBe("0");
  });

  it("leaves anything that is not a plain decimal as it is", () => {
    for (const value of ["", "?", "1e3", "1,5", "+5", ".5", "5.", "12 EUR", "abc", "1.2.3"]) {
      expect(germanNumber(value)).toBe(value);
    }
  });
});

describe("numberText and dateText", () => {
  it("write English as sevDesk sends it and German in German notation", () => {
    expect(numberText("1190.00", "en")).toBe("1190.00");
    expect(numberText("1190.00", "de")).toBe("1.190,00");
    expect(dateText("2026-11-03", "en")).toBe("2026-11-03");
    expect(dateText("2026-11-03", "de")).toBe("03.11.2026");
  });

  it("leave what is not an ISO date alone", () => {
    for (const value of ["", "03.11.2026", "2026-11-03T10:00:00Z", "2026-1-3", "soon"]) {
      expect(dateText(value, "de")).toBe(value);
    }
  });
});

describe("phrases", () => {
  it("keep both wordings together and give one language in order", () => {
    const first = phrase("One.", "Eins.");
    const second = phrase("Two.", "Zwei.");
    expect(first).toEqual({ en: "One.", de: "Eins." });
    expect(inLanguage([first, second], "en")).toEqual(["One.", "Two."]);
    expect(inLanguage([first, second], "de")).toEqual(["Eins.", "Zwei."]);
    expect(inLanguage([], "de")).toEqual([]);
  });

  it("build both previews from one function, English first", () => {
    const calls: string[] = [];
    const built = bothPreviews((lang) => {
      calls.push(lang);
      return { action: lang === "de" ? "Tun." : "Do.", count: 2 };
    });
    expect(built).toEqual({
      preview: { action: "Do.", count: 2 },
      previewDe: { action: "Tun.", count: 2 },
    });
    expect(calls).toEqual(["en", "de"]);
  });
});
