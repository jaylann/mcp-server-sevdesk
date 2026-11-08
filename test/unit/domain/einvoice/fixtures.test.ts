import { describe, expect, it } from "vitest";

import { buildEInvoiceFixtures } from "../../../../scripts/gen-einvoice-fixtures.js";
import { einvoiceFixture } from "./helpers.js";

describe("e-invoice fixtures (scripts/gen-einvoice-fixtures.ts)", () => {
  it("the committed generated and attack files equal what the script builds", async () => {
    const files = await buildEInvoiceFixtures();
    expect(files.size).toBeGreaterThan(15);
    for (const [path, bytes] of files) {
      expect(einvoiceFixture(path), path).toEqual(bytes);
    }
  });
});
