import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderStylesModule } from "../../../scripts/page-css.js";

const GENERATED = new URL("../../../src/pages/styles.generated.ts", import.meta.url);

describe("compiled page stylesheet", () => {
  it("matches pages.css and the installed @lanfermann/ui (run `pnpm pages:css` after changing either)", async () => {
    expect(readFileSync(GENERATED, "utf8")).toBe(await renderStylesModule());
  });
});
