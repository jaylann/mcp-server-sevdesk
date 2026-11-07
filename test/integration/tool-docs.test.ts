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
