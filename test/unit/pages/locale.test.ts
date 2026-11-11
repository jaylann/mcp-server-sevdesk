import { describe, expect, it } from "vitest";

import { pageContext } from "../../../src/pages/context.js";
import { LOCALES, pickLocale } from "../../../src/pages/locale.js";

describe("pickLocale", () => {
  it("answers in English without a usable header", () => {
    for (const header of [undefined, null, "", "   ", "fr-FR,fr;q=0.9", "*", "x", ";;;,,,"]) {
      expect(pickLocale(header)).toBe("en");
    }
  });

  it("picks German for German browsers, whatever the region", () => {
    expect(pickLocale("de")).toBe("de");
    expect(pickLocale("de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7")).toBe("de");
    expect(pickLocale("de-AT")).toBe("de");
    expect(pickLocale("DE-ch")).toBe("de");
    expect(pickLocale(" de ; q=0.5 ")).toBe("de");
  });

  it("takes the supported language with the highest quality, the first on a tie", () => {
    expect(pickLocale("en-GB,en;q=0.9,de;q=0.8")).toBe("en");
    expect(pickLocale("fr,de;q=0.4,en;q=0.6")).toBe("en");
    expect(pickLocale("fr,de;q=0.6,en;q=0.4")).toBe("de");
    expect(pickLocale("en;q=0.5,de;q=0.5")).toBe("en");
    expect(pickLocale("de;q=0.5,en;q=0.5")).toBe("de");
  });

  it("ignores refused and malformed entries", () => {
    expect(pickLocale("de;q=0,en;q=0.1")).toBe("en");
    expect(pickLocale("de;q=0")).toBe("en");
    expect(pickLocale("de;q=2,en;q=0.1")).toBe("en");
    expect(pickLocale("de;q=abc")).toBe("en");
    expect(pickLocale("de;q=1.000")).toBe("de");
    // A language that only starts like a supported one is another language.
    expect(pickLocale("den,dex-DE")).toBe("en");
  });

  it("reads only the start of an oversized header", () => {
    expect(pickLocale(`${"fr,".repeat(400)}de`)).toBe("en");
    expect(pickLocale(`de,${"fr,".repeat(400)}`)).toBe("de");
  });

  it("lists the default language first", () => {
    expect(LOCALES[0]).toBe("en");
  });
});

describe("pageContext", () => {
  it("carries the language, its texts and the origin", () => {
    const german = pageContext("de", "https://mcp.example.com");
    expect(german.locale).toBe("de");
    expect(german.origin).toBe("https://mcp.example.com");
    expect(german.t.inbox.approved.title).toBe("Freigegeben");
    expect(pageContext(null, "http://127.0.0.1:1").t.inbox.approved.title).toBe("Approved");
  });
});
