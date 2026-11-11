import { readFileSync } from "node:fs";

import { format } from "prettier";
import { describe, expect, it } from "vitest";

import { renderToolDocs } from "../../scripts/tool-docs.js";
import { ALL_TOOLS } from "../../src/tools/index.js";

const DOCS = new URL("../../docs/tools.md", import.meta.url);

describe("docs/tools.md", () => {
  it("is up to date with the tool definitions (run `pnpm docs:tools`)", async () => {
    const expected = await format(renderToolDocs(), { parser: "markdown", printWidth: 100 });
    expect(readFileSync(DOCS, "utf8")).toBe(expected);
  });

  it("documents every shipped tool", () => {
    const docs = readFileSync(DOCS, "utf8");
    for (const tool of ALL_TOOLS) {
      expect(docs).toContain(`### \`${tool.name}\``);
    }
  });
});

describe("the READMEs", () => {
  // The counts drifted once (73 and 36 while the catalog had 74 and 37; review 2026-11, round 3).
  const total = ALL_TOOLS.length;
  const read = ALL_TOOLS.filter((tool) => tool.tier === "read").length;

  it("give the number of tools and of read tools the catalog has", () => {
    const english = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(english).toContain(`${String(total)} tools across`);
    expect(english).toContain(`The ${String(read)} read tools`);
    const german = readFileSync(new URL("../../README.de.md", import.meta.url), "utf8");
    expect(german).toContain(`${String(total)} Werkzeuge in`);
    expect(german).toContain(`Die ${String(read)} Lesewerkzeuge`);
  });
});
